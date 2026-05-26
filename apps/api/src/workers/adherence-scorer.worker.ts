/**
 * Adherence scorer — calcula adherence_score_30d pra cada user ativo,
 * grava em users.adherence_score_30d, e detecta drops bruscos (>20%) pra
 * disparar atenção da Xarlote no próximo turno.
 *
 * Roda 1x/dia (23h BRT).
 */
import { db, writeLog, writeAudit } from '@iasaude/db';

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 dia
const DROP_THRESHOLD = 0.2;                   // 20% queda

async function runOnce(): Promise<void> {
  try {
    // Pega users ativos com pelo menos 1 medication_log nas últimas 30 dias
    const { data: usersWithLogs, error } = await db
      .from('medication_log')
      .select('user_id')
      .gte('scheduled_at', new Date(Date.now() - 30 * 86400_000).toISOString())
      .limit(5000);

    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'adherence', `query users falhou: ${error.message}`, {});
      return;
    }

    const userIds = Array.from(new Set((usersWithLogs ?? []).map((r) => r.user_id)));
    let computed = 0;
    let drops = 0;

    for (const userId of userIds) {
      try {
        // RPC calc_adherence_score
        const { data: score } = await db.rpc('calc_adherence_score', {
          p_user_id: userId,
          p_days: 30,
        });

        if (score == null) continue;
        const newScore = typeof score === 'number' ? score : parseFloat(score as string);

        // Pega score anterior pra detectar queda
        const { data: u } = await db
          .from('users').select('adherence_score_30d').eq('id', userId).single();

        const prevScore = (u?.adherence_score_30d as number | null) ?? null;
        const dropped = prevScore != null && (prevScore - newScore) > DROP_THRESHOLD;

        await db.from('users').update({ adherence_score_30d: newScore }).eq('id', userId);
        computed++;

        if (dropped) {
          drops++;
          await writeAudit({
            actorType: 'system',
            actorId: 'adherence-scorer',
            action: 'adherence.dropped',
            userId,
            targetTable: 'users',
            targetId: userId,
            before: { adherence_score_30d: prevScore },
            after: { adherence_score_30d: newScore },
            reason: `score caiu ${((prevScore - newScore) * 100).toFixed(1)}%`,
            metadata: { drop_percentage: (prevScore - newScore) },
          });
        }
      } catch (err) {
        await writeLog('warn', 'adherence', `user ${userId} score falhou: ${String(err).slice(0, 120)}`, {});
      }
    }

    await writeLog('info', 'adherence', `adherence-scorer: ${computed} score(s) calculados, ${drops} drop(s)`, {});
  } catch (err) {
    await writeLog('error', 'adherence', `adherence-scorer crashed: ${String(err).slice(0, 240)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startAdherenceScorerWorker(): void {
  if (interval) return;
  // Roda 1ª vez após 10 minutos do boot
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 10 * 60 * 1000);
  void writeLog('info', 'adherence', 'adherence-scorer worker iniciado (1x/dia)', {});
}

export function stopAdherenceScorerWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
