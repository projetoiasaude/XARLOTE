/**
 * appointment-integrity worker — a INVARIANTE de que uma consulta marcada nunca fica
 * pela metade. Roda a cada 20 min e conserta sozinho.
 *
 * ─── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────
 * Toda correção dos outros arquivos é preventiva: fecha o caminho por onde o erro
 * entrou. Isto aqui é diferente — é CURATIVO, e existe porque em produção nós
 * descobrimos que a única consulta agendada da história do produto estava pela metade:
 *
 *   • o registro em `scheduled` foi feito à mão por um humano no terminal, porque o
 *     LLM voltou vazio e o detector determinístico não existia;
 *   • e o lembrete "Consulta em 2 horas" — o único aviso no DIA da consulta — foi
 *     apagado por um curinga de `cancel_reminders`, sem que nada notasse.
 *
 * A lição não é "conserte esses dois bugs". É que **um estado terminal bom
 * (`scheduled`) pode ser alcançado por vários caminhos, e basta UM deles estar
 * incompleto pra o paciente perder a consulta em silêncio.** Prevenir cada caminho é
 * necessário mas não é suficiente: caminhos novos vão aparecer.
 *
 * Então a garantia é declarada como INVARIANTE sobre o ESTADO, não sobre o fluxo:
 *
 *   Toda consulta `scheduled` com horário no futuro TEM lembretes de 1d e 2h e o
 *   paciente SABE dela.
 *
 * Quem viola, o worker conserta — pela mesma porta idempotente que os fluxos normais
 * usam (`commitAppointment`). Sem intervenção humana, e independente de qual caminho
 * criou o problema. É por construção, não por lista.
 */
import { db, writeLog } from '@iasaude/db';
import { withCronLock } from '../middleware/cron-lock.js';
import { commitAppointment, anchorsMissing } from '../handlers/appointment-commit.js';

const POLL_INTERVAL_MS = 20 * 60_000;

/** Teto de reparos por rodada — protege a fila de outbound de uma rajada. */
const MAX_REPAIRS_PER_RUN = 15;

/**
 * Uma consulta futura recém-fechada pode estar a segundos de o próprio fluxo terminar
 * de avisar o paciente. Só considera "pela metade" o que já passou desta carência.
 */
const GRACE_MS = 5 * 60_000;

interface Row {
  id: string;
  user_id: string;
  status: string;
  specialty: string | null;
  scheduled_at: string | null;
  scheduled_clinic_id: string | null;
  scheduled_prescriber_id: string | null;
  selected_quote_id: string | null;
  preferences: Record<string, unknown> | null;
  updated_at: string;
}

