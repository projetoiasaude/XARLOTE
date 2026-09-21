/**
 * INGESTÃO DE DOCUMENTO DE EXAME — um caminho só, seja de onde vier.
 *
 * ─── O QUE ACONTECEU (Ciro, 18/09/2026) ────────────────────────────────────────
 * O laudo chegou (PDF), o leitor disse "ilegível", o modelo do turno decidiu sozinho o que
 * era e o que guardar, gravou o protocolo como resultado e disse "guardei" sem ter nada.
 * Três decisões distintas (ler, classificar, gravar) estavam no lugar errado: no modelo da
 * conversa, que tem outra tarefa e nenhuma prova.
 *
 * ─── O DESENHO ─────────────────────────────────────────────────────────────────
 * Todo documento de exame — PDF baixado do portal, PDF mandado no WhatsApp, PDF subido no
 * app, FOTO do laudo — passa por AQUI, antes de o modelo do turno abrir a boca:
 *   1. o ARQUIVO vai pro bucket privado + `app_media` (o histórico guarda o original);
 *   2. o TEXTO sai do pdf.js (PDF) ou de uma leitura estruturada da visão (foto);
 *   3. a CLASSIFICAÇÃO é determinística (laudo · protocolo · receita · pedido · outro);
 *   4. se é laudo, um modelo de EXTRAÇÃO (temperatura 0, saída JSON) tira os marcadores —
 *      e cada valor é CONFERIDO contra o texto: o que não está no laudo não entra;
 *   5. `user_exam_results` recebe o resultado ligado ao arquivo; o modelo do turno recebe o
 *      FATO ("guardado como X, N marcadores") e só comenta.
 * Nunca lança: devolve `ResultadoDaIngestao` com o que aconteceu, inclusive o que falhou.
 * Sem PII em log ≥ info: contagens, tipos e motivos, nunca nome de exame ou valor.
 */
import { randomUUID } from 'crypto';
import { db, writeLog, writeAudit, saveMemoryCard } from '@iasaude/db';
import { chat, userContentWithImage, dataUrl } from '@iasaude/llm';
import { lerPdfCompleto, mensagemDePdfIlegivel } from '@iasaude/integrations';
import {
  classificarTextoDeDocumento, normalizarExtraido, verificarAchadosNoTexto, previsaoDeLiberacaoDoTexto,
  type ResultadoDaIngestao, type ExameExtraido, type TipoDeDocumento,
} from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';

const BUCKET_PRIVADO = 'xarlote-app-media';
const MAX_CHARS_TEXTO = 24_000;
const MAX_ACHADOS = 120;

export type OrigemDoDocumento = 'portal' | 'whatsapp' | 'app';

export interface EntradaDaIngestao {
  userId: string;
  conversationId: string | null;
  traceId: string;
  origem: OrigemDoDocumento;
  buffer: Buffer;
  mime: string;
  /** Rótulo humano (nome do arquivo, ou o do portal). Vai no log só como tamanho. */
  rotulo?: string | null;
  /** A mensagem de onde o documento veio (WhatsApp/app), pra `user_exam_results.message_id`. */
  messageId?: string | null;
  labFetchId?: string | null;
  laboratorio?: string | null;
  /** Já hospedado em outro bucket (WhatsApp) — ainda assim guardamos a cópia privada. */
}

const PROMPT_EXTRACAO_TEXTO = `Você lê o TEXTO de um laudo de exame e devolve APENAS um JSON, sem comentários nem markdown:
{"exam_type":"sangue|urina|fezes|hormonal|imagem|cardiologico|outro","title":"nome curto do exame (ex.: Hemograma completo; Ressonância magnética do crânio)","exam_date":"AAAA-MM-DD ou null","laboratorio":"nome do laboratório/clínica ou null","summary":"1-3 frases do que o laudo diz (para imagem: a CONCLUSÃO escrita), sem interpretar clinicamente","findings":[{"marker":"nome do marcador","value":"valor como está escrito","unit":"unidade","reference":"faixa de referência como está escrita"}],"confidence":0.0-1.0}
Regras: copie valores, unidades e referências EXATAMENTE como estão no texto; NÃO invente marcador que não está no texto; inclua TODOS os marcadores com valor (até 120); se não houver data, null; "summary" descreve, não diagnostica.`;

