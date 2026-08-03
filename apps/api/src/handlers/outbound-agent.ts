import { db, writeLog, writeEvent } from '@iasaude/db';
import { isSimulatorMode, zproConfigured } from '@iasaude/whatsapp';
import { AGENT_INSTANCE, humanizeSupplierText, checkOutboundSanity, isWabaWindowOpen } from '@iasaude/shared';

/**
 * Relê a mensagem antes de mandar pra um terceiro real (clínica/farmácia).
 * Conserta o que dá (interpolação degenerada) e BLOQUEIA o que não dá conserto seguro —
 * é melhor a Xarlote ficar calada e alertar do que mandar "consulta de consulta" ou
 * "undefined" pra uma recepção. Devolve o texto são, ou null se não deve enviar.
 */
async function assertSane(
  text: string,
  alvo: string,
  conversationId: string,
  traceId: string,
): Promise<string | null> {
  const { text: fixed, blockers, repairs } = checkOutboundSanity(text);
  if (repairs.length) {
    await writeLog('warn', 'outbound', `🪞 Auto-verificação corrigiu a fala antes de enviar pra ${alvo}: ${repairs.join('; ')}`, { traceId, conversationId });
  }
  if (blockers.length) {
    await writeLog('error', 'outbound', `🛑 Envio pra ${alvo} BLOQUEADO pela auto-verificação: ${blockers.join('; ')} — texto: "${text.slice(0, 120)}"`, { traceId, conversationId });
    return null;
  }
  return fixed;
}
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { buildTemplatePayload, humanizeTemplate, templatesEnabled, type TemplateKey } from '../config/template-registry.js';
import { getRedisClient } from '../queue-config.js';

/** O número do agente está pronto pra enviar de verdade? (uazapi OU zpro/WABA) */
function agentChannelReady(): boolean {
  return !!process.env['UAZAPI_AGENT_TOKEN'] || zproConfigured(AGENT_INSTANCE);
}

// ─── JANELA DE 24h NA PERNA DO ESTABELECIMENTO ────────────────────────────────
//
// 🔴 A perna do PACIENTE ganhou, ao longo de um mês, toda a maquinaria de verdade de
// entrega: checagem de janela, template de reabertura, cap, carimbo em `messages`. A perna
// do ESTABELECIMENTO (clínica/farmácia) nunca ganhou nada disso — mandava texto livre
// direto pra fila e seguia adiante. Como a Meta REJEITA texto livre fora de 24h do último
// inbound do contato, todo follow-up a uma clínica/farmácia calada há mais de um dia
// simplesmente evaporava — e, sem carimbo, nós não tínhamos como saber.
//
// Caso que expôs isso (Ciro/Rita, 03/08): o último inbound da secretária foi 25/07 16:05.
// Reabrimos a negociação em 30/07 e cutucamos em 31/07, as duas vezes em texto livre, 5 e
// 6 dias fora da janela. `delivery_status` NULL nas três. A leitura fácil era "a clínica
// não responde"; a leitura correta é que provavelmente ela nunca recebeu.
//
// Isto vale pra TODA farmácia e clínica desde sempre, e é candidato a explicar boa parte
// do gargalo de conversão ("estabelecimento não responde").

/** Máximo 1 template por estabelecimento por 24h — HSM é pago e template demais queima o número. */
const ESTABLISHMENT_TEMPLATE_COOLDOWN_S = 24 * 60 * 60;

/** Template pra estabelecimento pode ser desligado sem redeploy (custo/política Meta). */
function establishmentTemplateEnabled(): boolean {
  return process.env['ESTABLISHMENT_TEMPLATE_ENABLED'] !== 'false';
}

/**
 * A janela de 24h com ESTE estabelecimento está aberta? Reusa `isWabaWindowOpen`, o mesmo
 * utilitário que a perna do paciente usa — a regra da Meta é uma só.
 */
