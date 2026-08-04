/**
 * founder-alerter — alerta crítico chega no WhatsApp do FUNDADOR.
 *
 * ─── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────
 * Os 12 pontos de alerta do `anomaly-detector` chamavam só o Telegram, e
 * `TELEGRAM_BOT_TOKEN` nunca foi configurado. Resultado medido em produção (04/08):
 *
 *   debug [telegram] Telegram não configurado — alerta
 *                    "💊 Remédio/consulta NÃO entregue (janela fechada)" silenciado
 *
 * O detector do anti-hipertensivo do Arthur FUNCIONAVA. Ele só não tinha para onde
 * falar. Construir uma detecção e não dar destino a ela é a mesma classe de erro que
 * "detecção que não propaga é pior que ausência de detecção" — só que na última milha.
 *
 * ─── DECISÕES ────────────────────────────────────────────────────────────────
 * • O alerta SEMPRE chega, não só quando a janela de 24h está aberta. Janela aberta →
 *   texto livre (grátis); fechada ou sem conversa → template aprovado, que a Meta
 *   aceita fora da janela. Um canal de alerta que só funciona metade do tempo não é
 *   canal de alerta.
 * • Passa pela FILA (CLAUDE.md §5) — rate limit é o que evita ban, e alerta em rajada
 *   é exatamente o cenário de rajada.
 * • O corpo é REDIGIDO (`redactPII`) antes de sair. O destinatário é o fundador, mas o
 *   transporte é a Meta: telefone/CPF de paciente não trafegam por aqui.
 * • O telefone vem de env (`FOUNDER_ALERT_PHONE`) e NUNCA do repositório.
 * • Teto diário no caminho PAGO (template). O caminho grátis não tem teto: se a janela
 *   está aberta, avisar mais é sempre melhor.
 */
import { db, writeLog, writeEvent, redactPII } from '@iasaude/db';
import { SARA_INSTANCE, whatsappJidVariants, isWabaWindowOpen, toE164BR } from '@iasaude/shared';
import { isSimulatorMode, providerFor } from '@iasaude/whatsapp';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { buildReengageTemplate, reengageTemplateEnabled } from '../config/template-registry.js';

export interface FounderAlertOpts {
  title: string;
  body: string;
  severity?: 'info' | 'warn' | 'high' | 'critical';
  throttleKey?: string;
}

const THROTTLE_MS = 60_000;
const lastSentByKey = new Map<string, number>();

/**
 * Teto de alertas por TEMPLATE por dia. O template é pago e conta pro risco de ban;
 * 8/dia cobre um incidente real com folga e impede que um detector em loop torre a conta.
 */
export const FOUNDER_TEMPLATE_DAILY_CAP = 8;
const templateSentAt: number[] = [];

/** Nome do fundador no template (só cosmético — o conteúdo vai na 2ª variável). */
const FOUNDER_FIRST_NAME = 'Hiago';

/** Quantos alertas por template já saíram nas últimas 24h. */
function templatesLast24h(nowMs: number): number {
  while (templateSentAt.length > 0 && nowMs - (templateSentAt[0] ?? 0) > 86_400_000) templateSentAt.shift();
  return templateSentAt.length;
}

/**
 * Decide o canal do alerta. PURO e testável — é a decisão que determina se o alerta
 * chega ou evapora, e ela não pode depender de I/O pra ser verificada.
 */
export function chooseFounderChannel(s: {
  windowOpen: boolean;
  templatesOn: boolean;
  templatesUsedToday: number;
  cap: number;
  severity: 'info' | 'warn' | 'high' | 'critical';
}): 'text' | 'template' | 'blocked' {
  if (s.windowOpen) return 'text';
  if (!s.templatesOn) return 'blocked';
  // `critical` fura o teto: uma dose de anti-hipertensivo não entregue vale o template.
  if (s.templatesUsedToday >= s.cap && s.severity !== 'critical') return 'blocked';
  return 'template';
}

/** A janela de 24h do fundador está aberta? (mesma disciplina do estabelecimento.) */
async function founderWindow(phoneE164: string): Promise<{ open: boolean; conversationId: string | null }> {
  // Canal sem restrição de janela (uazapi/simulador): sempre "aberto".
  if (isSimulatorMode() || providerFor(SARA_INSTANCE) !== 'zpro') return { open: true, conversationId: null };

  const jids = whatsappJidVariants(phoneE164);
  const { data: convs, error } = await db
    .from('conversations')
    .select('id')
    .eq('whatsapp_instance', SARA_INSTANCE)
    .in('whatsapp_jid', jids)
    .limit(1);
  // Erro de query NÃO pode virar "janela aberta" aqui: mandaríamos texto livre que a Meta
  // rejeita e o alerta sumiria. Na dúvida vai por template, que sempre chega.
  if (error) return { open: false, conversationId: null };
  const conv = convs?.[0];
  if (!conv) return { open: false, conversationId: null }; // ele nunca escreveu → janela fechada

  const { data: last } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1);
  const lastMs = last?.[0]?.created_at ? Date.parse(last[0].created_at as string) : null;
  return { open: isWabaWindowOpen(lastMs, Date.now()), conversationId: conv.id as string };
}

