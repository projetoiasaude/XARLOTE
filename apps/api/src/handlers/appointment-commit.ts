/**
 * appointment-commit — O FUNIL ÚNICO por onde uma consulta vira `scheduled`.
 *
 * ─── POR QUE ISTO EXISTE (auditoria 04/08) ────────────────────────────────────
 * O ciclo de vida do agendamento estava PARTIDO em duas metades, e nenhuma era
 * completa:
 *
 *   • lado PACIENTE (`handleConfirmConsultation`): cria os lembretes 1d/2h, avisa a
 *     clínica, põe a consulta em `confirming` — mas NÃO marca `scheduled`.
 *   • lado CLÍNICA (`record_appointment_confirmation`): marca `scheduled` +
 *     `scheduled_at` — e NÃO avisa o paciente, NÃO cria lembrete nenhum.
 *
 * Pior: ao setar `appointmentConfirmed = true`, o lado clínica DESLIGAVA o backstop de
 * repasse (agent-clinic.ts) — o único mecanismo que avisaria o paciente. Ou seja, o
 * evento "clínica confirmou" silenciava justamente quem deveria reagir a ele.
 *
 * Resultado real em 03/08: a Rita escreveu "Ficou então para o dia 26/08 quarta feira
 * ás 10 horas", o LLM voltou vazio, e a PRIMEIRA consulta agendada da história do
 * produto foi registrada à mão por um humano no terminal.
 *
 * ─── O QUE ESTE MÓDULO GARANTE ───────────────────────────────────────────────
 * `commitAppointment` é a ÚNICA porta pra `scheduled`, é IDEMPOTENTE, e ou faz as
 * quatro coisas ou não diz que fez nenhuma:
 *   1. estado no banco (CAS, nunca read-then-write)
 *   2. cotação representando o slot fechado (criando uma se for contraproposta)
 *   3. lembretes 1d + 2h (sem nunca duplicar)
 *   4. o paciente SABENDO, com o card completo
 * E carimba `preferences._commit` — o que permite ao worker de integridade varrer o
 * que ficou pela metade e CONSERTAR sozinho, sem intervenção humana.
 */
import { db, writeLog, writeAudit, writeEvent } from '@iasaude/db';
import { sendOutbound } from './outbound.js';

/** De onde veio o fechamento — vai pro log/auditoria e distingue o determinístico do LLM. */
export type CommitSource =
  | 'clinic_tool'        // record_appointment_confirmation (o LLM chamou a tool)
  | 'clinic_detected'    // detector determinístico leu o fechamento no texto da recepção
  | 'patient_selection'  // o paciente escolheu e a clínica já havia ofertado
  | 'integrity_worker';  // varredura de reparo

export interface CommitAppointmentInput {
  consultationId: string;
  /** Horário fechado, em ISO. Nunca inventado — vem de tool, texto ou cotação. */
  confirmedIso: string;
  clinicId?: string | null;
  prescriberId?: string | null;
  /** Cotação que representa o slot, se já existe. */
  quoteId?: string | null;
  source: CommitSource;
  traceId: string;
  /** Observações da recepção (código de confirmação, instruções de chegada). */
  notes?: string | null;
  /** Trecho literal que provou o fechamento — só pra auditoria. */
  evidence?: string | null;
  /** `false` suprime a mensagem ao paciente (quando o chamador já vai falar com ele). */
  notifyPatient?: boolean;
}

export interface CommitAppointmentResult {
  ok: boolean;
  /** `true` quando a consulta já estava fechada nesse mesmo horário (nada a fazer). */
  alreadyCommitted: boolean;
  remindersCreated: number;
  patientNotified: boolean;
  reason?: string;
}

/** Lembretes que toda consulta futura precisa ter. */
const REMINDER_KINDS = [
  { kind: '1d_before', offsetMs: -24 * 3_600_000 },
  { kind: '2h_before', offsetMs: -2 * 3_600_000 },
] as const;

