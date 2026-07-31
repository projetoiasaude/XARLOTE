// Cliente de SAÍDA do zpro (API Externa) — WhatsApp Business API oficial.
//
// Contrato CONFIRMADO pelo OpenAPI oficial do zpro (rota /v2/api/external/{ApiID}):
//   - Auth:    Authorization: Bearer <token>
//   - Número:  só dígitos com DDI, sem '+', sem @c.us  (ex.: "5562998345024")
//   - Texto:   POST {externalUrl}                 { number, body }
//   - MídiaURL POST {externalUrl}/url             { number, body(=legenda), mediaUrl }
//   - Base64:  POST {externalUrl}/base64          { number, body, base64Data, mimeType, fileName }
//   - Voz/PTT: POST {externalUrl}/voice           { number, audio(=URL) }
//   - Botões:  POST {externalUrl}/sendButtonWABA  { number, message, button1..3, ticketId }
//
// externalUrl = `${ZPRO_BASE_URL}/v2/api/external/${ZPRO_<INSTANCE>_API_ID}`
import axios from 'axios';
import { randomUUID } from 'crypto';

interface ZproConfig {
  externalUrl: string;
  token: string;
}

export function buildZproConfig(instance: string): ZproConfig {
  const base = (process.env['ZPRO_BASE_URL'] ?? '').replace(/\/+$/, '');
  const upper = instance.toUpperCase();
  const apiId = process.env[`ZPRO_${upper}_API_ID`] ?? '';
  const token = process.env[`ZPRO_${upper}_TOKEN`] ?? '';
  const externalUrl = base && apiId ? `${base}/v2/api/external/${apiId}` : '';
  return { externalUrl, token };
}

async function zproCall(cfg: ZproConfig, path: string, body: unknown): Promise<unknown> {
  if (!cfg.externalUrl) {
    throw new Error('zpro não configurado (ZPRO_BASE_URL / ZPRO_*_API_ID / ZPRO_*_TOKEN)');
  }
  try {
    const res = await axios.post(`${cfg.externalUrl}${path}`, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      timeout: 15_000,
    });
    // O zpro às vezes responde 200 com `{success:false, error:...}` (ex.: formato
    // de áudio que o WABA não entrega). Sem checar isso, o envio "falha em
    // silêncio" — tratamos como erro pra o caller cair no fallback (texto).
    const data = res.data as { success?: boolean; error?: string } | null;
    if (data && typeof data === 'object' && data.success === false) {
      throw new Error(`zpro ${path || '/text'} success=false: ${String(data.error ?? '').slice(0, 300)}`);
    }
    return res.data;
  } catch (err) {
    // Propaga o CORPO da resposta de erro do zpro pra mensagem do Error — assim o
    // log da fila outbound (que imprime String(err)) mostra POR QUE o zpro recusou
    // (ex.: 400 com o campo faltante), em vez de só "AxiosError 400".
    const ax = err as { response?: { status?: number; data?: unknown } };
    const status = ax.response?.status;
    if (status) {
      let detail: string;
      try {
        detail =
          typeof ax.response?.data === 'string'
            ? ax.response.data
            : JSON.stringify(ax.response?.data);
      } catch {
        detail = '<unserializable>';
      }
      throw new Error(`zpro ${path || '/text'} HTTP ${status}: ${detail.slice(0, 400)}`);
    }
    throw err;
  }
}

/**
 * O shape da resposta do zpro não é documentado — extraímos um id best-effort.
 * Prod 27/07 provou o envelope `{ success:boolean, data:object }` com o id em ALGUM lugar
 * dentro de `data` (nenhum candidato de raiz casou → providerMessageId vazio em 100%).
 * Então procuramos os mesmos candidatos na RAIZ e DENTRO de `data` — incluindo `msg.id` e
 * `message.id`, o vocabulário que o zpro usa no webhook de entrada (zpro-normalize.ts).
 */
export function pickMessageId(data: unknown): string {
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const scopes = [root, root?.['data']];
  for (const s of scopes) {
    if (!s || typeof s !== 'object') continue;
    const d = s as Record<string, unknown>;
    const candidates: unknown[] = [
      d['messageId'],
      d['id'],
      d['wamid'],
      (d['message'] as Record<string, unknown> | undefined)?.['id'],
      (d['msg'] as Record<string, unknown> | undefined)?.['id'],
      Array.isArray(d['messages']) ? (d['messages'][0] as Record<string, unknown>)?.['id'] : undefined,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c;
      if (typeof c === 'number') return String(c);
    }
  }
  return '';
}

