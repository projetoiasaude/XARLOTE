/**
 * Inventory tracker — detecta medicamentos cujo estoque vai acabar em <=7 dias
 * e cria assistant_tasks pra Xarlote oferecer reposição proativamente.
 *
 * Roda como `setInterval` a cada 6h (4x ao dia). Idempotente: cada inventory
 * só vira `reorder_offered_at` uma vez. Cron de fato ficaria mais robusto, mas
 * setInterval em single-process é OK até ~500 users.
 */
import { db, writeLog, writeAudit } from '@iasaude/db';
import { sendOutbound } from '../handlers/outbound.js';

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const THRESHOLD_DAYS = 7;

interface RunningLowRow {
  inventory_id: string;
  user_id: string;
  medication_id: string;
  medication_name: string;
  dosage: string | null;
  tablets_remaining: number;
  daily_consumption: number;
  days_remaining: number;
  user_phone: string;
  user_name: string | null;
}

async function runOnce(): Promise<void> {
  try {
    const { data, error } = await db.rpc('medications_running_low', {
      p_days_threshold: THRESHOLD_DAYS,
    });

    if (error) {
      // RPC pode não existir (migration pendente) — log e silencia
      if (error.message?.includes('does not exist')) {
        return;
      }
      await writeLog('warn', 'inventory', `medications_running_low RPC falhou: ${error.message}`, {});
      return;
    }

    const rows = (data as RunningLowRow[]) ?? [];
    if (rows.length === 0) return;

    await writeLog('info', 'inventory', `inventory-tracker achou ${rows.length} med(s) acabando`, {});

    for (const row of rows) {
      try {
        // Acha conversa ativa do user (a Xarlote envia direto via outbound)
        const { data: conv } = await db
          .from('conversations')
          .select('id')
          .eq('user_id', row.user_id)
          .eq('party_type', 'user')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();

        if (!conv?.id) {
          await writeLog('warn', 'inventory', `user ${row.user_id} sem conversa pra notificar`, {});
          // Marca offered mesmo assim pra não repetir
          await db.from('medication_inventory')
            .update({ reorder_offered_at: new Date().toISOString() })
            .eq('id', row.inventory_id);
          continue;
        }

        const greeting = row.user_name ? `, ${row.user_name}` : '';
        const dose = row.dosage ? ` ${row.dosage}` : '';
        const days = Math.floor(row.days_remaining);
        const msg = `Oi${greeting}! Vi que sua **${row.medication_name}${dose}** está acabando — restam uns ${days} dia(s). Quer que eu já cote pra repor 1 caixa?`;

        await sendOutbound(conv.id, row.user_phone, msg, crypto.randomUUID());

        // Marca offered
        await db.from('medication_inventory')
          .update({ reorder_offered_at: new Date().toISOString() })
          .eq('id', row.inventory_id);

        await writeAudit({
          actorType: 'system',
          actorId: 'inventory-tracker',
          action: 'medication.inventory.running_low',
          userId: row.user_id,
          targetTable: 'medication_inventory',
          targetId: row.inventory_id,
          reason: 'proactive_reorder_offer',
          metadata: {
            medication_name: row.medication_name,
            dosage: row.dosage,
            days_remaining: row.days_remaining,
            tablets_remaining: row.tablets_remaining,
          },
        });
      } catch (err) {
        await writeLog('error', 'inventory', `falha pra notificar user ${row.user_id}: ${String(err).slice(0, 240)}`, {});
      }
    }
  } catch (err) {
    await writeLog('error', 'inventory', `inventory-tracker run falhou: ${String(err).slice(0, 240)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startInventoryTrackerWorker(): void {
  if (interval) return;
  // Roda 1ª vez após 5 minutos (não atropela startup) e depois a cada POLL_INTERVAL
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 5 * 60 * 1000);
  void writeLog('info', 'inventory', 'inventory-tracker worker iniciado (cada 6h)', {});
}

export function stopInventoryTrackerWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
