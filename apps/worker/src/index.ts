import 'dotenv/config';
import { dispatchReminders } from './workers/reminder-dispatcher.worker.js';

console.log('🔧 Worker starting…');
console.log(`   WhatsApp mode: ${process.env['WHATSAPP_MODE'] ?? 'uazapi'}`);
console.log(`   Redis: ${process.env['REDIS_URL'] ?? 'redis://localhost:6379'}`);

// Reminder dispatcher — runs every 30s
setInterval(() => dispatchReminders().catch(console.error), 30_000);
dispatchReminders().catch(console.error);

console.log('✅ Workers active\n');

process.on('SIGTERM', () => { console.log('Worker shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('Worker shutting down'); process.exit(0); });