export async function establishmentWindow(conversationId: string): Promise<{ open: boolean; lastInboundMs: number | null }> {
  const { data } = await db.from('messages').select('created_at')
    .eq('conversation_id', conversationId).eq('direction', 'in')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const iso = data?.created_at as string | undefined;
  const lastInboundMs = iso ? new Date(iso).getTime() : null;
  return { open: isWabaWindowOpen(lastInboundMs, Date.now()), lastInboundMs };
}

/**
 * Reivindica o slot de template deste estabelecimento (1 por 24h).
 *
 * FAIL-CLOSED de propósito, ao contrário da trava de envio: se o Redis estiver fora, não
 * dá pra saber quantos templates já saíram, e template é dinheiro + risco de ban. Na
 * dúvida NÃO manda — e o `window_blocked` registra que o follow-up não saiu, então o
 * silêncio não é silencioso.
 */
async function claimEstablishmentTemplateSlot(phoneE164: string, traceId: string): Promise<boolean> {
  const key = `estab:tpl:${phoneE164.replace(/\D/g, '')}`;
  try {
    const ok = await getRedisClient().set(key, '1', 'EX', ESTABLISHMENT_TEMPLATE_COOLDOWN_S, 'NX');
    return ok !== null;
  } catch (err) {
    await writeLog('warn', 'outbound', `Cooldown de template a estabelecimento indisponível (Redis) — NÃO enviando template por precaução: ${String(err).slice(0, 120)}`, { traceId });
    return false;
  }
}

/**
 * POLÍTICA de canal pra estabelecimento — decisão PURA (testada em
 * tests/establishment-window.test.ts). Extraída de propósito: é a regra que decide se um
 * follow-up alcança a clínica ou evapora, e regra dessa consequência não pode viver
 * enterrada em código que só roda com banco e Redis.
 */
export function chooseEstablishmentChannel(s: {
  windowOpen: boolean;
  hasSubject: boolean;
  templatesOn: boolean;
  templateSlotFree: boolean;
}): 'text' | 'template' | 'blocked' {
  if (s.windowOpen) return 'text';              // dentro de 24h, texto livre é permitido
  if (!s.templatesOn) return 'blocked';          // template desligado → não há caminho
  if (!s.hasSubject) return 'blocked';           // a variável do template é obrigatória
  if (!s.templateSlotFree) return 'blocked';     // 1 template/24h por estabelecimento
  return 'template';
}

/** Carimba o veredito no espelho. Observabilidade: nunca derruba o envio. */
async function stampEstablishmentDelivery(messageId: string | null, status: 'window_blocked'): Promise<void> {
  if (!messageId) return;
  try {
    await db.from('messages').update({ delivery_status: status, delivered_at: null }).eq('id', messageId);
  } catch { /* best-effort */ }
}

/**
 * PONTO ÚNICO de entrega a estabelecimento. Decide entre texto livre (janela aberta),
 * template de reabertura (janela fechada) e registro honesto de não-entrega.
 */
