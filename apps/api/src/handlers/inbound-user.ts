import { randomUUID } from 'crypto';
import { db, findUserByPhone, upsertUser, findOrCreateConversation, insertMessage, getConversationMessages, writeLog, retrieveRelevantCards, deleteUserMemory, writeAudit, writeEvent, auditUserStateChange, queryUser360, formatUser360ForPrompt, loadUserSkills, formatSkillsForPrompt } from '@iasaude/db';
import { isForgetMeRequest, buildConsentEvent } from '@iasaude/core';
import { ONBOARDING_CONSENT_MESSAGE, ONBOARDING_CONSENT_REPEAT_MESSAGE, SARA_INSTANCE, QUEUE_NAMES } from '@iasaude/shared';
import type { NormalizedInbound, ProfileEnricherJob, MemoryCard } from '@iasaude/shared';
import { chat, buildXarloteSystemPrompt, xarloteTools, messagesToHistory, trimHistory, embed, userContentWithImage, dataUrl, type ChatContent } from '@iasaude/llm';
import { sendMenu, isSimulatorMode, fetchInboundMedia } from '@iasaude/whatsapp';
import { transcribeAudio } from '@iasaude/integrations';
import { Queue } from 'bullmq';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound, sendOutboundAudio } from './outbound.js';
import { handleToolCall } from './tool-executor.js';
import { findPendingClarificationForUser } from './clarification.js';

// Queue pra disparar enricher async — instância única por processo
const enricherQueue = new Queue(QUEUE_NAMES.PROFILE_ENRICHER, {
  connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
});