/**
 * Quão perto um lembrete existente tem que estar da âncora pra considerá-la COBERTA.
 *
 * Por que por PROXIMIDADE e não por `payload.kind` (achado ao verificar o deploy ao vivo,
 * 04/08): os lembretes que o MODELO cria via `create_reminder` têm
 * `payload = {"event_at": "..."}` — sem `consultation_id` e sem `kind`. A primeira versão
 * deste reconciliador só reconhecia os que ELE mesmo (ou o handler de confirmação) tinha
 * criado, então recriou o "amanhã" do Ciro ao lado do que o modelo já havia feito: ele
 * receberia DUAS mensagens iguais em 25/08, às 09h e às 10h.
 *
 * A pergunta certa não é "existe um lembrete com a minha etiqueta?", é "o paciente já vai
 * ser avisado por volta desta hora?". Proximidade responde isso independente de quem criou.
 */
export const ANCHOR_COVER_TOLERANCE_MS = 3 * 3_600_000;

/**
 * Quais âncoras de lembrete faltam pra uma consulta — considerando só as que AINDA cabem
 * no tempo, e tratando como coberta a âncora que já tem QUALQUER lembrete de consulta por
 * perto (venha ele de onde vier).
 *
 * A janela importa: numa consulta a 3h de distância o lembrete de 1 dia é impossível, e
 * cobrá-lo faria o vigilante "reparar" a mesma linha a cada 20 minutos, pra sempre.
 */
export function anchorsMissing(
  scheduledMs: number,
  nowMs: number,
  existingRunMs: number[],
  toleranceMs = ANCHOR_COVER_TOLERANCE_MS,
): string[] {
  const faltando: string[] = [];
  for (const { kind, offsetMs } of REMINDER_KINDS) {
    const alvo = scheduledMs + offsetMs;
    if (alvo <= nowMs) continue;
    const coberta = existingRunMs.some((t) => Number.isFinite(t) && Math.abs(t - alvo) <= toleranceMs);
    if (!coberta) faltando.push(kind);
  }
  return faltando;
}

