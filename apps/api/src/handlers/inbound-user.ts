import { randomUUID } from 'crypto';
import { db, findUserByPhone, upsertUser, findOrCreateConversation, insertMessage, getConversationMessages, writeLog } from '@iasaude/db';
import { isForgetMeRequest, buildConsentEvent } from '@iasaude/core';
import { ONBOARDING_CONSENT_MESSAGE, ONBOARDING_CONSENT_REPEAT_MESSAGE, SARA_INSTANCE } from '@iasaude/shared';
import type { NormalizedInbound } from '@iasaude/shared';
import { chat, buildSaraSystemPrompt, saraTools, messagesToHistory, trimHistory } from '@iasaude/llm';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound } from './outbound.js';
import { handleToolCall } from './tool-executor.js';

export async function processInboundUser(
  inbound: NormalizedInbound
): Promise<{ traceId: string; conversationId: string }> {
  const traceId = randomUUID();
  const phoneE164 = inbound.from.phoneE164;

  await writeLog('info', 'webhook', `Inbound from ${phoneE164}`, {
    traceId,
    contentType: inbound.contentType,
    instance: inbound.instance,
  });

  // 1. Find or create user
  let user = await findUserByPhone(phoneE164);
  if (!user) {
    // Create with not_started so first message triggers the LGPD consent link
    user = await upsertUser(phoneE164, {
      preferred_name: inbound.from.pushName ?? null,
      onboarding_status: 'not_started',
      metadata: {},
    });
  }

  // 2. Find or create conversation
  const conversation = await findOrCreateConversation(
    SARA_INSTANCE,
    inbound.from.jid,
    'user',
    user.id
  );

  // 3. Persist incoming message
  const inboundMsg = await insertMessage({
    conversation_id: conversation.id,
    external_id: inbound.externalId,
    direction: 'in',
    sender_role: 'user',
    content_type: inbound.contentType,
    content: inbound.text ?? null,
    media_storage_path: null,
    media_mime: inbound.mediaMime ?? null,
    media_duration_ms: inbound.mediaDurationMs ?? null,
    location_lat: inbound.location?.lat ?? null,
    location_lng: inbound.location?.lng ?? null,
    raw_payload: inbound.raw,
    llm_model: null,
    llm_tokens_in: null,
    llm_tokens_out: null,
    llm_latency_ms: null,
    trace_id: traceId,
  });

  // 4. Update conversation last_message_at
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id);

  // 5. Handle consent flow
  if (user.onboarding_status === 'not_started' || user.onboarding_status === 'consent_pending') {
    if (user.onboarding_status === 'not_started') {
      // Send LGPD consent link and wait for user to respond
      await db.from('users').update({ onboarding_status: 'consent_pending' }).eq('id', user.id);
      await sendOutbound(conversation.id, phoneE164, ONBOARDING_CONSENT_MESSAGE, traceId);
      return { traceId, conversationId: conversation.id };
    }

    // Link-based consent: any message after seeing the link = user accepted
    const text = inbound.text ?? '';
    if (text.trim().length > 0 || inbound.contentType !== 'text') {
      // Record consent
      const consentPayload = buildConsentEvent(user.id, inboundMsg.id, text || `[${inbound.contentType}]`);
      await db.from('consent_events').insert(consentPayload);
      await db.from('users').update({
        onboarding_status: 'profiling',
        lgpd_consent_at: new Date().toISOString(),
        lgpd_consent_version: consentPayload.policy_version,
        lgpd_consent_source: 'whatsapp',
        lgpd_consent_message_id: inboundMsg.id,
      }).eq('id', user.id);
      user = { ...user, onboarding_status: 'profiling', lgpd_consent_at: new Date().toISOString() };

      const welcomeMsg = `Boa! 💙 Agora me conta — como você gosta de ser chamado(a)?`;
      await sendOutbound(conversation.id, phoneE164, welcomeMsg, traceId);
      return { traceId, conversationId: conversation.id };
    } else {
      // Empty message or timeout — resend link
      await sendOutbound(conversation.id, phoneE164, ONBOARDING_CONSENT_REPEAT_MESSAGE, traceId);
      return { traceId, conversationId: conversation.id };
    }
  }

  // 6. Check forget-me
  if (inbound.text && isForgetMeRequest(inbound.text)) {
    const confirmMsg = `Entendido 💙 Para confirmar que você quer apagar todos os seus dados, responde com *CONFIRMO APAGAR*. Isso é irreversível.`;
    await sendOutbound(conversation.id, phoneE164, confirmMsg, traceId);
    return { traceId, conversationId: conversation.id };
  }
  if (inbound.text?.toLowerCase().includes('confirmo apagar')) {
    await handleForgetMe(user.id, conversation.id, phoneE164, traceId);
    return { traceId, conversationId: conversation.id };
  }

  // 7. Mark active if still profiling
  if (user.onboarding_status === 'profiling') {
    await db.from('users').update({ onboarding_status: 'active' }).eq('id', user.id);
    user = { ...user, onboarding_status: 'active' };
  }

  // 8. Build context for Xarlote
  const history = await getConversationMessages(conversation.id, 30);
  const geminiHistory = trimHistory(messagesToHistory(history.slice(0, -1)), 20);

  const { data: conditions } = await db.from('user_health_conditions').select('name').eq('user_id', user.id).eq('active', true);
  const { data: allergies } = await db.from('user_allergies').select('substance').eq('user_id', user.id);
  const { data: medications } = await db.from('user_medications').select('medication_name, dosage').eq('user_id', user.id).eq('active', true);
  const { data: addresses } = await db.from('user_addresses').select('*').eq('user_id', user.id);

  // Load active order summary (quoted = waiting for user to pick; confirming = waiting for pharmacy)
  const { data: activeOrder } = await db
    .from('orders')
    .select('id, status, items, summary')
    .eq('user_id', user.id)
    .in('status', ['quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const activeOrderSummary = activeOrder?.summary ?? null;

  const memoryCards = Array.isArray(conversation.memory_cards) ? conversation.memory_cards : [];

  const promptsConfig = loadPrompts();

  let systemPrompt = buildSaraSystemPrompt({
    user,
    preferredName: user.preferred_name,
    addresses: addresses ?? [],
    conditions: conditions?.map((c) => c.name) ?? [],
    allergies: allergies?.map((a) => a.substance) ?? [],
    medications: medications?.map((m) => `${m.medication_name}${m.dosage ? ` ${m.dosage}` : ''}`) ?? [],
    memoryCards,
    activeOrderSummary,
  });

  if (promptsConfig.sara_suffix.trim()) {
    systemPrompt += `\n\n## INSTRUÇÕES ADICIONAIS (configuradas no dashboard)\n${promptsConfig.sara_suffix.trim()}`;
  }

  // 9. Build user message string for Gemini
  let userMsgContent = inbound.text ?? '';
  if (inbound.contentType === 'location' && inbound.location) {
    userMsgContent = `[Localização compartilhada: lat ${inbound.location.lat}, lng ${inbound.location.lng}${inbound.location.name ? `, ${inbound.location.name}` : ''}]`;
  } else if (inbound.contentType === 'image') {
    userMsgContent = `[Imagem recebida${inbound.text ? `: ${inbound.text}` : ''}] (message_id: ${inboundMsg.id})`;
  } else if (inbound.contentType === 'audio') {
    userMsgContent = `[Áudio recebido — duração: ${Math.round((inbound.mediaDurationMs ?? 0) / 1000)}s]`;
  }

  // 10. Call LLM (Sara)
  const model = promptsConfig.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini';
  await writeLog('info', 'llm', `Xarlote → LLM [${model}] — msg: "${userMsgContent.slice(0, 80)}${userMsgContent.length > 80 ? '…' : ''}"`, {
    traceId, model, historyLen: geminiHistory.length,
  });

  const llmStart = Date.now();
  let llmResponse;
  try {
    llmResponse = await chat(userMsgContent, {
      model,
      apiKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: systemPrompt,
      history: geminiHistory,
      tools: saraTools,
      temperature: 0.4,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
    });
  } catch (err) {
    const errMsg = String(err);
    console.error('[LLM ERROR]', err);
    await writeLog('error', 'llm', `Sara LLM error: ${errMsg.slice(0, 200)}`, { traceId, error: errMsg });

    const isQuota = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
    const userMsg = isQuota
      ? 'Estou com a agenda cheia agora 🙈 tenta de novo em alguns minutinhos?'
      : 'Tive um probleminha aqui, mas já já resolvo. Pode repetir sua mensagem? 😊';

    await sendOutbound(conversation.id, phoneE164, userMsg, traceId);
    return { traceId, conversationId: conversation.id };
  }

  await writeLog('info', 'llm', `Xarlote ← LLM [${llmResponse.model}] — ${llmResponse.tokensIn}in/${llmResponse.tokensOut}out tok, ${llmResponse.latencyMs}ms${llmResponse.toolCalls.length ? ` — tools: ${llmResponse.toolCalls.map((t) => t.name).join(', ')}` : ''}${llmResponse.text ? ` — "${llmResponse.text.slice(0, 60)}…"` : ''}`, {
    traceId, model: llmResponse.model, tokensIn: llmResponse.tokensIn, tokensOut: llmResponse.tokensOut, latencyMs: llmResponse.latencyMs,
    tools: llmResponse.toolCalls.map((t) => t.name),
  });

  // 11. Execute tool calls
  if (llmResponse.toolCalls.length > 0) {
    for (const tc of llmResponse.toolCalls) {
      await writeLog('info', 'tool', `Tool call: ${tc.name}`, { traceId, args: tc.args });
      await handleToolCall(tc, {
        userId: user.id,
        conversationId: conversation.id,
        phoneE164,
        traceId,
        inboundMsg,
        inbound,
      });
    }
  }

  // 12. Send text response
  if (llmResponse.text.trim()) {
    await writeLog('info', 'outbound', `Xarlote → usuário: "${llmResponse.text.trim().slice(0, 100)}${llmResponse.text.length > 100 ? '…' : ''}"`, { traceId });
    await sendOutbound(conversation.id, phoneE164, llmResponse.text.trim(), traceId, {
      model: llmResponse.model,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
      latencyMs: Date.now() - llmStart,
    });
  }

  return { traceId, conversationId: conversation.id };
}

async function handleForgetMe(userId: string, conversationId: string, phoneE164: string, traceId: string) {
  // Record revocation
  await db.from('consent_events').insert({ user_id: userId, event_type: 'revoke', policy_version: '1.0', channel: 'whatsapp' });

  // Anonymize
  await db.from('messages').delete().eq('conversation_id', conversationId);
  await db.from('user_health_conditions').delete().eq('user_id', userId);
  await db.from('user_allergies').delete().eq('user_id', userId);
  await db.from('user_medications').delete().eq('user_id', userId);
  await db.from('user_addresses').delete().eq('user_id', userId);
  await db.from('users').update({ phone_e164: `deleted-${userId}`, full_name: null, preferred_name: null, deleted_at: new Date().toISOString() }).eq('id', userId);

  const goodbye = 'Pronto, apaguei tudo 💙 Se mudar de ideia, é só me chamar de novo.';
  await sendOutbound(conversationId, phoneE164, goodbye, traceId);

  await writeLog('info', 'lgpd', 'User forget-me completed', { traceId, userId });
}