/**
 * Manda o alerta pro WhatsApp do fundador. Devolve `true` só se REALMENTE foi despachado
 * (nunca "o POST não lançou" — golden rule: delivered tem que significar entrega).
 */
export async function sendFounderAlert(opts: FounderAlertOpts): Promise<boolean> {
  const raw = process.env['FOUNDER_ALERT_PHONE']?.trim();
  if (!raw) {
    await writeLog('warn', 'alerta', `alerta "${opts.title}" NÃO enviado — FOUNDER_ALERT_PHONE não configurado`, {});
    return false;
  }
  // O número pode vir sem o 9º dígito (o fundador passou 12 dígitos). `toE164BR` normaliza
  // e `whatsappJidVariants` cobre as duas formas na busca da conversa — nunca ADIVINHAMOS o
  // dígito no envio, mandamos exatamente o que foi configurado.
  const phone = toE164BR(raw) ?? (raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`);

  const sev = opts.severity ?? 'warn';
  if (opts.throttleKey && sev !== 'critical') {
    const now = Date.now();
    const last = lastSentByKey.get(opts.throttleKey) ?? 0;
    if (now - last < THROTTLE_MS) return false;
    lastSentByKey.set(opts.throttleKey, now);
  }

  // 🔒 Corpo REDIGIDO. O destinatário é o fundador, mas o transporte é a Meta —
  // telefone e CPF de paciente não trafegam num alerta operacional.
  const emoji = sev === 'critical' ? '🆘' : sev === 'high' || sev === 'warn' ? '⚠️' : 'ℹ️';
  const tituloSeguro = redactPII(opts.title);
  const corpoSeguro = redactPII(opts.body);
  const texto = `${emoji} ${tituloSeguro}\n\n${corpoSeguro}`.slice(0, 900);

  const nowMs = Date.now();
  // UMA leitura só: `founderWindow` faz 2 queries e o resultado serve pro canal E pro espelho.
  const janela = await founderWindow(phone);
  const canal = chooseFounderChannel({
    windowOpen: janela.open,
    templatesOn: reengageTemplateEnabled(),
    templatesUsedToday: templatesLast24h(nowMs),
    cap: FOUNDER_TEMPLATE_DAILY_CAP,
    severity: sev,
  });

  if (canal === 'blocked') {
    // Nunca em silêncio: o alerta que não chegou é ele mesmo um fato operacional.
    await writeLog('error', 'alerta', `alerta "${tituloSeguro}" NÃO chegou ao fundador — janela de 24h fechada e template indisponível/no teto (${templatesLast24h(nowMs)}/${FOUNDER_TEMPLATE_DAILY_CAP})`, {
      severity: sev, throttleKey: opts.throttleKey,
    });
    void writeEvent({ eventName: 'founder_alert.blocked', severity: 'critical', payload: { title: tituloSeguro, severity: sev } });
    return false;
  }

  // 📝 ESPELHO + VERDADE DE ENTREGA. Sem isto o alerta saía sem `messageId`, então
  // `stampDelivery` era no-op e "enviado" significava só "o POST não lançou" — exatamente
  // a mentira que esta base passou um mês eliminando. E sem linha em `messages` o alerta
  // não existia em lugar nenhum consultável além do log. Só espelha se a conversa JÁ
  // existe: um canal de alerta não deve criar paciente nem poluir a base.
  const conversationId = janela.conversationId;
  let mirrorId: string | undefined;
  if (conversationId) {
    const { data: mirror } = await db.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      sender_role: 'assistant',
      content_type: 'text',
      content: canal === 'template' ? buildReengageTemplate(FOUNDER_FIRST_NAME, texto).text : texto,
      trace_id: `alert-${sev}`,
    }).select('id').maybeSingle();
    mirrorId = (mirror?.id as string | undefined) ?? undefined;
    await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);
  }

  try {
    if (canal === 'text') {
      await dispatchOutbound({ kind: 'text', instance: SARA_INSTANCE, phoneE164: phone, text: texto, messageId: mirrorId });
    } else {
      // O template é o MESMO aprovado do re-engajamento: {{1}} nome, {{2}} o motivo —
      // e é no motivo que o alerta viaja. Funciona fora da janela, que é o ponto.
      const tpl = buildReengageTemplate(FOUNDER_FIRST_NAME, texto);
      await dispatchOutbound({
        kind: 'template', instance: SARA_INSTANCE, phoneE164: phone,
        templateName: tpl.name, templateLanguage: tpl.language, templateVariables: tpl.variables, text: tpl.text,
        messageId: mirrorId,
      });
      templateSentAt.push(nowMs);
    }
  } catch (err) {
    await writeLog('error', 'alerta', `falha ao despachar alerta ao fundador (${canal}): ${String(err).slice(0, 140)}`, {});
    return false;
  }

  await writeLog(sev === 'critical' ? 'error' : 'warn', 'alerta', `alerta enviado ao fundador por WhatsApp (${canal}): ${tituloSeguro}`, {
    severity: sev, canal, throttleKey: opts.throttleKey,
  });
  void writeEvent({
    eventName: 'founder_alert.sent',
    severity: sev === 'critical' ? 'critical' : 'info',
    payload: { title: tituloSeguro, severity: sev, canal, throttle_key: opts.throttleKey },
  });
  return true;
}