export async function runAppointmentIntegrityOnce(nowMs = Date.now()): Promise<{ checked: number; repaired: number }> {
  const { data, error } = await db
    .from('consultations')
    .select('id, user_id, status, specialty, scheduled_at, scheduled_clinic_id, scheduled_prescriber_id, selected_quote_id, preferences, updated_at')
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(nowMs).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(200);

  if (error) {
    // Erro de query aqui não pode ser silencioso: é o vigilante que fica cego.
    await writeLog('error', 'appointment-integrity', `varredura falhou: ${error.message.slice(0, 140)}`, {});
    return { checked: 0, repaired: 0 };
  }

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return { checked: 0, repaired: 0 };

  // Lembretes de consulta pendentes de todos esses pacientes, numa query só.
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: lembretes } = await db
    .from('reminders')
    .select('user_id, status, next_run_at')
    .in('user_id', userIds)
    .eq('type', 'appointment')
    .in('status', ['pending', 'sent']);

  // Cobertura por HORÁRIO e por PACIENTE — não por `payload.kind`. Lembrete criado pelo
  // modelo via `create_reminder` não carrega `consultation_id` nem `kind`, e a primeira
  // versão deste worker por isso recriou o "amanhã" do Ciro ao lado do que já existia:
  // ele receberia duas mensagens iguais em 25/08. A pergunta certa é "o paciente já vai
  // ser avisado perto dessa hora?", e essa não depende de quem criou o lembrete.
  const avisosPorUsuario = new Map<string, number[]>();
  for (const l of lembretes ?? []) {
    const t = Date.parse(l.next_run_at as string);
    if (!Number.isFinite(t)) continue;
    const uid = l.user_id as string;
    if (!avisosPorUsuario.has(uid)) avisosPorUsuario.set(uid, []);
    avisosPorUsuario.get(uid)!.push(t);
  }

  let repaired = 0;
  for (const r of rows) {
    if (repaired >= MAX_REPAIRS_PER_RUN) {
      // Teto atingido não pode passar por "tudo em ordem": diz quanto sobrou.
      await writeLog('info', 'appointment-integrity', `teto de ${MAX_REPAIRS_PER_RUN} reparos atingido nesta rodada — o resto entra na próxima`, {});
      break;
    }
    if (!r.scheduled_at) continue;
    if (nowMs - Date.parse(r.updated_at) < GRACE_MS) continue; // ainda no fluxo

    const alvo = Date.parse(r.scheduled_at);
    if (!Number.isFinite(alvo)) continue;

    const prefs = r.preferences ?? {};
    const commit = (prefs['_commit'] ?? null) as { notified_at?: string } | null;
    const avisos = avisosPorUsuario.get(r.user_id) ?? [];

    // 🕰️ CONSULTA ANTERIOR A ESTE CÓDIGO (`_commit` inexistente): NÃO reanuncia.
    // Revisão adversarial desta própria correção: sem esta guarda, a consulta do Ciro —
    // marcada em 03/08, com ele JÁ avisado naquele dia — receberia um "Confirmado, Ciro!
    // 🎉" novo na primeira rodada do worker, três semanas depois. Reparar não pode
    // significar reanunciar. O que ele realmente precisa é do LEMBRETE que foi apagado, e
    // isso o reconciliador faz sem falar nada. Carimba como avisado-por-presunção pra não
    // reavaliar a mesma linha a cada 20 min.
    if (!commit) {
      await writeLog('info', 'appointment-integrity', 'consulta marcada ANTES deste código (sem carimbo `_commit`) — reparo silencioso: conserta lembrete, não reanuncia', {
        consultationId: r.id,
      });
      await db.from('consultations')
        .update({ preferences: { ...prefs, _commit: { at: new Date(nowMs).toISOString(), iso: r.scheduled_at, source: 'legacy_backfill', notified_at: 'presumido-legado' } } })
        .eq('id', r.id);
      if (anchorsMissing(alvo, nowMs, avisos).length > 0) {
        await commitAppointment({
          consultationId: r.id,
          confirmedIso: r.scheduled_at,
          clinicId: r.scheduled_clinic_id,
          prescriberId: r.scheduled_prescriber_id,
          quoteId: r.selected_quote_id,
          source: 'integrity_worker',
          traceId: `integrity-${r.id.slice(0, 8)}`,
          notifyPatient: false,
        }).catch(async (e) => {
          await writeLog('error', 'appointment-integrity', `reparo legado falhou: ${String(e).slice(0, 140)}`, { consultationId: r.id });
          return null;
        });
        repaired += 1;
      }
      continue;
    }

    const faltando = anchorsMissing(alvo, nowMs, avisos);
    const semAviso = !commit.notified_at;

    if (faltando.length === 0 && !semAviso) continue;

    await writeLog('warn', 'appointment-integrity', `consulta MARCADA pela metade — ${[
      faltando.length > 0 ? `sem lembrete: ${faltando.join('+')}` : null,
      semAviso ? 'paciente possivelmente não avisado' : null,
    ].filter(Boolean).join(' · ')} — reparando`, {
      consultationId: r.id, userId: r.user_id, scheduledAt: r.scheduled_at,
    });

    const res = await commitAppointment({
      consultationId: r.id,
      confirmedIso: r.scheduled_at,
      clinicId: r.scheduled_clinic_id,
      prescriberId: r.scheduled_prescriber_id,
      quoteId: r.selected_quote_id,
      source: 'integrity_worker',
      traceId: `integrity-${r.id.slice(0, 8)}`,
      // Só fala com o paciente se ele REALMENTE não foi avisado — o carimbo
      // `_commit.notified_at` é a fonte. Sem esse cuidado, uma consulta antiga sem
      // carimbo receberia um "Confirmado!" fora de hora a cada rodada.
      notifyPatient: semAviso,
    }).catch(async (e) => {
      await writeLog('error', 'appointment-integrity', `reparo falhou: ${String(e).slice(0, 140)}`, { consultationId: r.id });
      return null;
    });

    if (res?.ok) repaired += 1;
  }

  return { checked: rows.length, repaired };
}

let interval: NodeJS.Timeout | null = null;

export function startAppointmentIntegrityWorker(): void {
  if (interval) return;
  const tick = () => void withCronLock('appointment-integrity', POLL_INTERVAL_MS, async () => {
    const { checked, repaired } = await runAppointmentIntegrityOnce();
    if (repaired > 0) {
      await writeLog('info', 'appointment-integrity', `${repaired} consulta(s) reparada(s) de ${checked} verificada(s)`, {});
    }
  });
  // Primeira passada 3 min após o boot: cedo o suficiente pra consertar o que já está
  // quebrado hoje, tarde o suficiente pra não competir com a subida dos outros workers.
  setTimeout(() => {
    tick();
    interval = setInterval(tick, POLL_INTERVAL_MS);
  }, 3 * 60_000);
  void writeLog('info', 'appointment-integrity', 'appointment-integrity worker iniciado (cada 20min)', {});
}

export function stopAppointmentIntegrityWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
