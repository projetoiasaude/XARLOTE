import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';

export function getRedisConnection(): ConnectionOptions {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  return { url };
}

export function createQueue(name: string): Queue {
  return new Queue(name, { connection: getRedisConnection() });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorker(name: string, processor: Processor<any, any, string>, concurrency = 5): Worker {
  return new Worker(name, processor, {
    connection: getRedisConnection(),
    concurrency,
  });
}

// Export queue instances
export const queues = {
  inboundUser: createQueue(QUEUE_NAMES.INBOUND_USER),
  outboundSara: createQueue(QUEUE_NAMES.OUTBOUND_SARA),
  outboundAgent: createQueue(QUEUE_NAMES.OUTBOUND_AGENT),
  pharmacyDiscovery: createQueue(QUEUE_NAMES.PHARMACY_DISCOVERY),
  pharmacyNegotiation: createQueue(QUEUE_NAMES.PHARMACY_NEGOTIATION),
  quoteConsolidation: createQueue(QUEUE_NAMES.QUOTE_CONSOLIDATION),
  reminderDispatcher: createQueue(QUEUE_NAMES.REMINDER_DISPATCHER),
  profileEnricher: createQueue(QUEUE_NAMES.PROFILE_ENRICHER),
};
