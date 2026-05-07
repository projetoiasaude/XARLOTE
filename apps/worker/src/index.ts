import 'dotenv/config';
import { dispatchReminders } from './workers/reminder-dispatcher.worker.js';
import { startProfileEnricherWorker } from './workers/profile-enricher.worker.js';
import { compactStaleConversations } from './workers/conversation-compactor.worker.js';

console.log('🔧 Worker starting…');
console.log(`   WhatsApp mode: ${process.env['WHATSAPP_MODE'] ?? 'uazapi'}`);
console.log(`   Redis: ${process.env['REDIS_URL'] ?? 'redis://localhost:6379'}`);

// Reminder dispatcher — runs every 30s
setInterval(() => dispatchReminders().catch(console.error), 30_000);
dispatchReminders().catch(console.error);

// Profile enricher — consome a queue PROFILE_ENRICHER (BullMQ), 2 jobs em paralelo
const enricherWorker = startProfileEnricherWorker();
console.log('   Profile enricher: ON');

// Conversation compactor — roda a cada 1h, condensa conversas longas em memory cards
setInterval(() => compactStaleConversations().catch(console.error), 60 * 60 * 1000);
console.log('   Conversation compactor: 1h interval');

console.log('✅ Workers active\n');

async function shutdown() {
  console.log('Worker shutting down');
  try { await enricherWorker.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
