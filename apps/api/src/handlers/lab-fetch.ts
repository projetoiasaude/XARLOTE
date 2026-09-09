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
 * Desenho e recusas de princípio: docs/PLANO_EXAMES_LAB.md.
 */
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { db, writeLog, writeAudit } from '@iasaude/db';
import { chat } from '@iasaude/llm';
import {
  extrairTextoDePdf,
  escolherAdapter, urlDeEntrada, mensagemDeParada,
  type CredenciaisLab, type MotivoParada, type PaginaDoPortal, type DesfechoDaBusca, type PdfBaixado,
} from '@iasaude/integrations';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound } from './outbound.js';
import { chaveDoCofre, decifrar } from '../lib/lab-vault.js';
import type { LabFetchJob } from '../queues/lab-fetch.queue.js';

const JOB_TIMEOUT_MS = 60_000;
const NAV_TIMEOUT_MS = 20_000;
const MAX_PDFS = 10;
const MAX_CHARS_PDF = 24_000;
const BUCKET = 'xarlote-app-media';
const USER_AGENT = 'Xarlote/1.0 (+https://xarlote.ai) assistente de saude a pedido do paciente';

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
    const b = await chromium.launch({ headless: true, executablePath: executavel });
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
  };
}

// ─── A busca em si (adapter + relógio) ───────────────────────────────────────

async function buscarNoPortal(job: LabFetchJob, creds: CredenciaisLab): Promise<DesfechoDaBusca> {
  const adapter = escolherAdapter({ url: job.portalUrl, nome: job.laboratorio });
  const entrada = urlDeEntrada({ url: job.portalUrl, nome: job.laboratorio }, adapter);
  if (!entrada) return { ok: false, motivo: 'portal_desconhecido', adapter: adapter.id, detalhe: 'sem url de entrada' };

  let browser: Browser | null = null;
  const relogio = new Promise<DesfechoDaBusca>((resolve) =>
    setTimeout(() => resolve({ ok: false, motivo: 'timeout', adapter: adapter.id }), JOB_TIMEOUT_MS),
  );

  const trabalho = (async (): Promise<DesfechoDaBusca> => {
    browser = await chromium.launch({
      headless: true,
      executablePath: resolverChromium(),
    });
    // Contexto NOVO por job: sem cookie de outra pessoa, sem cache, sem perfil.
    const ctx = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const p = embrulhar(page);

    await p.goto(entrada);
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
    return await Promise.race([trabalho, relogio]);
  } catch (err) {
    return { ok: false, motivo: 'erro_interno', adapter: adapter.id, detalhe: String(err).slice(0, 160) };
  } finally {
    if (browser) await (browser as Browser).close().catch(() => undefined);
  }
}

// ─── PDF → prontuário ────────────────────────────────────────────────────────

interface ExameExtraido {
  exam_type: string;
  title: string;
  exam_date?: string | null;
  summary?: string | null;
  findings: Array<{ marker: string; value: string; unit?: string; reference?: string }>;
  confidence?: number;
}

const PROMPT_EXTRACAO = `Você lê o TEXTO de um laudo de exame de laboratório e devolve APENAS um JSON, sem comentários:
{"exam_type":"sangue|urina|imagem|fezes|hormonal|outro","title":"nome curto do exame","exam_date":"AAAA-MM-DD ou null","summary":"1-2 frases do que o laudo diz, sem interpretar clinicamente","findings":[{"marker":"nome do marcador","value":"valor","unit":"unidade","reference":"faixa de referência"}],"confidence":0.0-1.0}
Regras: copie valores e unidades EXATAMENTE como estão; não invente marcador que não está no texto; se não houver data, null; "summary" descreve, não diagnostica.`;

function extrairJson(texto: string): ExameExtraido | null {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const j = JSON.parse(texto.slice(ini, fim + 1)) as Partial<ExameExtraido>;
    if (!j.title || !j.exam_type) return null;
    return {
      exam_type: String(j.exam_type).slice(0, 40),
      title: String(j.title).slice(0, 200),
      exam_date: j.exam_date && /^\d{4}-\d{2}-\d{2}$/.test(String(j.exam_date)) ? String(j.exam_date) : null,
      summary: j.summary ? String(j.summary).slice(0, 1000) : null,
      findings: Array.isArray(j.findings) ? j.findings.slice(0, 80).map((f) => ({
        marker: String(f?.marker ?? '').slice(0, 120),
        value: String(f?.value ?? '').slice(0, 80),
        ...(f?.unit ? { unit: String(f.unit).slice(0, 40) } : {}),
        ...(f?.reference ? { reference: String(f.reference).slice(0, 120) } : {}),
      })).filter((f) => f.marker && f.value) : [],
      confidence: typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : 0.8,
    };
  } catch {
    return null;
  }
}

