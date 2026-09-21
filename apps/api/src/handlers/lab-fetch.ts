/**
 * Orquestrador da busca de exames no portal do laboratório.
 *
 * Roda DENTRO do worker (nunca no request): abre um Chromium limpo, entrega a página ao
 * adapter, e cuida de tudo que o adapter não sabe — a pessoa, o prontuário, a mensagem, a
 * auditoria, o relógio.
 *
 * O que este arquivo garante, independente do adapter:
 *   • a credencial só é decifrada aqui, usada uma vez, e o objeto é zerado no `finally`;
 *   • o navegador fecha SEMPRE, mesmo em exceção — Chromium órfão num container do Railway
 *     é vazamento de memória até o healthcheck derrubar o serviço;
 *   • toda parada vira `MotivoParada` + frase honesta + linha em `lab_fetches` + audit_log.
 *     Nenhum caminho termina em silêncio;
 *   • só `application/pdf` de verdade (header `%PDF-`) entra no prontuário;
 *   • nada de PII em log: contagens e códigos, nunca nome de exame, nunca URL com token.
 *
 * v2 (21/09/2026, caso Ciro): a busca pode ser AGENDADA. O acesso fica cifrado na linha de
 * `lab_fetches` só enquanto ela está pendente e é apagado ao terminar; antes de prometer a
 * data, o worker RECONHECE o portal (abre, aceita cookies, confere o formulário — sem digitar);
 * e todo PDF passa pela ingestão única (`ingestao-de-exame.ts`).
 *
 * Desenho e recusas de princípio: docs/PLANO_EXAMES_LAB.md.
 */
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { db, writeLog, writeAudit } from '@iasaude/db';
import {
  escolherAdapter, escolherAdapterPelaPagina, urlDeEntrada, mensagemDeParada,
  type CredenciaisLab, type MotivoParada, type PaginaDoPortal, type DesfechoDaBusca, type PdfBaixado, type LabAdapter, type CampoDoPortal, type ReconhecimentoDoPortal,
} from '@iasaude/integrations';
import {
  mensagemAgendamentoConfirmado, mensagemAgendamentoImpossivel, mensagemBuscaAgendadaComecou, mensagemFaltouDado,
  corpoDoLembreteDeResultado,
} from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { chaveDoCofre, decifrar } from '../lib/lab-vault.js';
import { ingerirDocumentoDeExame } from './ingestao-de-exame.js';
import { enqueueLabFetch, type LabFetchJob } from '../queues/lab-fetch.queue.js';

const JOB_TIMEOUT_MS = 60_000;
const RECON_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;
const MAX_PDFS = 10;
const USER_AGENT = 'Xarlote/1.0 (+https://xarlote.ai) assistente de saude a pedido do paciente';
/**
 * Flags de container (21/09/2026, primeiro portal real): o Chromium do Nix no Railway
 * derrubou a aba ("Target crashed") ao renderizar a SPA do CDI — o /dev/shm do container é
 * minúsculo e o Chromium usa ele como memória compartilhada por padrão. `--disable-dev-shm-usage`
 * manda isso pro /tmp; `--no-sandbox` porque o processo já roda como root no container;
 * `--disable-gpu` porque não há GPU. O e2e com portal falso nunca viu isso: página simples.
 */
const LAUNCH_ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-zygote'];

/**
 * Onde está o Chromium. No container do worker (Railway/nixpacks) ele vem do Nix e fica
 * no PATH como `chromium`; o download do próprio Playwright é pulado no build
 * (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) para não baixar 150 MB em cada service. Localmente
 * o Playwright usa o dele. Ordem: env explícita → PATH → o padrão do Playwright.
 */
export function resolverChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicito = (env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? '').trim();
  if (explicito) return explicito;
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try {
      const p = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) return p;
    } catch { /* não está no PATH — tenta o próximo */ }
  }
  return undefined;
}

/**
 * Prova, de verdade, que este processo consegue abrir um navegador. Chamado pelo worker
 * ANTES de escutar a fila: se falhar, a fila não é escutada e a tool não é oferecida ao
 * modelo — capacidade que não existe não pode ser prometida a um paciente.
 */
export async function chromiumFunciona(): Promise<{ ok: true; executavel: string } | { ok: false; erro: string }> {
  const executavel = resolverChromium();
  try {
    const b = await chromium.launch({ headless: true, executablePath: executavel, args: LAUNCH_ARGS });
    await b.close();
    return { ok: true, executavel: executavel ?? '(bundled do Playwright)' };
  } catch (err) {
    return { ok: false, erro: String(err).split('\n').slice(0, 3).join(' | ').slice(0, 300) };
  }
}