async function deliverToEstablishment(args: {
  conversationId: string;
  phoneE164: string;
  text: string;
  messageId: string | null;
  templateSubject?: string;
  alvo: 'farmácia' | 'clínica';
  category: 'agent' | 'clinic';
  traceId: string;
}): Promise<void> {
  const { conversationId, phoneE164, text, messageId, alvo, category, traceId } = args;
  const { open, lastInboundMs } = await establishmentWindow(conversationId);

  if (open) {
    // `messageId` vai junto — é ele que faz o worker carimbar delivered/failed. Sem ele,
    // toda mensagem a estabelecimento ficava com `delivery_status` NULL pra sempre.
    await dispatchOutbound({ kind: 'text', instance: AGENT_INSTANCE, phoneE164, text, traceId, messageId: messageId ?? undefined });
    return;
  }

  const silentH = lastInboundMs ? Math.round((Date.now() - lastInboundMs) / 3_600_000) : null;
  const assunto = (args.templateSubject ?? '').trim();
  const templatesOn = templatesEnabled() && establishmentTemplateEnabled();

  // A reivindicação do slot só acontece se todo o resto permitir — assim um caminho que ia
  // ser bloqueado de qualquer jeito não queima a cota de template de 24h do estabelecimento.
  const slotFree = !!assunto && templatesOn && (await claimEstablishmentTemplateSlot(phoneE164, traceId));
  const canal = chooseEstablishmentChannel({ windowOpen: false, hasSubject: !!assunto, templatesOn, templateSlotFree: slotFree });

  if (canal === 'template') {
    try {
      const payload = buildTemplatePayload('general', [assunto]);
      await dispatchOutbound({
        kind: 'template', instance: AGENT_INSTANCE, phoneE164,
        templateName: payload.name, templateLanguage: payload.language, templateVariables: payload.variables,
        text: humanizeTemplate('general', [assunto]), traceId, messageId: messageId ?? undefined,
      });
      await writeLog('info', category, `Janela de 24h fechada com a ${alvo} (${silentH ?? '?'}h sem retorno) — follow-up saiu por TEMPLATE de reabertura`, { traceId, conversationId });
      return;
    } catch (err) {
      await writeLog('warn', category, `Template de reabertura pra ${alvo} inválido: ${String(err).slice(0, 160)}`, { traceId, conversationId });
    }
  }

  // Não havia caminho. Registra de forma que dê pra ver depois — antes isto era silêncio.
  await stampEstablishmentDelivery(messageId, 'window_blocked');
  await writeLog('warn', category, `Mensagem pra ${alvo} NÃO entregue — janela de 24h fechada (${silentH ?? '?'}h sem retorno dela) e sem template de reabertura disponível`, {
    traceId, conversationId, silentHours: silentH,
  });
  await writeEvent({
    eventName: 'establishment.window_blocked',
    conversationId,
    payload: { alvo, silent_hours: silentH, had_subject: !!assunto, templates_on: templatesEnabled() && establishmentTemplateEnabled() },
  }).catch(() => { /* evento é best-effort */ });
}

/**
 * Sends a message from the agent to a pharmacy supplier.
 *
 * In simulator mode: message is persisted to DB only.
 * The user responds manually via the simulator pharmacy panel.
 * (POST /api/simulate/pharmacy-reply)
 *
 * In real mode: message is sent via uazapi WhatsApp.
 */
export async function sendOutboundToSupplier(
  conversationId: string,
  supplierPhone: string,
  text: string,
  traceId: string,
  /** Assunto curto pro template de reabertura, se a janela de 24h estiver fechada. */
  templateSubject?: string,
): Promise<void> {
  // HIGIENE HUMANA no ponto ÚNICO de saída pra farmácia (incidente Santa Lúcia 07/07:
  // farmácia real achou que era robô e não entregou): tira TODO emoji e troca travessão
  // por vírgula — vale pro texto do LLM E pros determinísticos, sem caçar cada string.
  text = humanizeSupplierText(text);
  // 🪞 AUTO-VERIFICAÇÃO: relê o que vai sair antes de sair (ver checkOutboundSanity).
  {
    const sane = await assertSane(text, 'farmácia', conversationId, traceId);
    if (!sane) return;
    text = sane;
  }
  // SEM dedup aqui (review): a conversa de fornecedor é COMPARTILHADA por telefone entre
  // pedidos concorrentes; uma msg idêntica (ex.: pergunta de frete determinística) de
  // OUTRO pedido seria suprimida por engano. Dedup só no canal do usuário.
  const { data: mirror } = await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  }).select('id').single();

  await db.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  // Modo simulador OU canal do agente não pronto (nem uazapi nem zpro configurados)
  // → apenas persistimos a mensagem e o operador responde manual no dashboard.
  // ⚠️ CRÍTICO: usar agentChannelReady() (zpro-aware), NÃO só UAZAPI_AGENT_TOKEN —
  // senão, com o agente no zpro (token uazapi vazio), TODA resposta à farmácia era
  // descartada em silêncio (só a abertura por template saía).
  if (isSimulatorMode() || !agentChannelReady()) {
    await writeLog('info', 'agent', 'Mensagem do agente salva — aguardando resposta manual no dashboard (chat por farmácia)', {
      traceId, conversationId,
    });
    return;
  }

  await deliverToEstablishment({
    conversationId, phoneE164: supplierPhone, text,
    messageId: (mirror?.id as string | undefined) ?? null,
    templateSubject, alvo: 'farmácia', category: 'agent', traceId,
  });
}

