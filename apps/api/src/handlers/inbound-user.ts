import { randomUUID } from 'crypto';
import { db, findUserByPhone, upsertUser, findOrCreateConversation, insertMessage, getConversationMessages, writeLog, retrieveRelevantCards, deleteUserMemory, writeAudit, writeEvent, auditUserStateChange, queryUser360, formatUser360ForPrompt, loadUserSkills, formatSkillsForPrompt } from '@iasaude/db';
import { isForgetMeRequest, isConsentAccepted, buildConsentEvent } from '@iasaude/core';
import { ONBOARDING_CONSENT_MESSAGE, ONBOARDING_CONSENT_REPEAT_MESSAGE, SARA_INSTANCE, QUEUE_NAMES, resolveQuotePick, resolveSpecificPick, isOrderAcceptance, resolveSupplierByHint, itemDisplayName, shouldAskOnboardingQuestions, type OnboardingTopic } from '@iasaude/shared';

/**
 * Teto de idade da APRESENTAÇÃO pro backstop determinístico de fechamento poder agir.
 * Fechar compra é irreversível e preço/estoque envelhecem — passado isso, só a LLM fecha
 * (com o paciente reconfirmando). Incidente Vadivino 17/07: pedido de 3,5 DIAS fechado por
 * um "Ok" solto.
 */
const BACKSTOP_MAX_PRESENTED_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Teto de rodadas do loop agêntico. 4 cobre o encadeamento real mais longo observado
 * (buscar → ver resultado → agir → confirmar) sem risco de loop infinito ou latência
 * absurda pro paciente esperando no WhatsApp.
 */
const AGENT_MAX_ROUNDS = 4;

/**
 * Orçamento de tempo do LOOP inteiro (não por rodada). Sem teto global, 4 rodadas ×
 * (3 tentativas × 60s de timeout) passariam de 10min e estourariam o TTL do lock de turno
 * — aí a 2ª mensagem do paciente rodaria EM PARALELO com a 1ª (dupla execução de tool).
 * 75s deixa folga confortável dentro do TURN_LOCK_TTL_MS.
 */
const AGENT_LOOP_BUDGET_MS = 75_000;

/**
 * Kill-switch do loop agêntico. Default LIGADO — é a correção da cegueira estrutural
 * (ver o bloco ReAct no turno). `AGENT_LOOP_ENABLED=false` no Railway volta ao
 * comportamento single-shot antigo NA HORA, sem redeploy, se algo se comportar mal.
 */
function agentLoopEnabled(): boolean {
  return process.env['AGENT_LOOP_ENABLED'] !== 'false';
}
import type { NormalizedInbound, ProfileEnricherJob, MemoryCard, QuoteOption } from '@iasaude/shared';
import { chat, buildXarloteSystemPrompt, xarloteTools, messagesToHistory, trimHistory, embed, userContentWithImage, dataUrl, type ChatContent, type ChatMessage, type ToolCall } from '@iasaude/llm';
import { sendMenu, isSimulatorMode, fetchInboundMedia } from '@iasaude/whatsapp';
import { transcribeAudio } from '@iasaude/integrations';
import { Queue } from 'bullmq';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound, sendOutboundAudio } from './outbound.js';
import { handleToolCall, type ToolResult } from './tool-executor.js';
import { saveContactsToMemory } from './reach-out.js';
import { findPendingClarificationForUser } from './clarification.js';
import { loadLatestOrderState, buildOrderStateBlock } from './order-state.js';
import { buildConsultationStateBlock } from './consultation-state.js';
import { consolidateQuotes } from './quote-consolidation.js';
import { withUserLock } from '../concurrency/user-lock.js';

/**
 * Valida magic bytes de imagem (JPEG/PNG/GIF/WEBP/BMP/HEIC). Evita mandar corpo-LIXO ao modelo
 * de visão como se fosse imagem — um lookaside da Meta pode responder 200 com HTML/JSON de erro
 * (token expirado) em vez de bytes de imagem, e aí o modelo "vê" e ALUCINA ("vi seu cartão").
 * Incidente Vadivino 22/07: visão intermitente + afirmação de ter visto o cartão. Ler ≠ inventar.
 */
export function looksLikeImage(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 12) return false;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                       // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;       // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;       // GIF8
  if (b[0] === 0x42 && b[1] === 0x4d) return true;                                          // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&                   // RIFF….WEBP
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;        // ISO-BMFF 'ftyp' (HEIC/HEIF)
  return false;
}

// Serialização de turno (review H3): 2 mensagens rápidas do MESMO telefone geram 2 turnos
// concorrentes → dupla execução de tools + estado stale + vozes contraditórias. Espera generosa
// pra NÃO dropar a 2ª msg; se o turno anterior demorar mais que isso (raro), processa mesmo assim.
const TURN_LOCK_WAIT_MS = 45_000;
// TTL > pior turno (transcrição 30s + LLM 60s + retry + follow-up ≈ 130s) pra o lock NÃO
// auto-expirar no meio e deixar um turno concorrente entrar (review H3-ressalva).
// TTL > pior turno. Com o LOOP AGÊNTICO o turno ganhou rodadas extras (orçamento
// AGENT_LOOP_BUDGET_MS=75s) além de transcrição, retry de lembrete e narrador — o teto de
// 180s virou apertado e um lock expirando com o turno vivo faz a próxima mensagem do
// paciente rodar EM PARALELO (dupla execução de tool). 300s cobre o pior caso com folga.
const TURN_LOCK_TTL_MS = 300_000;

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
  // Serializa por telefone (H3). `withUserLock` é fail-open (Redis fora → roda sem lock) e devolve
  // null só se o lock não liberou em waitMs — nesse caso processa mesmo assim pra NUNCA dropar a
  // mensagem (degradado; os CAS/guards de cada tool cobrem a corrida remanescente).
  const done = await withUserLock(inbound.from.phoneE164, () => processInboundUserInner(inbound, traceId), {
    scope: 'turn', waitMs: TURN_LOCK_WAIT_MS, ttlMs: TURN_LOCK_TTL_MS,
  });
  if (done !== null) return done;
  await writeLog('warn', 'lock', `turn-lock não liberou em ${TURN_LOCK_WAIT_MS}ms — processando sem serialização (degradado)`, { traceId });
  return processInboundUserInner(inbound, traceId);
}