// ─── Playwright → PaginaDoPortal ─────────────────────────────────────────────

function embrulhar(page: Page): PaginaDoPortal {
  return {
    goto: (url, opts) => page.goto(url, { timeout: opts?.timeout ?? NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' }),
    url: () => page.url(),
    content: () => page.content(),
    fill: (sel, v) => page.fill(sel, v, { timeout: 5_000 }),
    click: (sel, opts) => page.click(sel, { timeout: opts?.timeout ?? 5_000 }),
    waitForLoadState: (state, opts) => page.waitForLoadState(state ?? 'load', { timeout: opts?.timeout ?? NAV_TIMEOUT_MS }),
    async clicarEEsperar(sel, opts) {
      // `load` da PRÓXIMA página, armado antes do clique. Se o clique não navegar (portal
      // SPA), o timeout curto solta e o adapter decide pelo conteúdo.
      const espera = page.waitForEvent('load', { timeout: Math.min(opts?.timeout ?? NAV_TIMEOUT_MS, 8_000) }).catch(() => null);
      await page.click(sel, { timeout: 5_000 });
      await espera;
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    },
    async baixar(url) {
      // `page.request` compartilha os cookies do contexto — é o GET autenticado.
      const r = await page.request.get(url, { timeout: NAV_TIMEOUT_MS, maxRedirects: 5 });
      return { contentType: r.headers()['content-type'] ?? '', body: Buffer.from(await r.body()) };
    },
    coletar: (sel, attrs) => page.$$eval(sel, (els, a) =>
      els.map((el) => Object.fromEntries(a.map((k) => [k, k === 'textContent' ? (el.textContent ?? null) : el.getAttribute(k)]))),
      attrs as string[],
    ),
    existe: (sel) => page.locator(sel).first().isVisible().catch(() => false),
    esperar: (ms) => page.waitForTimeout(ms),
    async clicarEBaixar(sel, opts) {
      // SPA que baixa por clique: arma a espera pelo evento de download ANTES de clicar.
      const espera = page.waitForEvent('download', { timeout: opts?.timeout ?? 15_000 }).catch(() => null);
      await page.click(sel, { timeout: 5_000 }).catch(() => undefined);
      const dl = await espera;
      if (!dl) return null;
      const stream = await dl.createReadStream().catch(() => null);
      if (!stream) return null;
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return { contentType: 'application/octet-stream', body: Buffer.concat(chunks) };
    },
  };
}

// ─── A linha de `lab_fetches` (o estado da busca) ────────────────────────────

interface LinhaDeBusca {
  id: string;
  user_id: string;
  conversation_id: string | null;
  laboratorio: string | null;
  portal_url: string | null;
  status: string;
  scheduled_for: string | null;
  credenciais_cifradas: string | null;
  campos: string[] | null;
  trace_id: string | null;
  users: { phone_e164: string | null } | null;
}

async function carregarBusca(fetchId: string): Promise<LinhaDeBusca | null> {
  const { data } = await db.from('lab_fetches')
    .select('id, user_id, conversation_id, laboratorio, portal_url, status, scheduled_for, credenciais_cifradas, campos, trace_id, users(phone_e164)')
    .eq('id', fetchId).maybeSingle();
  return (data as unknown as LinhaDeBusca | null) ?? null;
}

/** O acesso é apagado da linha em TODO desfecho — é a promessa "nunca depois da busca". */
async function apagarCredenciais(fetchId: string): Promise<void> {
  await db.from('lab_fetches').update({ credenciais_cifradas: null }).eq('id', fetchId);
}

function decifrarCredenciais(linha: LinhaDeBusca): CredenciaisLab | null {
  const chave = chaveDoCofre();
  const cru = chave && linha.credenciais_cifradas ? decifrar(linha.credenciais_cifradas, chave) : null;
  if (!cru) return null;
  try {
    const c = JSON.parse(cru) as CredenciaisLab;
    return c?.login && c?.senha ? c : null;
  } catch {
    return null;
  }
}

/** Sem digitar nada: o portal pede o quê, e nós temos o quê? */
function camposQueFaltam(campos: CampoDoPortal[], creds: CredenciaisLab): CampoDoPortal[] {
  return campos.filter((c) => {
    if (c === 'nascimento') return !creds.nascimento;
    if (c === 'cpf') return !creds.cpf;
    if (c === 'protocolo') return !creds.protocolo && !creds.login;
    return false;
  });
}

// ─── Navegador ───────────────────────────────────────────────────────────────

interface PortalAberto { browser: Browser; page: PaginaDoPortal; adapter: LabAdapter }

/**
 * Abre o portal num contexto novo, escolhe o adapter (pela URL; depois pela PÁGINA — o
 * protocolo do CDI diz "cdig.com.br", a home; a tela de resultados se apresenta como
 * Synapse) e prepara a tela (cookies). Quem chama fecha o navegador.
 */
async function abrirPortal(linha: LinhaDeBusca): Promise<{ ok: true; portal: PortalAberto } | { ok: false; motivo: MotivoParada; adapter: string | null; detalhe?: string }> {
  const alvo = { url: linha.portal_url, nome: linha.laboratorio };
  let adapter = escolherAdapter(alvo);
  const entrada = urlDeEntrada(alvo, adapter);
  if (!entrada) return { ok: false, motivo: 'portal_desconhecido', adapter: adapter.id, detalhe: 'sem url de entrada' };

  const browser = await chromium.launch({ headless: true, executablePath: resolverChromium(), args: LAUNCH_ARGS });
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const p = embrulhar(page);
    await p.goto(entrada);
    await p.waitForLoadState?.('networkidle', { timeout: 8_000 }).catch(() => undefined);
    adapter = escolherAdapterPelaPagina(await p.content(), adapter);
    // Se a URL do protocolo era a home e o adapter conhece a tela de entrada, vai pra ela.
    if (adapter.urlPadrao && !adapter.detecta?.(await p.content()) && adapter.id !== 'generico') {
      await p.goto(adapter.urlPadrao);
      await p.waitForLoadState?.('networkidle', { timeout: 8_000 }).catch(() => undefined);
    }
    await adapter.preparar?.(p);
    return { ok: true, portal: { browser, page: p, adapter } };
  } catch (err) {
    await browser.close().catch(() => undefined);
    return { ok: false, motivo: 'erro_interno', adapter: adapter.id, detalhe: String(err).slice(0, 160) };
  }
}

function comRelogio<T>(trabalho: Promise<T>, ms: number, aoEstourar: T): Promise<T> {
  return Promise.race([trabalho, new Promise<T>((resolve) => setTimeout(() => resolve(aoEstourar), ms))]);
}

// ─── RECONHECIMENTO (antes de prometer a data) ───────────────────────────────

export async function executarReconhecimento(job: LabFetchJob): Promise<void> {
  const linha = await carregarBusca(job.fetchId);
  if (!linha || linha.status !== 'reconhecendo') return;
  const fone = linha.users?.phone_e164 ?? null;
  const conv = linha.conversation_id;
  const quando = linha.scheduled_for ? new Date(linha.scheduled_for) : new Date();
  const creds = decifrarCredenciais(linha);

  const falar = async (texto: string) => { if (conv && fone) await sendOutbound(conv, fone, texto, job.traceId); };

  if (!creds) {
    await concluirReconhecimento(linha, { ok: false, motivo: 'erro_interno' }, 'credencial indecifrável', job.traceId);
    await falar(mensagemDeParada('erro_interno', linha.laboratorio));
    return;
  }

  const aberto = await comRelogio(abrirPortal(linha), RECON_TIMEOUT_MS, { ok: false as const, motivo: 'timeout' as MotivoParada, adapter: null });
  if (!aberto.ok) {
    await concluirReconhecimento(linha, { ok: false, motivo: aberto.motivo === 'timeout' ? 'timeout' : aberto.motivo === 'erro_interno' ? 'erro_interno' : 'portal_desconhecido' }, aberto.detalhe, job.traceId, aberto.adapter);
    await agendarLembreteHonesto(linha, quando, job.traceId);
    await falar(mensagemAgendamentoImpossivel(linha.laboratorio, quando, aberto.motivo));
    return;
  }

  let rec: ReconhecimentoDoPortal;
  try {
    rec = await comRelogio(aberto.portal.adapter.reconhecer(aberto.portal.page), RECON_TIMEOUT_MS, { ok: false as const, motivo: 'timeout' as const });
  } catch (err) {
    rec = { ok: false, motivo: 'erro_interno' };
    await writeLog('warn', 'lab', `reconhecimento lançou: ${String(err).slice(0, 120)}`, { traceId: job.traceId });
  } finally {
    await aberto.portal.browser.close().catch(() => undefined);
  }

  if (!rec.ok) {
    await concluirReconhecimento(linha, rec, undefined, job.traceId, aberto.portal.adapter.id);
    await agendarLembreteHonesto(linha, quando, job.traceId);
    await falar(mensagemAgendamentoImpossivel(linha.laboratorio, quando, rec.motivo));
    return;
  }

  const faltam = camposQueFaltam(rec.campos, creds);
  if (faltam.length) {
    // Sem o dado não dá pra entrar: para AQUI (sem agendar), pede o dado, e o acesso sai da
    // linha — a pessoa manda o dado + "sim" e o modelo chama a tool de novo, completa.
    await db.from('lab_fetches').update({ status: 'parada', motivo: 'faltou_dado', adapter: aberto.portal.adapter.id, campos: rec.campos, finished_at: new Date().toISOString() }).eq('id', linha.id);
    await apagarCredenciais(linha.id);
    await writeAudit({ actorType: 'system', actorId: 'lab-fetch', action: 'lab_fetch.stopped', userId: linha.user_id, conversationId: conv ?? undefined, targetTable: 'lab_fetches', targetId: linha.id, metadata: { motivo: 'faltou_dado', faltam, adapter: aberto.portal.adapter.id } });
    await writeLog('info', 'lab', `reconhecimento: o portal pede ${faltam.join('+')} e não temos — parada (faltou_dado)`, { traceId: job.traceId, userId: linha.user_id, adapter: aberto.portal.adapter.id });
    await falar(mensagemFaltouDado(linha.laboratorio, faltam[0] === 'cpf' ? 'cpf' : 'nascimento'));
    return;
  }

  // Prova feita: agora sim, a data combinada. O acesso fica cifrado até lá.
  await db.from('lab_fetches').update({ status: 'agendada', adapter: aberto.portal.adapter.id, campos: rec.campos }).eq('id', linha.id);
  await writeAudit({ actorType: 'system', actorId: 'lab-fetch', action: 'lab_fetch.scheduled', userId: linha.user_id, conversationId: conv ?? undefined, targetTable: 'lab_fetches', targetId: linha.id, metadata: { adapter: aberto.portal.adapter.id, campos: rec.campos, scheduledFor: linha.scheduled_for } });
  await writeLog('info', 'lab', `reconhecimento OK (${aberto.portal.adapter.id}, campos ${rec.campos.join('+')}) — busca agendada`, { traceId: job.traceId, userId: linha.user_id });
  await falar(mensagemAgendamentoConfirmado(linha.laboratorio, quando));
}

async function concluirReconhecimento(linha: LinhaDeBusca, rec: { ok: false; motivo: MotivoParada }, detalhe: string | undefined, traceId: string, adapter?: string | null): Promise<void> {
  await db.from('lab_fetches').update({ status: 'parada', motivo: rec.motivo, adapter: adapter ?? null, finished_at: new Date().toISOString() }).eq('id', linha.id);
  await apagarCredenciais(linha.id);
  await writeAudit({ actorType: 'system', actorId: 'lab-fetch', action: 'lab_fetch.stopped', userId: linha.user_id, conversationId: linha.conversation_id ?? undefined, targetTable: 'lab_fetches', targetId: linha.id, metadata: { fase: 'reconhecimento', motivo: rec.motivo, detalhe: detalhe ?? null, adapter: adapter ?? null } });
  await writeLog('warn', 'lab', `reconhecimento parado: ${rec.motivo}${detalhe ? ` (${detalhe})` : ''}`, { traceId, userId: linha.user_id, adapter: adapter ?? null });
}

/** O caminho que sempre funciona: no dia, um lembrete honesto pedindo o PDF (nada de "vou entrar"). */
async function agendarLembreteHonesto(linha: LinhaDeBusca, quando: Date, traceId: string): Promise<void> {
  if (quando.getTime() <= Date.now() + 60_000) return; // era "agora": a mensagem de parada já disse tudo
  try {
    const protocolo = null; // nunca sai da linha em claro; o corpo fala "seu exame do CDI"
    const { data } = await db.from('reminders').insert({
      user_id: linha.user_id, type: 'custom', title: `Resultado do exame${linha.laboratorio ? ` — ${linha.laboratorio}` : ''}`,
      body: corpoDoLembreteDeResultado(linha.laboratorio, protocolo), scheduled_at: quando.toISOString(), next_run_at: quando.toISOString(), status: 'pending',
      payload: { origem: 'lab_fetch', lab_fetch_id: linha.id },
    }).select('id').single();
    if (data?.id) await db.from('lab_fetches').update({ reminder_id: data.id }).eq('id', linha.id);
  } catch (err) {
    await writeLog('warn', 'lab', `lembrete de fallback não criado: ${String(err).slice(0, 120)}`, { traceId, userId: linha.user_id });
  }
}

// ─── A BUSCA (adapter + relógio) ─────────────────────────────────────────────

async function buscarNoPortal(linha: LinhaDeBusca, creds: CredenciaisLab): Promise<DesfechoDaBusca> {
  const aberto = await comRelogio(abrirPortal(linha), JOB_TIMEOUT_MS, { ok: false as const, motivo: 'timeout' as MotivoParada, adapter: null });
  if (!aberto.ok) return { ok: false, motivo: aberto.motivo, adapter: aberto.adapter, detalhe: aberto.detalhe };
  const { browser, page: p, adapter } = aberto.portal;

  const trabalho = (async (): Promise<DesfechoDaBusca> => {
    const rec = await adapter.reconhecer(p);
    if (!rec.ok) return { ok: false, motivo: rec.motivo, adapter: adapter.id };
    const faltam = camposQueFaltam(rec.campos, creds);
    if (faltam.length) return { ok: false, motivo: 'faltou_dado', adapter: adapter.id, detalhe: faltam.join('+') };

    const login = await adapter.login(p, creds);
    if (!login.ok) return { ok: false, motivo: login.motivo, adapter: adapter.id };

    const itens = (await adapter.listarResultados(p)).slice(0, MAX_PDFS);
    if (!itens.length) return { ok: false, motivo: 'sem_resultados', adapter: adapter.id };

    const pdfs: PdfBaixado[] = [];
    for (const it of itens) {
      const buf = await adapter.baixar(p, it).catch(() => null);
      if (buf) pdfs.push({ rotulo: it.rotulo, buffer: buf });
    }
    if (!pdfs.length) return { ok: false, motivo: 'download_falhou', adapter: adapter.id };
    return { ok: true, pdfs, adapter: adapter.id };
  })();

  try {
    return await comRelogio(trabalho, JOB_TIMEOUT_MS, { ok: false as const, motivo: 'timeout' as MotivoParada, adapter: adapter.id });
  } catch (err) {
    return { ok: false, motivo: 'erro_interno', adapter: adapter.id, detalhe: String(err).slice(0, 160) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ─── Entrada do worker ───────────────────────────────────────────────────────

export async function executarLabFetch(job: LabFetchJob): Promise<void> {
  const linha = await carregarBusca(job.fetchId);
  if (!linha) return;
  if (!['na_fila', 'agendada'].includes(linha.status)) return; // já rodou, ou cancelada
  const fone = linha.users?.phone_e164 ?? null;
  const conv = linha.conversation_id;
  const falar = async (texto: string) => { if (conv && fone) await sendOutbound(conv, fone, texto, job.traceId); };
  const eraAgendada = !!linha.scheduled_for && linha.status === 'agendada' || (job.kind === 'buscar' && !!linha.scheduled_for);

  await db.from('lab_fetches').update({ status: 'rodando', started_at: new Date().toISOString() }).eq('id', linha.id);

  let creds = decifrarCredenciais(linha);
  if (!creds) {
    await encerrar(linha, { ok: false, motivo: 'erro_interno', adapter: null, detalhe: 'credencial indecifrável' }, 0, 0, [], job.traceId);
    await falar(mensagemDeParada('erro_interno', linha.laboratorio));
    return;
  }
  if (eraAgendada) await falar(mensagemBuscaAgendadaComecou(linha.laboratorio));

  let desfecho: DesfechoDaBusca;
  try {
    desfecho = await buscarNoPortal(linha, creds);
  } finally {
    // Sai de escopo de qualquer jeito; zerar é o melhor que JS oferece. E some da linha.
    creds.senha = ''; creds.login = ''; creds = null;
    await apagarCredenciais(linha.id);
  }

  if (!desfecho.ok) {
    await encerrar(linha, desfecho, 0, 0, [], job.traceId);
    await falar(desfecho.motivo === 'faltou_dado'
      ? mensagemFaltouDado(linha.laboratorio, desfecho.detalhe?.includes('cpf') ? 'cpf' : 'nascimento')
      : mensagemDeParada(desfecho.motivo, linha.laboratorio));
    return;
  }

  let salvos = 0;
  const titulos: string[] = [];
  for (const pdf of desfecho.pdfs) {
    const r = await ingerirDocumentoDeExame({
      userId: linha.user_id, conversationId: conv, traceId: job.traceId, origem: 'portal',
      buffer: pdf.buffer, mime: 'application/pdf', rotulo: pdf.rotulo, labFetchId: linha.id, laboratorio: linha.laboratorio,
    });
    if (r.tipo === 'laudo' && r.examId) { salvos++; titulos.push(r.titulo ?? pdf.rotulo); }
  }
  await encerrar(linha, desfecho, desfecho.pdfs.length, salvos, titulos, job.traceId);
  await falar(salvos > 0
    ? `Consegui! Entrei no site${linha.laboratorio ? ` do ${linha.laboratorio}` : ''}, baixei ${desfecho.pdfs.length} arquivo(s) e guardei ${salvos} exame(s) no seu prontuário: ${titulos.slice(0, 5).join(', ')}${titulos.length > 5 ? '…' : ''}. Quer que eu te explique algum deles? 💙`
    : `Entrei no site e baixei ${desfecho.pdfs.length} arquivo(s), mas não consegui ler o conteúdo deles — guardei os PDFs no seu perfil mesmo assim. Se quiser, me manda a foto do laudo que eu leio por aqui 💙`);
}

async function encerrar(linha: LinhaDeBusca, desfecho: DesfechoDaBusca, pdfs: number, salvos: number, titulos: string[], traceId: string): Promise<void> {
  const agora = new Date().toISOString();
  const status = desfecho.ok ? 'concluida' : (desfecho.motivo === 'erro_interno' || desfecho.motivo === 'timeout' ? 'falhou' : 'parada');
  await db.from('lab_fetches').update({
    status, adapter: desfecho.adapter, motivo: desfecho.ok ? null : desfecho.motivo,
    pdfs_baixados: pdfs, exames_salvos: salvos, finished_at: agora, credenciais_cifradas: null,
  }).eq('id', linha.id);

  await writeAudit({
    actorType: 'system', actorId: 'lab-fetch', action: desfecho.ok ? 'lab_fetch.completed' : 'lab_fetch.stopped',
    userId: linha.user_id, conversationId: linha.conversation_id ?? undefined, targetTable: 'lab_fetches', targetId: linha.id,
    metadata: { adapter: desfecho.adapter, motivo: desfecho.ok ? null : desfecho.motivo, pdfs, salvos },
  });
  await writeLog(desfecho.ok ? 'info' : 'warn', 'lab',
    desfecho.ok ? `busca concluída: ${pdfs} PDF(s), ${salvos} exame(s) salvos` : `busca parada: ${desfecho.motivo}${desfecho.detalhe ? ` (${desfecho.detalhe})` : ''}`,
    { traceId, userId: linha.user_id, adapter: desfecho.adapter });
  void titulos;
}

// ─── Despachante das buscas agendadas ────────────────────────────────────────

/**
 * Roda no worker a cada minuto: o que venceu vira job. A reivindicação é atômica
 * (`status = 'agendada'` no WHERE do update) — dois workers não enfileiram a mesma linha —
 * e a fila deduplica pelo `jobId`. Worker parado na hora? Roda assim que voltar: a linha
 * espera no banco, não num timer.
 */
export async function despacharBuscasAgendadas(): Promise<number> {
  const { data: vencidas } = await db.from('lab_fetches')
    .select('id, trace_id')
    .eq('status', 'agendada')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(20);
  let n = 0;
  for (const l of vencidas ?? []) {
    const { data: claimed } = await db.from('lab_fetches')
      .update({ status: 'na_fila' }).eq('id', l.id).eq('status', 'agendada').select('id');
    if (!claimed?.length) continue;
    await enqueueLabFetch({ kind: 'buscar', fetchId: l.id as string, traceId: (l.trace_id as string | null) ?? `lab-fetch-${String(l.id).slice(0, 8)}` });
    n++;
  }
  if (n) await writeLog('info', 'lab', `${n} busca(s) agendada(s) enfileirada(s)`, {});
  return n;
}