const PROMPT_LEITURA_DE_FOTO = `Você olha a FOTO de um documento e devolve APENAS um JSON, sem comentários nem markdown:
{"tipo":"laudo|protocolo|receita|pedido|outro","descricao":"descrição OBJETIVA em até 700 caracteres do que se vê (que documento é, de quem, data, local, e os textos/valores relevantes), sem opinar","previsao_liberacao":"AAAA-MM-DDTHH:MM:00-03:00 se for protocolo de retirada com data prevista, senão null","laboratorio":"nome do laboratório/clínica ou null","exame":null ou {"exam_type":"sangue|urina|fezes|hormonal|imagem|cardiologico|outro","title":"nome curto","exam_date":"AAAA-MM-DD ou null","summary":"1-3 frases do que o laudo diz, sem interpretar","findings":[{"marker":"...","value":"...","unit":"...","reference":"..."}],"confidence":0.0-1.0}}
"laudo" = resultado de exame com valores/marcadores ou conclusão escrita. "protocolo" = comprovante/protocolo de retirada (código, senha, previsão de entrega) SEM resultado. Copie valores EXATAMENTE como estão; não invente.`;

function extrairJson(texto: string): unknown {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(texto.slice(ini, fim + 1)); } catch { return null; }
}

function cfgLlm() {
  const cfg = loadPrompts();
  return {
    apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
    texto: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
    visao: cfg.vision_model || 'openai/gpt-4.1-mini',
  };
}

/** 1. O arquivo, no bucket privado + app_media. Falha vira `null`, nunca exceção. */
export async function guardarArquivoNoProntuario(userId: string, buffer: Buffer, mime: string, traceId: string): Promise<string | null> {
  const ehPdf = mime.toLowerCase().includes('pdf');
  const ext = ehPdf ? 'pdf' : mime.toLowerCase().includes('png') ? 'png' : mime.toLowerCase().includes('webp') ? 'webp' : 'jpg';
  try {
    const caminho = `${userId}/${randomUUID()}.${ext}`;
    const { error: upErr } = await db.storage.from(BUCKET_PRIVADO).upload(caminho, buffer, { contentType: mime });
    if (upErr) {
      await writeLog('warn', 'exam', `upload do documento falhou: ${upErr.message.slice(0, 120)}`, { traceId, userId });
      return null;
    }
    const { data, error } = await db.from('app_media')
      .insert({ user_id: userId, storage_path: caminho, mime, bytes: buffer.length, kind: ehPdf ? 'pdf' : 'image' })
      .select('id').single();
    if (error) {
      await writeLog('warn', 'exam', `app_media do documento falhou: ${error.message.slice(0, 120)}`, { traceId, userId });
      return null;
    }
    return (data?.id as string | undefined) ?? null;
  } catch (err) {
    await writeLog('warn', 'exam', `guardar documento lançou: ${String(err).slice(0, 120)}`, { traceId, userId });
    return null;
  }
}

/** 4. Texto de laudo → marcadores conferidos. `null` se o modelo não devolveu o mínimo. */
export async function extrairExameDoTexto(texto: string, traceId: string): Promise<{ exame: ExameExtraido; descartados: number } | null> {
  const llm = cfgLlm();
  let bruto: unknown = null;
  try {
    const r = await chat(texto.slice(0, MAX_CHARS_TEXTO), {
      model: llm.texto, apiKey: llm.apiKey, systemInstruction: PROMPT_EXTRACAO_TEXTO,
      temperature: 0, maxOutputTokens: 4000, timeoutMs: 45_000,
    });
    bruto = extrairJson(r.text);
  } catch (err) {
    await writeLog('warn', 'exam', `extração do laudo falhou: ${String(err).slice(0, 140)}`, { traceId });
    return null;
  }
  const exame = normalizarExtraido(bruto);
  if (!exame) return null;
  const { mantidos, descartados } = verificarAchadosNoTexto(exame.findings, texto);
  if (descartados.length) {
    await writeLog('info', 'exam', `extração: ${descartados.length} achado(s) não confirmado(s) no texto foram descartados (${mantidos.length} mantidos)`, { traceId });
  }
  return { exame: { ...exame, findings: mantidos.slice(0, MAX_ACHADOS) }, descartados: descartados.length };
}

interface LeituraDeFoto {
  tipo: TipoDeDocumento;
  descricao: string | null;
  previsaoLiberacao: string | null;
  laboratorio: string | null;
  exame: ExameExtraido | null;
}

