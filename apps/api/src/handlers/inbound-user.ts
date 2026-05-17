import { randomUUID } from 'crypto';
import { db, findUserByPhone, upsertUser, findOrCreateConversation, insertMessage, getConversationMessages, writeLog, retrieveRelevantCards, deleteUserMemory } from '@iasaude/db';
import { isForgetMeRequest, buildConsentEvent } from '@iasaude/core';
import { ONBOARDING_CONSENT_MESSAGE, ONBOARDING_CONSENT_REPEAT_MESSAGE, SARA_INSTANCE, QUEUE_NAMES } from '@iasaude/shared';
import type { NormalizedInbound, ProfileEnricherJob, MemoryCard } from '@iasaude/shared';
import { chat, buildSaraSystemPrompt, saraTools, messagesToHistory, trimHistory, embed, userContentWithImage, dataUrl, type ChatContent } from '@iasaude/llm';
import { sendMenu, isSimulatorMode, downloadMedia } from '@iasaude/whatsapp';
import { transcribeAudio } from '@iasaude/integrations';
import { Queue } from 'bullmq';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound, sendOutboundAudio } from './outbound.js';
import { handleToolCall } from './tool-executor.js';

// Queue pra disparar enricher async — instância única por processo
const enricherQueue = new Queue(QUEUE_NAMES.PROFILE_ENRICHER, {
  connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
});

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

  // 5a. Comando especial @teste — zera tudo e reinicia Xarlote
  if (inbound.text?.trim() === '@teste') {
    await resetAllData(db);
    await sendOutbound(conversation.id, phoneE164, '🔄 Reset completo! Pode começar do zero.', traceId);
    return { traceId, conversationId: conversation.id };
  }

  // 5. Handle consent flow
  if (user.onboarding_status === 'not_started' || user.onboarding_status === 'consent_pending') {
    if (user.onboarding_status === 'not_started') {
      // Send LGPD consent message com botões interativos (Aceitar/Recusar) via uazapi /send/menu.
      // Persistimos o texto da mensagem normalmente em `messages` (pra aparecer no dashboard),
      // mas o envio real ao usuário usa sendMenu pra renderizar os botões clicáveis.
      await db.from('users').update({ onboarding_status: 'consent_pending' }).eq('id', user.id);

      await db.from('messages').insert({
        conversation_id: conversation.id,
        direction: 'out',
        sender_role: 'assistant',
        content_type: 'text',
        content: ONBOARDING_CONSENT_MESSAGE,
        trace_id: traceId,
      });
      await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id);

      if (!isSimulatorMode()) {
        try {
          await sendMenu(SARA_INSTANCE, phoneE164, ONBOARDING_CONSENT_MESSAGE, ['Aceitar', 'Recusar'], {
            type: 'button',
          });
        } catch (err) {
          await writeLog('error', 'outbound', `Failed to send consent menu: ${String(err)}`, { traceId });
          // Fallback: envia texto puro caso o menu falhe
          await sendOutbound(conversation.id, phoneE164, ONBOARDING_CONSENT_MESSAGE, traceId);
        }
      }
      return { traceId, conversationId: conversation.id };
    }

    // Resposta ao botão/texto. Detecta intenção: aceitar vs recusar.
    const text = (inbound.text ?? '').trim();
    const lower = text.toLowerCase();
    // Aceita formas: 'aceitar', 'aceito', 'sim aceito', 'concordo', etc.
    const isRefuse = /^recusar?$/.test(lower) || /^n[aã]o\s*aceito$/.test(lower) || lower === 'recuso';
    const isAccept = !isRefuse && (text.length > 0 || inbound.contentType !== 'text');

    await writeLog('info', 'consent', `Consent flow recebeu mensagem do usuário (status=${user.onboarding_status})`, {
      traceId,
      contentType: inbound.contentType,
      textLen: text.length,
      textPreview: text.slice(0, 60),
      isRefuse,
      isAccept,
    });

    if (isRefuse) {
      const refuseMsg = `Tudo bem, sem pressão. Sem o aceite da LGPD eu não posso seguir com o atendimento. Quando quiser, é só me responder *Aceitar* aqui que a gente continua de onde parou.`;
      await sendOutbound(conversation.id, phoneE164, refuseMsg, traceId);
      return { traceId, conversationId: conversation.id };
    }

    if (isAccept) {
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

      const welcomeMsg = `Boa! Pra gente começar, como você gosta de ser chamado(a)?`;
      await sendOutbound(conversation.id, phoneE164, welcomeMsg, traceId);
      return { traceId, conversationId: conversation.id };
    }

    // Mensagem vazia / mídia sem contexto — reenvia o link
    await sendOutbound(conversation.id, phoneE164, ONBOARDING_CONSENT_REPEAT_MESSAGE, traceId);
    return { traceId, conversationId: conversation.id };
  }

  // 6. Check forget-me
  if (inbound.text && isForgetMeRequest(inbound.text)) {
    const confirmMsg = `Entendido. Pra confirmar que você quer apagar todos os seus dados, responde com *CONFIRMO APAGAR*. Isso é irreversível.`;
    await sendOutbound(conversation.id, phoneE164, confirmMsg, traceId);
    return { traceId, conversationId: conversation.id };
  }
  if (inbound.text?.toLowerCase().includes('confirmo apagar')) {
    await handleForgetMe(user.id, conversation.id, phoneE164, traceId);
    return { traceId, conversationId: conversation.id };
  }

  // 7. Mark active if still profiling.
  // Captura wasProfiling pra disparar voice intro: a 1ª msg após `Aceitar` é
  // sempre o usuário dizendo o nome dele. A resposta da Sara nesse turno é a
  // saudação "Prazer, X!" que merece sair como áudio.
  const wasProfiling = user.onboarding_status === 'profiling';
  if (wasProfiling) {
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

  const promptsConfig = loadPrompts();

  // Memória semântica: top-K cards relevantes ao input atual (decay temporal aplicado).
  // Embedda só se houver texto pra consultar; senão usa fallback last_seen_at.
  let queryEmbedding: number[] | null = null;
  if (inbound.text && inbound.text.length > 0 && (promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'])) {
    try {
      queryEmbedding = await embed(inbound.text.slice(0, 1000), {
        apiKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
        timeoutMs: 6_000,
      });
    } catch (err) {
      // embedding não-bloqueante; fallback de retrieval cobre
      await writeLog('warn', 'memory', `embed query falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
  }
  const relevantCards = await retrieveRelevantCards(user.id, conversation.id, queryEmbedding, 8);
  const memoryCards: MemoryCard[] = relevantCards.length
    ? relevantCards.map((c) => ({
        id: c.id, kind: c.kind, text: c.text, tags: c.tags,
        confidence: c.confidence, source: c.source,
        last_seen_at: c.last_seen_at, created_at: c.created_at,
      }))
    : (Array.isArray(conversation.memory_cards) ? conversation.memory_cards : []);

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

  // 9. Build user message — texto, áudio (transcrito), imagem (multimodal vision), localização.
  // userMsgContent vira `string | ChatContent[]`. Default texto puro; vira array quando há imagem.
  let userMsgContent: string | ChatContent[] = inbound.text ?? '';
  let userMsgPreview = '';

  if (inbound.contentType === 'location' && inbound.location) {
    userMsgContent = `[Localização compartilhada: lat ${inbound.location.lat}, lng ${inbound.location.lng}${inbound.location.name ? `, ${inbound.location.name}` : ''}]`;
    userMsgPreview = userMsgContent;
  } else if (inbound.contentType === 'audio') {
    // Baixa o áudio do uazapi e transcreve antes da Sara ver.
    // uazapi exige o `id` LONGO (com prefixo de número), não o messageid curto.
    // IMPORTANTE: usa `SARA_INSTANCE` ("sara") como chave do buildConfig — o
    // `inbound.instance` é o nome real da uazapi (ex: "VEDACIL-HIAGO") e
    // não bate com a env var UAZAPI_SARA_TOKEN.
    const longId =
      (inbound.raw as { message?: { id?: string } } | null)?.message?.id ?? inbound.externalId;
    let transcript = '';
    let downloadedMime = inbound.mediaMime ?? 'audio/ogg';
    try {
      const media = await downloadMedia(SARA_INSTANCE, longId);
      if (media) {
        downloadedMime = media.mime || downloadedMime;
        await writeLog('info', 'transcription', `Áudio baixado (${media.buffer.length} bytes, ${downloadedMime})`, { traceId });
        const audioModel = promptsConfig.audio_model || 'openai/whisper-1';
        const result = await transcribeAudio(media.buffer, downloadedMime, {
          model: audioModel,
          openRouterKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
          geminiKey: process.env['GOOGLE_GENAI_API_KEY'],
          timeoutMs: 30_000,
        });
        transcript = result.text;
        await writeLog('info', 'transcription', `Áudio transcrito (${result.provider}/${result.model}, ${transcript.length} chars): "${transcript.slice(0, 80)}"`, {
          traceId, provider: result.provider, model: result.model, audioMime: downloadedMime,
        });
        if (transcript) {
          await db.from('messages').update({ transcript }).eq('id', inboundMsg.id);
        }
      } else {
        await writeLog('warn', 'transcription', `downloadMedia retornou null pro áudio (id=${longId})`, { traceId, longId });
      }
    } catch (err) {
      await writeLog('error', 'transcription', `Erro transcrever áudio: ${String(err).slice(0, 240)}`, { traceId, longId });
    }
    userMsgContent = transcript
      ? `[Áudio transcrito] ${transcript}`
      : `[Áudio recebido mas não consegui transcrever — duração: ${Math.round((inbound.mediaDurationMs ?? 0) / 1000)}s. Peça pra digitar.]`;
    userMsgPreview = userMsgContent;
  } else if (inbound.contentType === 'image') {
    // Baixa a imagem e passa pelo canal multimodal da OpenAI (image_url data URL).
    const caption = inbound.text ?? '';
    const longId =
      (inbound.raw as { message?: { id?: string } } | null)?.message?.id ?? inbound.externalId;
    let dataUrlValue: string | null = null;
    try {
      if (inbound.mediaBase64) {
        dataUrlValue = dataUrl(inbound.mediaBase64, inbound.mediaMime ?? 'image/jpeg');
      } else {
        const media = await downloadMedia(SARA_INSTANCE, longId);
        if (media) {
          await writeLog('info', 'vision', `Imagem baixada (${media.buffer.length} bytes, ${media.mime})`, { traceId });
          dataUrlValue = dataUrl(media.buffer.toString('base64'), media.mime || 'image/jpeg');
        } else {
          await writeLog('warn', 'vision', `downloadMedia retornou null pra imagem (id=${longId})`, { traceId, longId });
        }
      }
    } catch (err) {
      await writeLog('error', 'vision', `Erro baixar imagem: ${String(err).slice(0, 240)}`, { traceId, longId });
    }

    if (dataUrlValue) {
      const promptText = caption
        ? `[O usuário enviou uma imagem com a legenda: "${caption}". Olhe a imagem e responda naturalmente.]`
        : `[O usuário enviou uma imagem. Olhe e responda naturalmente — descreva brevemente o que vê e siga a conversa.]`;
      userMsgContent = userContentWithImage(promptText, [dataUrlValue]);
      userMsgPreview = `[imagem${caption ? ` + "${caption.slice(0, 40)}"` : ''}]`;
    } else {
      userMsgContent = `[Recebi uma imagem mas não consegui carregar. Peça pra mandar de novo.]${caption ? ` Legenda: ${caption}` : ''}`;
      userMsgPreview = userMsgContent;
    }
  } else {
    userMsgPreview = typeof userMsgContent === 'string' ? userMsgContent : '[multimodal]';
  }

  // 10. Call LLM (Sara) — usa vision_model quando a mensagem é multimodal (imagem)
  const isMultimodal = Array.isArray(userMsgContent);
  const model = isMultimodal
    ? (promptsConfig.vision_model || promptsConfig.llm_model || 'openai/gpt-4.1-mini')
    : (promptsConfig.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini');
  await writeLog('info', 'llm', `Xarlote → LLM [${model}${isMultimodal ? ' vision' : ''}] — msg: "${userMsgPreview.slice(0, 80)}${userMsgPreview.length > 80 ? '…' : ''}"`, {
    traceId, model, historyLen: geminiHistory.length, multimodal: isMultimodal,
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

    // Classifica o tipo de erro pra deixar log e mensagem ao usuário mais úteis.
    const isAuth = errMsg.includes('401') || errMsg.includes('User not found') || errMsg.includes('Unauthorized') || errMsg.includes('No auth credentials');
    const isQuota = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('insufficient_quota');
    const isPayment = errMsg.includes('402') || errMsg.includes('Payment Required') || errMsg.includes('credits');

    const errorTag = isAuth ? '[AUTH/KEY INVÁLIDA]' : isPayment ? '[SEM CRÉDITO]' : isQuota ? '[RATE LIMIT]' : '[ERRO LLM]';
    await writeLog('error', 'llm', `${errorTag} Sara LLM error: ${errMsg.slice(0, 200)}`, {
      traceId, error: errMsg, isAuth, isQuota, isPayment,
    });

    // Mensagem ao usuário (sem expor detalhes técnicos).
    let userMsg: string;
    if (isAuth || isPayment) {
      // Bug de configuração nosso, repetir não vai resolver. Pede pra aguardar.
      userMsg = 'Opa, tive um problema técnico aqui no atendimento. Já estou avisando o time pra resolver. Daqui a pouco a gente continua.';
    } else if (isQuota) {
      userMsg = 'Estou com a agenda cheia agora 🙈 tenta de novo em alguns minutinhos?';
    } else {
      userMsg = 'Tive um probleminha aqui, mas já já resolvo. Pode repetir sua mensagem?';
    }

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

  // 12. Send response — texto OU áudio (voice intro na primeira saudação)
  if (llmResponse.text.trim()) {
    const meta = (user.metadata as { audio_intro_sent?: boolean } | null | undefined) ?? {};
    const alreadyIntroed = meta.audio_intro_sent === true;
    // Conta quantas msgs outbound a Sara já mandou pra esse user fora do consent flow.
    // Se for a 1ª (= a próxima) E o user já consentiu E ainda não rolou intro,
    // dispara áudio. Robusto contra falhas anteriores (ex: deploy sem TTS).
    const { count: outCount } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .eq('direction', 'out')
      .eq('sender_role', 'assistant');
    // outCount inclui a msg de consent + o "como gosta de ser chamado" do consent flow.
    // Sara só começa a falar de fato APÓS o user passar de consent → profiling → active.
    // Então a 1ª resposta "real" dela = quando outCount <= 2 (consent + "como gosta de").
    const isFirstRealReply = (outCount ?? 99) <= 2;
    const shouldVoiceIntro =
      promptsConfig.tts_enabled &&
      !alreadyIntroed &&
      user.lgpd_consent_at != null &&
      (wasProfiling || isFirstRealReply);
    const replyText = llmResponse.text.trim();
    await writeLog('info', 'outbound', `Xarlote → usuário ${shouldVoiceIntro ? '[ÁUDIO intro]' : ''}: "${replyText.slice(0, 100)}${replyText.length > 100 ? '…' : ''}"`, { traceId, voiceIntro: shouldVoiceIntro });

    if (shouldVoiceIntro) {
      // Captura o nome a partir do texto da Sara se o enricher ainda não populou
      // user.preferred_name (a Sara acabou de ouvir o nome nesse turno; o enricher
      // roda async DEPOIS). Heurística: pega a 1ª palavra capitalizada depois de
      // "Oi", "Olá", "Prazer" — combina com como a Sara saúda.
      const nameMatch = replyText.match(/(?:oi|olá|ola|prazer|opa|ei)[,\s]+([A-ZÁÉÍÓÚÂÊÔÃÕ][a-záéíóúâêôãõ]{1,30})/i);
      const inferredName = nameMatch?.[1] ?? null;
      const sentAudio = await sendOutboundAudio(conversation.id, phoneE164, replyText, traceId, {
        model: llmResponse.model,
        tokensIn: llmResponse.tokensIn,
        tokensOut: llmResponse.tokensOut,
        latencyMs: Date.now() - llmStart,
      }, {
        preferredName: user.preferred_name ?? inferredName,
      });
      if (sentAudio) {
        // Marca o flag pra nunca mais repetir o intro pra esse usuário.
        await db.from('users').update({
          metadata: { ...meta, audio_intro_sent: true, audio_intro_at: new Date().toISOString() },
        }).eq('id', user.id);
      }
    } else {
      await sendOutbound(conversation.id, phoneE164, replyText, traceId, {
        model: llmResponse.model,
        tokensIn: llmResponse.tokensIn,
        tokensOut: llmResponse.tokensOut,
        latencyMs: Date.now() - llmStart,
      });
    }
  }

  // 13. Dispara enricher async (não bloqueia resposta — extrai fatos das últimas 6 msgs)
  try {
    const recent = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(6);
    const messageIds = (recent.data ?? []).map((m) => m.id).reverse();
    if (messageIds.length >= 2) {
      const job: ProfileEnricherJob = { conversationId: conversation.id, messageIds, traceId };
      await enricherQueue.add('enrich', job, {
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 50 },
        attempts: 2,
        backoff: { type: 'fixed', delay: 10_000 },
      });
    }
  } catch (err) {
    await writeLog('warn', 'enrichment', `Falha ao enfileirar enricher: ${String(err).slice(0, 120)}`, { traceId });
  }

  return { traceId, conversationId: conversation.id };
}

// Mesma lógica do endpoint POST /simulate/reset-all — apaga todos os dados de teste
async function resetAllData(dbClient: typeof db): Promise<void> {
  await dbClient.from('messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('quotes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('assistant_tasks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('reminders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('consent_events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('user_health_conditions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('user_allergies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('user_medications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('user_addresses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('conversations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
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
  await deleteUserMemory(userId);
  await db.from('users').update({ phone_e164: `deleted-${userId}`, full_name: null, preferred_name: null, deleted_at: new Date().toISOString() }).eq('id', userId);

  const goodbye = 'Pronto, apaguei tudo. Se mudar de ideia, é só me chamar de novo.';
  await sendOutbound(conversationId, phoneE164, goodbye, traceId);

  await writeLog('info', 'lgpd', 'User forget-me completed', { traceId, userId });
}
