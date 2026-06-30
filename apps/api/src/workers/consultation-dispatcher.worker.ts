/**
 * consultation-dispatcher — rede de segurança pro fluxo de consulta.
 *
 * O caminho normal dispara `initiateClinicNegotiation` via setTimeout logo após
 * criar as consultation_quotes. Mas setTimeout in-process MORRE se o processo
 * reinicia (deploy, crash) — deixando quotes órfãs (status='pending',
 * conversation_id=NULL) que nunca viram contato.
 *
 * Este worker roda a cada 30s e RESGATA essas órfãs:
 *   - pega quotes pending, sem conversation_id, de consultations 'searching'
 *   - criadas há > 60s (dá tempo do caminho normal rodar primeiro — evita duplicar)
 *   - reconstrói o contexto do banco e chama initiateClinicNegotiation
 *
 * Idempotência: initiateClinicNegotiation seta conversation_id logo no início,
 * então uma quote resgatada sai da fila e não é processada 2x.
 */
import { db, writeLog } from '@iasaude/db';
import { initiateClinicNegotiation } from '../handlers/agent-clinic.js';
import { scheduleConsultationTimeout, rescueStalledConsultations } from '../handlers/consultation-consolidation.js';
import { rescueOrphanedPharmacyQuotes } from '../handlers/quote-consolidation.js';
import { withCronLock } from '../middleware/cron-lock.js';

const POLL_INTERVAL_MS = 30 * 1000; // 30s
const MIN_AGE_MS = 60 * 1000;       // só resgata órfãs com > 60s (evita corrida com setTimeout)
const MAX_AGE_MS = 60 * 60 * 1000;  // ignora quotes velhas > 1h (consulta abandonada)

async function runOnce(): Promise<void> {
  // F1.A3: resgate durável de cotações de FARMÁCIA órfãs (independente da lógica
  // de clínica abaixo, que tem early-returns). Idempotente.
  await rescueOrphanedPharmacyQuotes();

  // Fase 4: resgate durável de CONSULTAS presas em 'searching' (timers in-process
  // que morreram OU consolidação adiada pelo gate de clarificação que não re-disparou).
  // Idempotente: consolidateConsultationQuotes faz transição atômica + re-checa o gate.
  await rescueStalledConsultations();

  try {
    const now = Date.now();
    const olderThan = new Date(now - MIN_AGE_MS).toISOString();
    const newerThan = new Date(now - MAX_AGE_MS).toISOString();

    // Quotes órfãs: pending, sem conversa, dentro da janela
    const { data: orphans, error } = await db
      .from('consultation_quotes')
      .select('id, consultation_id, clinic_id, created_at')
      .eq('status', 'pending')
      .is('conversation_id', null)
      .lt('created_at', olderThan)
      .gt('created_at', newerThan)
      .limit(50);

    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'consultation-dispatcher', `query órfãs falhou: ${error.message}`, {});
      return;
    }
    if (!orphans || orphans.length === 0) return;

    // Agrupa por consultation pra reconstruir contexto uma vez por consulta
    const byConsultation = new Map<string, typeof orphans>();
    for (const o of orphans) {
      const arr = byConsultation.get(o.consultation_id) ?? [];
      arr.push(o);
      byConsultation.set(o.consultation_id, arr);
    }

    let resgatadas = 0;

    for (const [consultationId, quotes] of byConsultation) {
      // Carrega consultation + user + conversa do paciente
      const { data: c } = await db
        .from('consultations')
        .select('id, status, specialty, urgency, modality, city, preferences, user_id, conversation_id')
        .eq('id', consultationId)
        .single();

      // Só resgata se ainda está buscando
      if (!c || c.status !== 'searching') continue;
      if (!c.conversation_id) continue;

      // Telefone do paciente + nome
      const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', c.conversation_id).single();
      const userPhone = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
      if (!userPhone) continue;
      const userPhoneE164 = `+${userPhone}`;

      const { data: u } = await db.from('users').select('preferred_name, full_name').eq('id', c.user_id).single();
      const patientName = (u?.preferred_name || u?.full_name)?.split(/\s+/)[0] ?? null;

      const prefs = (c.preferences as Record<string, unknown> | null) ?? {};

      for (const q of quotes) {
        // Carrega clínica
        const { data: clinic } = await db
          .from('clinics')
          .select('id, name, whatsapp_e164, phone_e164')
          .eq('id', q.clinic_id)
          .single();
        const channel = clinic?.whatsapp_e164 || clinic?.phone_e164;
        if (!clinic || !channel) {
          // Sem canal — marca como unavailable pra não ficar presa
          await db.from('consultation_quotes').update({ status: 'unavailable', notes: 'sem canal de contato' }).eq('id', q.id);
          continue;
        }

        try {
          await initiateClinicNegotiation({
            quoteId: q.id,
            consultationId: c.id,
            clinicId: clinic.id,
            clinicName: clinic.name,
            clinicWhatsApp: channel,
            ctx: {
              specialty: c.specialty,
              urgency: c.urgency as 'rotina' | '72h' | '24h' | 'urgente',
              modality: (c.modality as 'presencial' | 'telemedicina' | 'indiferente') ?? 'indiferente',
              patientCity: c.city,
              plan: (prefs['plan'] as string) ?? null,
              patientName,
              preferredTime: (prefs['horario_pref'] as string) ?? null,
            },
            userConversationId: c.conversation_id,
            userPhoneE164,
            traceId: `dispatcher-${q.id.slice(0, 8)}`,
          });
          resgatadas++;
        } catch (err) {
          await writeLog('error', 'consultation-dispatcher', `resgate quote ${q.id} falhou: ${String(err).slice(0, 160)}`, {});
        }
      }

      // Garante que o timer de consolidação está agendado (idempotente)
      scheduleConsultationTimeout(c.id, c.conversation_id, userPhoneE164, `dispatcher-${c.id.slice(0, 8)}`);
    }

    if (resgatadas > 0) {
      await writeLog('info', 'consultation-dispatcher', `resgatou ${resgatadas} cotação(ões) órfã(s)`, {});
    }
  } catch (err) {
    await writeLog('error', 'consultation-dispatcher', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startConsultationDispatcherWorker(): void {
  if (interval) return;
  // 1ª run após 45s (deixa o boot estabilizar)
  setTimeout(() => {
    void withCronLock('consultation-dispatcher', POLL_INTERVAL_MS, runOnce);
    interval = setInterval(() => void withCronLock('consultation-dispatcher', POLL_INTERVAL_MS, runOnce), POLL_INTERVAL_MS);
  }, 45 * 1000);
  void writeLog('info', 'consultation-dispatcher', 'consultation-dispatcher worker iniciado (cada 30s)', {});
}

export function stopConsultationDispatcherWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
