/**
 * Bootstrap de TODOS os workers de background (F1.A1).
 *
 * Fonte ÚNICA de verdade de "o que roda em background". Importado por server.ts
 * quando ROLE inclui 'worker':
 *   - ROLE=all    (default) → API + workers no MESMO processo (dev / single-box)
 *   - ROLE=api               → só HTTP (service "api" no Railway)
 *   - ROLE=worker            → só isto (service "worker" dedicado no Railway)
 *
 * Por que separar: rodar os 12 workers DENTRO do processo HTTP significa que um
 * vazamento/loop em qualquer cron derruba o inbound do WhatsApp inteiro (foi a
 * causa-raiz da queda de 02/06). Em service separado, crash de worker não deixa
 * a Xarlote muda — e cada lado escala/reinicia independente.
 *
 * NÃO mexe nos PRODUTORES de fila (dispatchOutbound, enqueue do enricher): esses
 * vivem no processo da API (quem produz é quem recebe o webhook). Aqui ficam só
 * os CONSUMIDORES (outbound workers, profile-enricher) e os crons.
 */
import { dispatchReminders } from './reminder-dispatcher.worker.js';
import { startProfileEnricherWorker } from './profile-enricher.worker.js';
import { compactStaleConversations } from './conversation-compactor.worker.js';
import { startInventoryTrackerWorker } from './inventory-tracker.worker.js';
import { startAdherenceScorerWorker } from './adherence-scorer.worker.js';
import { startConsultationFeedbackWorker } from './consultation-feedback.worker.js';
import { startConsultationDispatcherWorker } from './consultation-dispatcher.worker.js';
import { startKnowledgeGraphBuilderWorker } from './knowledge-graph-builder.worker.js';
import { startSkillExtractorWorker } from './skill-extractor.worker.js';
import { startAnomalyDetectorWorker } from './anomaly-detector.worker.js';
import { startMetricsAggregatorWorker } from './metrics-aggregator.worker.js';
import { startRedFlagEscalatorWorker } from './red-flag-escalator.worker.js';
import { startOutboundWorkers } from '../queues/outbound.queue.js';
import { onShutdown } from '../lifecycle.js';
import { withCronLock } from '../middleware/cron-lock.js';

/** Logger mínimo (compatível com app.log do Fastify e com console). */
export interface WorkerLogger {
  info: (msg: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

let started = false;

/**
 * Sobe todos os workers e registra seus disposers de graceful shutdown (F1.A5).
 * Guarda de idempotência: chamar 2x é no-op (evita duplicar crons).
 */
export function startAllWorkers(log: WorkerLogger): void {
  if (started) {
    log.info('startAllWorkers ignorado (já iniciado)');
    return;
  }
  started = true;

  // ── Crons com setInterval cujo timer precisamos limpar no shutdown ──
  // F1.A2: envolvidos em withCronLock — com N réplicas, só uma roda cada janela
  // (reminder duplicado = WhatsApp duplicado; compactor duplicado = cards repetidos).
  const REMINDER_MS = 30_000;
  const COMPACTOR_MS = 60 * 60 * 1000;
  const reminderTimer = setInterval(
    () => withCronLock('reminder-dispatcher', REMINDER_MS, dispatchReminders).catch((e) => log.error(e, 'reminder dispatch failed')),
    REMINDER_MS,
  );
  withCronLock('reminder-dispatcher', REMINDER_MS, dispatchReminders).catch((e) => log.error(e, 'reminder dispatch initial failed'));

  const enricherWorker = startProfileEnricherWorker();

  const compactorTimer = setInterval(
    () => withCronLock('conversation-compactor', COMPACTOR_MS, compactStaleConversations).catch((e) => log.error(e, 'compactor failed')),
    COMPACTOR_MS,
  );

  // ── Crons auto-contidos (setInterval interno; scans idempotentes — perder um
  //    tick num redeploy é inofensivo, re-rodam no próximo intervalo) ──
  startInventoryTrackerWorker();
  startAdherenceScorerWorker();
  startConsultationFeedbackWorker();
  startConsultationDispatcherWorker();
  startKnowledgeGraphBuilderWorker();
  startSkillExtractorWorker();
  startAnomalyDetectorWorker();
  startMetricsAggregatorWorker();
  startRedFlagEscalatorWorker();

  // ── Consumidores das filas outbound (rate-limit de envio WhatsApp, F0.7) ──
  startOutboundWorkers();

  // ── Disposers específicos dos workers (na ordem de registro) ──
  onShutdown('cron intervals', () => {
    clearInterval(reminderTimer);
    clearInterval(compactorTimer);
  });
  onShutdown('profile-enricher worker', () => enricherWorker.close());

  log.info(
    'Workers ON: reminder-dispatcher (30s), profile-enricher (queue), conversation-compactor (1h), ' +
      'inventory-tracker (6h), adherence-scorer (24h), consultation-feedback (1h), consultation-dispatcher (30s), ' +
      'kg-builder (6h), skill-extractor (24h), anomaly-detector (10min), metrics-aggregator (1h), ' +
      'red-flag-escalator (10s), outbound-whatsapp (queue)',
  );
}