/**
 * Assinatura ESTRUTURAL de um JSON — só CHAVES e tipos, NUNCA valores (o corpo carrega
 * telefone/texto = PII). Profundidade limitada; é o que falta pra cravar o caminho do
 * providerMessageId quando nenhum candidato casa.
 */
export function describeShape(v: unknown, depth = 3): string {
  if (Array.isArray(v)) {
    if (depth <= 0 || v.length === 0) return 'array';
    return `array<${describeShape(v[0], depth - 1)}>`;
  }
  if (v && typeof v === 'object') {
    if (depth <= 0) return 'object';
    const inner = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}:${describeShape(val, depth - 1)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  return v === null ? 'null' : typeof v;
}

function toNumber(phoneE164: string): string {
  return phoneE164.replace(/\D/g, '');
}

export async function zproSendText(
  instance: string,
  phoneE164: string,
  text: string,
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const data = await zproCall(cfg, '', {
    number: toNumber(phoneE164),
    body: text,
    externalKey: randomUUID(),
    isClosed: false,
  });
  const messageId = pickMessageId(data);
  // 🔬 `providerMessageId` vazio em 100% dos envios de 27/07 e o log raso só revelou o
  // envelope `{ success, data }`. Sem esse id somos cegos pra entrega dupla — e é exatamente
  // o que o suporte do zpro pede pra investigar. Agora logamos a assinatura PROFUNDA
  // (chaves+tipos até 3 níveis, NUNCA valores: o corpo carrega telefone/texto = PII) pra
  // cravar o caminho do id e apertar o pickMessageId na sequência.
  if (!messageId && data && typeof data === 'object') {
    console.warn(`[zpro] resposta de envio SEM messageId reconhecido — shape=${describeShape(data)}`);
  }
  return { messageId };
}

/**
 * Botões interativos (WABA reply buttons, máx 3) via /sendButtonWABA.
 *
 * O payload do zpro é "achatado" (button1/button2/button3, strings).
 * `ticketId` é incluído quando conhecido (vem do webhook de entrada). Quando
 * ausente, mandamos sem — alguns deploys do zpro resolvem o ticket pelo número;
 * se rejeitar, o caller (fila/handler) já degrada pra texto.
 *
 * O zpro não tem campo de footer aqui — então embutimos o footer no corpo.
 */
export async function zproSendMenu(
  instance: string,
  phoneE164: string,
  text: string,
  choices: string[],
  opts: { footerText?: string; ticketId?: number | string } = {},
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const top3 = choices.slice(0, 3);
  const message = opts.footerText ? `${text}\n\n${opts.footerText}` : text;
  const body: Record<string, unknown> = {
    number: toNumber(phoneE164),
    message,
    externalKey: randomUUID(),
  };
  top3.forEach((label, i) => {
    body[`button${i + 1}`] = label;
  });
  if (opts.ticketId !== undefined && opts.ticketId !== null && opts.ticketId !== '') {
    const tid = Number(opts.ticketId);
    body['ticketId'] = Number.isFinite(tid) ? tid : opts.ticketId;
  }
  const data = await zproCall(cfg, '/sendButtonWABA', body);
  return { messageId: pickMessageId(data) };
}

export async function zproSendImage(
  instance: string,
  phoneE164: string,
  imageUrl: string,
  caption?: string,
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const data = await zproCall(cfg, '/url', {
    number: toNumber(phoneE164),
    mediaUrl: imageUrl,
    body: caption ?? '',
    externalKey: randomUUID(),
    isClosed: false,
  });
  return { messageId: pickMessageId(data) };
}

/**
 * Áudio. O zpro só faz PTT (voice note) por URL (/voice). Quando temos um
 * Buffer (TTS gerado), não há URL pública — então mandamos via /base64 como
 * arquivo de áudio. Se o caller quiser PTT garantido, precisa passar URL.
 */
export async function zproSendAudio(
  instance: string,
  phoneE164: string,
  audio: Buffer | string,
  opts: { mime?: string } = {},
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const number = toNumber(phoneE164);
  if (typeof audio === 'string') {
    // WABA: /voice (PTT) NÃO é suportado nesse canal (ERR_CHANNEL_NOT_SUPPORTED).
    // Mídia de áudio vai pelo /url (mesmo endpoint da imagem). Em ogg/opus o
    // WhatsApp renderiza como voice note.
    // /url exige `body` não-vazio (validação do zpro). Em áudio o WhatsApp não
    // mostra caption, então um espaço basta pra passar a validação.
    const data = await zproCall(cfg, '/url', {
      number,
      mediaUrl: audio,
      body: ' ',
      externalKey: randomUUID(),
      isClosed: false,
    });
    return { messageId: pickMessageId(data) };
  }
  // Buffer → /base64. O fileName precisa BATER com o mime, senão o zpro/WABA pode
  // recusar ou tratar como arquivo errado. (audio/mpeg→.mp3, audio/ogg→.ogg, …)
  const mime = opts.mime ?? 'audio/ogg';
  const ext = /mpeg|mp3/i.test(mime)
    ? 'mp3'
    : /ogg|opus/i.test(mime)
      ? 'ogg'
      : /wav/i.test(mime)
        ? 'wav'
        : /mp4|m4a|aac/i.test(mime)
          ? 'm4a'
          : 'mp3';
  const data = await zproCall(cfg, '/base64', {
    number,
    body: '',
    base64Data: audio.toString('base64'),
    mimeType: mime,
    fileName: `audio.${ext}`,
    externalKey: randomUUID(),
    isClosed: false,
  });
  return { messageId: pickMessageId(data) };
}

/**
 * Envia um TEMPLATE (HSM) aprovado na Meta — abertura fria de conversa no WABA.
 *
 * Contrato CONFIRMADO (Postman oficial do zpro, "SendTemplateWaba"):
 *   POST {externalUrl}/template
 *   {
 *     number, isClosed:false,
 *     templateData: {                       // = payload cru da Cloud API da Meta
 *       messaging_product:"whatsapp", to:<mesmo number>, type:"template",
 *       template: { name, language:{code}, components?:[{type:"body",parameters:[{type:"text",text}]}] }
 *     },
 *     validateNumber:false                  // recomendado p/ WABA (usa o número como enviado;
 *   }                                       // sem normalizar o 9º dígito BR → evita ticket duplicado)
 * Sem variáveis → sem `components` (igual ao exemplo hello_world). Auth (Bearer) e
 * tratamento de erro reusam `zproCall`. O path é sobreponível por `ZPRO_TEMPLATE_PATH`
 * caso o zpro mude (default `/template`).
 */
export async function zproSendTemplate(
  instance: string,
  phoneE164: string,
  template: { name: string; language: string; variables: string[] },
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const path = process.env['ZPRO_TEMPLATE_PATH']?.trim() || '/template';
  const number = toNumber(phoneE164);

  const tpl: Record<string, unknown> = {
    name: template.name,
    language: { code: template.language },
  };
  if (template.variables.length) {
    // variáveis do CORPO na ORDEM dos slots {{1}},{{2}},… (aprovados na Meta)
    tpl['components'] = [
      { type: 'body', parameters: template.variables.map((text) => ({ type: 'text', text })) },
    ];
  }

  const body = {
    number,
    externalKey: randomUUID(), // obrigatório em todo envio zpro (gotcha #1); faltava aqui
    isClosed: false,
    templateData: {
      messaging_product: 'whatsapp',
      to: number,
      type: 'template',
      template: tpl,
    },
    validateNumber: false,
  };
  const data = await zproCall(cfg, path.startsWith('/') ? path : `/${path}`, body);
  return { messageId: pickMessageId(data) };
}

// A API externa do zpro não expõe checagem de número nem status de instância de
// forma documentada. Como nenhum caller depende disso hoje, devolvemos otimista
// (não bloquear envio / não derrubar health-check).
export async function zproCheckWhatsApp(
  _instance: string,
  _phoneE164: string,
): Promise<{ exists: boolean; jid?: string }> {
  return { exists: true };
}

export async function zproGetInstanceStatus(_instance: string): Promise<{ connected: boolean }> {
  return { connected: true };
}