/**
 * Envia mensagem da Xarlote pra uma CLÍNICA (fluxo de consulta médica).
 *
 * Diferente da farmácia, clínicas são descobertas no Google (números reais de
 * médicos). Por segurança, o envio real só acontece quando explicitamente
 * ativado via `CLINIC_OUTBOUND_MODE=real`. O DEFAULT é simulação: a mensagem é
 * persistida e o operador responde como a clínica pelo painel do /simulator
 * (POST /api/simulate/clinic-reply).
 *
 * Isso evita mandar WhatsApp pra médicos reais durante testes/beta.
 */
export async function sendOutboundToClinic(
  conversationId: string,
  clinicPhone: string,
  text: string,
  traceId: string,
  /** Assunto curto pro template de reabertura, se a janela de 24h estiver fechada. */
  templateSubject?: string,
): Promise<void> {
  text = humanizeSupplierText(text); // paridade com a farmácia: sem emoji, sem travessão
  {
    const sane = await assertSane(text, 'clínica', conversationId, traceId);
    if (!sane) return;
    text = sane;
  }
  // SEM dedup aqui (review): mesma razão do fornecedor — conversa de estabelecimento
  // compartilhada; dedup só no canal do usuário.
  const { data: mirror } = await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  }).select('id').single();
  await db.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  const realMode = process.env['CLINIC_OUTBOUND_MODE'] === 'real';

  // Default = simulação. Só manda real se CLINIC_OUTBOUND_MODE=real E não simulador E
  // o canal do agente pronto (uazapi OU zpro — agentChannelReady é zpro-aware).
  if (!realMode || isSimulatorMode() || !agentChannelReady()) {
    await writeLog('info', 'clinic', 'Mensagem pra clínica salva (modo simulação) — responda pelo painel do simulador', {
      traceId, conversationId,
    });
    return;
  }

  await deliverToEstablishment({
    conversationId, phoneE164: clinicPhone, text,
    messageId: (mirror?.id as string | undefined) ?? null,
    templateSubject, alvo: 'clínica', category: 'clinic', traceId,
  });
  await writeLog('info', 'clinic', `Mensagem REAL enfileirada pra clínica ${clinicPhone.slice(0, 8)}***`, { traceId, conversationId });
}

// ─── Abertura FRIA via TEMPLATE (HSM/WABA) — Fase 6 ──────────────────────────
// A 1ª mensagem proativa no número oficial PRECISA ser template (a Meta rejeita
// texto livre fora de janela). Estas funções persistem a versão humanizada (vista
// no dashboard) e enfileiram kind='template' com a humanizada como fallback de
// texto. Só são chamadas quando `templatesEnabled()` — ver os initiate*.