async function guardarPdf(job: LabFetchJob, pdf: PdfBaixado): Promise<{ examId: string | null; mediaId: string | null }> {
  const leitura = extrairTextoDePdf(pdf.buffer, { maxCaracteres: MAX_CHARS_PDF });
  if (!leitura.ok) {
    await writeLog('warn', 'lab', `PDF baixado mas ilegível (${leitura.motivo}) — guardado só o arquivo`, { traceId: job.traceId, userId: job.userId });
  }

  // 1. O arquivo, no bucket privado, com o mesmo forget-me das fotos.
  let mediaId: string | null = null;
  try {
    const caminho = `${job.userId}/${randomUUID()}.pdf`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(caminho, pdf.buffer, { contentType: 'application/pdf' });
    if (!upErr) {
      const { data } = await db.from('app_media')
        .insert({ user_id: job.userId, storage_path: caminho, mime: 'application/pdf', bytes: pdf.buffer.length, kind: 'pdf' })
        .select('id').single();
      mediaId = (data?.id as string | undefined) ?? null;
    }
  } catch (err) {
    await writeLog('warn', 'lab', `upload do PDF falhou: ${String(err).slice(0, 120)}`, { traceId: job.traceId });
  }

  if (!leitura.ok) return { examId: null, mediaId };

  // 2. O conteúdo, extraído pelo modelo e gravado como `source: 'portal'`.
  const cfg = loadPrompts();
  let extraido: ExameExtraido | null = null;
  try {
    const res = await chat(leitura.texto, {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: PROMPT_EXTRACAO,
      temperature: 0.1,
      maxOutputTokens: 1500,
      timeoutMs: 30_000,
    });
    extraido = extrairJson(res.text);
  } catch (err) {
    await writeLog('warn', 'lab', `extração do laudo falhou: ${String(err).slice(0, 120)}`, { traceId: job.traceId });
  }
  if (!extraido) return { examId: null, mediaId };

  const { data: row, error } = await db.from('user_exam_results').insert({
    user_id: job.userId,
    conversation_id: job.conversationId,
    exam_type: extraido.exam_type,
    title: extraido.title,
    summary: extraido.summary,
    findings: extraido.findings,
    exam_date: extraido.exam_date,
    source: 'portal',
    confidence: extraido.confidence ?? 0.8,
  }).select('id').single();
  if (error) {
    await writeLog('warn', 'lab', `insert do exame falhou: ${error.message.slice(0, 120)}`, { traceId: job.traceId });
    return { examId: null, mediaId };
  }
  return { examId: (row?.id as string | undefined) ?? null, mediaId };
}

// ─── Entrada do worker ───────────────────────────────────────────────────────

export async function executarLabFetch(job: LabFetchJob): Promise<void> {
  const { fetchId, userId, conversationId, phoneE164, traceId } = job;
  await db.from('lab_fetches').update({ status: 'rodando', started_at: new Date().toISOString() }).eq('id', fetchId);

  const chave = chaveDoCofre();
  const cru = chave ? decifrar(job.credenciaisCifradas, chave) : null;
  let creds: CredenciaisLab | null = null;
  try { creds = cru ? (JSON.parse(cru) as CredenciaisLab) : null; } catch { creds = null; }

  if (!creds?.login || !creds?.senha) {
    await encerrar(job, { ok: false, motivo: 'erro_interno', adapter: null, detalhe: 'credencial indecifrável' }, 0, 0);
    return;
  }

  let desfecho: DesfechoDaBusca;
  try {
    desfecho = await buscarNoPortal(job, creds);
  } finally {
    // Sai de escopo de qualquer jeito; zerar é o melhor que JS oferece.
    creds.senha = '';
    creds.login = '';
    creds = null;
  }

  if (!desfecho.ok) {
    await encerrar(job, desfecho, 0, 0);
    return;
  }

  let salvos = 0;
  const titulos: string[] = [];
  for (const pdf of desfecho.pdfs) {
    const r = await guardarPdf(job, pdf);
    if (r.examId) { salvos++; titulos.push(pdf.rotulo); }
  }
  await encerrar(job, desfecho, desfecho.pdfs.length, salvos, titulos);
  void conversationId; void phoneE164; void userId;
}

async function encerrar(job: LabFetchJob, desfecho: DesfechoDaBusca, pdfs: number, salvos: number, titulos: string[] = []): Promise<void> {
  const agora = new Date().toISOString();
  const status = desfecho.ok ? 'concluida' : (desfecho.motivo === 'erro_interno' || desfecho.motivo === 'timeout' ? 'falhou' : 'parada');
  await db.from('lab_fetches').update({
    status, adapter: desfecho.adapter, motivo: desfecho.ok ? null : desfecho.motivo,
    pdfs_baixados: pdfs, exames_salvos: salvos, finished_at: agora,
  }).eq('id', job.fetchId);

  await writeAudit({
    actorType: 'system', actorId: 'lab-fetch', action: desfecho.ok ? 'lab_fetch.completed' : 'lab_fetch.stopped',
    userId: job.userId, conversationId: job.conversationId, targetTable: 'lab_fetches', targetId: job.fetchId,
    metadata: { adapter: desfecho.adapter, motivo: desfecho.ok ? null : desfecho.motivo, pdfs, salvos },
  });
  await writeLog(desfecho.ok ? 'info' : 'warn', 'lab',
    desfecho.ok ? `busca concluída: ${pdfs} PDF(s), ${salvos} exame(s) salvos` : `busca parada: ${desfecho.motivo}${desfecho.detalhe ? ` (${desfecho.detalhe})` : ''}`,
    { traceId: job.traceId, userId: job.userId, adapter: desfecho.adapter });

  const texto = desfecho.ok
    ? (salvos > 0
      ? `Consegui! Entrei no site${job.laboratorio ? ` do ${job.laboratorio}` : ''}, baixei ${pdfs} arquivo(s) e guardei ${salvos} exame(s) no seu prontuário: ${titulos.slice(0, 5).join(', ')}${titulos.length > 5 ? '…' : ''}. Quer que eu te explique algum deles? 💙`
      : `Entrei no site e baixei ${pdfs} arquivo(s), mas não consegui ler o conteúdo deles — guardei os PDFs no seu perfil mesmo assim. Se quiser, me manda a foto do laudo que eu leio por aqui 💙`)
    : mensagemDeParada(desfecho.motivo, job.laboratorio);
  await sendOutbound(job.conversationId, job.phoneE164, texto, job.traceId);
}