/** 2b. A foto: UMA chamada de visão devolve classificação + descrição objetiva + (se laudo) os marcadores. */
export async function lerFotoDeDocumento(buffer: Buffer, mime: string, traceId: string): Promise<LeituraDeFoto | null> {
  const llm = cfgLlm();
  try {
    const r = await chat(userContentWithImage(PROMPT_LEITURA_DE_FOTO, [dataUrl(buffer.toString('base64'), mime)]), {
      model: llm.visao, apiKey: llm.apiKey, temperature: 0, maxOutputTokens: 4000, timeoutMs: 60_000,
    });
    const j = extrairJson(r.text) as Record<string, unknown> | null;
    if (!j) return null;
    const tipo = (['laudo', 'protocolo', 'receita', 'pedido', 'outro'] as const).includes(j['tipo'] as TipoDeDocumento) ? (j['tipo'] as TipoDeDocumento) : 'outro';
    const descricao = typeof j['descricao'] === 'string' ? j['descricao'].replace(/\s+/g, ' ').trim().slice(0, 900) : null;
    const prev = typeof j['previsao_liberacao'] === 'string' && !Number.isNaN(new Date(j['previsao_liberacao']).getTime()) ? j['previsao_liberacao'] : (descricao ? previsaoDeLiberacaoDoTexto(descricao) : null);
    const exame = tipo === 'laudo' ? normalizarExtraido(j['exame']) : null;
    return {
      tipo, descricao, previsaoLiberacao: prev,
      laboratorio: typeof j['laboratorio'] === 'string' ? j['laboratorio'].slice(0, 120) : null,
      exame: exame ? { ...exame, confidence: Math.min(exame.confidence, 0.75) } : null, // foto: sem texto pra conferir → confiança limitada
    };
  } catch (err) {
    await writeLog('warn', 'vision', `leitura estruturada da foto falhou: ${String(err).slice(0, 140)}`, { traceId });
    return null;
  }
}

/** 5. A linha do prontuário. */
async function gravarResultado(e: EntradaDaIngestao, exame: ExameExtraido, mediaId: string | null, source: 'pdf' | 'vision' | 'portal'): Promise<string | null> {
  const { data, error } = await db.from('user_exam_results').insert({
    user_id: e.userId,
    message_id: e.messageId ?? null,
    conversation_id: e.conversationId,
    exam_type: exame.exam_type,
    title: exame.title,
    summary: exame.summary,
    findings: exame.findings,
    exam_date: exame.exam_date,
    source,
    confidence: exame.confidence,
    media_id: mediaId,
    lab_fetch_id: e.labFetchId ?? null,
    laboratorio: exame.laboratorio ?? e.laboratorio ?? null,
  }).select('id').single();
  if (error) {
    await writeLog('error', 'exam', `insert do exame falhou: ${error.message.slice(0, 140)}`, { traceId: e.traceId, userId: e.userId });
    return null;
  }
  const examId = (data?.id as string | undefined) ?? null;
  if (examId) {
    // Card de memória pra recall ("seu exame de X do dia Y"); embedding vem no backfill do enricher.
    try {
      await saveMemoryCard({
        userId: e.userId, conversationId: e.conversationId ?? '', kind: 'fact',
        text: `Exame: ${exame.title}${exame.exam_date ? ` (${exame.exam_date})` : ''}${exame.laboratorio ? `, ${exame.laboratorio}` : ''} — ${exame.findings.length} marcador(es)${exame.summary ? ` — ${exame.summary}` : ''}`.slice(0, 200),
        tags: ['exame', exame.exam_type], confidence: 0.95, source: 'self_reported', embedding: null,
      });
    } catch { /* recall é best-effort; a linha do exame já está salva */ }
    await writeAudit({
      actorType: 'system', actorId: 'ingestao-de-exame', action: 'exam.ingested', userId: e.userId,
      conversationId: e.conversationId ?? undefined, targetTable: 'user_exam_results', targetId: examId,
      messageId: e.messageId ?? null, traceId: e.traceId,
      metadata: { origem: e.origem, source, achados: exame.findings.length, mediaId, labFetchId: e.labFetchId ?? null },
    });
  }
  return examId;
}

/**
 * A porta única. Nunca lança.
 */
