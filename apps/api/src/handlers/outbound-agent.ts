import { db, writeLog } from '@iasaude/db';
import { isSimulatorMode, zproConfigured } from '@iasaude/whatsapp';
import { AGENT_INSTANCE } from '@iasaude/shared';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { buildTemplatePayload, humanizeTemplate, type TemplateKey } from '../config/template-registry.js';

/** O número do agente está pronto pra enviar de verdade? (uazapi OU zpro/WABA) */
function agentChannelReady(): boolean {
  return !!process.env['UAZAPI_AGENT_TOKEN'] || zproConfigured(AGENT_INSTANCE);
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
): Promise<void> {
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  });

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

  // F0.7: envio via fila do agente (número distinto da Xarlote → limiter próprio).
  await dispatchOutbound({ kind: 'text', instance: AGENT_INSTANCE, phoneE164: supplierPhone, text, traceId });
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
): Promise<void> {
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  });
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

  // F0.7: envio via fila do agente com rate-limit.
  await dispatchOutbound({ kind: 'text', instance: AGENT_INSTANCE, phoneE164: clinicPhone, text, traceId });
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
