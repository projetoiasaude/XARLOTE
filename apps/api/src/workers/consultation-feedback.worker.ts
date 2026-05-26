/**
 * consultation-feedback worker — detecta consultas que JÁ aconteceram (status=
 * 'scheduled' e scheduled_at < now() - 24h) e pede ao paciente um rating + comentário.
 *
 * Fluxo:
 *   1. Roda 1x/h
 *   2. Acha consultations.scheduled_at < now() - 24h AND status='scheduled'
 *      AND user_rating IS NULL (não pediu feedback ainda)
 *   3. Muda status pra 'completed' provisoriamente
 *   4. Envia mensagem da Xarlote: "Como foi sua consulta? De 1 a 5..."
 *   5. Marca feedback_requested_at no preferences (pra não repetir)
 *
 * O rating + comentário do paciente chegam via inbound-user — quando a Xarlote
 * detectar a resposta, chama uma tool específica que atualiza
 * consultations.user_rating + user_feedback. (Tool fica pra próxima sprint —
 * por enquanto a Xarlote vai usar update livre via prompt rule.)
 */
import { db, writeLog, writeAudit } from '@iasaude/db';
import { sendOutbound } from '../handlers/outbound.js';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h
const FEEDBACK_DELAY_HOURS = 24; // pede feedback 24h após consulta

async function runOnce(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - FEEDBACK_DELAY_HOURS * 3600 * 1000).toISOString();

    const { data, error } = await db
      .from('consultations')
      .select('id, user_id, conversation_id, specialty, scheduled_clinic_id, scheduled_at, preferences')
      .eq('status', 'scheduled')
      .is('user_rating', null)
      .lt('scheduled_at', cutoff)
      .limit(50);

    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'consultation-feedback', `query falhou: ${error.message}`, {});
      return;
    }

    const rows = data ?? [];
    if (rows.length === 0) return;

    await writeLog('info', 'consultation-feedback', `${rows.length} consulta(s) elegíveis pra feedback`, {});

    for (const row of rows) {
      try {
        // Idempotência via preferences._feedback_asked_at
        const prefs = (row.preferences as Record<string, unknown> | null) ?? {};
        if (prefs['_feedback_asked_at']) continue;

        // Acha conversa do user
        if (!row.conversation_id) continue;
        const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', row.conversation_id).single();
        const userPhone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
        if (!userPhone) continue;

        // Acha nome da clínica
        let clinicName = 'a clínica';
        if (row.scheduled_clinic_id) {
          const { data: clinic } = await db.from('clinics').select('name').eq('id', row.scheduled_clinic_id).single();
          if (clinic?.name) clinicName = clinic.name;
        }

        const msg = `Oi! Vi que sua consulta de ${row.specialty} foi ontem 💙\n\nQuero saber como foi pra você — de 1 a 5, quão satisfeito(a) ficou com ${clinicName}? Se quiser comentar algo, fico atenta.\n\nSeu feedback ajuda eu aprender e te recomendar melhor da próxima vez.`;

        await sendOutbound(row.conversation_id, `+${userPhone}`, msg, crypto.randomUUID());

        // Mover status pra completed + marca _feedback_asked_at
        await db.from('consultations').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          preferences: { ...prefs, _feedback_asked_at: new Date().toISOString() },
        }).eq('id', row.id);

        await writeAudit({
          actorType: 'system',
          actorId: 'consultation-feedback',
          action: 'consultation.feedback_requested',
          userId: row.user_id,
          targetTable: 'consultations',
          targetId: row.id,
          metadata: { clinic: clinicName, specialty: row.specialty },
        });

        await writeLog('info', 'consultation-feedback', `Feedback solicitado pra consulta ${row.id}`, {});
      } catch (err) {
        await writeLog('warn', 'consultation-feedback', `falha pra consulta ${row.id}: ${String(err).slice(0, 200)}`, {});
      }
    }
  } catch (err) {
    await writeLog('error', 'consultation-feedback', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startConsultationFeedbackWorker(): void {
  if (interval) return;
  // Roda 1ª vez após 15min do boot
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 15 * 60 * 1000);
  void writeLog('info', 'consultation-feedback', 'consultation-feedback worker iniciado (1x/h)', {});
}

export function stopConsultationFeedbackWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
