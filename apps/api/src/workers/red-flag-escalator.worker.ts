/**
 * red-flag-escalator — worker DURÁVEL que escalona red flags não respondidos.
 *
 * Substitui o setTimeout em memória que existia no red-flag-handler (perdia o
 * escalonamento se o processo reiniciasse nos 60s críticos — risco de vida).
 *
 * A cada 10s varre `red_flag_pending` com status='pending' e expires_at < now.
 * Pra cada linha, faz um CLAIM ATÔMICO (update pending→escalated condicionado a
 * status='pending') — só um worker ganha a linha, mesmo com N réplicas. Então
 * chama `escalatePending` pra avisar o contato de emergência + o paciente.
 *
 * Usa o índice parcial `red_flag_pending_expires_idx (expires_at) WHERE status='pending'`.
 */
import { db, writeLog } from '@iasaude/db';
import { escalatePending, type RedFlagPendingRow } from '../handlers/red-flag-handler.js';

const POLL_MS = 10_000;

async function sweep(): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db
    .from('red_flag_pending')
    .select('id')
    .eq('status', 'pending')
    .lt('expires_at', nowIso)
    .limit(20);

  if (error || !due || due.length === 0) return;

  for (const { id } of due as Array<{ id: string }>) {
    // Claim atômico: só escala quem conseguir virar 'pending' → 'escalated'.
    const { data: claimed } = await db
      .from('red_flag_pending')
      .update({ status: 'escalated', escalated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id, user_id, conversation_id, category, severity, evidence, trace_id')
      .maybeSingle();

    if (!claimed) continue; // outra réplica/clique do paciente já tratou

    try {
      await escalatePending(claimed as RedFlagPendingRow);
    } catch (err) {
      await writeLog('error', 'red_flag', `escalatePending falhou para ${id}: ${String(err).slice(0, 200)}`, { pendingId: id });
    }
  }
}

export function startRedFlagEscalatorWorker(): void {
  setInterval(() => {
    sweep().catch((e) => writeLog('error', 'red_flag', `red-flag-escalator sweep falhou: ${String(e).slice(0, 200)}`, {}));
  }, POLL_MS);
  // Primeira varredura logo após o boot — resgata pendências órfãs de um restart.
  setTimeout(() => { sweep().catch(() => { /* logado no próximo tick */ }); }, 5_000);
}