export async function processInboundUser(
  inbound: NormalizedInbound,
  // F1.B2: o traceId nasce no webhook (ingresso) e desce até aqui pra correlacionar
  // todo o pipeline. Default randomUUID() mantém compat com callers diretos (simulate/testes).
  traceId: string = randomUUID(),
): Promise<{ traceId: string; conversationId: string }> {
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

  // 3+4. Persiste a mensagem de entrada + atualiza last_message_at da conversa EM
  // PARALELO (F2.G2 — são independentes; insertMessage devolve o inboundMsg usado
  // adiante, o update não retorna nada relevante). Mesma semântica de falha de antes.
  const [inboundMsg] = await Promise.all([
    insertMessage({
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
    }),
    db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id),
  ]);

  // 5a. Comando especial @teste — zera tudo e reinicia Xarlote.
  // SÓ em modo simulador (dev local): em produção isso apagaria o banco INTEIRO
  // de todos os usuários — qualquer pessoa digitando "@teste" no WhatsApp real
  // ou via POST /app/inbound destruiria dados clínicos + consent_events (LGPD).
  if (inbound.text?.trim() === '@teste') {
    if (!isSimulatorMode()) {
      await writeLog('warn', 'inbound', 'Comando @teste IGNORADO (só funciona em modo simulador)', { traceId, userId: user.id });
      // segue o fluxo normal: a Xarlote trata como mensagem comum
    } else {
      await resetAllData(db);
      await sendOutbound(conversation.id, phoneE164, '🔄 Reset completo! Pode começar do zero.', traceId);
      return { traceId, conversationId: conversation.id };
    }
  }

  // 5a.1 RED FLAG — se há pending ativo e mensagem parece resposta de botão,
  // processa AGORA e retorna. Crítico: não pode passar pelo LLM normal.
  if (inbound.text && inbound.text.trim().length > 0 && inbound.text.length <= 60) {
    try {
      const { handleRedFlagButtonResponse } = await import('./red-flag-handler.js');
      const handled = await handleRedFlagButtonResponse({
        userId: user.id,
        conversationId: conversation.id,
        phoneE164,
        buttonLabel: inbound.text.trim(),
        traceId,
      });
      if (handled) {
        return { traceId, conversationId: conversation.id };
      }
    } catch (err) {
      // Falha aqui é não-bloqueante — segue pro fluxo normal
      await writeLog('warn', 'red_flag', `button response check falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
  }

  // 5. Handle consent flow
  if (user.onboarding_status === 'not_started' || user.onboarding_status === 'consent_pending') {
    if (user.onboarding_status === 'not_started') {
      // Send LGPD consent message com botões interativos (Aceitar/Recusar) via uazapi /send/menu.
      // Persistimos o texto da mensagem normalmente em `messages` (pra aparecer no dashboard),
      // mas o envio real ao usuário usa sendMenu pra renderizar os botões clicáveis.
      await db.from('users').update({ onboarding_status: 'consent_pending' }).eq('id', user.id);
      await auditUserStateChange({
        userId: user.id,
        action: 'user.onboarding.advanced',
        before: { onboarding_status: 'not_started' },
        after: { onboarding_status: 'consent_pending' },
        reason: 'first_inbound_message',
        traceId,
        conversationId: conversation.id,
      });

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
            // zpro/WABA exige o ticketId pra renderizar botões — vem do webhook
            // de entrada desta 1ª mensagem. No uazapi é ignorado.
            ticketId: inbound.providerTicketId,
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
      await auditUserStateChange({
        userId: user.id,
        action: 'user.onboarding.consent_refused',
        before: { onboarding_status: 'consent_pending' },
        after: { onboarding_status: 'consent_pending' },
        reason: 'user_text_refuse',
        traceId,
        conversationId: conversation.id,
      });
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
      await auditUserStateChange({
        userId: user.id,
        action: 'user.onboarding.consent_accepted',
        before: { onboarding_status: 'consent_pending' },
        after: {
          onboarding_status: 'profiling',
          lgpd_consent_at: user.lgpd_consent_at,
          lgpd_consent_version: consentPayload.policy_version,
        },
        reason: 'lgpd_accepted',
        traceId,
        conversationId: conversation.id,
      });

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
    await writeAudit({
      actorType: 'user',
      action: 'user.forget_me.requested',
      userId: user.id,
      conversationId: conversation.id,
      messageId: inboundMsg.id,
      traceId,
      reason: 'user_typed_confirmo_apagar',
    });
    await handleForgetMe(user.id, conversation.id, phoneE164, traceId);
    return { traceId, conversationId: conversation.id };
  }

  // 7. Mark active if still profiling.
  // Captura wasProfiling pra disparar voice intro: a 1ª msg após `Aceitar` é
  // sempre o usuário dizendo o nome dele. A resposta da Xarlote nesse turno é a
  // saudação "Prazer, X!" que merece sair como áudio.
  const wasProfiling = user.onboarding_status === 'profiling';
  if (wasProfiling) {
    await db.from('users').update({ onboarding_status: 'active' }).eq('id', user.id);
    user = { ...user, onboarding_status: 'active' };
    await auditUserStateChange({
      userId: user.id,
      action: 'user.onboarding.activated',
      before: { onboarding_status: 'profiling' },
      after: { onboarding_status: 'active' },
      reason: 'user_replied_after_consent',
      traceId,
      conversationId: conversation.id,
    });
  }

  // 8. Build context for Xarlote — leituras de contexto em PARALELO (F2.G2).
  // Estas só dependem de user.id / conversation.id e eram feitas em SÉRIE (~6-8
  // round-trips ao banco em sa-east-1 ≈ 1-2s de rede morta por mensagem, ANTES de
  // a LLM começar). Agora vão num Promise.all → o custo vira o round-trip mais
  // lento, não a soma. A msg de entrada já foi persistida (passo 3), então o
  // getConversationMessages enxerga o histórico completo (e o slice(0,-1) tira ela).
  const promptsConfig = loadPrompts();
  const llmKey = promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'];

  // Sub-cadeia memória: embed(input) → match semântico (decay temporal aplicado).
  // Embedda só com texto+key; falha é não-bloqueante (retrieval cai no last_seen_at).
  const retrieveMemory = async (): Promise<Awaited<ReturnType<typeof retrieveRelevantCards>>> => {
    let queryEmbedding: number[] | null = null;
    if (inbound.text && inbound.text.length > 0 && llmKey) {
      try {
        queryEmbedding = await embed(inbound.text.slice(0, 1000), { apiKey: llmKey, timeoutMs: 6_000 });
      } catch (err) {
        await writeLog('warn', 'memory', `embed query falhou: ${String(err).slice(0, 120)}`, { traceId });
      }
    }
    return retrieveRelevantCards(user.id, conversation.id, queryEmbedding, 8);
  };

  // Skills emergentes (skill-extractor) — falha silenciosa se a migration ainda
  // não rodou (→ []), pra não derrubar o turno.
  const loadSkillsSafe = async (): Promise<Awaited<ReturnType<typeof loadUserSkills>>> => {
    try {
      return await loadUserSkills(user.id);
    } catch (err) {
      await writeLog('warn', 'skills', `loadUserSkills falhou: ${String(err).slice(0, 120)}`, { traceId });
      return [];
    }
  };

  const [history, user360, activeOrderRes, relevantCards, skills, paymentHistRes, pendingClarif] = await Promise.all([
    getConversationMessages(conversation.id, 30),
    queryUser360(user.id),
    db.from('orders')
      .select('id, status, items, summary')
      .eq('user_id', user.id)
      .in('status', ['quoting', 'quoted', 'confirming'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    retrieveMemory(),
    loadSkillsSafe(),
    // Histórico de pagamento: pra Xarlote CONFIRMAR a forma usual em vez de re-perguntar.
    db.from('orders')
      .select('payment_method')
      .eq('user_id', user.id)
      .not('payment_method', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10),
    // Loop agêntico: pergunta pendente de farmácia/clínica aguardando o cliente.
    findPendingClarificationForUser(conversation.id),
  ]);

  const geminiHistory = trimHistory(messagesToHistory(history.slice(0, -1)), 20);
  const activeOrderSummary = activeOrderRes.data?.summary ?? null;

  // Preferência de pagamento aprendida: método mais usado nos pedidos recentes
  // (empate -> mais recente). Xarlote confirma ("no pix de novo?") em vez de perguntar.
  const paymentPreference = (() => {
    const rows = (paymentHistRes.data ?? []) as Array<{ payment_method: string | null }>;
    const methods = rows.map((r) => r.payment_method).filter((m): m is string => !!m);
    if (!methods.length) return null;
    const counts = new Map<string, number>();
    for (const m of methods) counts.set(m, (counts.get(m) ?? 0) + 1);
    let best = methods[0]!;
    let bestN = 0;
    for (const m of methods) {
      const n = counts.get(m)!;
      if (n > bestN) { bestN = n; best = m; }
    }
    return best;
  })();

  // Perfil: 1 RPC unificada (user360). Fallback p/ queries individuais SÓ se a RPC
  // não existir (deploy intermediário) — caso raro, tolera rodar em série.
  const { data: conditions } = user360
    ? { data: user360.conditions.map((c) => ({ name: c.name })) }
    : await db.from('user_health_conditions').select('name').eq('user_id', user.id).eq('active', true);
  const { data: allergies } = user360
    ? { data: user360.allergies.map((a) => ({ substance: a.substance })) }
    : await db.from('user_allergies').select('substance').eq('user_id', user.id);
  const { data: medications } = user360
    ? { data: user360.active_treatments.flatMap((t) => t.medications.map((m) => ({ medication_name: m.name, dosage: m.dosage }))) }
    : await db.from('user_medications').select('medication_name, dosage').eq('user_id', user.id).eq('active', true);
  const { data: addresses } = user360
    ? { data: user360.addresses }
    : await db.from('user_addresses').select('*').eq('user_id', user.id);

  const memoryCards: MemoryCard[] = relevantCards.length
    ? relevantCards.map((c) => ({
        id: c.id, kind: c.kind, text: c.text, tags: c.tags,
        confidence: c.confidence, source: c.source,
        last_seen_at: c.last_seen_at, created_at: c.created_at,
      }))
    : (Array.isArray(conversation.memory_cards) ? conversation.memory_cards : []);

  let systemPrompt = buildXarloteSystemPrompt({
    user,
    preferredName: user.preferred_name,
    addresses: addresses ?? [],
    conditions: conditions?.map((c) => c.name) ?? [],
    allergies: allergies?.map((a) => a.substance) ?? [],
    medications: medications?.map((m) => `${m.medication_name}${m.dosage ? ` ${m.dosage}` : ''}`) ?? [],
    memoryCards,
    activeOrderSummary,
    paymentPreference,
  });

  // Se temos user360 com tratamentos/sintomas/consultas/skills, anexa contexto rico
  if (user360 && (
    user360.active_treatments.length > 0 ||
    user360.upcoming_consultations.length > 0 ||
    user360.recent_symptoms.length > 0 ||
    user360.favorite_pharmacies.length > 0 ||
    user360.skills.length > 0
  )) {
    systemPrompt += `\n\n${formatUser360ForPrompt(user360)}`;
  }

  // Skills emergentes (já carregadas em paralelo acima).
  if (skills.length > 0) {
    systemPrompt += `\n\n${formatSkillsForPrompt(skills)}`;
  }

  if (promptsConfig.sara_suffix.trim()) {
    systemPrompt += `\n\n## INSTRUÇÕES ADICIONAIS (configuradas no dashboard)\n${promptsConfig.sara_suffix.trim()}`;
  }

  // Loop agêntico: se uma farmácia/clínica está esperando um dado do cliente,
  // injeta a pergunta pendente pra Xarlote levar a resposta de volta.
  if (pendingClarif) {
    const oQue = pendingClarif.kind === 'clinic' ? 'a consulta' : 'o pedido';
    systemPrompt += `\n\n## ⏳ PERGUNTA PENDENTE DE UM ESTABELECIMENTO\n${pendingClarif.supplierName} está aguardando uma resposta sua pra continuar ${oQue}:\n"${pendingClarif.question}"\n\nSe a mensagem do usuário responde isso (mesmo parcial), chame **relay_answer_to_establishment** com a resposta dele no campo \`answer\` — eu devolvo pro estabelecimento e a negociação segue. Se ele falar de OUTRA coisa, responda normal; a pergunta continua pendente.`;
  }

  // 9. Build user message — texto, áudio (transcrito), imagem (multimodal vision), localização.
  // userMsgContent vira `string | ChatContent[]`. Default texto puro; vira array quando há imagem.
  let userMsgContent: string | ChatContent[] = inbound.text ?? '';
  let userMsgPreview = '';

  if (inbound.contentType === 'location' && inbound.location) {
    userMsgContent = `[Localização compartilhada: lat ${inbound.location.lat}, lng ${inbound.location.lng}${inbound.location.name ? `, ${inbound.location.name}` : ''}]`;
    userMsgPreview = userMsgContent;
  } else if (inbound.contentType === 'audio') {
    // Baixa o áudio do uazapi e transcreve antes da Xarlote ver.
    // uazapi exige o `id` LONGO (com prefixo de número), não o messageid curto.
    // IMPORTANTE: usa `SARA_INSTANCE` ("sara") como chave do buildConfig — o
    // `inbound.instance` é o nome real da uazapi (ex: "VEDACIL-HIAGO") e
    // não bate com a env var UAZAPI_SARA_TOKEN.
    const longId =
      (inbound.raw as { message?: { id?: string } } | null)?.message?.id ?? inbound.externalId;
    let transcript = '';
    let downloadedMime = inbound.mediaMime ?? 'audio/ogg';
    try {
      const media = await fetchInboundMedia(inbound, SARA_INSTANCE);
      if (media) {
        downloadedMime = media.mime || downloadedMime;
        await writeLog('info', 'transcription', `Áudio baixado (${media.buffer.length} bytes, ${downloadedMime})`, { traceId });
        const audioModel = promptsConfig.audio_model || 'elevenlabs/scribe_v1';
        const result = await transcribeAudio(media.buffer, downloadedMime, {
          model: audioModel,
          openRouterKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
          geminiKey: process.env['GOOGLE_GENAI_API_KEY'],
          elevenLabsKey: promptsConfig.tts_api_key || process.env['ELEVENLABS_API_KEY'],
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
        const media = await fetchInboundMedia(inbound, SARA_INSTANCE);
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

  // 10. Call LLM (Xarlote) — usa vision_model quando a mensagem é multimodal (imagem)
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
      tools: xarloteTools,
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
    await writeLog('error', 'llm', `${errorTag} Xarlote LLM error: ${errMsg.slice(0, 200)}`, {
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

  await writeEvent({
    eventName: 'llm.completion',
    userId: user.id,
    conversationId: conversation.id,
    traceId,
    durationMs: llmResponse.latencyMs,
    tokensIn: llmResponse.tokensIn,
    tokensOut: llmResponse.tokensOut,
    payload: {
      model: llmResponse.model,
      multimodal: isMultimodal,
      tool_calls: llmResponse.toolCalls.map((t) => t.name),
      text_length: llmResponse.text.length,
      cached_tokens: llmResponse.cachedTokens, // F2.G3: medir cache hit do prompt
    },
  });
  await writeLog('info', 'llm', `Xarlote ← LLM [${llmResponse.model}] — ${llmResponse.tokensIn}in (${llmResponse.cachedTokens} cache)/${llmResponse.tokensOut}out tok, ${llmResponse.latencyMs}ms${llmResponse.toolCalls.length ? ` — tools: ${llmResponse.toolCalls.map((t) => t.name).join(', ')}` : ''}${llmResponse.text ? ` — "${llmResponse.text.slice(0, 60)}…"` : ''}`, {
    traceId, model: llmResponse.model, tokensIn: llmResponse.tokensIn, cachedTokens: llmResponse.cachedTokens, tokensOut: llmResponse.tokensOut, latencyMs: llmResponse.latencyMs,
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
    // Voice intro só é possível se TTS ligado + ainda não rolou + user já consentiu.
    // F2.G2: só nesse caso pagamos a query de contagem (1 round-trip). O caso comum
    // (já introduzido / TTS off) pula direto, sem ir ao banco.
    const voiceEligible =
      promptsConfig.tts_enabled && !alreadyIntroed && user.lgpd_consent_at != null;
    let shouldVoiceIntro = false;
    if (voiceEligible) {
      if (wasProfiling) {
        // 1ª msg após o "Aceitar" — é a saudação "Prazer, X!", sempre por áudio.
        shouldVoiceIntro = true;
      } else {
        // Conta as msgs outbound da Xarlote: a 1ª resposta "real" é quando
        // outCount <= 2 (msg de consent + "como gosta de ser chamado").
        const { count: outCount } = await db
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id)
          .eq('direction', 'out')
          .eq('sender_role', 'assistant');
        shouldVoiceIntro = (outCount ?? 99) <= 2;
      }
    }
    const replyText = llmResponse.text.trim();
    await writeLog('info', 'outbound', `Xarlote → usuário ${shouldVoiceIntro ? '[ÁUDIO intro]' : ''}: "${replyText.slice(0, 100)}${replyText.length > 100 ? '…' : ''}"`, { traceId, voiceIntro: shouldVoiceIntro });

    if (shouldVoiceIntro) {
      // Captura o nome a partir do texto da Xarlote se o enricher ainda não populou
      // user.preferred_name (a Xarlote acabou de ouvir o nome nesse turno; o enricher
      // roda async DEPOIS). Heurística: pega a 1ª palavra capitalizada depois de
      // "Oi", "Olá", "Prazer" — combina com como a Xarlote saúda.
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
  await dbClient.from('user_exam_results').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('conversations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await dbClient.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

async function handleForgetMe(userId: string, conversationId: string, phoneE164: string, traceId: string) {
  // Audit ANTES de executar — caso algo falhe no meio, sabemos que foi tentado
  await writeAudit({
    actorType: 'user',
    action: 'user.forget_me.executing',
    userId,
    conversationId,
    traceId,
    reason: 'lgpd_article_18',
    metadata: { phone_e164: phoneE164 },
  });

  // Record revocation
  await db.from('consent_events').insert({ user_id: userId, event_type: 'revoke', policy_version: '1.0', channel: 'whatsapp' });

  // LGPD Art.18 — apaga TODOS os dados clínicos/pessoais do usuário. Enumera TODAS
  // as tabelas com user_id; filhos (quotes, consultation_quotes, prescription_items,
  // etc) caem por ON DELETE CASCADE dos pais. Mantém só consent_events (prova do
  // aceite/revogação) e audit_log (compliance append-only). system_logs já é redatado.
  const FORGET_ME_TABLES = [
    'symptoms_log', 'treatments', 'medication_inventory', 'medication_log',
    'consultations', 'prescriptions', 'reminders', 'orders', 'assistant_tasks',
    'red_flag_pending', 'feedback_events', 'agent_skills', 'entity_relations',
    'device_tokens', 'event_log',
    'user_health_conditions', 'user_allergies', 'user_medications', 'user_addresses', 'user_exam_results',
  ] as const;

  // Mensagens de TODAS as conversas do usuário (não só a atual).
  const { data: userConvs } = await db.from('conversations').select('id').eq('user_id', userId);
  for (const c of userConvs ?? []) await db.from('messages').delete().eq('conversation_id', c.id);

  for (const t of FORGET_ME_TABLES) {
    const { error } = await db.from(t as string).delete().eq('user_id', userId);
    if (error) await writeLog('warn', 'lgpd', `forget-me: falha ao limpar ${t}: ${error.message}`, { traceId, userId });
  }
  await deleteUserMemory(userId);
  // Fonte CANÔNICA dos memory cards é o JSONB da conversa — deleteUserMemory só
  // limpa o índice; sem isto, dados de saúde sobreviviam ao apagamento LGPD.
  await db.from('conversations').update({ memory_cards: [] }).eq('user_id', userId);
  await db.from('users').update({ phone_e164: `deleted-${userId}`, full_name: null, preferred_name: null, deleted_at: new Date().toISOString() }).eq('id', userId);

  await writeAudit({
    actorType: 'user',
    action: 'user.forget_me.executed',
    userId,
    conversationId,
    traceId,
    reason: 'lgpd_article_18',
    metadata: {
      phone_e164_anonymized: `deleted-${userId}`,
      tables_cleared: ['messages', ...FORGET_ME_TABLES, 'memory_cards_index', 'conversations.memory_cards'],
    },
  });

  const goodbye = 'Pronto, apaguei tudo. Se mudar de ideia, é só me chamar de novo.';
  await sendOutbound(conversationId, phoneE164, goodbye, traceId);

  await writeLog('info', 'lgpd', 'User forget-me completed', { traceId, userId });
}