export async function ingerirDocumentoDeExame(e: EntradaDaIngestao): Promise<ResultadoDaIngestao & { descricao?: string | null; mediaId: string | null }> {
  const ehPdf = e.mime.toLowerCase().includes('pdf');
  const mediaId = await guardarArquivoNoProntuario(e.userId, e.buffer, e.mime, e.traceId);
  const arquivoGuardado = mediaId !== null;

  if (ehPdf) {
    const leitura = await lerPdfCompleto(e.buffer, { maxCaracteres: MAX_CHARS_TEXTO }).catch(() => null);
    if (!leitura || !leitura.ok) {
      const motivo = leitura ? leitura.motivo : 'falha_ao_ler';
      await writeLog('info', 'exam', `documento PDF ilegível (${motivo}, ${e.buffer.length} bytes) — só o arquivo guardado`, { traceId: e.traceId, userId: e.userId });
      return { tipo: 'outro', arquivoGuardado, mediaId, motivoIlegivel: motivo, motivoNaoLido: mensagemDePdfIlegivel(motivo as never), texto: null, paginas: leitura?.paginas ?? 0 };
    }
    const texto = leitura.texto;
    const doPdf = { paginas: leitura.paginas, caracteres: leitura.caracteres, truncado: leitura.truncado };
    const cls = classificarTextoDeDocumento(texto);
    await writeLog('info', 'exam', `documento PDF lido (${leitura.paginas} pág, ${leitura.caracteres} chars) — tipo=${cls.tipo}${cls.sinais.length ? ` [${cls.sinais.join(',')}]` : ''}`, { traceId: e.traceId, userId: e.userId, origem: e.origem });
    if (cls.tipo !== 'laudo') {
      return { tipo: cls.tipo, arquivoGuardado, mediaId, texto, ...doPdf, previsaoLiberacao: cls.previsaoLiberacao ?? null, laboratorio: e.laboratorio ?? null };
    }
    const ext = await extrairExameDoTexto(texto, e.traceId);
    if (!ext) {
      return { tipo: 'laudo', examId: null, arquivoGuardado, mediaId, texto, ...doPdf, motivoNaoLido: 'a extração dos marcadores falhou' };
    }
    const examId = await gravarResultado(e, ext.exame, mediaId, e.origem === 'portal' ? 'portal' : 'pdf');
    await writeLog(examId ? 'info' : 'warn', 'exam', examId ? `📄 exame guardado no prontuário (${ext.exame.findings.length} marcador(es), ${ext.descartados} descartado(s), origem=${e.origem})` : 'exame lido mas NÃO gravado', { traceId: e.traceId, userId: e.userId, examId });
    return {
      tipo: 'laudo', examId, titulo: ext.exame.title, examDate: ext.exame.exam_date, laboratorio: ext.exame.laboratorio ?? e.laboratorio ?? null,
      achados: ext.exame.findings, descartados: ext.descartados, arquivoGuardado, mediaId, texto, ...doPdf,
      motivoNaoLido: examId ? null : 'falha ao gravar',
    };
  }

  // Foto
  const foto = await lerFotoDeDocumento(e.buffer, e.mime, e.traceId);
  if (!foto) {
    return { tipo: 'outro', arquivoGuardado, mediaId, motivoNaoLido: 'não consegui ler a foto' };
  }
  await writeLog('info', 'exam', `foto de documento lida — tipo=${foto.tipo}${foto.exame ? `, ${foto.exame.findings.length} marcador(es)` : ''}`, { traceId: e.traceId, userId: e.userId, origem: e.origem });
  if (foto.tipo !== 'laudo' || !foto.exame) {
    return { tipo: foto.tipo, arquivoGuardado, mediaId, descricao: foto.descricao, previsaoLiberacao: foto.previsaoLiberacao, laboratorio: foto.laboratorio ?? e.laboratorio ?? null };
  }
  // Foto: os valores são conferidos contra a PRÓPRIA descrição (mesma leitura) — é o que há.
  const { mantidos, descartados } = verificarAchadosNoTexto(foto.exame.findings, foto.descricao ?? '');
  const exame: ExameExtraido = { ...foto.exame, findings: (mantidos.length ? mantidos : foto.exame.findings).slice(0, MAX_ACHADOS) };
  const examId = await gravarResultado(e, exame, mediaId, 'vision');
  return {
    tipo: 'laudo', examId, titulo: exame.title, examDate: exame.exam_date, laboratorio: exame.laboratorio ?? foto.laboratorio ?? null,
    achados: exame.findings, descartados: mantidos.length ? descartados.length : 0, arquivoGuardado, mediaId, descricao: foto.descricao,
    motivoNaoLido: examId ? null : 'falha ao gravar',
  };
}