async function processInboundUserInner(
  inbound: NormalizedInbound,
  traceId: string,
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
    // last_active_at: o paciente ACABOU de falar. A coluna existia mas NUNCA era escrita
    // (auditoria 20/07) → o sistema ficava cego pra silêncio e não sabia fazer back-off de
    // quem sumiu. Agora todo inbound carimba "ativo agora" (dashboard + sinais de engajamento).
    db.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', user.id),
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
    const isRefuse = /^recusar?$/.test(lower) || /^n[aã]o\s*aceito$/.test(lower) || lower === 'recuso';
    // 🔏 Aceite EXPLÍCITO apenas (LGPD art. 5º XII — manifestação inequívoca): botão
    // "Aceitar" ou afirmação clara (CONSENT_ACCEPTED_PATTERNS). Antes, QUALQUER texto
    // não-"recusar" E QUALQUER MÍDIA valiam como aceite — o consent da Elizabet (09/07)
    // foi registrado a partir de um áudio NUNCA transcrito (evidence_text='[audio]'),
    // com o conteúdo do áudio descartado em silêncio. Mídia nunca aceita; texto
    // não-afirmativo cai no re-pedido logo abaixo (o pedido dele fica no histórico e é
    // atendido normalmente depois do aceite).
    const isAccept = !isRefuse && text.length > 0 && isConsentAccepted(text);

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

    // Nem aceitou nem recusou: mídia (não processada antes do aceite — LGPD) ou texto
    // não-afirmativo → re-pede o aceite SEM registrar consent. Honesto sobre o áudio:
    // avisa que ainda não pôde ouvir, em vez de descartar em silêncio (caso Elizabet).
    // RE-ENVIA OS BOTÕES (review 10/07 #24): o re-pedido saía como texto puro e o caminho
    // de 1 toque sumia — idoso responde texto livre e podia ficar em loop.
    const repeatMsg = inbound.contentType !== 'text'
      ? `Recebi seu ${inbound.contentType === 'audio' ? 'áudio' : 'arquivo'}, mas antes do seu aceite eu ainda não posso abri-lo, tá? 🙈\n\n${ONBOARDING_CONSENT_REPEAT_MESSAGE}`
      : ONBOARDING_CONSENT_REPEAT_MESSAGE;
    await db.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'out',
      sender_role: 'assistant',
      content_type: 'text',
      content: repeatMsg,
      trace_id: traceId,
    });
    await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id);
    if (!isSimulatorMode()) {
      try {
        await sendMenu(SARA_INSTANCE, phoneE164, repeatMsg, ['Aceitar', 'Recusar'], {
          type: 'button',
          ticketId: inbound.providerTicketId,
        });
      } catch (err) {
        await writeLog('warn', 'outbound', `Re-pedido de consent: menu falhou, caindo pra texto: ${String(err).slice(0, 100)}`, { traceId });
        await sendOutbound(conversation.id, phoneE164, repeatMsg, traceId);
      }
    }
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
    // PONTO 8 (incidente Valdivino→Vadivino): a resposta à pergunta "como gosta de ser
    // chamado?" NUNCA era persistida → preferred_name ficava no pushName do WhatsApp. Agora
    // salva o nome DIGITADO (conservador: só se parece nome — curto, letras, sem verbo de pedido).
    const typedName = (inbound.text ?? '').trim();
    const looksLikeName = !!typedName
      && typedName.length <= 30
      && typedName.split(/\s+/).length <= 3
      && /^[\p{L}][\p{L}\s'.\-]*$/u.test(typedName)
      && !/\b(comprar|preciso|quero|rem[ée]dio|medic|cotar|pedir|ajuda|oi|ol[áa]|bom dia|boa tarde|boa noite|sim|n[ãa]o|prazer|obrigad[oa]|valeu|beleza|blz|de nada|opa|e a[íi]|tudo bem|tudo bom|ok|okay|test[ae])\b/i.test(typedName);
    if (looksLikeName) {
      const cleanName = typedName.replace(/\s+/g, ' ').slice(0, 40);
      await db.from('users').update({ preferred_name: cleanName, onboarding_status: 'active' }).eq('id', user.id);
      user = { ...user, preferred_name: cleanName, onboarding_status: 'active' };
    } else {
      await db.from('users').update({ onboarding_status: 'active' }).eq('id', user.id);
      user = { ...user, onboarding_status: 'active' };
    }
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
    // Msg CURTA ("oi", "sim", "não") tem densidade semântica ~zero: o embedding
    // dela filtra fora quase toda a memória relevante (similaridade nunca passa do
    // piso). Nesses casos pulamos o semântico → retrieval cai no fallback por
    // recência+confiança, que traz o perfil (alergias/medicamentos) mesmo assim.
    const queryText = (inbound.text ?? '').trim();
    if (queryText.length >= 12 && llmKey) {
      try {
        queryEmbedding = await embed(queryText.slice(0, 1000), { apiKey: llmKey, timeoutMs: 6_000 });
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

  const [history, user360, activeOrderRes, relevantCards, skills, paymentHistRes, pendingClarif, activeRemindersRes, recentTasksRes, orderState, consultStateBlock] = await Promise.all([
    getConversationMessages(conversation.id, 30),
    queryUser360(user.id),
    db.from('orders')
      .select('id, status, items, summary, presented_at')
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
    // Lembretes ativos: a Xarlote precisa ENXERGAR o que já existe pra não criar
    // plano duplicado (caso real: 2 planos de água sobrepostos = 15 pings/dia) e
    // pra saber o que cancelar via cancel_reminders ao substituir um plano.
    db.from('reminders')
      .select('title, type, rrule, next_run_at, payload')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('next_run_at', { ascending: true })
      .limit(20),
    // Fix #5: ações que a Xarlote JÁ executou no turno anterior (fire-and-forget não
    // devolve resultado ao LLM → ela se contradizia "já cuidei" + "me diz qual prefere").
    // Injeta o desfecho real das tools recentes pra ela NÃO afirmar o que não aconteceu.
    db.from('assistant_tasks')
      .select('tool_name, status, completed_at')
      .eq('conversation_id', conversation.id)
      .in('status', ['success', 'error'])
      .not('completed_at', 'is', null)
      .gte('completed_at', new Date(Date.now() - 10 * 60_000).toISOString())
      .order('completed_at', { ascending: false })
      .limit(6),
    // Estado COMPLETO do pedido de farmácia mais recente (todas as farmácias, cada uma
    // num ponto) — pra Xarlote entender o pedido inteiro, re-contatar uma específica
    // (message_supplier) e nunca alucinar "confirmado" num pedido que falhou.
    loadLatestOrderState(user.id).catch(() => null),
    // ESTADO DA CONSULTA ativa — sem isto a Xarlote fica CEGA à consulta em andamento e "insiste
    // em marcar" cai no fluxo de farmácia (incidente Vadivino 22/07).
    buildConsultationStateBlock(user.id).catch(() => null),
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

  // Convênio declarado pelo paciente. Fica em users.metadata (gravado por
  // save_user_profile_fact category 'other', que faz MERGE no metadata) — sem coluna nova.
  const userHealthPlan = (() => {
    const m = user.metadata as Record<string, unknown> | null | undefined;
    const v = m?.['health_plan'];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  })();

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
    healthPlan: userHealthPlan,
  });

  // 🤝 CONHECER O PACIENTE — 3 perguntas de baixa fricção, só pra quem acabou de entrar.
  //
  // Roda DEPOIS do onboarding existente (consentimento → nome → áudio): o gate é
  // `onboarding_status === 'active'`, que só é atingido quando aquele fluxo terminou. Nada
  // do que já funciona é tocado.
  //
  // Estado DERIVADO, sem máquina de estado nova: a pergunta some sozinha quando o dado
  // existe. Sem migração, sem flag pra corromper, sem escrita extra por turno.
  //   • medicação de uso contínuo → destrava reposição automática e lembretes
  //   • condição acompanhada      → contexto que ela nunca infere sozinha com segurança
  //   • convênio                  → prioriza clínicas que aceitam o plano (no caso real do
  //     Ciro, a clínica só revelou "não atendo plano" depois de 5h de ida e volta)
  // Alergia NÃO entra aqui (decisão do fundador): é colhida no 1º pedido de remédio, onde
  // a pergunta é natural e a taxa de resposta é maior.
  {
    const PERGUNTA: Record<OnboardingTopic, string> = {
      medication: '- **Remédio de uso contínuo**: *"Você toma algum remédio todo dia?"* → guarde com `save_user_profile_fact` (category `medication`).',
      condition: '- **Condição acompanhada**: *"Tem alguma condição que você acompanha? Pressão, diabetes, tireoide, colesterol…"* (os exemplos são obrigatórios — sem eles a pessoa trava e diz "não") → `save_user_profile_fact` (category `condition`).',
      health_plan: '- **Convênio**: *"E pra consulta ou exame, você tem plano de saúde ou prefere particular?"* → `save_user_profile_fact` (category `other`, payload `{"health_plan": "<nome do plano ou \'particular\'>"}`). ⚠️ Diga SEMPRE "pra consulta ou exame": em FARMÁCIA você não aplica desconto de convênio, e sem esse recorte a pessoa entende errado.',
    };
    const decision = shouldAskOnboardingQuestions({
      onboardingStatus: user.onboarding_status,
      createdAtIso: (user.created_at as string | null | undefined) ?? null,
      nowMs: Date.now(),
      hasMedications: Boolean(medications?.length),
      hasConditions: Boolean(conditions?.length),
      hasHealthPlan: Boolean(userHealthPlan),
      // Já ofereceu nesta conversa? Deriva do próprio histórico — nada é gravado pra isso.
      alreadyOffered: (history ?? []).some((m) => {
        const c = typeof (m as { content?: unknown }).content === 'string' ? (m as { content: string }).content : '';
        return (m as { direction?: string }).direction === 'out' && /nos conhecer melhor|perguntinhas/i.test(c);
      }),
      // Recusa DURÁVEL: `alreadyOffered` só enxerga a janela de histórico carregada, então
      // sem isto a pergunta voltaria dias depois pra quem já disse não.
      declined: (user.metadata as Record<string, unknown> | null | undefined)?.['onboarding_qs_declined'] === true,
      isProfilingTurn: wasProfiling,
    });

    if (decision.ask) {
      systemPrompt += `\n\n## 🤝 CONHECER ESTE PACIENTE (ele é novo — você ainda não sabe estas coisas)
${decision.missing.map((t) => PERGUNTA[t]).join('\n')}

**COMO CONDUZIR (a ordem importa):**
1. Primeiro responda o que ele trouxe nesta mensagem. Sempre. O paciente vem antes do roteiro.
2. Se ele não trouxe nada específico (só cumprimentou/agradeceu), OFEREÇA a escolha, uma vez só: *"Posso te fazer duas ou três perguntinhas rápidas pra te conhecer melhor? Ou, se preferir, já me diz o que você precisa 💙"*
3. Com o "sim", faça **UMA pergunta por mensagem** — nunca as três juntas, nunca em lista.
4. Recebeu a resposta → chame \`save_user_profile_fact\` na hora e emende a próxima com naturalidade.

**QUANDO PARAR (inegociável):**
- Ele pediu QUALQUER coisa (remédio, consulta, dúvida, lembrete) → **abandone o roteiro imediatamente** e atenda. Não volte ao assunto nesse turno.
- Ele disse que não quer, desconversou ou ignorou → aceite na primeira vez e **NUNCA insista**. Some com o assunto e registre a recusa com \`save_user_profile_fact\` (category \`other\`, payload \`{"onboarding_qs_declined": true}\`) pra você não voltar a perguntar em outro dia.
- Nunca pergunte o que já está no CONTEXTO DESTE USUÁRIO acima.
- Isto é conversa, não formulário: nada de "pergunta 1 de 3", numeração ou "para finalizar seu cadastro".`;
    }
  }

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

  // Lembretes ativos — visibilidade pro gerenciamento (criar/cancelar/substituir).
  const activeReminders = (activeRemindersRes.data ?? []) as Array<{ title: string; type: string; rrule: string | null; next_run_at: string; payload: Record<string, unknown> | null }>;
  if (activeReminders.length > 0) {
    const fmtHora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const fmtData = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const linhas = activeReminders.map((r) => {
      const cond = r.payload as { condition?: string; depends_on_title?: string } | null;
      const tag = cond?.condition === 'if_not_confirmed'
        ? ` — ⚙️ backup condicional de "${cond.depends_on_title ?? ''}" (só dispara se o primário não for confirmado)`
        : '';
      return `- "${r.title}" (${r.type}) — ${r.rrule ? `recorrente, próximo às ${fmtHora(r.next_run_at)}` : `único em ${fmtData(r.next_run_at)} às ${fmtHora(r.next_run_at)}`}${tag}`;
    });
    systemPrompt += `\n\n## ⏰ LEMBRETES ATIVOS DESTE USUÁRIO (${activeReminders.length})\n${linhas.join('\n')}\n\nEsta lista é a VERDADE — vale mais que qualquer coisa dita no histórico da conversa. Estes JÁ EXISTEM. NÃO crie de novo os mesmos (mesmo assunto/horário) — se ele reperguntar "agendou?"/"criou?", responda SIM olhando esta lista, sem chamar create_reminder. Pra MUDAR/REDIVIDIR um plano, chame cancel_reminders (title_query) ANTES de criar os novos — nunca deixe dois planos do mesmo assunto coexistirem. Se pedir pra parar, cancel_reminders resolve sozinho.`;
  } else {
    // 🔴 O NEGATIVO PRECISA SER EXPLÍCITO (incidente Hiago 28/07).
    // Antes, lista vazia = bloco AUSENTE, e o silêncio é ambíguo: o modelo preencheu com o
    // histórico, onde ELE MESMO tinha escrito no dia anterior "criei 4 lembretes pra hoje:
    // 10h, 13h, 16h e 19h". Respondeu "você já tem lembretes marcados pra hoje" com ZERO
    // lembretes no banco — e às 10h não chegou nada. Pior: um lembrete one-shot de ontem
    // dizia "pra HOJE", que lido hoje vira uma data diferente (armadilha de dêitico, agora
    // no histórico da conversa e não no corpo do lembrete).
    // A ausência de informação estava sendo lida como confirmação. Agora o vazio FALA.
    systemPrompt += `\n\n## ⏰ LEMBRETES ATIVOS DESTE USUÁRIO (0)\nEste usuário **NÃO tem NENHUM lembrete ativo agora**. Esta é a VERDADE do banco de dados neste instante.\n\n⚠️ O histórico da conversa pode conter você dizendo que criou lembretes em dias anteriores — **aqueles JÁ DISPARARAM e não existem mais**. NUNCA use o histórico pra afirmar que existe lembrete: se ele perguntar "tenho lembrete?"/"vai me avisar?", a resposta honesta é que NÃO há nenhum ativo, e ofereça criar agora. Um lembrete que você "lembra" de ter criado ontem para "hoje" era para o dia ANTERIOR.`;
  }

  // Fix #5 — desfecho REAL das tools do turno anterior (anti-contradição). O loop é
  // fire-and-forget: o LLM não vê o retorno das tools e se contradizia ("já cuidei" +
  // "me diz qual prefere"). Aqui ele passa a saber o que FECHOU vs o que está AGUARDANDO.
  const recentTasks = (recentTasksRes.data ?? []) as Array<{ tool_name: string; status: string; completed_at: string }>;
  if (recentTasks.length > 0) {
    const OUTCOME: Record<string, string> = {
      confirm_order_selection: 'pedido de medicamento FECHADO com a farmácia (aguardando pagamento/entrega)',
      start_pharmacy_order: 'cotação de medicamento INICIADA — AGUARDANDO farmácias responderem (NÃO afirme que já tem preço; se ele perguntar, use get_order_status)',
      confirm_consultation_selection: 'consulta CONFIRMADA com a clínica',
      start_consultation_search: 'busca de consulta INICIADA — AGUARDANDO clínicas responderem',
      create_reminder: 'lembrete(s) criado(s) — os títulos/horários já estão em LEMBRETES ATIVOS; NÃO recrie os mesmos',
      cancel_reminders: 'lembrete(s) cancelado(s)',
      log_medication_taken: 'dose registrada',
      log_symptom: 'sintoma registrado',
      set_emergency_contact: 'contato de emergência salvo',
      save_exam_result: 'resultado de exame guardado no perfil',
      red_flag_check: 'protocolo de emergência acionado (botões enviados)',
    };
    const seen = new Set<string>();
    const linhas: string[] = [];
    for (const tsk of recentTasks) {
      if (seen.has(tsk.tool_name)) continue;
      seen.add(tsk.tool_name);
      const desc = OUTCOME[tsk.tool_name];
      if (!desc) continue;
      linhas.push(
        tsk.status === 'error'
          ? `- ❌ ${tsk.tool_name} FALHOU — NÃO diga que deu certo; se ele cobrar, peça pra tentar de novo.`
          : `- ✅ ${desc}`,
      );
    }
    if (linhas.length) {
      systemPrompt += `\n\n## ✅ O QUE VOCÊ JÁ FEZ (último turno — use como CONTEXTO, não repita mecanicamente)\n${linhas.join('\n')}\n\nNão prometa nem re-execute o que já está aqui. Se o desfecho diz AGUARDANDO, não diga que já concluiu. Seja coerente com o estado real.`;
    }
  }

  if (promptsConfig.sara_suffix.trim()) {
    systemPrompt += `\n\n## INSTRUÇÕES ADICIONAIS (configuradas no dashboard)\n${promptsConfig.sara_suffix.trim()}`;
  }

  // Loop agêntico: se uma farmácia/clínica está esperando um dado do cliente,
  // injeta a pergunta pendente pra Xarlote levar a resposta de volta.
  if (pendingClarif) {
    const oQue = pendingClarif.kind === 'clinic' ? 'a consulta' : 'o pedido';
    systemPrompt += `\n\n## ⏳ PERGUNTA PENDENTE DE UM ESTABELECIMENTO\n${pendingClarif.supplierName} está aguardando uma resposta sua pra continuar ${oQue}:\n"${pendingClarif.question}"\n\nSe a mensagem do usuário responde um DADO desta pergunta (mesmo parcial), chame **relay_answer_to_establishment** com a resposta dele no campo \`answer\`. Se ele falar de OUTRA coisa, responda normal; a pergunta continua pendente.\n\n🔒 EXCEÇÃO IMPORTANTE: se a mensagem do usuário for um ACEITE/ESCOLHA de uma opção já cotada (ver PEDIDO ATIVO) — ex.: "aceito", "pode ser", "quero a X" — use **confirm_order_selection** (NÃO relay). Fechar já avisa a farmácia.`;
  }

  // Estado COMPLETO do pedido (todas as farmácias + o que cada uma disse + quais dá pra
  // re-contatar na janela de 24h). Dá à Xarlote a compreensão do pedido inteiro — pra
  // voltar numa farmácia específica (message_supplier), reportar honesto e não alucinar.
  if (!orderState) {
    // Mesmo defeito do bloco de lembretes (incidente Hiago 28/07): sem pedido ativo o bloco
    // some, e o silêncio deixa o modelo inferir do histórico que a compra de dias atrás
    // ainda está viva ("já mandei pras farmácias, te aviso"). O negativo tem que ser dito.
    systemPrompt += `\n\n## 📦 ESTADO DO PEDIDO\nEste usuário **NÃO tem nenhum pedido de medicamento ativo** nas últimas 24h. Esta é a VERDADE do banco neste instante — o histórico da conversa pode mencionar pedidos ANTIGOS, já encerrados. Se ele perguntar sobre um pedido, seja honesta: não há nenhum em andamento, e ofereça começar.`;
  }
  if (orderState) {
    systemPrompt += `\n\n${buildOrderStateBlock(orderState)}`;
  }

  // Estado da CONSULTA ativa (espelho do de farmácia) — dá o anchor pra Xarlote não confundir
  // "insiste em marcar [consulta]" com pedido de remédio, e saber usar nudge_consultation.
  if (consultStateBlock) {
    systemPrompt += `\n\n${consultStateBlock}`;
  }

  // 9. Build user message — texto, áudio (transcrito), imagem (multimodal vision), localização.
  // userMsgContent vira `string | ChatContent[]`. Default texto puro; vira array quando há imagem.
  let userMsgContent: string | ChatContent[] = inbound.text ?? '';
  let userMsgPreview = '';

  if (inbound.sharedContacts?.length) {
    // Contato(s) do WhatsApp compartilhado(s): mostra nome+telefone pro LLM (pra ele
    // poder chamar contact_establishment) e SALVA na memória automaticamente. O telefone
    // NÃO fica no content persistido (inbound.text é phone-free) — só no prompt do LLM.
    const list = inbound.sharedContacts
      .map((c) => `${c.name} (WhatsApp ${c.phoneE164}${c.org ? `, ${c.org}` : ''})`).join('; ');
    const plural = inbound.sharedContacts.length > 1;
    userMsgContent = `[O usuário compartilhou ${plural ? 'os contatos' : 'o contato'}: ${list}. Já salvei na sua memória. Se ele quiser que você FALE com esse número (pedir remédio, marcar consulta, etc.), chame contact_establishment com esse phone e o kind certo. Se ele não disse o que quer, pergunte.]`;
    userMsgPreview = `[contato: ${inbound.sharedContacts.map((c) => c.name).join(', ')}]`;
    await saveContactsToMemory(inbound.sharedContacts, { userId: user.id, conversationId: conversation.id, phoneE164, traceId })
      .catch(() => { /* memória é best-effort */ });
    // Chegou contato NOVO → invalida uma busca-por-nome pendente (senão um "sim" depois
    // poderia contatar o candidato antigo em vez deste contato — review).
    await db.from('conversations').update({ pending_lookup: null }).eq('id', conversation.id).then(() => {}, () => {});
  } else if (inbound.contentType === 'location' && inbound.location) {
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
        // Valida magic bytes ANTES de mandar ao modelo (corpo pode vir corrompido/não-imagem).
        const probe = Buffer.from(inbound.mediaBase64.slice(0, 64), 'base64');
        if (looksLikeImage(probe)) {
          dataUrlValue = dataUrl(inbound.mediaBase64, inbound.mediaMime ?? 'image/jpeg');
        } else {
          await writeLog('warn', 'vision', `mediaBase64 não parece imagem válida — tratando como falha (id=${longId})`, { traceId, longId });
        }
      } else {
        const media = await fetchInboundMedia(inbound, SARA_INSTANCE);
        if (media && looksLikeImage(media.buffer)) {
          await writeLog('info', 'vision', `Imagem baixada (${media.buffer.length} bytes, ${media.mime})`, { traceId });
          dataUrlValue = dataUrl(media.buffer.toString('base64'), media.mime || 'image/jpeg');
        } else if (media) {
          // 200 com corpo que NÃO é imagem (ex.: lookaside da Meta devolvendo erro HTML/JSON com
          // token expirado) → NÃO manda ao modelo (senão ele alucina que "viu"). Trata como falha.
          await writeLog('warn', 'vision', `Mídia baixada não parece imagem válida (${media.buffer.length} bytes, ${media.mime}) — tratando como falha (id=${longId})`, { traceId, longId });
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
      // 2000 (era 1500/1024): turnos com VÁRIAS tool calls (ex.: plano de 2 lembretes +
      // condicional) gastam tokens nos args e truncavam o texto no meio (incidente Glauber:
      // "...e outro de"). Mais folga + o fallback abaixo.
      maxOutputTokens: 2000,
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
  // ctx ÚNICO do turno: o Set ordersCreatedThisTurn é COMPARTILHADO entre todas as
  // tools (e o backstop) → cancel_order não cancela um pedido criado por um
  // start_pharmacy_order do mesmo turno, independente da ordem que o LLM emitiu (HIGH-1).
  const turnToolCtx = {
    userId: user.id,
    conversationId: conversation.id,
    phoneE164,
    traceId,
    inboundMsg,
    inbound,
    ordersCreatedThisTurn: new Set<string>(),
    // UMA VOZ: handlers auto-contidos (message_supplier) setam suppressLlmText — o texto
    // do LLM não sai junto contradizendo a resposta real da tool (incidente 07/07 17:34).
    turnFlags: { suppressLlmText: false, supplierMessaged: false },
  };

  // 🚑 PREEMPÇÃO DE EMERGÊNCIA. Sinais físicos CLAROS e AGUDOS (dor no peito, falta de ar,
  // desmaio, convulsão, AVC, sangramento) → força red_flag_check (botões SAMU) e SUPRIME a
  // conversa de pedido/backstops neste turno. Regex CONSERVADORA de propósito: distress vago
  // ("passando mal", "dor de cabeça forte" sem intensificador) NÃO dispara SAMU — é coberto
  // pelo status honesto do message_supplier (nunca mais o enlatado que ignorou o Vadivino).
  // Guarda de PASSADO/3ª pessoa: "semana passada minha mãe teve dor no peito, cota AAS" NÃO é
  // emergência atual → não preempta (senão dropava o pedido legítimo — review 09/07).
  const distressText = typeof userMsgContent === 'string' ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '').trim() : '';
  const EMERGENCY_RE = /(dor no peito|aperto no peito|falta de ar|n[aã]o consigo respirar|desmai|convuls|derrame\b|\bavc\b|rosto torto|fala arrastada|sangrando muito|dor de cabe[çc]a (muito|t[aã]o|super|bem) forte)/i;
  const PAST_OR_OTHER_RE = /\b(semana passada|m[êe]s passado|ano passado|ontem|anteontem|passad[oa]|minha m[ãa]e|meu pai|minha av[óo]|meu av[ôo]|minha filha|meu filho|minha esposa|meu marido|um amigo|uma amiga|j[áa] tive|tinha tido|ele teve|ela teve|costumo ter|as vezes tenho|[àa]s vezes tenho)\b/i;
  const alreadyRedFlag = llmResponse.toolCalls.some((t) => t.name === 'red_flag_check');
  let distressPreempted = false;
  if (!alreadyRedFlag && EMERGENCY_RE.test(distressText) && !PAST_OR_OTHER_RE.test(distressText)) {
    await writeLog('warn', 'red_flag', `🚑 Emergência determinística ("${distressText.slice(0, 40)}") → forçando red_flag_check`, { traceId });
    await handleToolCall(
      { id: randomUUID(), name: 'red_flag_check', args: { category: 'other_critical', severity: 'high', evidence: distressText.slice(0, 200) } } as unknown as Parameters<typeof handleToolCall>[0],
      turnToolCtx,
    );
    turnToolCtx.turnFlags.suppressLlmText = true;
    distressPreempted = true;
  }

  // ═══ LOOP AGÊNTICO (ReAct) — a correção da CEGUEIRA ═══════════════════════════════
  // Antes de 26/07 este bloco era um `for` de uma passada: as tools rodavam, o resultado ia
  // pro VAZIO (handleToolCall era `void`) e o texto ao paciente já tinha sido escrito NA
  // MESMA chamada — ou seja, a Xarlote descrevia o que IMAGINAVA que ia acontecer. Daí
  // "já falei com a farmácia" sem ter falado, contradição no mesmo turno e tool errada sem
  // chance de correção. Agora: executa → DEVOLVE o resultado ao modelo → ele re-decide
  // ENXERGANDO o que aconteceu. É a diferença entre narrar e observar.
  //
  // Custo: só há rodada extra quando houve tool call (turno de papo puro sai em 1 chamada,
  // como antes) e o prompt-cache cobre ~99% do input a partir da 2ª. Kill-switch:
  // AGENT_LOOP_ENABLED=false volta ao comportamento antigo sem redeploy.
  const EMERGENCY_SKIP_TOOLS = ['message_supplier', 'relay_answer_to_establishment', 'confirm_order_selection', 'start_pharmacy_order', 'expand_pharmacy_search', 'get_order_status', 'contact_establishment', 'find_clinic_by_name', 'start_consultation_search', 'confirm_consultation_selection', 'cancel_order'];
  const priorMessages: ChatMessage[] = [];
  // Guarda o `ok` junto: os backstops anti-mentira precisam saber se a tool teve SUCESSO,
  // não só se foi TENTADA — senão um create_reminder que falhou marca "já chamou a tool" e
  // o backstop deixa passar a promessa falsa (paciente fica sem o lembrete).
  const executedToolCalls: Array<ToolCall & { ok: boolean }> = [];
  // Tools de efeito IRREVERSÍVEL que não podem repetir entre rodadas do loop (o modelo, ao
  // ver o resultado, tende a "reforçar" a ação). Emergência escalonada 2× liga 2 vezes pro
  // contato do paciente; message_supplier 2× manda 2 WhatsApps reais pra farmácia.
  const ONCE_PER_TURN_TOOLS = new Set(['red_flag_check', 'message_supplier', 'send_emergency_orientation']);
  const alreadyRanThisTurn = new Set<string>();
  // Orçamento de tempo do turno INTEIRO: sem isto, 4 rodadas × (3 tentativas × 60s) podia
  // passar de 10min e estourar o TTL do lock de turno (180s) — dois turnos do mesmo paciente
  // rodariam em paralelo, que é exatamente a corrida que o lock existe pra matar.
  const agentDeadline = Date.now() + AGENT_LOOP_BUDGET_MS;
  let agentRounds = 0;
  let redFlagFiredInLoop = false;
  let lastNonEmptyRoundText = '';

  for (;;) {
    agentRounds++;
    const roundResults: Array<{ tc: ToolCall; res: ToolResult }> = [];
    let skippedAny = false;
    for (const tc of llmResponse.toolCalls) {
      // Emergência tem precedência: não deixa a conversa de PEDIDO/farmácia sair junto do
      // protocolo de emergência (o usuário não pode ouvir "mandei msg pra farmácia" agora).
      // Vale em TODA rodada — inclusive quando quem disparou a emergência foi o próprio
      // modelo (aí `distressPreempted` é false, mas `redFlagFiredInLoop` pega).
      if ((distressPreempted || redFlagFiredInLoop) && EMERGENCY_SKIP_TOOLS.includes(tc.name)) { skippedAny = true; continue; }
      if (ONCE_PER_TURN_TOOLS.has(tc.name) && alreadyRanThisTurn.has(tc.name)) {
        await writeLog('warn', 'tool', `Tool ${tc.name} repetida no mesmo turno — IGNORADA (efeito irreversível)`, { traceId });
        skippedAny = true;
        continue;
      }
      await writeLog('info', 'tool', `Tool call: ${tc.name}`, { traceId, args: tc.args });
      const res = await handleToolCall(tc, turnToolCtx);
      alreadyRanThisTurn.add(tc.name);
      if (tc.name === 'red_flag_check' && res.ok) redFlagFiredInLoop = true;
      executedToolCalls.push({ ...tc, ok: res.ok });
      roundResults.push({ tc, res });
    }

    // Continua o loop só se: flag ligada, alguma tool rodou, NENHUMA foi pulada (senão o
    // transcript teria tool_call sem resultado e a API rejeita o turno inteiro), há orçamento
    // de rodadas e de tempo, e não estamos em contexto de emergência.
    const canLoop = agentLoopEnabled()
      && roundResults.length > 0
      && !skippedAny
      && roundResults.length === llmResponse.toolCalls.length
      && roundResults.every((r) => Boolean(r.tc.id))
      && agentRounds < AGENT_MAX_ROUNDS
      && Date.now() < agentDeadline
      && !distressPreempted
      && !redFlagFiredInLoop;
    if (!canLoop) break;

    // Ecoa o passo do assistant + o RESULTADO de cada tool. Regra dura da API: toda
    // tool_call ecoada PRECISA de uma mensagem `role:'tool'` com o mesmo id.
    priorMessages.push({ role: 'assistant', content: llmResponse.text || '', tool_calls: llmResponse.rawToolCalls });
    for (const { tc, res } of roundResults) {
      priorMessages.push({
        role: 'tool',
        tool_call_id: tc.id as string, // garantido pelo `every(r => Boolean(r.tc.id))` acima
        content: JSON.stringify(res),
      });
    }

    // Guarda o melhor texto já visto: modelos costumam devolver `content` vazio na rodada
    // final (os tool results já disseram tudo). Sem isto, um turno que produziu uma resposta
    // ótima na rodada 1 cairia no narrador genérico ("Prontinho, já cuidei disso aqui!").
    if (llmResponse.text.trim()) lastNonEmptyRoundText = llmResponse.text.trim();

    const roundStart = Date.now();
    try {
      llmResponse = await chat(userMsgContent, {
        model,
        apiKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
        systemInstruction: systemPrompt,
        history: geminiHistory,
        tools: xarloteTools,
        temperature: 0.4,
        maxOutputTokens: 2000,
        // Rodadas ≥2 têm timeout CURTO: o paciente já está esperando desde a rodada 1 e o
        // orçamento total do turno é limitado (ver agentDeadline).
        timeoutMs: 25_000,
        priorMessages,
      });
    } catch (err) {
      // Rodada extra falhou: NÃO derruba o turno — as tools da rodada anterior JÁ rodaram
      // (efeito real no mundo). Mantém o que temos e segue pros backstops/narrador.
      await writeLog('warn', 'llm', `rodada ${agentRounds + 1} do loop agêntico falhou (${String(err).slice(0, 120)}) — seguindo com o resultado parcial`, { traceId });
      break;
    }
    await writeLog('info', 'llm', `↻ loop agêntico rodada ${agentRounds + 1} [${llmResponse.model}] — ${llmResponse.tokensIn}in (${llmResponse.cachedTokens} cache)/${llmResponse.tokensOut}out, ${Date.now() - roundStart}ms${llmResponse.toolCalls.length ? ` — tools: ${llmResponse.toolCalls.map((t) => t.name).join(', ')}` : ' — resposta final'}`, {
      traceId, round: agentRounds + 1, model: llmResponse.model,
    });
  }

  // Os backstops abaixo inspecionam `llmResponse.toolCalls` pra decidir se precisam agir.
  // Sem isto eles só enxergariam a ÚLTIMA rodada e re-forçariam tools que já rodaram.
  // A última rodada terminou sem pedir mais nada? Então o texto dela é a conclusão do modelo
  // DEPOIS de ver os resultados — o texto mais informado do turno (ver suppressReply).
  const llmResponseFinalHadNoTools = llmResponse.toolCalls.length === 0;
  // Rodada final veio sem texto? Reaproveita o melhor texto do turno (ver lastNonEmptyRoundText).
  const finalText = llmResponse.text.trim() || lastNonEmptyRoundText;
  llmResponse = { ...llmResponse, text: finalText, toolCalls: executedToolCalls };
  /**
   * A tool rodou COM SUCESSO neste turno? Os backstops anti-mentira precisam disto e não de
   * "foi tentada": um `create_reminder` que EXPLODIU deixava `calledReminderTool = true`, o
   * backstop se calava e a promessa falsa ("te lembro todo dia às 7h") ia pro paciente com o
   * lembrete inexistente. Agora só o sucesso conta.
   */
  const toolRanOk = (...names: string[]) => executedToolCalls.some((t) => names.includes(t.name) && t.ok);

  // 11a. BACKSTOP DE CONSOLIDAÇÃO SOB DEMANDA (auditoria 1º pedido 14/07): o usuário disse
  // "pode pedir" com uma farmácia já precificada, mas o pedido ainda estava 'quoting' (NÃO
  // consolidado) → o glm-5.2 NARROU "deixa eu pegar os detalhes / deixa eu verificar" SEM
  // chamar tool, e a consolidação só veio por TIMEOUT (5min depois). Se o usuário quer
  // decidir/saber e já há preço, consolidamos AGORA — independe do humor do LLM.
  // ⚠️ Estado FRESCO (o snapshot do início do turno pode estar velho: um timer pode ter
  // consolidado no meio) e só suprime o LLM se a consolidação REALMENTE apresentou — senão
  // seria TURNO MUDO (consolidateQuotes sai calada em bail: pendingClarif, status, no-op).
  {
    const decideText = typeof userMsgContent === 'string' ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '').trim() : '';
    const DECIDE_RE = /\b(pode (pedir|fechar|ir|mandar|seguir)|quero (fechar|pedir|essa|a de|a mais)|fecha (essa|a[íi]|com|logo)|vai nessa|manda ver|a mais barata|qual (a mais|melhor|mais em conta|mais barat)|alguma (resposta|not[íi]cia)|tem (not[íi]cia|resposta)|j[áa] (respondeu|tem pre[çc]o))/i;
    const wantsToDecide = !!decideText && (isOrderAcceptance(decideText) || DECIDE_RE.test(decideText));
    const alreadyClosing = llmResponse.toolCalls.some((t) => t.name === 'confirm_order_selection');
    if (wantsToDecide && !distressPreempted && !alreadyClosing) {
      const { data: fresh } = await db.from('orders')
        .select('id, status, summary').eq('user_id', user.id).eq('status', 'quoting')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (fresh && !fresh.summary) {
        const { data: pricedQ } = await db.from('quotes').select('id').eq('order_id', fresh.id).not('total', 'is', null).limit(1);
        if (pricedQ && pricedQ.length) {
          // "pode pedir" é a RESPOSTA a uma eventual pergunta pendente desse pedido → marca
          // 'answered' pra destravar a consolidação (que senão bailaria em hasPendingClarification).
          await db.from('quotes').update({ clarification_status: 'answered' }).eq('order_id', fresh.id).eq('clarification_status', 'awaiting_user');
          await consolidateQuotes(fresh.id, conversation.id, phoneE164, traceId);
          // só suprime o texto do LLM se a consolidação REALMENTE apresentou (virou 'quoted'
          // com summary); senão deixa o LLM responder — NUNCA cala o turno.
          const { data: after } = await db.from('orders').select('status, summary').eq('id', fresh.id).maybeSingle();
          if (after?.status === 'quoted' && after.summary) {
            turnToolCtx.turnFlags.suppressLlmText = true;
            await writeLog('info', 'order', `🔒 Backstop 11a: consolidação sob demanda apresentada ("${decideText.slice(0, 40)}")`, { traceId, orderId: fresh.id });
          } else {
            await writeLog('info', 'order', `Backstop 11a: consolidação não apresentou (bail) — deixando o LLM responder`, { traceId, orderId: fresh.id });
          }
        }
      }
    }
  }

  // 11b. BACKSTOP DETERMINÍSTICO DE FECHAMENTO (Fix #1). O pedido do cliente parava
  // em 'quoted' porque o LLM escolhia relay_answer_to_establishment em vez de
  // confirm_order_selection no aceite (colisão com a PERGUNTA PENDENTE). Se há PEDIDO
  // ATIVO 'quoted' com opções e o texto do usuário é um aceite/escolha RESOLVÍVEL
  // (número, nome, "a mais barata", ou aceite genérico com 1 opção só), forçamos o
  // confirm com o quote certo — independe do humor do LLM. Conservador: resolveQuotePick
  // devolve null quando é ambíguo (não fecha errado).
  let backstopConfirmed = false;
  {
    const activeOrder = activeOrderRes.data as { id: string; status: string; summary: string | null; presented_at: string | null } | null;
    const userTextForPick = typeof userMsgContent === 'string'
      ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '').trim()
      : '';
    const alreadyConfirmed = llmResponse.toolCalls.some((t) => t.name === 'confirm_order_selection');
    if (activeOrder && activeOrder.status === 'quoted' && activeOrder.summary && !alreadyConfirmed && userTextForPick && !distressPreempted) {
      try {
        const parsed = JSON.parse(activeOrder.summary) as { options?: QuoteOption[] };
        const options = Array.isArray(parsed.options) ? parsed.options : [];
        // ESPECÍFICA (número/nome/superlativo) se auto-identifica; GENÉRICA ("ok"/"sim"/"👍")
        // é contextual — só quer dizer "sim" pra ÚLTIMA coisa que a Xarlote falou.
        const specificQuoteId = resolveSpecificPick(options, userTextForPick);
        const pickedQuoteId = specificQuoteId ?? resolveQuotePick(options, userTextForPick);
        const isGenericYes = !!pickedQuoteId && !specificQuoteId;

        // ─── CONSENTIMENTO: 3 guardas em camadas (incidente Vadivino 17/07 02:48) ───
        // Ele respondeu "Ok" a um "salvei o contato da Célia" e o backstop fechou um pedido
        // apresentado 3,5 DIAS antes — mandando a farmácia preparar de verdade, com preço
        // errado (R$4,95 auto-capturado vs "74,94" que a farmácia disse) e com a pergunta
        // da farmácia SEM resposta. A LLM tinha acertado ("Precisa de mais alguma coisa?");
        // o backstop determinístico atropelou. Fechar compra é irreversível → só com sinal
        // INEQUÍVOCO. Na dúvida, não fecha: a LLM ainda pode conduzir e o paciente confirma.
        const presentedAt = activeOrder.presented_at ? new Date(activeOrder.presented_at).getTime() : null;
        const ageMs = presentedAt != null ? Date.now() - presentedAt : Infinity;

        // G1 — RECÊNCIA: só restringe o aceite GENÉRICO. Uma escolha ESPECÍFICA ("quero a 2",
        // "a mais barata") é consentimento inequívoco por si — barrá-la por idade regredia o
        // Fix #1 inteiro, inclusive pra todo pedido já aberto no dia do deploy, que tem
        // presented_at NULL → ageMs=Infinity (review).
        const fresh = !isGenericYes || ageMs <= BACKSTOP_MAX_PRESENTED_AGE_MS;

        // G2 — PERGUNTA PENDENTE nunca cede a aceite genérico: com a farmácia esperando
        // resposta, um "ok" provavelmente RESPONDE a pergunta, não fecha a compra.
        const clarifOk = !pendingClarif || !isGenericYes;

        // G3 — ADJACÊNCIA (a que teria evitado o incidente): aceite genérico só vale se a
        // apresentação das opções for a ÚLTIMA fala da Xarlote. Se ela falou outra coisa
        // depois (salvar contato, lembrete, etc.), o "ok" é sobre AQUILO.
        let adjacencyOk = true;
        if (isGenericYes) {
          if (presentedAt == null) {
            adjacencyOk = false; // pedido antigo, sem âncora de apresentação → não arrisca
          } else {
            const { data: laterOut } = await db.from('messages')
              .select('id')
              .eq('conversation_id', conversation.id)
              .eq('direction', 'out')
              .gt('created_at', activeOrder.presented_at as string)
              .limit(1);
            adjacencyOk = !(laterOut && laterOut.length > 0);
          }
        }

        const safeToConfirm = !!pickedQuoteId && fresh && clarifOk && adjacencyOk;
        if (!safeToConfirm && pickedQuoteId) {
          await writeLog('info', 'order', `🛡️ Backstop de fechamento ABORTADO (consentimento não inequívoco) — deixando a LLM conduzir`, {
            traceId, orderId: activeOrder.id, quoteId: pickedQuoteId,
            motivo: !fresh ? `apresentação antiga (${Math.round(ageMs / 3_600_000)}h)` : !clarifOk ? 'aceite genérico com pergunta da farmácia pendente' : 'aceite genérico não responde à apresentação (a Xarlote falou outra coisa depois)',
            generico: isGenericYes, texto: userTextForPick.slice(0, 40),
          });
        }
        if (safeToConfirm && pickedQuoteId) {
          await writeLog('info', 'order', `🔒 Backstop: aceite detectado ("${userTextForPick.slice(0, 40)}") → forçando confirm_order_selection`, {
            traceId, orderId: activeOrder.id, quoteId: pickedQuoteId, llmTools: llmResponse.toolCalls.map((t) => t.name), hadPendingClarif: !!pendingClarif,
            especifica: !isGenericYes, apresentadaHaMin: presentedAt != null ? Math.round(ageMs / 60_000) : null,
          });
          await handleToolCall(
            { id: randomUUID(), name: 'confirm_order_selection', args: { order_id: activeOrder.id, quote_id: pickedQuoteId } } as unknown as Parameters<typeof handleToolCall>[0],
            turnToolCtx,
          );
          backstopConfirmed = true;
        }
      } catch (err) {
        await writeLog('warn', 'order', `Backstop de confirm: parse/resolve falhou: ${String(err).slice(0, 120)}`, { traceId });
      }
    }
  }

  // 11c. BACKSTOP DETERMINÍSTICO DE RE-CONTATO (incidente 07/07 ao vivo): o glm-5.2
  // NARROU "já falei com a farmácia! mandei mensagem…" SEM chamar message_supplier —
  // mentira: nada saiu pra farmácia. Se o usuário claramente pede pra CONTATAR/VOLTAR
  // numa farmácia do pedido (verbo de re-contato em forma de PEDIDO, não pergunta-passado)
  // e resolvemos UMA farmácia-alvo pela dica (conservador, null em ambiguidade), forçamos
  // message_supplier — o handler faz todos os guards (janela 24h, freeze, revive). Mensagem
  // sintetizada limpa e humana; a farmácia responde e o loop normal segue.
  let backstopReContacted = false;
  {
    const alreadyContacted = llmResponse.toolCalls.some((t) =>
      ['message_supplier', 'contact_establishment', 'relay_answer_to_establishment', 'confirm_order_selection', 'expand_pharmacy_search', 'start_pharmacy_order'].includes(t.name));
    const userText = typeof userMsgContent === 'string' ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '').trim() : '';
    // Verbos de PEDIDO (presente/infinitivo/imperativo) — NÃO passado ("falou?"/"mandou?"
    // são perguntas sobre o passado, não comandos → não disparam).
    const reContactVerb =
      /\b(fala|fale|falar|pergunt[ae]|perguntar|volt[ae]|voltar|entra(r)? em contato|manda|mande|mandar|contata|contatar|contate|pede|pe[çc]a|pedir|chama|chame|chamar|v[êe] com|confirma com|verifica com)\b/i.test(userText);
    if (!alreadyContacted && reContactVerb && orderState && orderState.suppliers.length && userText && !distressPreempted) {
      const targetQuoteId = resolveSupplierByHint(
        orderState.suppliers.map((s) => ({ quote_id: s.quoteId, supplier_name: s.supplierName, status: s.status, responded: s.responded })),
        userText,
      );
      const target = targetQuoteId ? orderState.suppliers.find((s) => s.quoteId === targetQuoteId) : null;
      if (target) {
        const itemName = orderState.items.map((i) => itemDisplayName(i.name, i.dosage)).join(', ') || 'o pedido';
        // Mensagem ciente do estado: pedido FECHADO → cobra a entrega; senão → retoma a cotação.
        const isClosed = ['confirming', 'handed_off'].includes(orderState.status) && target.quoteId === orderState.selectedQuoteId;
        const msg = isClosed
          ? `oi! tudo certo com o pedido do ${itemName}? consegue me confirmar se já saiu pra entrega?`
          : `oi! sobre o ${itemName} que perguntei mais cedo — vocês conseguem me atender agora? se puder me passar o valor e como fica a entrega, agradeço`;
        await writeLog('warn', 'order', `🔒 Backstop de re-contato: LLM narrou sem chamar message_supplier → forçando contato com ${target.supplierName}`, {
          traceId, orderId: orderState.orderId, quoteId: target.quoteId, llmTools: llmResponse.toolCalls.map((t) => t.name),
        });
        await handleToolCall(
          { id: randomUUID(), name: 'message_supplier', args: { supplier_hint: target.supplierName, message: msg } } as unknown as Parameters<typeof handleToolCall>[0],
          turnToolCtx,
        );
        backstopReContacted = true;
      }
    }
  }

  // 11c2. BACKSTOP DE CANCELAMENTO (incidente Glauber 12/07): ele mandou só "Cancelar", o
  // glm-5.2 devolveu turno VAZIO (fallback "me atrapalhei") e NÃO chamou cancel_order → o
  // pedido ficou vivo, indo pra entrega (ainda por cima no endereço errado). Se o usuário
  // pede cancelamento CLARO, há pedido ATIVO e o LLM não cancelou (nem tratou como troca),
  // cancelamos determinístico + mensagem honesta. Não confunde com cancelar LEMBRETE.
  let backstopCancelled = false;
  {
    // Amplia o "já tratou": qualquer ação de progresso de pedido no turno significa que o
    // LLM NÃO leu como cancelamento — não força cancel (review 12/07: "não quero mais o
    // genérico, quero a marca" é refino, não cancelamento).
    const calledCancel = llmResponse.toolCalls.some((t) =>
      ['cancel_order', 'start_pharmacy_order', 'confirm_order_selection', 'message_supplier', 'relay_answer_to_establishment', 'expand_pharmacy_search', 'contact_establishment'].includes(t.name));
    const uText = typeof userMsgContent === 'string' ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '').trim() : '';
    // Intenção de cancelar O PEDIDO, CLARA e sem ambiguidade (review 12/07 endureceu):
    //  • "cancela/cancelar" isolado (bare "Cancelar" do Glauber);
    //  • "desisti/desistir DO PEDIDO/da compra" (não "desisti de esperar, tenta outra");
    //  • "deixa pra lá" isolado;
    //  • "não quero mais O PEDIDO/a compra/o remédio/nada" (objeto OBRIGATÓRIO — "não quero
    //    mais o genérico"/"não quero mais essa farmácia" são REFINO, não cancelamento).
    const cancelWord = /(^|\b)(cancela|cancelar|cancele)(\b|$)/i.test(uText);
    const desistOrder = /\bdesist\w+\s+(d[oa]\s+)?(pedido|compra|rem[ée]dio|medicamento|tudo)\b/i.test(uText)
      || /^\s*desisti\.?\s*$/i.test(uText);
    const deixaPraLa = /(^|\b)deixa\s+pra?\s+l[áa](\b|$)/i.test(uText) && uText.length < 25;
    const naoQueroMais = /\bn[ãa]o\s+quero\s+mais\s+(o\s+pedido|a\s+compra|o\s+rem[ée]dio|o\s+medicamento|a\s+entrega|nada)\b/i.test(uText);
    const cancelIntent = (cancelWord || desistOrder || deixaPraLa || naoQueroMais)
      && !/\blembrete|lembra|alarme|despertador\b/i.test(uText)  // cancelar LEMBRETE é outro caminho
      && !/\btroca(r)?\b/i.test(uText)                            // troca de remédio é outro fluxo
      && !/\b(essa|dessa|aquela|outra)\s+farm[áa]cia\b/i.test(uText); // "cancela ESSA farmácia" = trocar farmácia, não o pedido
    // Cobre handed_off (incidente Glauber: pedido fecha em handed_off no MESMO turno; o
    // "Cancelar" seguinte precisa alcançá-lo). cancelActiveOrder avisa a farmácia nesse caso.
    const activeOrderId = orderState && ['quoting', 'quoted', 'confirming', 'handed_off'].includes(orderState.status) ? orderState.orderId : null;
    // Exclusão mútua com o backstop de re-contato (11c) — os dois não disparam no mesmo turno.
    if (cancelIntent && activeOrderId && !calledCancel && !distressPreempted && !backstopReContacted) {
      await writeLog('warn', 'order', `🔒 Backstop de cancelamento: usuário pediu cancelar ("${uText.slice(0, 40)}") e o LLM não chamou cancel_order → cancelando (status=${orderState!.status})`, {
        traceId, orderId: activeOrderId,
      });
      try {
        await handleToolCall(
          { id: randomUUID(), name: 'cancel_order', args: { order_id: activeOrderId, reason: 'cancelado pelo usuário' } } as unknown as Parameters<typeof handleToolCall>[0],
          turnToolCtx,
        );
        backstopCancelled = true;
      } catch (err) {
        await writeLog('error', 'order', `Backstop de cancelamento falhou: ${String(err).slice(0, 120)}`, { traceId });
      }
    }
  }

  // 11d. BACKSTOP ANTI-MENTIRA DE LEMBRETE (incidente Waldir 09/07): o glm-5.2 disse "amanhã
  // às 7h te lembro do Oftpred e do Hiluropt" mas NÃO chamou create_reminder → o lembrete
  // nunca existiu e não disparou. Se o texto AFIRMA ter agendado/vai lembrar num horário e
  // NENHUM create_reminder/cancel/list rodou, forçamos UM retry que OBRIGA a chamar a tool
  // (o histórico tem os detalhes). Se o retry criar, a narração original vira VERDADE; se não,
  // trocamos por resposta honesta. Espelha o backstop anti-mentira da farmácia.
  let reminderClaimUnfulfilled = false;
  {
    const calledReminderTool = toolRanOk('create_reminder', 'cancel_reminders', 'list_reminders');
    const txt = llmResponse.text ?? '';
    // Precisa de: verbo de agendamento + menção a LEMBRETE/AGENDAMENTO (senão pega "te aviso"
    // de contexto de PEDIDO) + HORÁRIO DE RELÓGIO (não só "amanhã") + não ser pergunta.
    const claimsReminder =
      /\b(te (lembro|aviso|chamo)|vou te (lembrar|avisar|chamar)|agendei|agendado|marquei o lembrete|deixei o lembrete|lembrete (criado|marcado|agendado|configurado))\b/i.test(txt)
      // DEVE mencionar "lembr" (lembrete/lembrar/lembro) — não só "agend": senão "agendei sua
      // consulta às 14h"/"pedido agendado pra 9h" (contexto de CONSULTA/ENTREGA) disparava.
      // OU ser promessa de RE-CHAMADA/backup condicional (caso Ciro 09/07: "te chamo de novo
      // às 8h pra garantir" não tem "lembr" nenhum e passava batido — o backup nunca existiu).
      && (/lembr/i.test(txt) || /\b(te (chamo|aviso|lembro) de novo|volto a te (chamar|avisar|lembrar)|se (voc[êe] )?n[ãa]o confirmar)\b/i.test(txt))
      // ÂNCORA TEMPORAL: relógio ("7h", "14:30", "meio-dia") OU cadência sem relógio
      // ("4 vezes ao dia", "todo dia", "de manhã"). O gate só-relógio deixou passar o caso
      // REAL de 24/07: "Vou te lembrar 4 vezes ao longo do dia" + "Tô organizando seus
      // lembretes de água" → NENHUM create_reminder rodou; o 1º só veio 3h depois.
      && (
        /(\b\d{1,2}\s*h\b|\b\d{1,2}:\d{2}\b|meio[- ]dia)/i.test(txt)
        || /\b(\d+|uma|duas|tr[êe]s|quatro|cinco|seis)\s*(x|vezes)\b/i.test(txt)
        || /\b(todo dia|todos os dias|diariamente|toda (manh[ãa]|tarde|noite)|de (manh[ãa]|tarde|noite)|ao longo do dia|por dia|a cada \d+)\b/i.test(txt)
      )
      && !/\bquer que eu\b/i.test(txt);
    if (claimsReminder && !calledReminderTool && !distressPreempted) {
      await writeLog('warn', 'agent', `🚫 Anti-mentira de lembrete: LLM afirmou agendar SEM chamar create_reminder → retry forçado`, { traceId, textPreview: txt.slice(0, 80) });
      let created = false;
      try {
        // O retry PRECISA ver o turno ATUAL: geminiHistory tira a msg atual (slice(0,-1)) e
        // o 1º arg aqui é o nudge (não o pedido). Sem isto o retry ficaria CEGO ao pedido do
        // Waldir → não criaria ou alucinaria horário/remédio errado (review 09/07). Anexo o
        // pedido do usuário + a narração que o próprio LLM acabou de fazer.
        const currentUserText = (typeof userMsgContent === 'string' ? userMsgContent : userMsgPreview) || '(pedido de lembrete do usuário)';
        const retryHistory = [
          ...geminiHistory,
          { role: 'user' as const, content: currentUserText },
          { role: 'assistant' as const, content: txt || '(prometi agendar um lembrete)' },
        ];
        const retry = await chat(
          '(Sistema: você acabou de dizer ao usuário que ia CRIAR/AGENDAR um lembrete (veja sua última mensagem acima), mas NÃO chamou a tool create_reminder — então o lembrete NÃO existe e NÃO vai disparar. Chame create_reminder AGORA, uma vez para CADA lembrete que o usuário pediu, com type, title, body (no seu tom) e o horário: use scheduled_at (ISO com offset -03:00) se for único, ou rrule (BYHOUR/BYMINUTE em horário de Brasília) se for recorrente/todo dia. Baseie-se EXATAMENTE no que o usuário pediu (medicamentos e horário na conversa acima) — NÃO invente horário nem remédio. Se não tiver certeza do horário/medicamento, NÃO chame a tool. NÃO escreva texto, só chame a(s) tool(s).)',
          {
            model,
            apiKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'],
            systemInstruction: systemPrompt,
            history: retryHistory,
            tools: xarloteTools,
            temperature: 0.1,
            maxOutputTokens: 600,
            timeoutMs: 20_000,
          },
        );
        for (const tc of retry.toolCalls) {
          if (tc.name === 'create_reminder') {
            await writeLog('info', 'tool', `Tool call (retry lembrete): create_reminder`, { traceId, args: tc.args });
            await handleToolCall(tc, turnToolCtx);
            created = true;
          }
        }
      } catch (err) {
        await writeLog('error', 'agent', `Retry de lembrete falhou: ${String(err).slice(0, 120)}`, { traceId });
      }
      // Se nem o retry criou, a narração "te lembro às 7h" ainda é mentira → resposta honesta.
      if (!created) reminderClaimUnfulfilled = true;
    }
  }

  // 11e. BACKSTOP DE CONFIRMAÇÃO DE REMÉDIO (caso Waldir 09/07 18:09, PÓS-deploy do 11d):
  // o usuário respondeu "tomei" a um lembrete recém-disparado, o glm-5.2 disse "Show,
  // anotado!" mas NÃO chamou log_medication_taken → last_confirmed_at ficou null → o gate
  // do backup condicional (0020) acha que ele NÃO confirmou e o backup dispara à toa (ou
  // pior: a adesão não é registrada). Determinístico: confirmação clara + lembrete disparado
  // há pouco + tool não chamada → chamamos log_medication_taken nós mesmos com o TÍTULO do
  // lembrete (match exato garantido — é o mesmo título que o gate/create usam). A narração
  // "anotado!" do LLM vira VERDADE (mesma filosofia do retry 11d). Não mexe no texto.
  {
    const calledLog = llmResponse.toolCalls.some((t) => t.name === 'log_medication_taken');
    const userText = (typeof userMsgContent === 'string' ? userMsgContent.replace(/^\[Áudio transcrito\]\s*/i, '') : '').trim();
    // Confirmação FORTE = verbo de TOMADA DE MEDICAÇÃO (review 10/07 #21: "tomei um susto",
    // "bebi um suco", "usei o app", "passei mal" NÃO são adesão). Verbos genéricos
    // (bebi/passei/usei/coloquei) só valem com checagem de coerência pós-fetch (tipo do
    // lembrete / palavra do título na frase). Objetos não-medicamentosos vetam.
    const strongVerb = /\b(tomei|pinguei|apliquei|injetei)\b/i.test(userText);
    const genericVerb = /\b(bebi|passei|usei|coloquei)\b/i.test(userText);
    const negated = /\b(n[ãa]o|nao|esqueci|ainda n|depois|daqui a pouco|vou tomar|amanh[ãa])\b/i.test(userText);
    const nonMedObject = /\b(tomei|levei)\s+(um\s+)?(susto|caf[ée]|banho|sol|chuva|cerveja|vinho|refri|uma?\s+(decis[ãa]o|surra))|\bpassei\s+(mal|vergonha|raiva)|\busei\s+o\s+(app|aplicativo|site)\b/i.test(userText);
    const strongConfirm = (strongVerb || genericVerb) && !negated && !nonMedObject;
    // Ack FRACO ("ok"/"sim"/"👍") é ambíguo — pode responder OUTRA pergunta da Xarlote
    // (review #20: "quer que eu amplie a busca?" → "ok" carimbava remédio). Só vale se o
    // turno não teve NENHUMA outra tool (sinal de que o ack respondeu outra coisa) e, mais
    // abaixo, se a ÚLTIMA fala da Xarlote foi o próprio disparo do lembrete.
    const weakAck = /^(ok(ay)?|sim|feito|pronto|tomado|blz|beleza|👍|✅|joia|j[óo]ia)[.!\s]*$/i.test(userText)
      && llmResponse.toolCalls.length === 0;
    if (!calledLog && (strongConfirm || weakAck) && !distressPreempted) {
      const windowMs = strongConfirm ? 3 * 60 * 60_000 : 20 * 60_000;
      const { data: recentRem } = await db.from('reminders')
        .select('id, title, type, last_run_at')
        .eq('user_id', user.id)
        .in('status', ['pending', 'sent'])
        .gte('last_run_at', new Date(Date.now() - windowMs).toISOString())
        .order('last_run_at', { ascending: false })
        .limit(1).maybeSingle();
      // Coerência verbo↔lembrete: "bebi" só confirma lembrete de hidratação; verbo genérico
      // (passei/usei/coloquei sem verbo forte) exige palavra do título (≥4 chars) na frase
      // (ex.: "passei nas sobrancelhas" ↔ título "Passar remédio nas sobrancelhas").
      let coherent = Boolean(recentRem?.title);
      if (coherent && !strongVerb && !weakAck) {
        if (/\bbebi\b/i.test(userText)) {
          coherent = recentRem!.type === 'hydration';
        } else {
          const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
          const titleWords = fold(recentRem!.title).split(/\W+/).filter((w) => w.length >= 4);
          const textFolded = fold(userText);
          coherent = titleWords.some((w) => textFolded.includes(w.slice(0, Math.max(4, w.length - 2))));
        }
      }
      // Ack fraco: a última fala da Xarlote precisa ser o PRÓPRIO disparo do lembrete
      // (mirror inserido no despacho ±90s do last_run_at) — sem pergunta no meio.
      if (coherent && weakAck && recentRem?.last_run_at) {
        const { data: lastOut } = await db.from('messages')
          .select('created_at')
          .eq('conversation_id', conversation.id)
          .eq('direction', 'out')
          .order('created_at', { ascending: false })
          .limit(1).maybeSingle();
        const outTs = lastOut?.created_at ? new Date(lastOut.created_at as string).getTime() : 0;
        coherent = Math.abs(outTs - new Date(recentRem.last_run_at).getTime()) < 90_000;
      }
      if (recentRem && coherent) {
        // Carimba DIRETO por id (determinístico, zero efeito colateral) — passar o TÍTULO
        // pro log_medication_taken criava user_medications FANTASMA ("Hora do Dipirona
        // 500mg" virava remédio no perfil — review #23). Adesão/analytics via event_log.
        await db.from('reminders').update({ last_confirmed_at: new Date().toISOString() }).eq('id', recentRem.id);
        await writeLog('warn', 'agent', `🛟 Backstop de confirmação: adesão registrada sem log_medication_taken (reminder ${recentRem.id})`, {
          traceId, userId: user.id, reminderId: recentRem.id,
        });
        void writeEvent({
          eventName: 'reminder.confirmed_backstop',
          userId: user.id,
          conversationId: conversation.id,
          payload: { reminder_id: recentRem.id, via: strongConfirm ? 'strong' : 'weak_ack' },
        });
      }
    }
  }

  // 12. Resolve o texto da resposta.
  // 🛑 TURNO SÓ-TOOL (incidente Glauber 2026-07-01): o gpt-4.1-mini às vezes executa
  // a(s) tool(s) SEM escrever texto (ex.: create_reminder criado, mas nenhuma
  // confirmação) → o usuário ficava no VÁCUO e re-perguntava ("agendou?", "tá aí?"),
  // e o LLM re-chamava a tool (criando duplicatas). Se NENHUMA mensagem saiu neste
  // turno (a tool tb não respondeu — discovery/red-flag mandam a própria), fazemos UM
  // follow-up (sem tools) pra NARRAR o que foi feito. Rede de segurança determinística.
  // Se o backstop fechou o pedido, handleConfirmOrder já mandou a msg de pagamento —
  // suprime o texto do LLM (relay-style "vou avisar a farmácia"). MAS só quando o turno
  // foi PURAMENTE o aceite: se o LLM também fez outra ação (ex.: create_reminder), o
  // texto narra essa ação e NÃO pode ser engolido (review) — aí mantém.
  const onlyAcceptTurn = !llmResponse.toolCalls.some((t) => !['relay_answer_to_establishment', 'confirm_order_selection', 'message_supplier'].includes(t.name));
  // Suprime o texto do LLM quando um backstop OU um handler auto-contido assumiu:
  // confirm (aceite), re-contato do backstop, ou message_supplier que já respondeu
  // ("Prontinho, mandei…" / desambiguação). Senão o usuário vê DUAS vozes contraditórias
  // no mesmo turno (incidente 07/07 17:34).
  //   • suppressLlmText (handler auto-contido JÁ mandou a resposta certa) suprime SEMPRE —
  //     inclusive quando o LLM empacotou message_supplier com OUTRA tool legal (ex.:
  //     create_reminder), caso em que onlyAcceptTurn virava false e a 2ª voz vazava
  //     ("Não tenho certeza…" + "Deixa eu mandar 💙" juntos) — review 08/07. A ação
  //     empacotada roda (o lembrete é criado); só a narração conflitante é engolida.
  //   • backstopConfirmed é FORÇADO em silêncio (o LLM não sabia) → só suprime quando o
  //     turno foi PURAMENTE o aceite; senão engoliria a narração de uma ação legítima.
  // Cancelamento PURO = o backstop cancelou e o LLM não narrou OUTRA ação legítima
  // (ex.: create_reminder empacotado). Se narrou, mantém a narração e só ANEXA o "cancelei".
  const onlyCancelTurn = !llmResponse.toolCalls.some((t) => !['cancel_order', 'start_pharmacy_order'].includes(t.name));
  // 🔊 UMA VOZ ≠ AMORDAÇAR A HONESTIDADE — mas SÓ quando há o que ser honesto sobre.
  //
  // A exceção existe pra um caso específico: a tool FALHOU, o handler não conseguiu dizer
  // nada útil, e a rodada seguinte do loop escreveu a explicação honesta ("não consegui
  // buscar agora"). Suprimir esse texto o trocaria por um genérico "tô cuidando disso" —
  // falsa tranquilização, exatamente o que o loop existe pra eliminar.
  //
  // ⚠️ REGRESSÃO CORRIGIDA (27/07): a condição era só "a última rodada não teve tool", o que
  // destravava TAMBÉM o caso em que a tool deu certo e o handler JÁ FALOU com o paciente —
  // reintroduzindo a voz dupla. Aconteceu 2× ao vivo: o handler mandou "Achei a Odonpaz…
  // É essa mesma?" e a rodada 2 mandou "Encontrei a Odontopaz! Te mandei os detalhes…"
  // (mesmo padrão com a Antônia/IAD às 18:03). Agora a exceção exige FALHA REAL: se toda
  // tool teve sucesso, quem já falou tem a palavra final.
  const anyToolFailed = executedToolCalls.some((t) => !t.ok);
  const lastRoundIsHonestyRecovery = agentRounds > 1 && llmResponseFinalHadNoTools && anyToolFailed;
  const suppressReply = !lastRoundIsHonestyRecovery && (
    (backstopConfirmed && onlyAcceptTurn) || turnToolCtx.turnFlags.suppressLlmText
    || backstopReContacted || (backstopCancelled && onlyCancelTurn)
  );
  let replyText = suppressReply ? '' : llmResponse.text.trim();

  // Backstop de cancelamento (11c2): o cancelActiveOrder só mexe no banco, não avisa o
  // usuário — então a confirmação honesta sai daqui (senão ele veria o fallback "me
  // atrapalhei" e não saberia que cancelou). Se o turno foi SÓ o cancelamento, sobrescreve;
  // se o LLM também narrou outra ação (lembrete etc.), ANEXA sem engolir a narração dela.
  if (backstopCancelled) {
    const itemName = orderState?.items?.map((i) => itemDisplayName(i.name, i.dosage)).filter(Boolean).join(', ');
    const cancelMsg = itemName
      ? `Pronto, cancelei seu pedido de ${itemName} 💙`
      : `Pronto, cancelei seu pedido 💙`;
    replyText = onlyCancelTurn || !replyText ? `${cancelMsg} Se precisar de mais alguma coisa, é só falar!` : `${cancelMsg}\n\n${replyText}`;
  }

  // 🚫 GUARDA ANTI-MENTIRA RESIDUAL (incidente 07/07): o LLM afirma ter contatado a
  // farmácia ("já falei com a farmácia", "mandei mensagem", "entrei em contato") mas
  // NENHUM contato real ocorreu (nem tool nem backstop — alvo ambíguo/sem pedido). Não
  // deixa a mentira sair: troca por uma resposta HONESTA que pede o nome da farmácia.
  if (replyText && !backstopReContacted) {
    // `message_supplier` NÃO conta por NOME: 10 dos seus 12 caminhos são dead-end (alvo
    // ambíguo, fora da janela, sem CEP, pedido fechado…). Contar o nome dava `reallyContacted
    // = true` mesmo sem nada ter saído — foi assim que "Falei com as 5 redes" passou pelo
    // guard (incidente Vadivino 17/07). Agora vale o sinal REAL de envio. As demais tools
    // abaixo disparam contato por construção.
    const reallyContacted = turnToolCtx.turnFlags.supplierMessaged === true
      || llmResponse.toolCalls.some((t) =>
        // `find_clinic_by_name` FORA: ela só BUSCA no Google e devolve "achei X, é essa?" —
        // nunca contata ninguém. Mantê-la aqui liberava "Já entrei em contato com a Clínica
        // São Lucas!" passar pelo guard (review).
        ['contact_establishment', 'relay_answer_to_establishment', 'confirm_order_selection', 'start_pharmacy_order', 'expand_pharmacy_search', 'start_consultation_search'].includes(t.name));
    const claimsContactPast = /(mandei\s+(uma\s+)?(mensagem|msg|recado)|entrei\s+em\s+contato|acabei de falar com (a|as|o) ?(farm|drog)|j[áa]\s+(falei|avisei|mandei|entrei em contato)\s+(com\s+)?(a\s+|as\s+|na\s+|pra\s+|para\s+|o\s+)?(farm[aá]cia|drog|eles\b|a loja))/i.test(replyText);
    // FUTURO também é mentira se nenhuma tool saiu (incidente Pague Menos 09/07: "Vou falar
    // com a Pague Menos agora! 💙" repetido 2x e o contato NUNCA foi feito — o usuário ficou
    // esperando uma cotação que não existia). O ALVO tem que vir LOGO APÓS a preposição —
    // um \p{Lu}\p{Ll}+ solto casava qualquer palavra capitalizada da frase (inclusive o
    // "Vou" inicial) e "Vou verificar pra você" virava non-sequitur de farmácia (review
    // 10/07 #22; "verificar" fora do gatilho pelo mesmo motivo). Nome Próprio é checado
    // case-SENSITIVE em regex separada ( /i + \p{Lu} casaria "ele/eles" minúsculo).
    let claimsContactFuture = false;
    {
      const lead = /\b(vou (falar|conversar|entrar em contato|mandar (mensagem|msg)|cotar)|(j[áa] )?t[ôo] falando)\s+(com|na|no|pra|para)\s+(a\s+|o\s+|as\s+|os\s+)?/iu.exec(replyText);
      if (lead) {
        const target = replyText.slice(lead.index + lead[0].length);
        claimsContactFuture =
          (/^(farm[aá]c\w*|drog\w*|loja|televendas|atendimento|unidade|cl[íi]nica|eles\b|elas\b)/i.test(target)
            || /^\p{Lu}\p{Ll}+/u.test(target))
          && !/^voc[êe]\b/i.test(target);
      }
    }
    const claimsContact = claimsContactPast || claimsContactFuture;
    if (claimsContact && !reallyContacted) {
      await writeLog('warn', 'agent', `🚫 Anti-mentira: LLM afirmou contato com farmácia sem chamar tool → resposta honesta`, { traceId, textPreview: replyText.slice(0, 60) });
      replyText = orderState && orderState.suppliers.length
        ? 'Deixa eu acertar direitinho: com qual farmácia do seu pedido você quer que eu fale? Me diz o nome que eu mando a mensagem na hora 💙'
        : 'Pra eu falar com uma farmácia eu preciso de um pedido ativo — me fala o remédio e o endereço que eu começo a busca 💙';
    }
  }

  // 🚫 ANTI-MENTIRA DE LEMBRETE (incidente Waldir): afirmou agendar, mas nem o LLM nem o retry
  // criaram → NÃO deixa sair "te lembro às 7h" (mentira que fez o Waldir não ser avisado).
  // Só quando o texto do LLM ia mesmo sair (não suprimido por outro handler — evita 2ª voz).
  if (reminderClaimUnfulfilled && !suppressReply) {
    await writeLog('warn', 'agent', `🚫 Anti-mentira de lembrete: nem o retry criou → resposta honesta`, { traceId });
    replyText = 'Deixa eu confirmar certinho pra NÃO falhar: qual(is) medicamento(s), que horas, e é todo dia ou só uma vez? Aí eu agendo o lembrete na hora 💙';
  }

  // Roda mesmo sob suppressReply (review M1): se um handler setou suppressLlmText porque "já
  // respondeu" mas o ENVIO falhou (ex.: message_supplier caiu, ou confirm sem supplierPhone), a
  // supressão engoliria a fala E esta rede nunca dispararia → turno mudo no aceite/re-contato. O
  // árbitro é o `sentThisTurn`: se NADA saiu de fato neste turno, gera fallback; se o handler enviou
  // (sentThisTurn>0), o guard interno não dispara (sem 2ª voz).
  if (!replyText) {
    const { count: sentThisTurn } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .eq('direction', 'out')
      .gt('created_at', new Date(llmStart).toISOString());
    if (!sentThisTurn) {
      if (llmResponse.toolCalls.length > 0) {
        // Turno só-tool: narra o que foi feito.
        const toolNames = llmResponse.toolCalls.map((t) => t.name).join(', ');
        const lastUserText = typeof userMsgContent === 'string' ? userMsgContent : userMsgPreview;
        try {
          const followup = await chat(
            // ⚠️ NUNCA afirmar sucesso aqui. O prompt antigo dizia "você acabou de executar com
            // sucesso: {tools}… confirme o que foi feito" — mas o turno chega aqui JUSTAMENTE
            // quando nada saiu, e o modelo só recebe NOMES de tool, nunca o resultado delas.
            // Foi essa instrução que produziu "Falei com as 5 redes que você pediu…" com ZERO
            // mensagens enviadas (incidente Vadivino 17/07), deixando o paciente esperando dias.
            `(Sistema: o turno terminou sem nenhuma mensagem ao usuário. Ferramentas acionadas: ${toolNames}. ` +
            `⚠️ Você NÃO recebeu o resultado delas e NÃO tem confirmação de que deram certo. Portanto: NÃO afirme ` +
            `que falou/mandou mensagem/entrou em contato com farmácia, rede ou clínica; NÃO cite nomes de ` +
            `estabelecimentos que teria contatado; NÃO invente preço, prazo ou disponibilidade; NÃO prometa ` +
            `resposta de terceiros ("assim que responderem"). O usuário havia dito: "${String(lastUserText).slice(0, 200)}". ` +
            `Escreva 1-2 linhas curtas e humanas dizendo que você está cuidando disso e que avisa assim que tiver ` +
            `novidade. NÃO chame nenhuma tool.)`,
            { model, apiKey: promptsConfig.llm_api_key || process.env['OPENROUTER_API_KEY'], systemInstruction: systemPrompt, history: geminiHistory, tools: [], temperature: 0.4, maxOutputTokens: 400, timeoutMs: 20_000 },
          );
          replyText = followup.text.trim();
          await writeLog('info', 'agent', `Follow-up narrou turno só-tool (${toolNames})`, { traceId });
        } catch (err) {
          await writeLog('warn', 'agent', `Follow-up do turno só-tool falhou: ${String(err).slice(0, 120)}`, { traceId });
        }
        if (!replyText) replyText = 'Prontinho, já cuidei disso aqui! 💙 Precisa de mais alguma coisa?';
      } else if (!suppressReply) {
        // 🛡️ TURNO VAZIO: o LLM não gerou texto NEM tool (ex.: estourou o limite de tokens
        // numa resposta truncada / contexto gigante). NUNCA ficar muda — incidente Cefaliv
        // 06/07 (ela ficou muda 2 turnos seguidos, 1024/1024 tokens de saída). Fallback honesto
        // que reengata a conversa. SÓ quando não-suprimido (review M1-LOW): sob supressão sem
        // tool, um handler/backstop assumiu e corretamente não enviou nada aqui (ex.: confirm
        // abortado por outro turno já ter fechado) → ficar calado, não contradizer com "me atrapalhei".
        replyText = 'Opa, me atrapalhei aqui por um instante 🙈 Pode me falar de novo o que você precisa? Já cuido pra você 💙';
        await writeLog('warn', 'llm', `Turno vazio (sem texto e sem tool — LLM truncado?) — fallback gracioso`, { traceId, tokensOut: llmResponse.tokensOut });
      }
    }
  }

  // 12b. Send response — texto OU áudio (voice intro na primeira saudação)
  if (replyText) {
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
      // dedup: true — só aqui (resposta conversacional) roda o anti double-send; dois
      // turnos concorrentes com o mesmo texto param no 2º (Fix #4).
      await sendOutbound(conversation.id, phoneE164, replyText, traceId, {
        model: llmResponse.model,
        tokensIn: llmResponse.tokensIn,
        tokensOut: llmResponse.tokensOut,
        latencyMs: Date.now() - llmStart,
      }, { dedup: true });
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