function fmtBr(iso: string): string {
  try {
    const d = new Date(iso);
    const data = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${data} às ${hora}`;
  } catch {
    return iso;
  }
}

function fmtHora(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  } catch {
    return '';
  }
}

/**
 * Garante que os lembretes 1d/2h existam pra esta consulta. Idempotente.
 *
 * Só cria a âncora que ainda está no futuro e que NÃO existe. "Existe" inclui um
 * lembrete cancelado A PEDIDO DO PACIENTE (`payload.cancel_reason === 'patient_request'`)
 * — respeitar quem pediu pra não ser lembrado é mais importante que a invariante.
 * Cancelamento COLATERAL (o curinga do `cancel_reminders`) não conta como pedido, e é
 * exatamente por isso que esta função repara o lembrete que o Ciro perdeu.
 */
export async function reconcileAppointmentReminders(args: {
  consultationId: string;
  userId: string;
  specialty: string | null;
  scheduledIso: string;
  nowMs?: number;
  traceId: string;
}): Promise<{ created: number; skipped: string[] }> {
  const now = args.nowMs ?? Date.now();
  const alvo = Date.parse(args.scheduledIso);
  if (!Number.isFinite(alvo)) return { created: 0, skipped: ['scheduled_at inválido'] };

  const { data: existentes, error } = await db
    .from('reminders')
    .select('id, status, next_run_at, payload')
    .eq('user_id', args.userId)
    .eq('type', 'appointment');
  if (error) {
    await writeLog('error', 'consultation', `reconcile de lembrete: leitura falhou (${error.message.slice(0, 90)}) — NÃO criei nada pra não duplicar`, {
      traceId: args.traceId, consultationId: args.consultationId,
    });
    return { created: 0, skipped: ['leitura falhou'] };
  }

  const doMesmo = (existentes ?? []).filter((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return p['consultation_id'] === args.consultationId;
  });
  // Cobertura por PROXIMIDADE, sobre tudo que ainda vai disparar — inclusive lembrete que
  // o modelo criou via `create_reminder`, cujo payload não tem `consultation_id` nem `kind`.
  const jaAvisamPorPerto = (existentes ?? [])
    .filter((r) => r.status === 'pending' || r.status === 'sent')
    .map((r) => Date.parse(r.next_run_at as string))
    .filter((t) => Number.isFinite(t));
  const faltantes = new Set(anchorsMissing(alvo, now, jaAvisamPorPerto));

  const especialidade = args.specialty ?? 'consulta';
  let created = 0;
  const skipped: string[] = [];

  for (const { kind, offsetMs } of REMINDER_KINDS) {
    const quando = alvo + offsetMs;
    if (quando <= now) { skipped.push(`${kind}: âncora já passou`); continue; }
    if (!faltantes.has(kind)) { skipped.push(`${kind}: o paciente já é avisado por volta dessa hora`); continue; }

    const irmao = doMesmo.find((r) => ((r.payload ?? {}) as Record<string, unknown>)['kind'] === kind);
    if (irmao && irmao.status === 'cancelled') {
      const p = (irmao.payload ?? {}) as Record<string, unknown>;
      if (p['cancel_reason'] === 'patient_request') { skipped.push(`${kind}: paciente pediu pra cancelar`); continue; }
    }

    const iso = new Date(quando).toISOString();
    const { error: insErr } = await db.from('reminders').insert({
      user_id: args.userId,
      type: 'appointment',
      title: kind === '1d_before' ? `Consulta de ${especialidade} amanhã` : 'Consulta em 2 horas',
      body: kind === '1d_before'
        ? `Sua consulta de ${especialidade} é amanhã às ${fmtHora(args.scheduledIso)}. 💙`
        : `Sua consulta de ${especialidade} é hoje em 2 horas. Não esquece! 💙`,
      scheduled_at: iso,
      next_run_at: iso,
      status: 'pending',
      payload: { consultation_id: args.consultationId, kind, restored: Boolean(irmao) },
    });
    if (insErr) {
      await writeLog('error', 'consultation', `lembrete ${kind} de consulta NÃO criado: ${insErr.message.slice(0, 120)}`, {
        traceId: args.traceId, consultationId: args.consultationId,
      });
      skipped.push(`${kind}: insert falhou`);
      continue;
    }
    created += 1;
    if (irmao) {
      await writeLog('warn', 'consultation', `lembrete ${kind} de consulta RESTAURADO — existia cancelado sem pedido do paciente (cancelamento colateral)`, {
        traceId: args.traceId, consultationId: args.consultationId, reminderId: irmao.id,
      });
    }
  }

  // Consulta futura que não conseguiu NENHUMA âncora precisa ser visível: é uma
  // consulta sem nenhum aviso, e o silêncio aqui já custou uma no-show em potencial.
  if (created === 0 && skipped.every((s) => s.includes('já passou'))) {
    await writeLog('warn', 'consultation', 'consulta confirmada e NENHUM lembrete pôde ser criado — o horário está a menos de 2h', {
      traceId: args.traceId, consultationId: args.consultationId,
    });
  }
  return { created, skipped };
}

/**
 * Fecha a consulta: estado + cotação + lembretes + paciente avisado. Idempotente.
 *
 * Chamar duas vezes com o mesmo horário é seguro (devolve `alreadyCommitted`). Chamar
 * com horário DIFERENTE de um `scheduled` existente é reagendamento: atualiza e
 * reconcilia os lembretes pro horário novo.
 */
export async function commitAppointment(input: CommitAppointmentInput): Promise<CommitAppointmentResult> {
  const { consultationId, confirmedIso, traceId, source } = input;
  const nowMs = Date.now();

  const alvo = Date.parse(confirmedIso);
  if (!Number.isFinite(alvo)) {
    await writeLog('error', 'consultation', `commitAppointment recusado: horário inválido "${confirmedIso}"`, { traceId, consultationId });
    return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'horário inválido' };
  }
  // Fechar consulta no PASSADO corrompe métricas e dispara o worker de feedback
  // perguntando "como foi sua consulta?" sobre algo que nunca aconteceu.
  if (alvo < nowMs - 60_000) {
    await writeLog('warn', 'consultation', `commitAppointment recusado: horário no PASSADO (${confirmedIso}) — origem=${source}`, { traceId, consultationId });
    return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'horário no passado' };
  }

  const { data: c, error: cErr } = await db
    .from('consultations')
    .select('id, user_id, status, specialty, conversation_id, scheduled_at, preferences, selected_quote_id')
    .eq('id', consultationId)
    .maybeSingle();
  if (cErr || !c) {
    await writeLog('error', 'consultation', `commitAppointment: consulta não encontrada (${cErr?.message ?? 'sem linha'})`, { traceId, consultationId });
    return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'consulta não encontrada' };
  }
  if (c.status === 'cancelled') {
    await writeLog('warn', 'consultation', 'commitAppointment recusado: consulta CANCELADA — não se fecha o que o paciente desmarcou', { traceId, consultationId });
    return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'consulta cancelada' };
  }

  const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
  const commitAnterior = (prefs['_commit'] ?? null) as { at?: string; iso?: string; notified_at?: string } | null;
  const mesmoHorario = c.scheduled_at ? Math.abs(Date.parse(c.scheduled_at) - alvo) <= 60_000 : false;
  const jaFechada = c.status === 'scheduled' && mesmoHorario;

  // 1. Cotação que representa o slot. Contraproposta aceita pela clínica não tem
  //    cotação nenhuma — cria uma, senão o card do paciente sai sem preço/endereço e
  //    nada liga a consulta à clínica que a confirmou.
  let quoteId = input.quoteId ?? (c.selected_quote_id as string | null) ?? null;
  const clinicId = input.clinicId ?? null;
  if (!quoteId && clinicId) {
    const { data: irma } = await db
      .from('consultation_quotes')
      .select('id, price_brl, plan_accepted, payment_methods, modality, prescriber_id, conversation_id, notes')
      .eq('consultation_id', consultationId)
      .eq('clinic_id', clinicId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: nova, error: novaErr } = await db.from('consultation_quotes').insert({
      consultation_id: consultationId,
      clinic_id: clinicId,
      prescriber_id: input.prescriberId ?? irma?.prescriber_id ?? null,
      conversation_id: irma?.conversation_id ?? null,
      status: 'selected',
      proposed_datetime: new Date(alvo).toISOString(),
      // Herda o comercial da cotação irmã: o preço não muda porque o dia mudou.
      price_brl: irma?.price_brl ?? null,
      plan_accepted: irma?.plan_accepted ?? null,
      payment_methods: irma?.payment_methods ?? null,
      modality: irma?.modality ?? 'presencial',
      notes: [irma?.notes, input.notes, 'horário fechado fora da lista ofertada'].filter(Boolean).join(' · '),
      responded_at: new Date().toISOString(),
    }).select('id').single();
    if (novaErr) {
      await writeLog('error', 'consultation', `commitAppointment: não consegui criar cotação do slot fechado (${novaErr.message.slice(0, 100)})`, { traceId, consultationId });
    } else {
      quoteId = nova?.id ?? null;
      await writeLog('info', 'consultation', 'cotação criada pro horário fechado fora da lista ofertada (contraproposta aceita)', { traceId, consultationId, quoteId });
    }
  }

  // 2. Estado, por CAS. Nunca sobrescreve `cancelled`, nunca faz read-then-write no STATUS.
  if (!jaFechada) {
    // ⚠️ `preferences` é JSONB e a gravação é merge-em-memória — então relê AGORA, e não
    // o snapshot do topo: entre as duas leituras rodaram os roundtrips de criação de
    // cotação, e `consolidateConsultationQuotes` escreve `_consolidated_summary` no mesmo
    // objeto. Reler encurta a janela de perda pro mínimo possível sem um merge no
    // servidor (que exigiria migration).
    const { data: prefsFresh } = await db.from('consultations').select('preferences').eq('id', consultationId).maybeSingle();
    const prefsAgora = (prefsFresh?.preferences as Record<string, unknown> | null) ?? prefs;
    const { data: mudou, error: upErr } = await db
      .from('consultations')
      .update({
        status: 'scheduled',
        scheduled_at: new Date(alvo).toISOString(),
        ...(clinicId ? { scheduled_clinic_id: clinicId } : {}),
        ...(input.prescriberId ? { scheduled_prescriber_id: input.prescriberId } : {}),
        ...(quoteId ? { selected_quote_id: quoteId } : {}),
        preferences: {
          ...prefsAgora,
          _commit: {
            ...(commitAnterior ?? {}),
            at: new Date().toISOString(),
            iso: new Date(alvo).toISOString(),
            source,
            ...(input.evidence ? { evidence: input.evidence.slice(0, 200) } : {}),
          },
        },
      })
      .eq('id', consultationId)
      .not('status', 'in', '(cancelled,completed)')
      .select('id');
    if (upErr) {
      await writeLog('error', 'consultation', `commitAppointment: CAS falhou (${upErr.message.slice(0, 120)})`, { traceId, consultationId });
      return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'falha ao gravar' };
    }
    if (!mudou || mudou.length === 0) {
      await writeLog('warn', 'consultation', 'commitAppointment: CAS não pegou nenhuma linha — consulta já terminal', { traceId, consultationId });
      return { ok: false, alreadyCommitted: false, remindersCreated: 0, patientNotified: false, reason: 'consulta terminal' };
    }
    if (quoteId) {
      await db.from('consultation_quotes').update({ status: 'selected', proposed_datetime: new Date(alvo).toISOString() }).eq('id', quoteId);
      await db.from('consultation_quotes')
        .update({ status: 'rejected' })
        .eq('consultation_id', consultationId)
        .neq('id', quoteId)
        .in('status', ['pending', 'offered']);
    }
  }

  // 3. Lembretes. Roda SEMPRE (mesmo em `alreadyCommitted`): é o que repara uma
  //    consulta que ficou sem aviso — inclusive uma fechada antes deste código existir.
  const rec = await reconcileAppointmentReminders({
    consultationId,
    userId: c.user_id as string,
    specialty: (c.specialty as string | null) ?? null,
    scheduledIso: new Date(alvo).toISOString(),
    nowMs,
    traceId,
  });

  // 4. O paciente tem que SABER. Um `scheduled` que ele não conhece é pior que
  //    nenhum: ele não aparece e a clínica guardou a vaga.
  let patientNotified = Boolean(commitAnterior?.notified_at);
  const querAvisar = input.notifyPatient !== false;
  if (querAvisar && !patientNotified) {
    patientNotified = await notifyPatientCommitted({
      consultation: c as Record<string, unknown>,
      quoteId,
      scheduledIso: new Date(alvo).toISOString(),
      remindersCreated: rec.created,
      traceId,
    });
    if (patientNotified) {
      const { data: fresh } = await db.from('consultations').select('preferences').eq('id', consultationId).maybeSingle();
      const p = (fresh?.preferences as Record<string, unknown> | null) ?? {};
      const cm = (p['_commit'] ?? {}) as Record<string, unknown>;
      await db.from('consultations')
        .update({ preferences: { ...p, _commit: { ...cm, notified_at: new Date().toISOString() } } })
        .eq('id', consultationId);
    }
  }

  await writeAudit({
    actorType: source === 'patient_selection' ? 'xarlote' : 'agent_clinic',
    action: 'consultation.scheduled',
    userId: c.user_id as string,
    targetTable: 'consultations',
    targetId: consultationId,
    conversationId: (c.conversation_id as string | null) ?? undefined,
    traceId,
    metadata: {
      confirmed_datetime: new Date(alvo).toISOString(),
      source,
      already_committed: jaFechada,
      reminders_created: rec.created,
      patient_notified: patientNotified,
      evidence: input.evidence?.slice(0, 160) ?? null,
    },
  });
  await writeEvent({
    eventName: 'consultation.committed',
    userId: c.user_id as string,
    payload: {
      consultation_id: consultationId,
      source,
      reminders_created: rec.created,
      patient_notified: patientNotified,
      already_committed: jaFechada,
    },
  }).catch(() => {});

  await writeLog('info', 'consultation', `✅ consulta FECHADA (${source}) — ${fmtBr(new Date(alvo).toISOString())} · lembretes criados: ${rec.created} · paciente avisado: ${patientNotified ? 'sim' : 'NÃO'}`, {
    traceId, consultationId, quoteId, source, skipped: rec.skipped,
  });

  return { ok: true, alreadyCommitted: jaFechada, remindersCreated: rec.created, patientNotified };
}

/** Manda o card completo pro paciente. Devolve se realmente saiu. */
async function notifyPatientCommitted(args: {
  consultation: Record<string, unknown>;
  quoteId: string | null;
  scheduledIso: string;
  remindersCreated: number;
  traceId: string;
}): Promise<boolean> {
  const convId = args.consultation['conversation_id'] as string | null;
  if (!convId) {
    await writeLog('warn', 'consultation', 'consulta fechada mas sem conversation_id — paciente NÃO avisado', { traceId: args.traceId });
    return false;
  }
  const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', convId).maybeSingle();
  const tel = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!tel) {
    await writeLog('warn', 'consultation', 'consulta fechada mas sem telefone do paciente — NÃO avisado', { traceId: args.traceId });
    return false;
  }

  const { data: u } = await db.from('users').select('preferred_name, full_name').eq('id', args.consultation['user_id'] as string).maybeSingle();
  const nome = String(u?.preferred_name || u?.full_name || '').split(/\s+/)[0] ?? '';

  let clinica: string | null = null;
  let endereco: string | null = null;
  let medico: string | null = null;
  let preco: number | null = null;
  let pagamentos: string[] | null = null;
  if (args.quoteId) {
    const { data: q } = await db
      .from('consultation_quotes')
      .select('price_brl, payment_methods, clinics(name, address), prescribers(name)')
      .eq('id', args.quoteId)
      .maybeSingle();
    clinica = ((q?.clinics as { name?: string } | null)?.name) ?? null;
    endereco = ((q?.clinics as { address?: string } | null)?.address) ?? null;
    medico = ((q?.prescribers as { name?: string } | null)?.name) ?? null;
    preco = (q?.price_brl as number | null) ?? null;
    pagamentos = (q?.payment_methods as string[] | null) ?? null;
  }

  const especialidade = (args.consultation['specialty'] as string | null) ?? 'consulta';
  const linhas = [
    `Confirmado${nome ? `, ${nome}` : ''}! 🎉`,
    '',
    `🩺 Consulta${medico ? ` com ${medico}` : ''}${especialidade ? ` (${especialidade})` : ''}`,
    `📅 ${fmtBr(args.scheduledIso)}`,
  ];
  if (endereco || clinica) linhas.push(`📍 ${[endereco, clinica].filter(Boolean).join(' · ')}`);
  if (preco != null) {
    const formas = pagamentos && pagamentos.length > 0 ? ` (${pagamentos.join(', ')})` : '';
    linhas.push(`💰 R$ ${preco.toFixed(2).replace('.', ',')}${formas}`);
  }
  if (args.remindersCreated > 0) {
    linhas.push('', `Já deixei ${args.remindersCreated === 1 ? 'o lembrete pronto' : 'os lembretes prontos'} pra você não esquecer 💙`);
  }

  return sendOutbound(convId, `+${tel}`, linhas.join('\n'), args.traceId, {}, { dedup: true, dedupWindowMs: 5 * 60_000 });
}