/** Abertura fria pra FARMÁCIA via template. */
export async function sendTemplateOpeningToSupplier(
  conversationId: string,
  supplierPhone: string,
  templateKey: TemplateKey,
  variables: string[],
  traceId: string,
): Promise<void> {
  const human = humanizeTemplate(templateKey, variables);
  // Valida o payload ANTES de persistir/despachar. Se a contagem/var falhar
  // (buildTemplatePayload lança), degrada pra TEXTO — nunca deixa a abertura muda.
  let payload;
  try {
    payload = buildTemplatePayload(templateKey, variables);
  } catch (err) {
    await writeLog('warn', 'agent', `Template inválido (${templateKey}) — caindo pra texto: ${String(err).slice(0, 200)}`, { traceId, conversationId });
    await sendOutboundToSupplier(conversationId, supplierPhone, human, traceId);
    return;
  }

  await db.from('messages').insert({
    conversation_id: conversationId, direction: 'out', sender_role: 'assistant',
    content_type: 'text', content: human, trace_id: traceId,
  });
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  if (isSimulatorMode() || !agentChannelReady()) {
    await writeLog('info', 'agent', 'Abertura (template) salva — aguardando resposta manual no dashboard', { traceId, conversationId });
    return;
  }
  await dispatchOutbound({
    kind: 'template', instance: AGENT_INSTANCE, phoneE164: supplierPhone,
    templateName: payload.name, templateLanguage: payload.language, templateVariables: payload.variables,
    text: human, traceId,
  });
}

/** Abertura fria pra CLÍNICA via template (respeita CLINIC_OUTBOUND_MODE=real). */
export async function sendTemplateOpeningToClinic(
  conversationId: string,
  clinicPhone: string,
  templateKey: TemplateKey,
  variables: string[],
  traceId: string,
): Promise<void> {
  const human = humanizeTemplate(templateKey, variables);
  let payload;
  try {
    payload = buildTemplatePayload(templateKey, variables);
  } catch (err) {
    await writeLog('warn', 'clinic', `Template inválido (${templateKey}) — caindo pra texto: ${String(err).slice(0, 200)}`, { traceId, conversationId });
    await sendOutboundToClinic(conversationId, clinicPhone, human, traceId);
    return;
  }

  await db.from('messages').insert({
    conversation_id: conversationId, direction: 'out', sender_role: 'assistant',
    content_type: 'text', content: human, trace_id: traceId,
  });
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  const realMode = process.env['CLINIC_OUTBOUND_MODE'] === 'real';
  if (!realMode || isSimulatorMode() || !agentChannelReady()) {
    await writeLog('info', 'clinic', 'Abertura (template) pra clínica salva (modo simulação)', { traceId, conversationId });
    return;
  }
  await dispatchOutbound({
    kind: 'template', instance: AGENT_INSTANCE, phoneE164: clinicPhone,
    templateName: payload.name, templateLanguage: payload.language, templateVariables: payload.variables,
    text: human, traceId,
  });
}

/**
 * 📎 Encaminha um DOCUMENTO do paciente (carteirinha, pedido médico, receita) a um
 * estabelecimento — clínica ou farmácia.
 *
 * Nasceu do caso Glauber (30/07): o consultório do Dr. Marco Elísio pediu "foto da
 * carteirinha do Ipasgo e do pedido médico" e a Xarlote não tinha como repassar NADA —
 * a fila só aceitava texto e a mídia recebida nem era guardada. O fluxo travava ali,
 * esperando um documento que nunca ia chegar.
 *
 * A imagem vai por URL pública (é como o zpro envia foto), servida do nosso Storage.
 * `caption` é a legenda humana que acompanha o documento.
 */
export async function sendMediaToEstablishment(
  conversationId: string,
  phoneE164: string,
  imageUrl: string,
  caption: string,
  traceId: string,
): Promise<void> {
  const legenda = humanizeSupplierText(caption || '');
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'image',
    content: legenda || '[documento encaminhado]',
    trace_id: traceId,
  });
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);
  await dispatchOutbound({
    kind: 'image',
    instance: AGENT_INSTANCE,
    phoneE164,
    imageUrl,
    text: legenda || undefined,
    traceId,
  });
  await writeLog('info', 'outbound', '📎 documento do paciente encaminhado ao estabelecimento', { traceId, conversationId });
}
