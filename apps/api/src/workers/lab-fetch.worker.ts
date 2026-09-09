/**
 * Worker da busca de exames — abre o Chromium, um job por vez.
 *
 * ─── PRONTIDÃO É PROVADA, NÃO DECLARADA ──────────────────────────────────────
 * Antes de escutar a fila, o worker ABRE E FECHA um Chromium de verdade. Se conseguir,
 * grava `lab-fetch:ready` no Redis (com TTL) e renova a cada minuto. A API só oferece a
 * tool `fetch_lab_results` ao modelo quando essa chave existe — então "a Xarlote consegue
 * buscar seu exame" só é dito a um paciente quando um worker acabou de provar que consegue
 * abrir um navegador. Sem isso, um container sem Chromium deixaria a tool no ar, o
 * paciente ouviria "tô entrando", e o job morreria em `erro_interno`. É a família de
 * incidente que este projeto mais pagou: anunciar o que não faz.
 *
 * `concurrency: 1` é decisão, não cautela: dois Chromium no mesmo container do Railway
 * estouram memória e derrubam o healthcheck do serviço inteiro — que também despacha
 * lembrete de remédio.
 *
 * O job é removido ao terminar (ver a fila) porque carrega credencial cifrada. Uma falha
 * inesperada aqui NÃO re-executa: `executarLabFetch` já avisa a pessoa e registra em
 * `lab_fetches`; um retry seria tentar a senha de novo num portal que talvez tenha recusado.
 */
import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { writeLog } from '@iasaude/db';
import { getRedisConnection, getRedisClient } from '../queue-config.js';
import { executarLabFetch, chromiumFunciona } from '../handlers/lab-fetch.js';
import { labFetchDisponivel, LAB_FETCH_READY_KEY, LAB_FETCH_READY_TTL_S } from '../lib/lab-vault.js';
import type { LabFetchJob } from '../queues/lab-fetch.queue.js';

let worker: Worker<LabFetchJob> | null = null;
let heartbeat: NodeJS.Timeout | null = null;

async function marcarPronto(): Promise<void> {
  try {
    await getRedisClient().set(LAB_FETCH_READY_KEY, String(process.pid), 'EX', LAB_FETCH_READY_TTL_S);
  } catch { /* Redis fora: a chave expira sozinha e a tool some — é o comportamento certo */ }
}

export async function startLabFetchWorker(): Promise<void> {
  if (worker) return;
  // Sem flag + chave, NÃO escuta a fila (a tool não é oferecida). Mas SONDA o Chromium
  // mesmo assim e loga — é o que permite provar, no container real e antes de ligar a
  // feature, que o navegador existe. Sem esta sonda a primeira verificação seria um
  // paciente de verdade dizendo "sim".
  if (!labFetchDisponivel()) {
    const sonda = await chromiumFunciona();
    const msg = sonda.ok
      ? `sonda: Chromium abre neste container (${sonda.executavel}) — feature DESLIGADA por flag, fila não escutada`
      : `sonda: Chromium NÃO abre neste container — feature desligada, e ligar agora falharia: ${sonda.erro}`;
    // `writeLog` vai só para o system_logs. O stdout é o que a plataforma (railway logs)
    // mostra — e é onde uma sonda de startup precisa aparecer para ser conferida sem banco.
    console.log(`[lab] ${msg}`);
    await writeLog(sonda.ok ? 'info' : 'warn', 'lab', msg, {});
    return;
  }

  const prova = await chromiumFunciona();
  if (!prova.ok) {
    // ERRO, não warn: o anomaly-detector alerta o fundador. A tool fica fora do ar.
    const msg = `Chromium NÃO abre neste container — busca de exames FORA DO AR: ${prova.erro}`;
    console.error(`[lab] ${msg}`);
    await writeLog('error', 'lab', msg, {});
    return;
  }
  console.log(`[lab] Chromium OK (${prova.executavel}) — worker de busca de exames escutando`);
  await writeLog('info', 'lab', `Chromium OK (${prova.executavel}) — worker de busca de exames escutando`, {});

  worker = new Worker<LabFetchJob>(
    QUEUE_NAMES.LAB_FETCH,
    async (job) => { await executarLabFetch(job.data); },
    { connection: getRedisConnection(), concurrency: 1, lockDuration: 90_000 },
  );

  worker.on('failed', (job, err) => {
    void writeLog('error', 'lab', `job de busca falhou fora do orquestrador: ${String(err).slice(0, 200)}`, {
      traceId: job?.data.traceId, userId: job?.data.userId,
    });
  });

  await marcarPronto();
  heartbeat = setInterval(() => { void marcarPronto(); }, Math.floor(LAB_FETCH_READY_TTL_S / 2) * 1000);
}

export async function stopLabFetchWorker(): Promise<void> {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  try { await getRedisClient().del(LAB_FETCH_READY_KEY); } catch { /* best-effort */ }
  if (worker) { await worker.close(); worker = null; }
}
