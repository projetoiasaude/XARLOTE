import { db, writeLog, auditToolCall, writeAudit, saveMemoryCard } from '@iasaude/db';
import { extractStructured } from '@iasaude/llm';
import { PRESCRIPTION_OCR_PROMPT } from '@iasaude/llm';
import type { ToolCall } from '@iasaude/llm';
import type { NormalizedInbound, Message, OrderItem, CareLinkView } from '@iasaude/shared';
import { resolveReminderFirstRun, proximoDiaDoMes, horaDeIso, isPlaceholderPhone, toE164BR, parseRrule, fimDaRecorrencia, rruleComFim, fimDoDiaLocal, contarOcorrencias, sanitizarCorpoDeLembrete, pediuCancelarTudo, ehRruleComListaDeMinutos, isPharmacyChain, sameMedication, shortSupplierAddress, itemDisplayName, extractAcceptConditions, humanizePaymentLabel, isServiceNumber, normalizeReminderBody, classifyBrPhone, extractWaMeNumber, PLATFORM_HANDOFF_SUMMARY, formatOrderTotal, resolverAlvoDaTool,
  decidirVerificacaoDeNome, perguntaDeConfirmacaoDeNome, enderecoFoiMencionado, perguntaJaRespondida, aceitouSubstituto, linhaDoProduto, pacienteFalouDeSubstituto, extractDeliverySector, parseEnderecoDigitado, montarEnderecoHumano, nomeJaConfirmadoPeloPaciente, quantidadeFoiMencionada, JANELA_PEDIDO_VIVO_MS, type ProdutoCotado, type OrigemDoNome } from '@iasaude/shared';
import { verificarExistenciaDoRemedio } from './verificar-nome-remedio.js';
import { findNearbyPharmacies, geocodeAddress, reverseGeocode, reverseGeocodeNominatim, getPlacePhone, getPlaceContact, fetchWebsiteHtml, matchPlatformNetworkByName, type PlaceResult } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { markSupplierVerifiedById } from './supplier-directory.js';
import { chaveDoCofre, cifrar, labFetchDisponivel, redigirCredenciais } from '../lib/lab-vault.js';
import { enqueueLabFetch } from '../queues/lab-fetch.queue.js';
import { presentPlatformQuotes, extractCep } from './platform-quotes.js';
import { loadPrompts } from '../config/prompts.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';
import { scheduleQuoteTimeout, sendCurrentOrderStatus } from './quote-consolidation.js';
import { relayUserAnswerToEstablishment } from './clarification.js';
import { handleFindByName, handleContactEstablishment, handleNudgeConsultation , handleForwardMediaToEstablishment } from './reach-out.js';
import { avisarSujeitoDeAcaoDoCuidador, acaoPesa } from './care-notify.js';
import { loadLatestOrderState, resolveTargetSupplier } from './order-state.js';
import {
  handleStartTreatmentFromOrder, handleLogMedicationTaken, handleUpdateTreatmentStatus,
  handleLogSymptom, handleSetDefaultAddress,
  handleStartConsultationSearch, handleConfirmConsultation, handleCancelConsultation,
  handleSetEmergencyContact,
  type StartTreatmentArgs, type LogMedicationTakenArgs, type UpdateTreatmentStatusArgs,
  type LogSymptomArgs, type StartConsultationArgs, type SetEmergencyContactArgs,
} from './tool-executor-v2.js';
import { handleRedFlagCheck, type RedFlagArgs } from './red-flag-handler.js';
import { ToolFailure, resolveOrderForUser, resolveMediaMessageId } from './entity-resolve.js';

// `extractDeliverySector` vem de @iasaude/shared (endereco-entrega.ts). Este arquivo tinha uma
// CÓPIA local mais antiga — que tratava "Qd. B8" como rua e "Lt. 20" como setor — e foi ela que
// abriu a cotação da Ludmila com "entregar Rua 14, Lt. 20" em 14/09/2026, um dia depois de a
// versão certa ter sido testada e deployada só no inbound-supplier (regra 104: o endurecimento
// aplicado num lugar e esquecido no outro é dívida silenciosa).

/**
 * A mídia deste turno, já baixada UMA vez pelo inbound e classificada pelos BYTES.
 *
 * Por que o contrato mora aqui, e não no `NormalizedInbound`: o inbound descreve o que o
 * provedor ENTREGOU (uma URL, um mime declarado); isto descreve o que o servidor JÁ APUROU
 * sobre o arquivo. São coisas diferentes, e misturá-las é como uma tool acaba confiando na
 * etiqueta de quem enviou.
 *
 * `tipo` vem de `sniffMidia` — 'document' é PDF, e nesse caso `texto` traz o que foi extraído.
 */
export interface MidiaDoTurno {
  tipo: 'image' | 'document' | 'audio';
  /** O mime REAL, lido dos bytes. */
  mime: string;
  buffer: Buffer;
  /** Texto do PDF, ou transcrição do áudio. Vazio quando não deu pra ler. */
  texto?: string;
}

interface ToolContext {
  /**
   * De quem é a ação.
   *
   * ⚠️ Este campo é REESCRITO por chamada quando a tool traz `para_quem` e o ator cuida
   * daquela pessoa (ver `handleToolCall`). Os handlers continuam usando `ctx.userId` e
   * passam a escrever no registro certo sem saber que existe cuidador — foi o que evitou
   * mexer em 30 handlers.
   *
   * `conversationId` e `phoneE164` NÃO são reescritos: a resposta volta pra quem falou.
   */
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  /**
   * Quem está falando, quando é diferente do dono do registro. Só preenchido em ação de
   * cuidador — é o que a auditoria usa pra distinguir "o filho anotou" de "ela anotou".
   */
  atorUserId?: string | null;
  /** Nome do ator, pra desambiguar "pra mim" de "pra minha mãe". */
  atorNome?: string | null;
  /** Pessoas de quem o ATOR cuida. Vazio no fluxo de sempre. */
  careLinks?: CareLinkView[];
  inboundMsg: Message;
  inbound: NormalizedInbound;
  /**
   * O que o paciente DISSE neste turno, já resolvido (texto, legenda da foto ou
   * transcrição do áudio). É o que uma ferramenta lê quando precisa saber se ele NOMEOU
   * algo ou só respondeu "tomei"/"sim" — ver adherence-guard. `inboundMsg.content` não
   * serve: pra áudio a transcrição chega depois do insert.
   */
  textoDoPaciente?: string | null;
  /**
   * Mídia do turno (foto/PDF/áudio) já baixada e verificada. Opcional: turno de texto puro
   * não tem nenhuma, e o backstop determinístico também chama tools sem mídia.
   */
  midiaDoTurno?: MidiaDoTurno | null;
  /**
   * IDs de pedidos CRIADOS neste turno (compartilhado entre as tools do mesmo turno).
   * Blindagem contra a ordem não-determinística das tool calls (review HIGH-1): se o
   * LLM emite `start_pharmacy_order` (que cria um pedido novo na troca) ANTES de
   * `cancel_order`, o cancel NÃO pode cancelar o pedido recém-criado. cancel_order
   * ignora qualquer id aqui.
   */
  ordersCreatedThisTurn?: Set<string>;
  /**
   * UMA VOZ POR TURNO (incidente 07/07): quando um handler manda uma resposta
   * auto-contida ao usuário (ex.: message_supplier "Prontinho, mandei…" ou a
   * desambiguação "qual farmácia?"), ele seta suppressLlmText=true — senão o texto do
   * LLM sai JUNTO e contradiz ("Não tenho certeza…" + "Deixa eu mandar mensagem 💙").
   */
  /**
   * Sinais REAIS do turno (resultado, não intenção). `supplierMessaged` só vira true no
   * ponto de envio de verdade a uma farmácia — é o que o guard anti-mentira consulta, no
   * lugar de "o nome da tool apareceu na lista" (que dava true mesmo em 10 dead-ends).
   */
  turnFlags?: { suppressLlmText: boolean; supplierMessaged?: boolean };
  /**
   * OBSERVAÇÃO PRO MODELO (loop ReAct, 26/07). O handler escreve aqui o que o MODELO
   * precisa saber pra decidir o próximo passo — não é texto pro paciente. Ex.:
   * "5 farmácias contatadas, aguardando preço". Resetado a cada tool call.
   */
  observation?: { note: string | null };
}

/**
 * Resultado de uma tool call — o que volta ao modelo no loop agêntico.
 *
 * Antes de 26/07 `handleToolCall` retornava `void`: o modelo pedia a ferramenta e nunca
 * sabia se deu certo. Um erro era ENGOLIDO pelo catch e a Xarlote seguia escrevendo ao
 * paciente como se tivesse funcionado ("já falei com a farmácia"). Agora o erro volta
 * pro modelo, que pode se corrigir na mesma conversa.
 */
export interface ToolResult {
  ok: boolean;
  /** Erro real da execução (o modelo PRECISA ver pra mudar de rumo). */
  error?: string;
  /** Nota do handler pro modelo (ver ToolContext.observation). */
  note?: string;
  /** O handler já respondeu ao paciente sozinho (uma-voz) — não escreva de novo. */
  spoke?: boolean;
}

export async function handleToolCall(tc: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  // ── 🤝 DE QUEM É ESTA AÇÃO ──────────────────────────────────────────────────
  //
  // Uma resolução, no funil, antes de qualquer efeito. Os 30 handlers continuam escrevendo
  // `.eq('user_id', ctx.userId)` sem saber que cuidador existe — é o que permitiu abrir o
  // produto pra multi-paciente sem tocar em nenhum deles.
  //
  // `resolverAlvoDaTool` NUNCA lança: devolve a frase que o modelo vai ler. Sem `para_quem`
  // (o caminho de praticamente todo turno) é o próprio ator, e o objeto de contexto sequer
  // é clonado.
  const alvo = resolverAlvoDaTool(tc.name, tc.args as Record<string, unknown> | undefined, {
    userId: ctx.userId,
    nome: ctx.atorNome ?? null,
    vinculos: ctx.careLinks ?? [],
  });
  const ctxAlvo: ToolContext = alvo.ok && alvo.subjectUserId !== ctx.userId
    ? { ...ctx, userId: alvo.subjectUserId, atorUserId: ctx.userId }
    : ctx;

  // recordTaskStart DENTRO de um guard: ele estava fora do try, então uma falha do Supabase
  // ao inserir em `assistant_tasks` (contabilidade, não a ação) lançava pra fora do handler,
  // escapava do loop de tools e derrubava o turno INTEIRO — o paciente não recebia nada.
  // A contabilidade nunca pode matar o atendimento.
  let taskId = '';
  try {
    taskId = await recordTaskStart(tc, ctxAlvo);
  } catch (err) {
    await writeLog('warn', 'tool', `recordTaskStart falhou (seguindo mesmo assim): ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
  }
  const startedAt = Date.now();
  // Buffer de observação desta chamada (handlers escrevem via ctx.observation.note).
  const obs: { note: string | null } = { note: null };
  ctx.observation = obs;
  // O clone foi feito ANTES desta linha — sem isto, um handler chamado com `ctxAlvo`
  // escreveria a observação num objeto que ninguém lê, e o modelo ficaria sem o retorno.
  ctxAlvo.observation = obs;
  const spokeBefore = ctx.turnFlags?.suppressLlmText === true;

  try {
    // Alvo irresolúvel (ambíguo, desconhecido, ou tool que não pode agir por terceiro):
    // NADA é executado e o modelo recebe a frase explicando. Mesma escola do ToolFailure —
    // ele lê "NADA FOI FEITO" e não anuncia o que não aconteceu.
    if (!alvo.ok) throw new ToolFailure(alvo.mensagem);

    switch (tc.name) {
      case 'save_user_profile_fact':
        await handleSaveProfileFact(tc.args as { category: string; payload: Record<string, unknown> }, ctxAlvo);
        break;
      case 'request_user_location':
        // Xarlote will say it in text; nothing else needed
        break;
      case 'parse_prescription_image':
        await handleParsePrescription({}, ctxAlvo);
        break;
      case 'save_exam_result':
        await handleSaveExamResult(tc.args as unknown as SaveExamArgs, ctxAlvo);
        break;
      case 'start_pharmacy_order':
        await handleStartPharmacyOrder(tc.args as { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string; preferred_pharmacy_names?: string[] }, ctxAlvo);
        break;
      case 'create_reminder':
        await handleCreateReminder(tc.args as { type: string; title: string; scheduled_at?: string; rrule?: string; dia_do_mes?: number; payload?: Record<string, unknown>; depends_on_title?: string; event_at?: string }, ctxAlvo);
        break;
      case 'fetch_lab_results':
        await handleFetchLabResults(tc.args as FetchLabArgs, ctxAlvo);
        break;
      case 'cancel_reminders':
        await handleCancelReminders(tc.args as { title_query?: string; all?: boolean }, ctxAlvo);
        break;
      case 'list_reminders':
        await handleListReminders(ctxAlvo);
        break;
      case 'send_emergency_orientation':
        // DEPRECATED — redireciona pra red_flag_check (que envia botões).
        // Mantido como fallback compat enquanto modelos antigos do LLM ainda usam.
        await writeLog('warn', 'tool', 'send_emergency_orientation chamada (deprecated) — redirecionando pra red_flag_check', { traceId: ctx.traceId });
        await handleRedFlagCheck({
          category: 'other_critical',
          severity: 'high',
          evidence: (tc.args as { symptoms_summary?: string }).symptoms_summary ?? 'situação reportada como emergência',
        }, ctxAlvo);
        break;
      case 'get_order_status':
        await handleGetOrderStatus(ctxAlvo);
        break;
      case 'expand_pharmacy_search':
        await handleExpandPharmacySearch(ctxAlvo);
        break;
      case 'message_supplier':
        await handleMessageSupplier(tc.args as { supplier_hint?: string; message?: string }, ctxAlvo);
        break;
      case 'confirm_order_selection':
        await handleConfirmOrder(tc.args as { order_id: string; quote_id: string }, ctxAlvo);
        break;
      case 'cancel_order':
        await handleCancelOrder(tc.args as { order_id?: string; reason?: string }, ctxAlvo);
        break;
      case 'forward_media_to_establishment':
        await handleForwardMediaToEstablishment(tc.args as { what?: string; caption?: string }, ctxAlvo);
        break;
      case 'find_clinic_by_name':
        await handleFindByName(tc.args as { name: string; city?: string; specialty?: string }, ctxAlvo);
        break;
      case 'contact_establishment':
        await handleContactEstablishment(tc.args as { phone?: string; name?: string; kind?: 'clinic' | 'pharmacy'; specialty?: string; professional?: string; items?: OrderItem[] }, ctxAlvo);
        break;
      case 'relay_answer_to_establishment':
        // Loop agêntico: o cliente respondeu a uma pergunta de farmácia/clínica.
        // Devolve a resposta ao estabelecimento certo (farmácia ou clínica) e a
        // negociação continua de onde parou.
        await relayUserAnswerToEstablishment(ctx.conversationId, (tc.args as { answer?: string }).answer ?? '', ctx.traceId);
        break;
      // ─── Xarlote 2.0 ──────────────────────────────────────────────────────
      case 'start_treatment_from_order':
        await handleStartTreatmentFromOrder(tc.args as unknown as StartTreatmentArgs, ctxAlvo);
        break;
      case 'log_medication_taken':
        await handleLogMedicationTaken(tc.args as unknown as LogMedicationTakenArgs, ctxAlvo);
        break;
      case 'update_treatment_status':
        await handleUpdateTreatmentStatus(tc.args as unknown as UpdateTreatmentStatusArgs, ctxAlvo);
        break;
      case 'log_symptom':
        await handleLogSymptom(tc.args as unknown as LogSymptomArgs, ctxAlvo);
        break;
      case 'query_my_addresses':
        // Não faz nada server-side — a Xarlote já tem os endereços no user_360 context.
        // Tool é "marker" pra a LLM saber que o user perguntou.
        break;
      case 'set_default_address':
        await handleSetDefaultAddress(tc.args as unknown as { address_label: string }, ctxAlvo);
        break;
      case 'save_address':
        await handleSaveAddress(tc.args as unknown as { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean; confirmed_residential?: boolean }, ctxAlvo);
        break;
      case 'start_consultation_search':
        await handleStartConsultationSearch(tc.args as unknown as StartConsultationArgs, ctxAlvo);
        break;
      case 'confirm_consultation_selection':
        await handleConfirmConsultation(tc.args as unknown as { consultation_id: string; quote_id?: string; requested_datetime?: string }, ctxAlvo);
        break;
      case 'cancel_consultation':
        await handleCancelConsultation(tc.args as unknown as { consultation_id: string; reason: string }, ctxAlvo);
        break;
      case 'nudge_consultation':
        // `ctxAlvo`, não `ctx`: hoje são o mesmo objeto (nudge_consultation não aceita
        // `para_quem`), mas este handler recebe o contexto como PRIMEIRO argumento e não
        // foi alcançado pela troca dos demais. Se um dia a tool entrar em
        // `TOOLS_COM_SUJEITO`, aqui já está certo em vez de escrever calado no ator.
        await handleNudgeConsultation(ctxAlvo, tc.args as { message?: string });
        break;
      case 'red_flag_check': {
        // Handler envia BOTÕES diretos pra uazapi + agenda escalation 60s.
        // Não devolve texto pra Xarlote — paciente vai responder via botão.
        await handleRedFlagCheck(tc.args as unknown as RedFlagArgs, ctxAlvo);
        break;
      }
      case 'set_emergency_contact':
        await handleSetEmergencyContact(tc.args as unknown as SetEmergencyContactArgs, ctxAlvo);
        break;
      default:
        break;
    }
    if (taskId) await db.from('assistant_tasks').update({ status: 'success', tool_output: tc.args, completed_at: new Date().toISOString() }).eq('id', taskId);
    await auditToolCall({
      toolName: tc.name,
      // O REGISTRO afetado — que numa ação de cuidador é o do sujeito, não o de quem falou.
      userId: ctxAlvo.userId,
      caregiverUserId: ctxAlvo.atorUserId ?? null,
      conversationId: ctx.conversationId,
      traceId: ctx.traceId,
      args: (tc.args as Record<string, unknown>) ?? {},
      result: 'success',
      durationMs: Date.now() - startedAt,
    });

    // 🤝 O DONO DO REGISTRO PRECISA SABER. Um ponto só, depois do sucesso, cobrindo toda
    // tool de cuidador — presente e futura. Consentimento dado uma vez não é vigilância
    // permanente: se aparecer um aviso que ela não esperava, ela descobre AGORA que
    // precisa revogar. `void`: transparência não atrasa nem derruba o que já aconteceu.
    if (ctxAlvo.atorUserId && acaoPesa(tc.name)) {
      void avisarSujeitoDeAcaoDoCuidador({
        subjectUserId: ctxAlvo.userId,
        caregiverUserId: ctxAlvo.atorUserId,
        toolName: tc.name,
        traceId: ctx.traceId,
      });
    }
    return {
      ok: true,
      ...(obs.note ? { note: obs.note } : {}),
      // "Falei com o paciente por conta própria" — o modelo não deve repetir a mensagem.
      ...(!spokeBefore && ctx.turnFlags?.suppressLlmText === true ? { spoke: true } : {}),
    };
  } catch (err) {
    // ToolFailure = recusa DELIBERADA do handler (referência inválida/ambígua, precondição
    // não satisfeita). Não é crash: a mensagem já foi escrita pro modelo ler, então vai
    // limpa (sem "Error:") e o log é warn. Qualquer outro erro segue como falha técnica.
    const deliberate = err instanceof ToolFailure;
    const forModel = deliberate ? (err as ToolFailure).modelMessage : String(err).slice(0, 240);
    if (taskId) await db.from('assistant_tasks').update({ status: 'error', error: forModel.slice(0, 400), completed_at: new Date().toISOString() }).eq('id', taskId);
    if (deliberate) {
      await writeLog('warn', 'tool', `Tool ${tc.name} recusou executar: ${forModel.slice(0, 160)}`, { traceId: ctx.traceId });
    }
    await auditToolCall({
      toolName: tc.name,
      userId: ctxAlvo.userId,
      caregiverUserId: ctxAlvo.atorUserId ?? null,
      conversationId: ctx.conversationId,
      traceId: ctx.traceId,
      args: (tc.args as Record<string, unknown>) ?? {},
      result: 'failure',
      error: forModel.slice(0, 240),
      durationMs: Date.now() - startedAt,
    });
    // O erro NÃO é mais engolido em silêncio: volta pro modelo no loop agêntico pra ele
    // corrigir o rumo (ou ser honesto com o paciente) em vez de narrar sucesso inexistente.
    // `note` repete o motivo no canal de observação (alguns caminhos só leem a nota).
    // `spoke` também vale no ERRO: um handler pode falhar DEPOIS de já ter falado com o
    // paciente (parse_prescription pede a foto de novo e então recusa) — sem isso o modelo
    // não sabe que a mensagem já saiu e escreve a segunda.
    return {
      ok: false,
      error: forModel.slice(0, 400),
      ...(deliberate ? { note: forModel } : {}),
      ...(!spokeBefore && ctx.turnFlags?.suppressLlmText === true ? { spoke: true } : {}),
    };
  }
}

async function recordTaskStart(tc: ToolCall, ctx: ToolContext): Promise<string> {
  const { data } = await db.from('assistant_tasks').insert({
    conversation_id: ctx.conversationId,
    user_id: ctx.userId,
    tool_name: tc.name,
    // `redigirCredenciais` ANTES de gravar: `fetch_lab_results` chega com a senha do portal
    // do laboratório nos args, e esta tabela é para sempre. Para as outras tools é no-op.
    tool_input: redigirCredenciais(tc.args),
    status: 'running',
    trace_id: ctx.traceId,
  }).select('id').single();
  return data?.id ?? '';
}

async function handleSaveProfileFact(
  args: { category: string; payload: Record<string, unknown> },
  ctx: ToolContext
) {
  // O payload vem LIVRE do LLM — espalhar `...args.payload` direto no insert
  // deixava qualquer chave inventada derrubar o insert (depois da Xarlote já
  // ter dito "salvei!"). Filtra pra colunas conhecidas de cada tabela.
  const pick = (keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (args.payload[k] !== undefined) out[k] = args.payload[k];
    return out;
  };

  /**
   * 🔴 PAYLOAD VAZIO NÃO É SUCESSO (auditoria 09/09/2026 — caso Rodrigo, 24/08).
   *
   * O modelo chamou esta tool com `{category:'identity', payload:{}}` QUATRO vezes seguidas.
   * O `identity` monta um patch, acha o patch vazio, não escreve nada — e RETORNA NORMAL.
   * `assistant_tasks` gravou quatro `success`, o turno terminou sem texto, e o narrador de
   * turno só-tool ("Prontinho, já cuidei disso aqui!") virou o **ÁUDIO DE BOAS-VINDAS** do
   * paciente, que tinha acabado de dizer o nome.
   *
   * As categorias de lista eram piores: `condition`/`allergy`/`medication` com payload vazio
   * INSERIAM uma linha com nome `''` no prontuário. Dado-lixo que depois aparece como
   * "condição registrada" no contexto dela.
   *
   * Regra 26 do projeto: falha nunca vira sucesso. Se não há o que gravar, o modelo tem que
   * ouvir isso e chamar de novo com o valor — nunca anunciar que guardou.
   */
  const exigir = (valor: string, oQue: string): string => {
    const v = valor.trim();
    if (!v) {
      void writeLog('warn', 'tool', `save_user_profile_fact (${args.category}) sem ${oQue} — recusado`, {
        traceId: ctx.traceId, userId: ctx.userId,
      });
      throw new ToolFailure(`NÃO guardei nada: faltou ${oQue} em save_user_profile_fact (category "${args.category}"). Chame de novo com o valor preenchido, e NÃO diga que guardou.`);
    }
    return v;
  };

  switch (args.category) {
    case 'condition':
      await db.from('user_health_conditions').insert({
        user_id: ctx.userId,
        name: exigir(String(args.payload['name'] ?? ''), 'o nome da condição'),
        ...pick(['severity', 'notes', 'active']),
        source: 'self_reported',
      });
      break;
    case 'allergy':
      await db.from('user_allergies').insert({
        user_id: ctx.userId,
        substance: exigir(String(args.payload['substance'] ?? args.payload['name'] ?? ''), 'a substância da alergia'),
        ...pick(['severity', 'reaction']),
        source: 'self_reported',
      });
      break;
    case 'medication':
      await db.from('user_medications').insert({
        user_id: ctx.userId,
        medication_name: exigir(String(args.payload['medication_name'] ?? args.payload['name'] ?? ''), 'o nome do medicamento'),
        ...pick(['dosage', 'frequency', 'form', 'active']),
        source: 'self_reported',
      });
      break;
    case 'address': {
      // UPSERT por rótulo — o insert cru aqui era um dos três escritores que deixaram a
      // Ludmila com 5 endereços e 3 "casa" (14/09). Um rótulo, uma linha.
      const rotulo = String(args.payload['label'] ?? 'principal').trim() || 'principal';
      const campos = pick(['street', 'number', 'complement', 'neighborhood', 'city', 'state', 'cep', 'is_default', 'latitude', 'longitude']);
      const { data: jaExiste } = await db.from('user_addresses').select('id').eq('user_id', ctx.userId).ilike('label', escapeLike(rotulo)).limit(1).maybeSingle();
      if (jaExiste?.id) await db.from('user_addresses').update({ ...campos }).eq('id', jaExiste.id);
      else await db.from('user_addresses').insert({ user_id: ctx.userId, label: rotulo, ...campos });
      break;
    }
    case 'identity': {
      // PONTO 8 (Valdivino→Vadivino): o usuário disse/corrigiu o próprio nome → persiste no
      // perfil (senão a saudação seguia com o pushName do WhatsApp). Só nomes plausíveis.
      const patch: Record<string, unknown> = {};
      const pn = String(args.payload['preferred_name'] ?? '').trim();
      const fn = String(args.payload['full_name'] ?? '').trim();
      if (pn && pn.length <= 40) patch['preferred_name'] = pn.slice(0, 40);
      if (fn && fn.length <= 120) patch['full_name'] = fn.slice(0, 120);
      // Patch vazio = nada a gravar. É o caso Rodrigo: falhar alto em vez de "success" mudo.
      exigir(Object.keys(patch).length ? 'ok' : '', 'preferred_name ou full_name');
      await db.from('users').update(patch).eq('id', ctx.userId);
      break;
    }
    default: {
      // MERGE no metadata — substituir o objeto inteiro apagava fatos anteriores.
      exigir(Object.keys(args.payload ?? {}).length ? 'ok' : '', 'o conteúdo do payload');
      const { data: u } = await db.from('users').select('metadata').eq('id', ctx.userId).maybeSingle();
      const merged = { ...((u?.metadata as Record<string, unknown>) ?? {}), ...args.payload };
      await db.from('users').update({ metadata: merged }).eq('id', ctx.userId);
    }
  }
}

async function handleParsePrescription(_args: { message_id?: string }, ctx: ToolContext) {
  // Mesma raiz do save_exam_result: o `message_id` do modelo era inútil (ele não conhece
  // uuids) e o `.single()` com texto inválido devolvia null → `return` mudo, sem o paciente
  // nem o modelo saberem por quê. Quem sabe qual é a imagem é o runtime.
  const messageId = await resolveMediaMessageId(ctx.conversationId, ctx.inboundMsg?.id, {
    hasInboundMedia: temMidiaNesteTurno(ctx),
  });

  /**
   * 🔴 A receita NUNCA foi lida em produção, e o defeito era este: o handler exigia
   * `ctx.inbound.mediaBase64`, que só o SIMULADOR preenche. No WhatsApp (zpro/uazapi) e no
   * app a mídia chega por URL. Então, para todo paciente de verdade, a tool caía neste `if`,
   * respondia "não consegui processar, manda de novo" e falhava — e falhava outra vez na
   * foto seguinte, para sempre. Uma falha permanente vestida de pedido de reenvio.
   *
   * Agora os bytes vêm do turno (baixados uma vez pelo inbound, `ctx.midiaDoTurno`).
   */
  const midia = ctx.midiaDoTurno;
  if (midia?.tipo === 'document') {
    // Receita em PDF: a visão não lê PDF, e o TEXTO dele já está na mensagem do paciente.
    // Mandar tirar foto de um arquivo legível é o pior dos dois mundos — devolve o caminho
    // certo ao modelo sem falar com o paciente.
    throw new ToolFailure('Essa receita chegou em PDF, não em foto — parse_prescription_image só lê IMAGEM. O TEXTO do PDF já está na mensagem do paciente: liste os medicamentos a partir dele e confirme com ele, sem chamar esta ferramenta de novo.');
  }
  const base64 = midia?.tipo === 'image' ? midia.buffer.toString('base64') : ctx.inbound.mediaBase64 ?? null;
  if (!base64) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Não consegui processar a imagem da receita. Pode mandar de novo? 📋', ctx.traceId);
    if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
    throw new ToolFailure('A receita NÃO foi lida: a imagem não está disponível neste turno (o paciente precisa reenviar a foto). Já pedi a foto de novo a ele — não afirme que leu ou guardou a receita.');
  }

  interface OcrResult {
    error?: string;
    items?: Array<{ medication_name: string; dosage?: string; quantity?: string; frequency?: string }>;
    doctor?: { name?: string; crm?: string; uf?: string };
    issued_at?: string;
    raw_text?: string;
  }

  // Mime dos BYTES quando existe (o declarado pelo provedor mente: a foto do iPhone chega
  // anunciada como jpeg e é HEIC, e o modelo de visão recusa o par errado).
  const parsed = await extractStructured<OcrResult>(PRESCRIPTION_OCR_PROMPT, base64, midia?.mime || ctx.inbound.mediaMime || 'image/jpeg');

  if (parsed.error === 'not_a_prescription') {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Não parece ser uma receita médica. Pode mandar a foto certinha? 📋', ctx.traceId);
    if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
    throw new ToolFailure('A imagem NÃO é uma receita médica — nenhum medicamento foi extraído. Já pedi a foto certa ao paciente. NÃO liste medicamentos nem diga que leu a receita.');
  }

  const { data: prescription, error: prescErr } = await db.from('prescriptions').insert({
    user_id: ctx.userId,
    message_id: messageId,
    ocr_raw_text: parsed.raw_text,
    parsed_json: parsed,
    doctor_name: parsed.doctor?.name,
    doctor_crm: parsed.doctor?.crm,
    doctor_uf: parsed.doctor?.uf,
    issued_at: parsed.issued_at,
  }).select('id').single();

  if (prescErr || !prescription?.id) {
    // Falha de escrita não pode virar "guardei sua receita" (mesma classe do save_exam).
    await writeLog('error', 'exam', `Falha ao salvar receita: ${prescErr?.message ?? 'sem id'}`, { traceId: ctx.traceId, userId: ctx.userId });
    throw new ToolFailure('LI a receita, mas NÃO consegui guardá-la no perfil (falha ao gravar). Pode falar dos medicamentos que leu, mas NÃO diga que salvou/registrou a receita.');
  }
  if (parsed.items) {
    for (const item of parsed.items) {
      await db.from('prescription_items').insert({ prescription_id: prescription.id, ...item });
    }
  }
}

interface SaveExamArgs {
  exam_type: string;
  title: string;
  summary?: string;
  findings?: Array<{ marker: string; value: string; unit?: string; reference?: string }>;
  exam_date?: string;
}

/**
 * Este turno TEM mídia? É o que decide se a mensagem do turno é a mensagem da mídia.
 *
 * Antes a pergunta era `!!ctx.inbound.mediaBase64` — verdadeira só no simulador. Com ela
 * falsa, `resolveMediaMessageId` ia procurar no histórico a última mensagem com
 * `media_mime` não-nulo: se o PDF de hoje chegou sem mime declarado (acontece), o exame era
 * amarrado à FOTO DE OUTRO DIA. Vincular o resultado ao arquivo errado é pior que não
 * vincular: o médico abre o exame e vê outra coisa.
 */
function temMidiaNesteTurno(ctx: ToolContext): boolean {
  return !!(ctx.midiaDoTurno || ctx.inbound.mediaBase64 || ctx.inbound.mediaUrl);
}

/**
 * Valida a data do exame: formato AAAA-MM-DD, real (round-trip — rejeita 2026-13-40),
 * e não-futura (laudo no futuro é alucinação). Retorna null se inválida — melhor não
 * gravar data do que gravar lixo (ou estourar o INSERT na coluna `date`).
 */
function parseExamDate(input?: string): string | null {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const d = new Date(`${input}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // round-trip: garante que 2026-02-30 / 2026-13-01 não "normalizem" pra outra data
  if (d.toISOString().slice(0, 10) !== input) return null;
  // não aceita data no futuro (tolera 1 dia de fuso)
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return input;
}

/**
 * Fase 5 — guarda no perfil um resultado de exame que o paciente compartilhou
 * (foto lida via vision). A Xarlote chama isto APÓS o paciente confirmar.
 *
 * LGPD: exame é dado clínico sensível → nada de valores em log ≥ info (CLAUDE.md #3),
 * só tipo + contagem de marcadores. A row cai na cascata de forget-me (FK + delete
 * explícito no handler de apagar). O memory card nasce sem embedding — o enricher
 * faz backfill no próximo turn (loop de cards com embedding null).
 */
async function handleSaveExamResult(args: SaveExamArgs, ctx: ToolContext) {
  if (!args.exam_type || !args.title) {
    await writeLog('warn', 'exam', 'save_exam_result sem exam_type/title — ignorado', { traceId: ctx.traceId });
    throw new ToolFailure('NÃO guardei o exame: faltou o tipo ou o título. Chame de novo informando exam_type e title — e não diga que guardou até dar certo.');
  }
  const findings = Array.isArray(args.findings) ? args.findings : [];
  const examDate = parseExamDate(args.exam_date);

  // 🔴 INCIDENTE 30/07 (Glauber, 12 falhas em 4 minutos): o `message_id` vinha do MODELO e
  // chegou como "message_id", "message_0", "1", "chatcmpl-…" — texto numa coluna uuid, então
  // o INSERT INTEIRO falhava e o exame do paciente se perdia (a leitura tinha funcionado).
  // O modelo nunca teve como saber esse uuid: agora o parâmetro nem existe no schema e o
  // runtime resolve a mensagem da mídia. Nunca peça ao LLM um dado que só o servidor tem.
  const messageId = await resolveMediaMessageId(ctx.conversationId, ctx.inboundMsg?.id, {
    hasInboundMedia: temMidiaNesteTurno(ctx),
  });
  /**
   * COMO o resultado foi lido, e por que isso vira coluna.
   *
   * 'vision' = valores lidos de uma FOTO pelo canal multimodal. 'pdf' = valores lidos do
   * TEXTO de um PDF, que é uma leitura mais confiável (não passa por OCR). São graus de
   * confiança diferentes no mesmo número, e o médico que abre o link do paciente precisa
   * poder distinguir. Carimbar tudo como 'vision' seria afirmar que vimos uma imagem que
   * nunca existiu.
   */
  const leitura: 'vision' | 'pdf' = ctx.midiaDoTurno?.tipo === 'document' ? 'pdf' : 'vision';
  const { data: row, error } = await db.from('user_exam_results').insert({
    user_id: ctx.userId,
    message_id: messageId,
    conversation_id: ctx.conversationId,
    exam_type: args.exam_type,
    title: args.title,
    summary: args.summary ?? null,
    findings,
    exam_date: examDate,
    source: leitura,
  }).select('id').single();

  if (error) {
    // Falha de escrita NÃO pode virar "guardei no seu perfil": volta pro modelo.
    await writeLog('error', 'exam', `Falha ao salvar exame: ${error.message}`, { traceId: ctx.traceId, userId: ctx.userId });
    throw new ToolFailure('NÃO consegui guardar o exame no perfil (falha ao gravar). NÃO diga que guardou — avise que deu um problema técnico e que ele pode mandar de novo daqui a pouco.');
  }

  // Memory card pra recall ("seu exame de X do dia Y"). Sem embedding agora — o
  // enricher faz backfill no próximo turn (cards com embedding null).
  const cardText = `Exame: ${args.title}${examDate ? ` (${examDate})` : ''}${args.summary ? ` — ${args.summary}` : ''}`.slice(0, 200);
  try {
    await saveMemoryCard({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: 'fact',
      text: cardText,
      tags: ['exame', args.exam_type],
      confidence: 0.9,
      source: 'self_reported',
      embedding: null,
    });
  } catch { /* card é best-effort; a row do exame já está salva */ }

  await writeAudit({
    actorType: 'system',
    actorId: 'xarlote',
    action: 'exam_result.saved',
    userId: ctx.userId,
    targetTable: 'user_exam_results',
    targetId: row?.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { exam_type: args.exam_type, markers: findings.length }, // sem valores clínicos
  });

  await writeLog('info', 'exam', `📄 Exame guardado no perfil (tipo=${args.exam_type}, ${findings.length} marcador(es))`, {
    traceId: ctx.traceId, userId: ctx.userId, examId: row?.id,
  });
}

const ACTIVE_ORDER_STATUSES = ['drafting', 'quoting', 'quoted', 'confirming'];
// Cancelável = ativo + JÁ FECHADO ('handed_off'). O usuário pode cancelar depois do
// fechamento (incidente Glauber 12/07: confirmou → handed_off → "Cancelar" e o pedido
// seguia vivo pra entrega). Pós-fechamento, cancelar TAMBÉM avisa a farmácia (não é flip
// silencioso no banco) — ver cancelActiveOrder.
const CANCELLABLE_ORDER_STATUSES = [...ACTIVE_ORDER_STATUSES, 'handed_off'];

/**
 * Cancela um pedido de medicamento: marca 'cancelled', congela as cotações vivas
 * e fecha clarificações pendentes — assim os workers (nudge/rescue) não re-cutucam
 * um pedido morto. Idempotente: cancelar um pedido já terminal é no-op benigno (o
 * filtro `.in(status, ACTIVE)` não casa nada). NÃO avisa as farmácias (evita spam;
 * respostas tardias caem no guard de status do inbound-supplier). Mesmo status
 * terminal 'timeout' usado no freeze de cotações irmãs do confirm_order_selection.
 */
async function cancelActiveOrder(orderId: string, reason: string, traceId: string): Promise<boolean> {
  // Lê o estado ANTES de cancelar: se o pedido já estava FECHADO (handed_off), a farmácia
  // foi acionada e precisa ser AVISADA do cancelamento (não some no banco em silêncio).
  const { data: before } = await db.from('orders')
    .select('status, selected_quote_id, items, user_id')
    .eq('id', orderId).maybeSingle();
  const wasHandedOff = before?.status === 'handed_off';

  // Checa o erro do update do PEDIDO (review hardening): se falhar (DB transiente), o
  // caller da TROCA aborta em vez de criar um 2º pedido vivo com o antigo ainda ativo.
  const { data: updated, error: ordErr } = await db.from('orders')
    .update({ status: 'cancelled', cancelled_reason: reason.slice(0, 500) })
    .eq('id', orderId)
    .in('status', CANCELLABLE_ORDER_STATUSES)
    .select('id');
  if (ordErr) {
    await writeLog('error', 'order', `Falha ao cancelar pedido ${orderId}: ${String(ordErr.message ?? ordErr).slice(0, 160)}`, { traceId, orderId });
    return false;
  }
  if (!updated?.length) {
    // Nada mudou (já terminal) — no-op honesto.
    await writeLog('info', 'order', `cancelActiveOrder no-op — pedido ${orderId} já não estava cancelável`, { traceId, orderId });
    return false;
  }
  await db.from('quotes')
    .update({ status: 'timeout', completed_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .in('status', ['pending', 'contacting', 'negotiating', 'quoted']);
  await db.from('quotes')
    .update({ clarification_status: 'closed' })
    .eq('order_id', orderId)
    .eq('clarification_status', 'awaiting_user');
  await writeLog('info', 'order', `Pedido cancelado — ${reason}`, { traceId, orderId });

  // 📣 AVISO À FARMÁCIA no cancelamento PÓS-FECHAMENTO (incidente Glauber 12/07): o pedido
  // fechado foi entregue à farmácia — cancelar sem avisar deixaria ela preparando/entregando.
  // Best-effort: acha a conversa da cotação escolhida e manda um pedido de parada humano.
  if (wasHandedOff && before?.selected_quote_id) {
    try {
      const { data: q } = await db.from('quotes')
        .select('conversation_id, suppliers(phone_e164, whatsapp_e164)')
        .eq('id', before.selected_quote_id as string).maybeSingle();
      const sup = q?.suppliers as { phone_e164?: string; whatsapp_e164?: string } | null;
      const phone = sup?.whatsapp_e164 || sup?.phone_e164;
      // isServiceNumber: não manda "cancela" pra call-center 4002/0800 (não é WhatsApp de loja).
      if (q?.conversation_id && phone && !isServiceNumber(phone) && !isPlaceholderPhone(phone)) {
        const items = (before.items ?? []) as OrderItem[];
        const itemName = items.map((it) => itemDisplayName(it.name, it.dosage)).filter(Boolean).join(', ') || 'aquele pedido';
        await sendOutboundToSupplier(
          q.conversation_id as string,
          phone,
          `Oi! Preciso cancelar o pedido de ${itemName} que a gente tinha fechado, por favor não prepara nem envia. Desculpa o transtorno e obrigada pela compreensão!`,
          traceId,
        );
        await writeLog('info', 'order', `Farmácia avisada do cancelamento pós-fechamento`, { traceId, orderId, quoteId: before.selected_quote_id });
      }
    } catch (err) {
      await writeLog('warn', 'order', `Falha ao avisar farmácia do cancelamento (ignorado): ${String(err).slice(0, 120)}`, { traceId, orderId });
    }
  }
  return true;
}

/**
 * Tool `cancel_order` — ANTES não tinha `case` no dispatch: caía no `default: break`
 * e era marcada 'success' sem cancelar NADA (incidente Cefaliv 06/07 — o usuário
 * mandava "cancela o Pietra e pede Cefaliv", a Xarlote dizia "cancelei!" mas o
 * pedido seguia 'quoted', travando o novo pedido na trava de idempotência e fazendo
 * ela repetir "suas cotações já estão prontas, olha acima" — o delírio).
 * O `order_id` vem do LLM e pode estar errado/alucinado → a fonte de verdade é o
 * pedido ATIVO do usuário; só honra o order_id se ele pertencer a ESSE usuário.
 */
async function handleCancelOrder(args: { order_id?: string; reason?: string }, ctx: ToolContext): Promise<void> {
  // 🔴 MESMA RAIZ DO INCIDENTE 30/07 (cancel_consultation), aqui no handler MAIS usado:
  // o `order_id` do modelo ia cru pro `.eq('id', …)`; texto numa coluna uuid devolvia
  // null, o handler fazia `return` mudo, a task era carimbada `success` e a Xarlote dizia
  // "Pronto, cancelei seu pedido 💙" com o pedido VIVO — travando inclusive o pedido novo
  // na idempotência (o delírio do Cefaliv). Agora resolve pelo estado real e, quando não
  // dá pra ter certeza, recusa em voz alta em vez de fingir.
  const target = await resolveOrderForUser(args.order_id, ctx.userId, {
    action: 'cancelado',
    traceId: ctx.traceId,
    statuses: CANCELLABLE_ORDER_STATUSES,
    excludeIds: ctx.ordersCreatedThisTurn,
  });

  // 🛑 `handed_off` = a farmácia JÁ recebeu o pedido; cancelar dispara mensagem real ("não
  // prepara, não envia"). O critério é RECÊNCIA, não como o id chegou: o modelo nunca tem o
  // uuid de um pedido handed_off (o bloco PEDIDO ATIVO só lista quoting/quoted/confirming),
  // então exigir identificação exata tornaria o cancelamento pós-fechamento IMPOSSÍVEL — e
  // a farmácia entregaria um pedido que o paciente cancelou. Um handoff de horas atrás é
  // quase certamente o que ele quer cancelar; um de semanas atrás, quase certamente não
  // (ex.: ele pediu pra cancelar um LEMBRETE e o modelo errou a rota).
  const handoffAgeMs = Date.now() - new Date(target.updated_at ?? 0).getTime();
  if (target.status === 'handed_off' && target.resolvedBy === 'only-one' && handoffAgeMs > 48 * 60 * 60_000) {
    throw new ToolFailure('NADA FOI CANCELADO: o único pedido que encontrei já foi entregue à farmácia há dias, e não ficou claro que é ESSE que o paciente quer cancelar (pode ser um lembrete, por exemplo). CONFIRME com ele antes de eu avisar a farmácia.');
  }

  const cancelled = await cancelActiveOrder(target.id, args.reason ?? 'cancelado pelo usuário', ctx.traceId);
  if (!cancelled) {
    // Corrida: outro turno cancelou entre a resolução e o UPDATE. Não é sucesso.
    throw new ToolFailure('O pedido NÃO foi cancelado agora (ele já não estava mais ativo). Não anuncie um cancelamento novo — se o paciente perguntou, confirme que o pedido já não está de pé.');
  }
}

/**
 * Salva/atualiza um endereço ROTULADO do usuário (casa/trabalho/outro) pra reusar
 * depois via start_pharmacy_order(saved_address_label). Fonte da localização:
 * (1) full_address se geocodifica PRECISO; senão (2) a localização EXATA do último
 * pedido (caso 📍/salvar-o-que-acabei-de-usar); senão pede o endereço.
 * NUNCA loga o endereço (PII — CLAUDE.md #3): só o label + id.
 */
async function handleSaveAddress(
  args: { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean; confirmed_residential?: boolean; apply_to_active_order?: boolean },
  ctx: ToolContext,
): Promise<void> {
  let label = (args.label ?? '').trim() || 'principal';
  let lat: number | null = null;
  let lng: number | null = null;
  let addrText: string | null = (args.full_address ?? '').trim() || null;
  const hadText = !!addrText;

  // 🏷️ A CORREÇÃO CORRIGE O ENDEREÇO QUE O PEDIDO USAVA. Com pedido vivo (24h) apontando pra um
  // endereço salvo, o rótulo é o DELE — não o que o modelo escolheu. Em 14/09 o trabalho da
  // Ludmila foi regravado como "casa" porque o prompt dizia "label = o rótulo que ele usa, ou
  // casa" (regra 98: o campo que você oferece é a pergunta que você faz).
  const { data: pedidoVivo } = args.apply_to_active_order !== false
    ? await db.from('orders').select('id, user_address_id').eq('user_id', ctx.userId)
      .in('status', ['quoting', 'quoted'])
      .gte('created_at', new Date(Date.now() - JANELA_PEDIDO_VIVO_MS).toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  if (pedidoVivo?.user_address_id) {
    const { data: usado } = await db.from('user_addresses').select('label').eq('id', pedidoVivo.user_address_id).maybeSingle();
    const rotuloDoPedido = String(usado?.label ?? '').trim();
    if (rotuloDoPedido && rotuloDoPedido.toLowerCase() !== label.toLowerCase()) {
      await writeLog('info', 'address', `save_address: pedido vivo usa o endereço "${rotuloDoPedido}" — a correção vai pra ele (o modelo pediu "${label}")`, { traceId: ctx.traceId, orderId: pedidoVivo.id });
      label = rotuloDoPedido;
    }
  }

  // 1. Texto PRECISO tem prioridade (salvar proativo "meu trabalho é Av X 100").
  if (addrText) {
    const geo = await geocodeAddress(addrText);
    if (geo && geo.confidence === 'precise') {
      lat = geo.lat; lng = geo.lng;
      addrText = geo.formattedAddress || addrText;
    }
  }
  // 2. SEM texto (caso 📍 / "salva o que acabei de usar") → localização EXATA do último
  //    pedido. ⚠️ NÃO cai aqui se o usuário DEU um texto que só geocodificou impreciso —
  //    salvar a localização de OUTRO pedido sob esse rótulo mandaria a entrega pro lugar
  //    errado. Nesse caso pede o CEP (abaixo).
  if ((lat == null || lng == null) && !hadText) {
    const { data: ord } = await db.from('orders')
      .select('delivery_lat, delivery_lng, delivery_address')
      .eq('user_id', ctx.userId)
      .not('delivery_lat', 'is', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (ord?.delivery_lat != null && ord?.delivery_lng != null) {
      lat = ord.delivery_lat as number;
      lng = ord.delivery_lng as number;
      addrText = (ord.delivery_address as string | null);
    }
  }
  if (lat == null || lng == null) {
    const pedido = hadText
      ? `Não consegui localizar esse endereço com precisão 🙈 Me confirma com o CEP que eu salvo certinho.`
      : `Pra guardar esse endereço eu preciso dele completo 🙂 Me manda com o CEP, ou compartilha sua localização 📍 que eu salvo.`;
    await sendOutbound(ctx.conversationId, ctx.phoneE164, pedido, ctx.traceId);
    return;
  }

  // 3. Componentes estruturados. O QUE A PESSOA DIGITOU É O DADO (caso Ludmila, 10–14/09):
  //    o reverse-geocode trocava "Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste" por "Rua 14,
  //    Setor Sul" sem número — o setor do mapa numa rua de divisa, e o número perdido. O mapa
  //    só completa o que ela não disse (cidade/UF/CEP).
  const digitado = parseEnderecoDigitado(hadText ? (args.full_address ?? '') : (addrText ?? ''));
  let street: string | null = digitado.street, number: string | null = digitado.number, neighborhood: string | null = digitado.neighborhood;
  let city: string | null = digitado.city, state: string | null = digitado.state, cep: string | null = digitado.cep;
  try {
    const nomi = await reverseGeocodeNominatim(lat, lng);
    if (nomi) {
      street = street ?? nomi.road ?? null; number = number ?? nomi.houseNumber ?? null;
      neighborhood = neighborhood ?? nomi.neighborhood ?? null; city = city ?? nomi.city ?? null;
      state = state ?? nomi.state ?? null; cep = cep ?? nomi.postcode ?? null;
    }
  } catch { /* best-effort — coords bastam */ }
  // Se nem o texto nem o mapa deram rua, guarda o texto inteiro como rua.
  if (!street && addrText) street = addrText.slice(0, 180);
  // Complemento: o que veio no argumento próprio + o que estava no texto (Qd./Lt./Apto), sem repetir.
  const complementoArg = (args.complement ?? '').trim();
  const complemento = [complementoArg, digitado.complement].filter((c): c is string => !!c && c.trim().length > 0)
    .filter((c, i, arr) => arr.findIndex((x) => x.toLowerCase().replace(/\W/g, '') === c.toLowerCase().replace(/\W/g, '')) === i)
    .join(', ') || null;

  // PONTO 10 (incidente Vadivino: hospital salvo como "casa" + virou endereço default):
  // endereço institucional (hospital/UPA/clínica) sob rótulo residencial → confirma antes
  // de salvar (é onde a pessoa TÁ agora, não a casa dela) e NUNCA vira default automático.
  const looksInstitutional = /\b(hospital|upa|pronto[- ]socorro|pronto atendimento|cl[íi]nica|santa casa|maternidade|ubs|posto de sa[úu]de|laborat[óo]rio)\b/i
    .test(`${addrText ?? ''} ${street ?? ''}`);
  if (looksInstitutional && !args.confirmed_residential && /^(casa|trabalho|home|work)$/i.test(label.trim())) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Esse endereço parece ser de um hospital/clínica 🙂 é só onde você tá agora (pra essa entrega) ou quer guardar como a sua casa mesmo? Me confirma que eu salvo do jeito certo.', ctx.traceId);
    return;
  }

  // 4. Upsert por (user, label) — atualiza se já existe esse rótulo.
  const { data: existing } = await db.from('user_addresses')
    .select('id').eq('user_id', ctx.userId).ilike('label', escapeLike(label)).limit(1).maybeSingle();
  const row: Record<string, unknown> = {
    user_id: ctx.userId, label,
    street, number, complement: complemento,
    neighborhood, city, state, cep,
    latitude: lat, longitude: lng,
    notes: (args.notes ?? '').trim() || null,
  };
  let addrId: string | null = null;
  if (existing?.id) {
    await db.from('user_addresses').update(row).eq('id', existing.id);
    addrId = existing.id as string;
  } else {
    const { data: ins } = await db.from('user_addresses').insert(row).select('id').single();
    addrId = (ins?.id as string | undefined) ?? null;
  }

  // 5. Default: se pedido explicitamente OU se é o ÚNICO endereço do usuário.
  if (addrId) {
    const { count } = await db.from('user_addresses')
      .select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId);
    // Endereço institucional não vira default sozinho (só se o usuário pedir explicitamente).
    if (args.set_default === true || ((count ?? 0) <= 1 && !looksInstitutional)) {
      await db.from('user_addresses').update({ is_default: false }).eq('user_id', ctx.userId);
      await db.from('user_addresses').update({ is_default: true }).eq('id', addrId);
    }
  }
  await writeLog('info', 'address', `Endereço "${label}" salvo/atualizado`, { traceId: ctx.traceId, userAddressId: addrId });
  await writeAudit({
    actorType: 'xarlote', action: 'user.address.save', userId: ctx.userId,
    targetTable: 'user_addresses', targetId: addrId ?? undefined,
    conversationId: ctx.conversationId, traceId: ctx.traceId, metadata: { label },
  });

  // 📦 CORREÇÃO NO MEIO DO PEDIDO (caso Ludmila, 10/09): ela corrigiu o endereço com o pedido em
  // cotação; a correção virou mensagem solta à farmácia e o pedido/perfil ficaram errados. Agora
  // o endereço salvo TAMBÉM vira o endereço do pedido vivo, e a farmácia que já cotou recebe UMA
  // mensagem com o endereço certo pedindo o frete pra lá (via fila do agente; janela respeitada).
  // "Pedido em andamento" tem a MESMA janela do roteador (24h): em 14/09 um pedido cotado em
  // 10/09 e nunca fechado recebeu o endereço novo e uma mensagem pra farmácia, num turno em que
  // a paciente só disse "oi".
  if (args.apply_to_active_order !== false && addrId) {
    const { data: ativo } = await db.from('orders').select('id, delivery_address').eq('user_id', ctx.userId)
      .in('status', ['quoting', 'quoted'])
      .gte('created_at', new Date(Date.now() - JANELA_PEDIDO_VIVO_MS).toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (ativo?.id) {
      const enderecoNovo = montarEnderecoHumano({ street, number, complement: complemento, neighborhood, city, state, cep }) || addrText || null;
      await db.from('orders').update({ delivery_address: enderecoNovo, delivery_lat: lat, delivery_lng: lng, user_address_id: addrId }).eq('id', ativo.id);
      const { data: cotadas } = await db.from('quotes').select('id, conversation_id, suppliers(name, whatsapp_e164, phone_e164)').eq('order_id', ativo.id).eq('status', 'quoted');
      let avisadas = 0;
      for (const q of cotadas ?? []) {
        const sup = q.suppliers as { name?: string; whatsapp_e164?: string | null; phone_e164?: string | null } | null;
        const fone = sup?.whatsapp_e164 || sup?.phone_e164 || null;
        if (!q.conversation_id || !fone || isPlaceholderPhone(fone)) continue;
        const curto = shortSupplierAddress(enderecoNovo) || enderecoNovo || 'o endereço que te passei';
        const ok = await sendOutboundToSupplier(q.conversation_id as string, fone, `Corrigindo o endereço da entrega: é ${curto}. Quanto fica o frete pra lá?`, ctx.traceId);
        if (ok) avisadas++;
      }
      await writeLog('info', 'order', `Endereço corrigido aplicado ao pedido ${String(ativo.id).slice(0, 8)}; ${avisadas} farmácia(s) avisada(s)`, { traceId: ctx.traceId, orderId: ativo.id });
      if (ctx.observation) {
        ctx.observation.note = `Endereço "${label}" salvo E aplicado ao pedido em andamento (${enderecoNovo}). ${avisadas ? `Já avisei ${avisadas} farmácia(s) que cotaram e pedi o frete pro endereço certo — não mande message_supplier pra isso.` : 'Nenhuma farmácia precisou ser avisada ainda.'}`;
      }
    }
  }
}

async function handleStartPharmacyOrder(
  args: { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string; preferred_pharmacy_names?: string[] },
  ctx: ToolContext
) {
  // ─── ITENS COMO DADO HONESTO (caso Ludmila, 10/09) ─────────────────────────
  // `substitutes_ok` era OBRIGATÓRIO no schema → o modelo preenchia `true` sozinho e a farmácia
  // ouvia "Venaflon serve sim" sem a paciente ter sido perguntada. Agora: true/false SÓ quando
  // vieram como boolean (o prompt manda passar só se o paciente disse); o resto vira null =
  // "não perguntado". `source` diz de onde o nome veio (texto/foto/áudio).
  // O booleano só é honrado se o PACIENTE falou de genérico/similar/marca (teste cego 13/09: o
  // modelo de visão preencheu `false` sozinho ao ler a receita). Consentimento pela fala.
  // As FALAS RECENTES do paciente (texto + o que foi lido de foto/áudio), nos últimos 30 min.
  // Eram 3 mensagens contando a atual (14/09: "Pode ser pro trabalho" dita duas mensagens antes
  // já tinha saído da janela). Uma conversa de pedido tem 6–10 falas curtas; olhamos 8.
  const { data: falasRecentes } = await db.from('messages').select('content, transcript, direction, created_at')
    .eq('conversation_id', ctx.conversationId)
    .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .order('created_at', { ascending: false }).limit(16);
  const recentes = (falasRecentes ?? []) as Array<{ content: string | null; transcript: string | null; direction: 'in' | 'out'; created_at: string }>;
  const falasIn = recentes.filter((m) => m.direction === 'in').slice(0, 8);
  // O que o PACIENTE disse (texto/legenda) — é o que vale como consentimento (substituto, endereço).
  const falasDoPaciente = [ctx.textoDoPaciente, ...falasIn.map((m) => m.content)];
  // …e mais o que foi LIDO da foto/áudio (transcript) — vale só pra quantidade (a receita diz "30 comprimidos").
  const falas = [...falasDoPaciente, ...falasIn.map((m) => m.transcript)];
  const ultimaFalaDaXarlote = recentes.find((m) => m.direction === 'out')?.content ?? null;
  const falouDeSubstituto = pacienteFalouDeSubstituto(falasDoPaciente);
  args.items = (args.items ?? []).map((i) => {
    // 📦 QUANTIDADE QUE NINGUÉM DISSE NÃO ENTRA (14/09): "30 cápsulas"/"90 cápsulas" inventados
    // da posologia viraram forma de busca e "(90 cápsulas)" pra farmácia. Sem número dito pelo
    // paciente ou lido da receita, a quantidade cai — 1 caixa é o padrão e a farmácia cota assim.
    const quantidade = quantidadeFoiMencionada(falas, i.quantity) ? i.quantity : undefined;
    if (i.quantity && !quantidade) {
      void writeLog('info', 'order', `start_pharmacy_order: quantidade "${i.quantity}" de "${i.name}" não foi dita por ninguém — removida (1 caixa é o padrão)`, { traceId: ctx.traceId });
    }
    return {
      ...i,
      name: String(i.name ?? '').trim(),
      quantity: quantidade,
      substitutes_ok: typeof i.substitutes_ok === 'boolean' && falouDeSubstituto ? i.substitutes_ok : null,
      source: (['texto', 'foto', 'audio'] as const).includes((i.source ?? 'texto') as OrigemDoNome) ? (i.source ?? 'texto') : 'texto',
    };
  });
  if (!args.items.length || !args.items[0]?.name) {
    throw new ToolFailure('NENHUM pedido foi criado: faltou o nome do medicamento. Pergunte ao paciente qual remédio ele quer.');
  }

  // ─── IDEMPOTÊNCIA + TROCA DE PRODUTO ───────────────────────────────────────
  // Se já existe uma order ativa (quoting/quoted/confirming) pra esse usuário:
  //   • MESMO medicamento → NÃO cria outra e NÃO reinicia contato (proteção
  //     essencial: a Xarlote re-chama essa tool quando o usuário pressiona
  //     "e aí, achou?"). Só devolve o status atual.
  //   • Medicamento DIFERENTE + pedido ainda em cotação (quoting/quoted) →
  //     é uma TROCA (incidente Cefaliv 06/07: largou o Pietra, quer o Cefaliv).
  //     Cancela o antigo e SEGUE criando o novo — em vez de ficar preso
  //     repetindo "suas cotações já estão prontas, olha acima".
  //     'confirming' (já escolheu farmácia, handoff em curso) NÃO auto-troca —
  //     conservador; nesse caso mostra status e o usuário/`cancel_order` decide.
  const { data: existingActive } = await db
    .from('orders')
    .select('id, status, items')
    .eq('user_id', ctx.userId)
    .in('status', ['quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingActive) {
    const activeItems = (existingActive.items ?? []) as OrderItem[];
    const status = existingActive.status as string;
    const differentProduct = !sameMedication(args.items, activeItems);

    if (differentProduct && ['quoting', 'quoted'].includes(status)) {
      // TROCA em cotação: cancela o antigo e SEGUE criando o novo.
      await writeLog('info', 'order', `start_pharmacy_order — TROCA de medicamento; cancelando pedido ativo ${existingActive.id} e abrindo o novo`, {
        traceId: ctx.traceId, existingOrderId: existingActive.id,
        from: activeItems.map((i) => i.name).join(', '), to: (args.items ?? []).map((i) => i.name).join(', '),
      });
      const ok = await cancelActiveOrder(existingActive.id, 'usuário trocou de medicamento', ctx.traceId);
      if (!ok) {
        // Cancel do antigo falhou (DB transiente) → NÃO cria o novo (senão ficam 2 vivos).
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          'Tive um probleminha aqui pra trocar seu pedido 🙈 Pode me mandar de novo qual medicamento você quer agora?', ctx.traceId);
        return;
      }
      // NÃO retorna — cai no fluxo normal de criação do novo pedido abaixo.
    } else if (differentProduct && status === 'confirming') {
      // Pedido já em FECHAMENTO com a farmácia (confirmação possivelmente já enviada) —
      // não cancela sozinha (farmácia comprometida; golden rule). Não mente "olha acima";
      // pergunta de forma honesta e deixa o usuário/`cancel_order` decidir (MEDIUM-1).
      const novo = (args.items ?? []).map((i) => i.name).filter(Boolean).join(', ') || 'o novo medicamento';
      await writeLog('info', 'order', `start_pharmacy_order — troca pedida com pedido em 'confirming'; pedindo confirmação`, {
        traceId: ctx.traceId, existingOrderId: existingActive.id,
      });
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Seu pedido anterior já está sendo fechado com a farmácia 💙 Quer que eu cancele ele pra buscar ${novo}? Se sim, é só confirmar que eu começo na hora.`,
        ctx.traceId);
      return;
    } else {
      // MESMO medicamento → protege contra reinício (anti-restart). Só devolve status.
      await writeLog('warn', 'order', `start_pharmacy_order ignorado — já há pedido ativo do mesmo medicamento (${status})`, {
        traceId: ctx.traceId, existingOrderId: existingActive.id,
      });
      await sendCurrentOrderStatus(existingActive.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
      return;
    }
  }

  let lat: number | null = null;
  let lng: number | null = null;
  let deliveryAddress: string | null = null;
  let locationSource = 'unknown';
  let userAddressId: string | null = null;

  // Prioridade: ENDEREÇO SALVO (label) > endereço de texto > localização do WhatsApp > lat/lng do LLM.
  // (LLM costuma reaproveitar coords antigas do histórico — texto fresco é mais confiável;
  //  mas endereço SALVO explicitamente escolhido é a localização exata guardada — reusa direto.)
  if (args.saved_address_label) {
    const { data: saved } = await db
      .from('user_addresses')
      .select('id, label, street, number, complement, neighborhood, city, state, cep, latitude, longitude, usage_count')
      .eq('user_id', ctx.userId)
      .ilike('label', escapeLike(args.saved_address_label.trim()))
      .order('is_default', { ascending: false })
      .limit(1)
      .maybeSingle();
    // 🗣️ CONSENTIMENTO PELA FALA (caso Ludmila): o modelo escolheu "trabalho" sozinho — ela só
    // mandou a foto e "consegue cotar?". Um endereço salvo só entra se o paciente o MENCIONOU
    // (rótulo, "mesmo endereço", a rua) neste turno ou no anterior. Senão, pergunta pra onde vai.
    if (saved) {
      // Olha as falas recentes de verdade (não só a atual + 1) e aceita a resposta à NOSSA
      // proposta: "Confirmo o pedido pro trabalho?" → "Isso" é consentimento (14/09).
      if (!enderecoFoiMencionado(falasDoPaciente, { label: String(saved.label ?? ''), street: (saved.street as string | null) ?? null }, { propostaDaXarlote: ultimaFalaDaXarlote, respostaAtual: ctx.textoDoPaciente })) {
        const { data: todos } = await db.from('user_addresses').select('label, street, number, complement, neighborhood, is_default, created_at').eq('user_id', ctx.userId).order('is_default', { ascending: false }).order('created_at', { ascending: false }).limit(8);
        // Um por rótulo (o default ou o mais novo) — a lista com "trabalho, trabalho, casa, casa" era ilegível.
        const porRotulo = new Map<string, { label: string; street: string | null; number: string | null; complement: string | null; neighborhood: string | null }>();
        for (const a of (todos ?? []) as Array<{ label: string; street: string | null; number: string | null; complement: string | null; neighborhood: string | null }>) {
          const k = String(a.label ?? '').trim().toLowerCase();
          if (k && !porRotulo.has(k)) porRotulo.set(k, a);
        }
        const lista = [...porRotulo.values()].map((a) => `*${a.label}* (${[[a.street, a.number].filter(Boolean).join(', '), a.complement, a.neighborhood].filter(Boolean).join(', ') || 'endereço salvo'})`).join(', ');
        await writeLog('warn', 'order', `start_pharmacy_order: endereço salvo "${saved.label}" NÃO foi mencionado pelo paciente — perguntando pra onde vai em vez de assumir`, { traceId: ctx.traceId });
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          `Pra onde eu mando? Tenho aqui ${lista || 'um endereço salvo'} — ou me passa um endereço novo (com o CEP) 💙`, ctx.traceId);
        if (ctx.observation) ctx.observation.note = 'NENHUM pedido foi criado: o paciente ainda não disse pra qual endereço vai (não assuma um salvo). A pergunta já foi enviada; aguarde a resposta dele.';
        return;
      }
    }
    if (saved?.latitude != null && saved?.longitude != null) {
      lat = saved.latitude as number;
      lng = saved.longitude as number;
      userAddressId = saved.id as string;
      const parts = [
        [saved.street, saved.number].filter(Boolean).join(', '),
        saved.complement, saved.neighborhood,
        [saved.city, saved.state].filter(Boolean).join(' - '),
        saved.cep,
      ].filter((p) => p && String(p).trim());
      deliveryAddress = parts.join(', ') || (saved.label as string);
      locationSource = `saved_address:${saved.label}`;
      // Marca uso (pra sugerir default depois e ordenar por frequência). Read-then-write
      // simples — 1 usuário por vez, sem concorrência real aqui.
      await db.from('user_addresses')
        .update({ usage_count: ((saved.usage_count as number | null) ?? 0) + 1, last_used_at: new Date().toISOString() })
        .eq('id', saved.id);
      await writeLog('info', 'order', `start_pharmacy_order — usando endereço salvo "${saved.label}"`, {
        traceId: ctx.traceId, userAddressId, lat, lng,
      });
    } else {
      // Label não encontrado / sem coords → pede o endereço (não inventa localização).
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Hmm, não achei esse endereço salvo aqui 🙈 Me manda o endereço (com o CEP fica perfeito) ou compartilha sua localização 📍 que eu já coto.`,
        ctx.traceId);
      return;
    }
  } else if (args.location?.address) {
    await writeLog('info', 'geocoding', `Geocodificando endereço do usuário`, { traceId: ctx.traceId, address: args.location.address });
    const geo = await geocodeAddress(args.location.address);
    if (geo && geo.confidence === 'precise') {
      lat = geo.lat;
      lng = geo.lng;
      // O endereço do pedido é o que o paciente DIGITOU (número, quadra, lote, setor); o mapa
      // só empresta cidade/CEP quando faltam. O `formattedAddress` do geocoder trocava
      // "Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste" por "Rua 14, Setor Sul" (14/09).
      const digitado = parseEnderecoDigitado(args.location.address);
      const doMapa = parseEnderecoDigitado(geo.formattedAddress ?? '');
      deliveryAddress = montarEnderecoHumano({ ...digitado, city: digitado.city ?? doMapa.city, state: digitado.state ?? doMapa.state, cep: digitado.cep ?? doMapa.cep }) || geo.formattedAddress || args.location.address;
      locationSource = `geocoded:${geo.formattedAddress}`;
      await writeLog('info', 'geocoding', `Endereço localizado (confiança: precise)`, { traceId: ctx.traceId, lat, lng, address: geo.formattedAddress });
    } else if (geo && geo.confidence === 'low') {
      // Geocoder caiu no fallback de cidade/estado — provavelmente bairro/rua não existe.
      // Não usa pra busca local (centro da cidade pode estar a km do usuário); pede refinamento.
      await writeLog('warn', 'geocoding', `Match impreciso (só cidade/UF) — pedindo refinamento`, {
        traceId: ctx.traceId, queriedAddress: args.location.address, matchedAddress: geo.formattedAddress,
      });
      await sendOutbound(
        ctx.conversationId,
        ctx.phoneE164,
        `Hmm, não consegui achar esse endereço exato no mapa 😕 Confere pra mim o nome do bairro/setor e o CEP? Ou se preferir, compartilha sua localização pelo botão 📍 que fica mais rápido 💙`,
        ctx.traceId,
      );
      return;
    } else {
      await writeLog('warn', 'geocoding', `Endereço não encontrado`, { traceId: ctx.traceId, address: args.location.address });
      await sendOutbound(
        ctx.conversationId,
        ctx.phoneE164,
        'Não consegui localizar esse endereço no mapa 😕 Pode compartilhar sua localização pelo botão 📍 abaixo? Fica mais fácil assim!',
        ctx.traceId,
      );
      return;
    }
  } else if (ctx.inbound.location) {
    lat = ctx.inbound.location.lat;
    lng = ctx.inbound.location.lng;
    locationSource = 'whatsapp_location';
    // Reverse geocode pra ter um endereço REAL ("Rua X, 123, Setor Y, Cidade - UF, CEP") em vez
    // de "Localização compartilhada via WhatsApp (lat ...)" — a farmácia precisa disso pra calcular frete.
    // Tenta Nominatim primeiro (gratuito, retorna structured address com rua/número/setor/CEP).
    // Cai pro Google Geocoding como fallback se o Nominatim falhar (ele pode estar lento ou off).
    try {
      const nomi = await reverseGeocodeNominatim(lat, lng);
      if (nomi) {
        deliveryAddress = nomi.formattedAddress;
        await writeLog('info', 'geocoding', `Reverse geocode (Nominatim) OK`, {
          traceId: ctx.traceId, lat, lng, address: nomi.shortAddress,
          road: nomi.road, neighborhood: nomi.neighborhood, city: nomi.city, postcode: nomi.postcode,
        });
      } else {
        const goog = await reverseGeocode(lat, lng).catch(() => null);
        if (goog) {
          deliveryAddress = goog;
          await writeLog('info', 'geocoding', `Reverse geocode (Google fallback) OK`, {
            traceId: ctx.traceId, lat, lng, address: goog,
          });
        } else {
          deliveryAddress = `Localização compartilhada via WhatsApp (lat ${lat.toFixed(5)}, lng ${lng.toFixed(5)})`;
          await writeLog('warn', 'geocoding', `Reverse geocode falhou em Nominatim e Google — usando coords`, {
            traceId: ctx.traceId, lat, lng,
          });
        }
      }
    } catch (err) {
      deliveryAddress = `Localização compartilhada via WhatsApp (lat ${lat.toFixed(5)}, lng ${lng.toFixed(5)})`;
      await writeLog('warn', 'geocoding', `Reverse geocode lançou exception: ${String(err).slice(0, 120)}`, {
        traceId: ctx.traceId, lat, lng,
      });
    }
  } else if (args.location?.lat && args.location?.lng) {
    // Fallback: LLM mandou só lat/lng (sem endereço de texto e sem localização do usuário na msg atual).
    // Aceita, mas registra para debug — costuma ser sintoma de coord reaproveitada do histórico.
    lat = args.location.lat;
    lng = args.location.lng;
    locationSource = 'llm_args_coords_only';
    await writeLog('warn', 'geocoding', `LLM passou lat/lng sem endereço de texto — possível reuso de histórico`, {
      traceId: ctx.traceId, lat, lng,
    });
  }

  if (!lat || !lng) {
    await sendOutbound(
      ctx.conversationId,
      ctx.phoneE164,
      'Preciso da sua localização para encontrar farmácias próximas. Pode usar o botão 📍 abaixo para compartilhar?',
      ctx.traceId,
    );
    return;
  }

  // 🔎 O NOME EXISTE? (caso Ludmila: "Aflor 1000 Flex" lido da receita foi pra 5 farmácias.)
  // Catálogo real das grandes redes decide; a regra do que fazer é pura (nome-remedio.ts):
  // foto/áudio + inexistente → confirma com o paciente ANTES de acionar alguém; texto do
  // paciente + inexistente → segue (a palavra dele vence); redes fora → segue sem verificar.
  // A CONVERSA É A MEMÓRIA da checagem: se a pergunta "Li *X* na receita…" já saiu e o
  // paciente respondeu, X está confirmado — não se pergunta de novo (14/09: quatro vezes).
  const { data: recentesMsgs } = await db.from('messages').select('direction, content')
    .eq('conversation_id', ctx.conversationId)
    .gte('created_at', new Date(Date.now() - 6 * 60 * 60_000).toISOString())
    .order('created_at', { ascending: true }).limit(40);
  const conversaRecente = [...((recentesMsgs ?? []) as Array<{ direction: 'in' | 'out'; content: string | null }>), { direction: 'in' as const, content: ctx.textoDoPaciente ?? '' }];
  for (const item of args.items) {
    const origem = (item.source ?? 'texto') as OrigemDoNome;
    if (origem !== 'texto' && nomeJaConfirmadoPeloPaciente(conversaRecente, item.name)) {
      item.name_verified = true;
      await writeLog('info', 'pharmacy', `Nome "${item.name}" (${origem}): já confirmado pelo paciente nesta conversa → segue sem re-perguntar`, { traceId: ctx.traceId });
      continue;
    }
    const ver = await verificarExistenciaDoRemedio(item.name, ctx.traceId);
    item.name_verified = ver.existe;
    const decisao = decidirVerificacaoDeNome({ origem, existe: ver.existe });
    await writeLog('info', 'pharmacy', `Nome "${item.name}" (${origem}): existe=${ver.existe} via ${ver.fonte} → ${decisao}${ver.exemplos.length ? ` (ex.: ${ver.exemplos[0]})` : ''}`, { traceId: ctx.traceId });
    if (decisao === 'confirmar') {
      const pergunta = perguntaDeConfirmacaoDeNome(itemDisplayName(item.name, item.dosage), origem);
      await sendOutbound(ctx.conversationId, ctx.phoneE164, pergunta, ctx.traceId);
      if (ctx.observation) ctx.observation.note = `NENHUM pedido foi criado: "${item.name}" foi lido de ${origem === 'foto' ? 'uma foto' : 'um áudio'} e NÃO existe em nenhum catálogo de farmácia — provavelmente foi lido errado. A pergunta de confirmação já foi enviada ao paciente; aguarde a resposta. NÃO diga que está cotando.`;
      return;
    }
  }

  // Só avisa que está buscando quando já tem coordenadas
  await sendOutbound(
    ctx.conversationId,
    ctx.phoneE164,
    'Ótimo! Estou buscando farmácias reais próximas a você agora 🔍 Aguarda alguns instantes!',
    ctx.traceId,
  );

  await writeLog('info', 'order', `Criando pedido (fonte da localização: ${locationSource.split(':')[0]})`, {
    traceId: ctx.traceId, lat, lng, items: args.items.map((i) => i.name),
  });

  const { data: order } = await db.from('orders').insert({
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    origin: 'user_text',
    status: 'quoting',
    items: args.items,
    delivery_lat: lat,
    delivery_lng: lng,
    delivery_address: deliveryAddress,
    user_address_id: userAddressId,
    payment_method: args.payment_method ?? null,
  }).select('id').single();

  if (!order?.id) return;
  // Marca o pedido como criado NESTE turno → cancel_order não pode cancelá-lo (HIGH-1).
  ctx.ordersCreatedThisTurn?.add(order.id as string);

  // Loop ReAct: o pedido JÁ nasceu e o paciente JÁ foi avisado da busca. Sem esta nota o
  // modelo re-chamava start_pharmacy_order ou prometia preço que ainda não existe.
  if (ctx.observation) {
    ctx.observation.note = `Pedido ${order.id.slice(0, 8)} criado e busca de farmácias INICIADA (o paciente já foi avisado). As cotações chegam de forma assíncrona — você AINDA NÃO tem preço nenhum. Não invente valores nem prometa prazo.`;
  }
  await startPharmacyDiscovery(order.id, lat, lng, args.items, deliveryAddress, args.payment_method ?? null, ctx, Array.isArray(args.preferred_pharmacy_names) ? args.preferred_pharmacy_names : []);
}

// ─── Seleção v2 de farmácias + substituição dinâmica (análise 12/07) ─────────
// Celular responde 61%, fixo 8% — o Google Places devolve o FIXO do balcão. O diretório
// aprende quem tem WhatsApp (whatsapp_verified_at via ack/resposta; strikes via silêncio)
// e a seleção prioriza quem REALMENTE conversa. Orçamentos controlam custo por pedido.
const PHARMACY_TARGET_SLOTS = Number(process.env['PHARMACY_TARGET_SLOTS'] ?? 5);
const PHARMACY_DETAILS_BUDGET = Number(process.env['PHARMACY_DETAILS_BUDGET'] ?? 12);
const PHARMACY_WAME_BUDGET = Number(process.env['PHARMACY_WAME_BUDGET'] ?? 4);
const PHARMACY_CHAIN_CAP = Number(process.env['PHARMACY_CHAIN_CAP'] ?? 2);
const PHARMACY_TOPUP_CHECK_MS = Number(process.env['PHARMACY_TOPUP_CHECK_MS'] ?? 180_000);
const PHARMACY_MAX_TOPUP = Number(process.env['PHARMACY_MAX_TOPUP'] ?? 2);

interface EnrichedPharmacy {
  place: PlaceResult;
  supplierId: string;
  /** número que será usado no contato (whatsapp_e164 preferido) */
  contact: string;
  tier: 'verificada' | 'celular' | 'fixo';
}

interface PharmacyBackupState {
  candidates: PlaceResult[];
  items: OrderItem[];
  userNeighborhood: string;
  paymentMethod: string | null;
  userConversationId: string;
  userPhoneE164: string;
  traceId: string;
  createdAt: number;
}
// Estado local do processo (single-instance, como o debounce do supplier). Perde no
// deploy → só pula a substituição dos pedidos em voo naquele instante.
const pharmacyBackups = new Map<string, PharmacyBackupState>();

/**
 * Resolve telefone + WhatsApp real de uma candidata e a classifica por probabilidade de
 * conversa. Cache-first: se o supplier já existe com telefone, NÃO gasta Details. Minera
 * wa.me do site quando o telefone do Google é fixo (o celular verdadeiro mora no site).
 * Devolve null quando não há número utilizável (placeholder/serviço/nenhum).
 */
async function enrichPharmacyCandidate(
  pharmacy: PlaceResult,
  opts: { traceId: string; allowDetails: () => boolean; allowWame: () => boolean; onDetails: () => void; onWame: () => void },
): Promise<EnrichedPharmacy | 'budget' | null> {
  // 1) Diretório primeiro (barato + carrega o aprendizado: já verificada?).
  const { data: existing } = await db.from('suppliers')
    .select('id, whatsapp_e164, phone_e164, whatsapp_verified_at')
    .eq('google_place_id', pharmacy.placeId)
    .maybeSingle();

  let phoneE164: string | null = (existing?.phone_e164 as string | null) ?? null;
  let whatsappE164: string | null = (existing?.whatsapp_e164 as string | null) ?? null;
  let website: string | null = null;
  const verifiedAlready = Boolean(existing?.whatsapp_verified_at);

  // 2) Details só quando precisa CHAMAR o Google (mesmo call traz o website de graça):
  //    - sem número nenhum, OU
  //    - número FIXO ainda não verificado (pra minerar o WhatsApp real do site — os ~65
  //      fixos legados do banco eram invisíveis pro mining porque nunca re-chamavam Details).
  const cachedCls = classifyBrPhone(whatsappE164 ?? phoneE164);
  const wantsMining = !verifiedAlready && (cachedCls === 'landline' || cachedCls === 'invalid');
  const needsDetails = (!whatsappE164 && !phoneE164) || (wantsMining && !website);
  if (needsDetails) {
    if (!opts.allowDetails()) return 'budget'; // orçamento estourou — devolve pro backup (não é "sem número")
    opts.onDetails();
    const contact = await getPlaceContact(pharmacy.placeId);
    if (!phoneE164) phoneE164 = toE164BR(contact.phone);
    website = contact.website;
    if (!whatsappE164) whatsappE164 = phoneE164;
  }

  // 3) Telefone fixo/sem número + site → minera o WhatsApp real (wa.me).
  const currentCls = classifyBrPhone(whatsappE164 ?? phoneE164);
  if (!verifiedAlready && (currentCls === 'landline' || currentCls === 'invalid') && website && opts.allowWame()) {
    opts.onWame();
    const html = await fetchWebsiteHtml(website);
    const mined = extractWaMeNumber(html);
    if (mined && !isPlaceholderPhone(mined) && !isServiceNumber(mined)) {
      whatsappE164 = mined;
      await writeLog('info', 'places', `⛏️ WhatsApp minerado do site de ${pharmacy.name}: ${classifyBrPhone(mined)}`, { traceId: opts.traceId });
    }
  }

  // 4) Upsert no diretório (não sobrescreve telefone bom com null).
  const upsertData: Record<string, unknown> = {
    type: 'pharmacy', name: pharmacy.name, google_place_id: pharmacy.placeId,
    address: pharmacy.address, city: pharmacy.city, state: pharmacy.state,
    latitude: pharmacy.lat, longitude: pharmacy.lng, rating: pharmacy.rating,
    reviews: pharmacy.userRatingCount, status: 'active',
  };
  if (phoneE164) upsertData['phone_e164'] = phoneE164;
  if (whatsappE164) upsertData['whatsapp_e164'] = whatsappE164;
  const { data: supplier } = await db.from('suppliers').upsert(upsertData, { onConflict: 'google_place_id' })
    .select('id, whatsapp_e164, phone_e164, whatsapp_verified_at').single();
  if (!supplier?.id) return null;

  const contact = (supplier.whatsapp_e164 as string | null) || (supplier.phone_e164 as string | null);
  if (!contact || isPlaceholderPhone(contact) || isServiceNumber(contact)) return null;

  // Tier = probabilidade de conversa. SÓ sinais POSITIVOS/estruturais (verificada, tipo do
  // número) — sem strikes (review 13/07: strike deduzido de silêncio/ack especulativo
  // envenenaria o diretório; a seleção prioriza sozinha sem punir ninguém).
  const verified = Boolean(supplier.whatsapp_verified_at);
  const tier: EnrichedPharmacy['tier'] = verified ? 'verificada' : classifyBrPhone(contact) === 'mobile' ? 'celular' : 'fixo';
  return { place: pharmacy, supplierId: supplier.id as string, contact, tier };
}

function scheduleTopUpCheck(orderId: string): void {
  setTimeout(() => {
    topUpIfDeadAir(orderId).catch((err) =>
      writeLog('warn', 'places', `top-up check falhou (ignorado): ${String(err).slice(0, 120)}`, { orderId }),
    );
  }, PHARMACY_TOPUP_CHECK_MS);
}

/**
 * TOP-UP ADITIVO (3min apos as aberturas). ADITIVO por design (review 13/07): NUNCA mata
 * nem pune farmacia por silencio — o sinal de "sem WhatsApp" viria de um parser de status
 * do zpro NAO-DOCUMENTADO + 3min e curto demais pra farmacia lenta (respondem em 15-60min).
 * Punir/matar com base nisso envenenaria o diretorio em TODO pedido. Entao aqui so ADICIONA
 * mais farmacias do backup quando o pedido esta em VACUO TOTAL (zero sinal de vida): nenhuma
 * verificada e nenhuma resposta ainda. As originais seguem vivas (os timers de 45min cuidam
 * delas). Verificacao POSITIVA (respondeu em alguma epoca) e carimbada de passagem.
 */
async function topUpIfDeadAir(orderId: string): Promise<void> {
  const info = pharmacyBackups.get(orderId);
  const now = Date.now();
  // Limpeza oportunista de estados velhos (>1h) — o Map nao cresce sem fim.
  for (const [k, v] of pharmacyBackups) if (now - v.createdAt > 60 * 60_000) pharmacyBackups.delete(k);
  if (!info) return;

  const { data: order } = await db.from('orders').select('status').eq('id', orderId).maybeSingle();
  if (!order || order.status !== 'quoting') { pharmacyBackups.delete(orderId); return; }

  // Ja tem PRECO? Entao ha vida — nao precisa top-up (e a consolidacao esta a caminho).
  const { count: quotedCount } = await db.from('quotes')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .in('status', ['quoted']);
  if ((quotedCount ?? 0) > 0) { pharmacyBackups.delete(orderId); return; }

  // Conta SINAIS DE VIDA nas cotacoes vivas: verificada (ack/resposta) OU respondeu agora.
  const { data: quotes } = await db.from('quotes')
    .select('id, conversation_id, supplier_id, suppliers(whatsapp_verified_at)')
    .eq('order_id', orderId)
    .in('status', ['pending', 'contacting', 'negotiating']);
  let live = 0;
  for (const q of quotes ?? []) {
    const sup = q.suppliers as { whatsapp_verified_at?: string | null } | null;
    if (sup?.whatsapp_verified_at) { live++; continue; }
    const { count } = await db.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', q.conversation_id)
      .eq('direction', 'in');
    if ((count ?? 0) > 0) {
      live++;
      void markSupplierVerifiedById(q.supplier_id as string).catch(() => { /* aprendizado */ });
    }
  }

  // Vacuo total (zero vida) + ha backups → ADICIONA ate PHARMACY_MAX_TOPUP. Nao mata ninguem.
  if (live === 0 && info.candidates.length) {
    let added = 0;
    for (let i = 0; i < PHARMACY_MAX_TOPUP; i++) {
      const name = await launchNextBackup(orderId, info);
      if (!name) break;
      added++;
    }
    if (added) {
      await writeLog('info', 'places', `Top-up: pedido em vacuo (0 sinais de vida em 3min) → +${added} farmacia(s) do backup (aditivo, nada removido)`, {
        traceId: info.traceId, orderId,
      });
    }
  }
  pharmacyBackups.delete(orderId);
}

/** Lanca a proxima candidata VIAVEL do backup como cotacao NOVA (aditiva) do pedido. */
async function launchNextBackup(orderId: string, info: PharmacyBackupState): Promise<string | null> {
  let attempts = 0;
  let wame = 0;
  let details = 0;
  while (info.candidates.length && attempts < 5) {
    const candidate = info.candidates.shift()!;
    attempts++;
    // Re-le os JA cotados a cada tentativa (o launch anterior deste mesmo top-up adicionou
    // um) pra nunca duplicar fornecedor/telefone dentro do pedido.
    const { data: existing } = await db.from('quotes')
      .select('supplier_id, suppliers(whatsapp_e164, phone_e164)')
      .eq('order_id', orderId);
    const usedSupplierIds = new Set((existing ?? []).map((q) => q.supplier_id as string));
    const usedPhones = new Set(
      (existing ?? []).map((q) => {
        const s = q.suppliers as { whatsapp_e164?: string | null; phone_e164?: string | null } | null;
        return ((s?.whatsapp_e164 || s?.phone_e164) ?? '').replace(/\D/g, '');
      }).filter(Boolean),
    );
    let enriched: EnrichedPharmacy | 'budget' | null = null;
    try {
      enriched = await enrichPharmacyCandidate(candidate, {
        traceId: info.traceId,
        allowDetails: () => details < 3,
        allowWame: () => wame < 1,
        onDetails: () => { details++; },
        onWame: () => { wame++; },
      });
    } catch { /* tenta a proxima */ }
    if (!enriched || enriched === 'budget') continue;
    if (usedSupplierIds.has(enriched.supplierId) || usedPhones.has(enriched.contact.replace(/\D/g, ''))) continue;
    const { data: quote } = await db.from('quotes').insert({
      order_id: orderId,
      supplier_id: enriched.supplierId,
      status: 'pending',
      distance_km: enriched.place.distanceKm,
    }).select('id').single();
    if (!quote?.id) continue;
    await db.from('suppliers').update({ last_contacted_at: new Date().toISOString() }).eq('id', enriched.supplierId);
    setImmediate(() => {
      initiatePharmacyNegotiation(
        quote.id as string, orderId, info.items, info.userNeighborhood, info.paymentMethod,
        info.userConversationId, info.userPhoneE164, info.traceId,
      ).catch((err) => writeLog('error', 'places', `Top-up: negociacao falhou: ${String(err).slice(0, 120)}`, { traceId: info.traceId }));
    });
    return enriched.place.name;
  }
  return null;
}


async function startPharmacyDiscovery(
  orderId: string,
  lat: number,
  lng: number,
  items: OrderItem[],
  deliveryAddress: string | null,
  paymentMethod: string | null,
  ctx: ToolContext,
  preferredNames: string[] = [],
) {
  await writeLog('info', 'places', `Buscando farmácias via Google Places (raio 3km)`, {
    traceId: ctx.traceId, orderId, lat, lng,
  });

  // CEP pra cotar nas grandes redes (plataformas VTEX): do endereço de entrega e, se não
  // vier ali, um reverse-geocode leve pelas coordenadas. Sem CEP, a simulação por região
  // não roda (fica só o WhatsApp das farmácias de bairro).
  let userCep = extractCep(deliveryAddress);
  if (!userCep) {
    try {
      const rg = await reverseGeocodeNominatim(lat, lng, 4000); // fallback curto — não segura o discovery
      userCep = extractCep(rg?.postcode ?? null);
    } catch { /* segue sem CEP */ }
  }

  let pharmacies: Awaited<ReturnType<typeof findNearbyPharmacies>> = [];
  let apiError = '';

  try {
    pharmacies = await findNearbyPharmacies(lat, lng, 3000);
    if (pharmacies.length < 3) {
      await writeLog('info', 'places', `Poucos resultados (${pharmacies.length}) com raio 3km, expandindo para 5km`, { traceId: ctx.traceId });
      pharmacies = await findNearbyPharmacies(lat, lng, 5000);
    }
    await writeLog('info', 'places', `Google Places retornou ${pharmacies.length} farmácias`, {
      traceId: ctx.traceId,
      farmácias: pharmacies.slice(0, 5).map((p) => ({
        nome: p.name,
        endereco: p.address,
        distancia: `${p.distanceKm?.toFixed(2)}km`,
        avaliacao: p.rating,
      })),
    });
  } catch (err) {
    apiError = String(err);
    await writeLog('error', 'places', `Erro na API Google Places: ${apiError}`, { traceId: ctx.traceId });
  }

  if (pharmacies.length === 0) {
    await writeLog('warn', 'places', 'Nenhuma farmácia encontrada via Google Places', { traceId: ctx.traceId, apiError });
    await sendOutbound(
      ctx.conversationId,
      ctx.phoneE164,
      'Não encontrei farmácias próximas à sua localização via Google Maps. Verifique se a API do Google Places está habilitada no console GCP.',
      ctx.traceId,
    );
    await db.from('orders').update({ status: 'failed' }).eq('id', orderId);
    return;
  }

  // Fix #6: redes grandes (Drogasil/Raia/Pague Menos…) quase só mandam auto-resposta
  // e nunca engajam um humano no WhatsApp; independentes conversam de verdade. Então
  // priorizamos INDEPENDENTES (por distância), deixando as redes pro fim. Fallback
  // garantido: se sobrarem <5 independentes, as redes preenchem o resto (o concat
  // nunca deixa de contatar — só REORDENA). A ordem do Google (prominência) favorecia
  // redes; aqui trocamos por relevância real de engajamento + proximidade.
  const byDist = (a: (typeof pharmacies)[number], b: (typeof pharmacies)[number]) =>
    (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  // PONTO 5 (incidente Vadivino: pediu Drogasil/Pacheco e foram ignoradas): farmácia que o
  // usuário NOMEOU entra no topo, IGNORANDO a despriorização de rede — se ele pediu, contata.
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const preferredNorm = preferredNames.map((n) => norm(n).trim()).filter((n) => n.length >= 3);
  const isPreferred = (p: { name: string }) => preferredNorm.some((n) => norm(p.name).includes(n));
  const preferred = preferredNorm.length ? pharmacies.filter(isPreferred).sort(byDist) : [];
  const rest = pharmacies.filter((p) => !preferred.includes(p));
  // SELEÇÃO v2 (análise 12/07: celular responde 61%, fixo 8% — o Google dá o FIXO do balcão):
  // abertas (open_now) antes das fechadas em cada grupo (o Google nos DIZ quem está aberta
  // e isso era ignorado — pedido noturno contatou 15 fechadas); redes com CAP além de
  // despriorizadas (fixo de loja de rede é quase sempre void — nunca mais 15 Drogasil).
  const openTier = (arr: typeof pharmacies) => [...arr.filter((p) => p.isOpen !== false), ...arr.filter((p) => p.isOpen === false)];
  const independentes = openTier(rest.filter((p) => !isPharmacyChain(p.name)).sort(byDist));
  const redes = openTier(rest.filter((p) => isPharmacyChain(p.name)).sort(byDist));
  const rankedAll = [...preferred, ...independentes, ...redes.slice(0, PHARMACY_CHAIN_CAP)];
  await writeLog('info', 'places', `Seleção v2: ${independentes.length} independente(s), ${Math.min(redes.length, PHARMACY_CHAIN_CAP)}/${redes.length} rede(s) (cap ${PHARMACY_CHAIN_CAP})`, {
    traceId: ctx.traceId, orderId,
    candidatas: rankedAll.slice(0, 10).map((p) => `${p.name}${isPharmacyChain(p.name) ? ' [rede]' : ''}${p.isOpen === false ? ' [fechada]' : ''}`),
  });

  const quoteIds: string[] = [];
  let semTelefone = 0;
  // Enriquece candidato a candidato até ter 5 VÁLIDAS (não 5 brutas): telefone real via
  // Details (+ website no MESMO call/custo) e, quando o telefone é fixo, minera o WhatsApp
  // verdadeiro do site (wa.me). Orçamentos limitam custo/latência por pedido.
  let detailsCalls = 0;
  let wameCalls = 0;
  const usedPhones = new Set<string>();
  const preferredPool: EnrichedPharmacy[] = []; // NOMEADA pelo usuário — SEMPRE no time (nunca cortada)
  const slotPool: EnrichedPharmacy[] = [];      // verificada/celular — contata primeiro
  const fixoPool: EnrichedPharmacy[] = [];      // fixo desconhecido — completa se faltar
  const backupCandidates: PlaceResult[] = [];   // sobras → top-up (3min, aditivo)
  const preferredSet = new Set(preferred);

  let redesPuladas = 0;
  for (const pharmacy of rankedAll) {
    const isPref = preferredSet.has(pharmacy);
    // Rede grande com catálogo público NÃO recebe WhatsApp: a Xarlote lê o preço dela por
    // API em 1 segundo, enquanto o balconista de uma Drogasil nunca responde a um número
    // desconhecido (aconteceu em 05/08 e 26/08 — "Initiating negotiation with Drogasil").
    // Gastar um dos 5 slots com ela é tirar o slot de uma farmácia que responderia.
    // EXCEÇÃO: se o usuário pediu a rede PELO NOME, respeitamos — ignorar o pedido dele
    // em silêncio é pior do que uma cotação que não volta.
    if (!isPref && isPharmacyChain(pharmacy.name)) {
      redesPuladas++;
      continue;
    }
    // Para de considerar quando o time (não-preferido) já encheu — MAS preferidas seguem
    // sempre (o usuário pediu por nome). Cache-hit não gasta Details, então NÃO paramos por
    // budget: o enrich devolve 'budget' quando PRECISARIA chamar o Google e não pode.
    if (!isPref && slotPool.length + fixoPool.length >= PHARMACY_TARGET_SLOTS + 3) {
      backupCandidates.push(pharmacy);
      continue;
    }
    let enriched: EnrichedPharmacy | 'budget' | null = null;
    try {
      enriched = await enrichPharmacyCandidate(pharmacy, {
        traceId: ctx.traceId,
        allowDetails: () => detailsCalls < PHARMACY_DETAILS_BUDGET,
        allowWame: () => wameCalls < PHARMACY_WAME_BUDGET,
        onDetails: () => { detailsCalls++; },
        onWame: () => { wameCalls++; },
      });
    } catch (err) {
      await writeLog('warn', 'places', `Falha ao enriquecer ${pharmacy.name}: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
    }
    if (enriched === 'budget') { backupCandidates.push(pharmacy); continue; } // orçamento — pro backup, não é "sem número"
    if (!enriched) { semTelefone++; continue; }
    const phoneKey = enriched.contact.replace(/\D/g, '');
    if (usedPhones.has(phoneKey)) continue; // mesmo número em 2 entradas = 1 contato só
    usedPhones.add(phoneKey);
    if (isPref) preferredPool.push(enriched);
    else if (enriched.tier === 'verificada' || enriched.tier === 'celular') slotPool.push(enriched);
    else fixoPool.push(enriched);
  }

  // Time final: NOMEADAS sempre (mesmo fixas — o usuário pediu), depois verificadas/
  // celulares, fixos completam. Cap = max(TARGET, nº de preferidas) pra nunca cortar nomeada.
  const cap = Math.max(PHARMACY_TARGET_SLOTS, preferredPool.length);
  const finalTeam = [...preferredPool, ...slotPool, ...fixoPool].slice(0, cap);
  // Enriquecidas que sobraram viram backup de 1ª linha (telefone já resolvido no diretório).
  for (const left of [...slotPool, ...fixoPool].slice(Math.max(0, cap - preferredPool.length))) {
    if (!finalTeam.includes(left)) backupCandidates.push(left.place);
  }
  await writeLog('info', 'places', `Time final (${finalTeam.length}): ${finalTeam.map((e) => `${e.place.name} [${e.tier}]`).join(' · ') || 'nenhuma'} — ${detailsCalls} Details, ${wameCalls} site(s) minerado(s), ${backupCandidates.length} backup(s)${redesPuladas ? `, ${redesPuladas} rede(s) grande(s) deixada(s) pro catálogo` : ''}`, {
    traceId: ctx.traceId, orderId,
  });

  for (const e of finalTeam) {
    const { data: quote } = await db.from('quotes').insert({
      order_id: orderId,
      supplier_id: e.supplierId,
      status: 'pending',
      distance_km: e.place.distanceKm,
    }).select('id').single();
    if (quote?.id) {
      quoteIds.push(quote.id);
      await db.from('suppliers').update({ last_contacted_at: new Date().toISOString() }).eq('id', e.supplierId);
    }
  }

  if (semTelefone > 0) {
    await writeLog('warn', 'places', `${semTelefone} farmácia(s) sem telefone no Places — NÃO contatadas (nunca fabricar número)`, { traceId: ctx.traceId, orderId });
  }

  // Nenhuma farmácia de bairro com WhatsApp → antes de desistir, tenta as GRANDES REDES
  // (o buraco clássico: região só com Drogasil/Pacheco/etc., que não atendem WhatsApp mas
  // têm vitrine online pública). Se cotou, apresenta e NÃO falha o pedido.
  if (quoteIds.length === 0) {
    if (userCep) {
      const pres = await presentPlatformQuotes({
        orderId, items, cep: userCep,
        conversationId: ctx.conversationId, phoneE164: ctx.phoneE164, traceId: ctx.traceId,
        soleChannel: true,
      }).catch(async (err) => {
        await writeLog('warn', 'platform', `Falha apresentando plataformas (canal único): ${String(err).slice(0, 140)}`, { traceId: ctx.traceId, orderId });
        return { networksPresented: 0, itemsCovered: 0 };
      });
      if (pres.networksPresented > 0) {
        // Handoff de plataforma: entregamos os links das grandes redes; não há negociação nem
        // fechamento pela Xarlote. Marca 'handed_off' + summary com o prefixo PLATFORM_HANDOFF
        // (o get_order_status distingue por ele). NÃO usar 'quoted' — dispararia o nudge "as
        // farmácias te esperam, quer fechar/cancelar?" pra um handoff sem o que fechar (review M2).
        await db.from('orders').update({
          status: 'handed_off',
          summary: `${PLATFORM_HANDOFF_SUMMARY} — ${pres.networksPresented} opção(ões) de rede enviada(s) com link pra finalizar direto no site.`,
        }).eq('id', orderId);
        await writeLog('info', 'order', `Sem farmácia de bairro com WhatsApp — ${pres.networksPresented} rede(s) apresentada(s) (handoff)`, { traceId: ctx.traceId, orderId });
        return;
      }
    }
    await writeLog('warn', 'order', `Nenhuma farmácia com telefone/WhatsApp encontrada — pedido não pôde ser cotado`, { traceId: ctx.traceId, orderId, semTelefone });
    await sendOutbound(
      ctx.conversationId,
      ctx.phoneE164,
      'Achei farmácias aqui na sua região, mas nenhuma com WhatsApp disponível pra eu cotar agora 😕 Assim que eu tiver contatos de farmácias por aqui eu te aviso. Posso te ajudar em outra coisa?',
      ctx.traceId,
    );
    await db.from('orders').update({ status: 'failed' }).eq('id', orderId);
    return;
  }

  await writeLog('info', 'order', `${quoteIds.length} cotações criadas para o pedido — iniciando negociações`, {
    traceId: ctx.traceId, orderId,
    farmácias: finalTeam.map((e, i) => `${i + 1}. ${e.place.name} [${e.tier}] (${e.place.distanceKm?.toFixed(2)}km)`),
  });

  // ─── A REDE VEM PRIMEIRO ────────────────────────────────────────────────────
  // Medição de 01/09/2026 sobre 240 cotações reais: a farmácia de bairro deu preço em
  // 6,7% das vezes (197 `timeout`, 27 "não tenho"). A cotação por catálogo volta em ~2s
  // com preço, frete e prazo, e em Goiânia três redes entregam em 60 min. Anunciar
  // "já entrei em contato, te aviso" ANTES disso é prometer espera quando a resposta
  // já está pronta — e era essa promessa que ficava sem cumprir.
  //
  // O `await` é deliberado: são ~2s, e a ORDEM das duas mensagens é o produto. As
  // negociações do bairro só saem depois daqui, então o custo é 2s no pior caso.
  let redesApresentadas = 0;
  if (userCep) {
    const pres = await presentPlatformQuotes({
      orderId, items, cep: userCep,
      conversationId: ctx.conversationId, phoneE164: ctx.phoneE164, traceId: ctx.traceId,
      soleChannel: false,
    }).catch(async (err) => {
      await writeLog('warn', 'platform', `Falha apresentando plataformas (primeiro canal): ${String(err).slice(0, 140)}`, { traceId: ctx.traceId, orderId });
      return { networksPresented: 0, itemsCovered: 0 };
    });
    redesApresentadas = pres.networksPresented;
  }

  // ─── E O BAIRRO COMO COMPLEMENTO ────────────────────────────────────────────
  // HONESTIDADE NOTURNA: se a maioria das escolhidas está fechada agora (open_now),
  // avisa que a resposta vem quando abrirem (senão ele fica esperando resposta de loja
  // fechada, caso Glauber 22h). Quando a rede JÁ resolveu, a loja fechada deixa de ser
  // má notícia — a pessoa não está mais dependendo dela.
  const openKnown = finalTeam.filter((e) => e.place.isOpen !== undefined);
  const allClosed = openKnown.length >= 3 && openKnown.every((e) => e.place.isOpen === false);
  const nightNote = allClosed
    ? (redesApresentadas > 0
        ? ' (esse horário a maioria do bairro já fechou, então elas devem responder cedinho)'
        : ' Ah, esse horário a maioria já tá fechada — deixei a mensagem lá e assim que abrirem elas costumam responder cedinho, tá?')
    : '';
  const plural = quoteIds.length > 1;
  const textoBairro = redesApresentadas > 0
    ? `Também tô cotando em ${quoteIds.length} farmácia${plural ? 's' : ''} do seu bairro — se sair mais em conta que isso aí de cima, eu te aviso na hora 😊${nightNote}`
    : `Achei ${quoteIds.length} farmácia${plural ? 's' : ''} aqui na sua região e já entrei em contato com ${plural ? 'elas' : 'ela'} ✨ assim que chegarem as respostas eu te aviso na hora.${nightNote}`;
  await sendOutbound(ctx.conversationId, ctx.phoneE164, textoBairro, ctx.traceId);

  // Setor/bairro real do usuário pra passar pra farmácia (não a cidade da farmácia em si).
  const userNeighborhood =
    extractDeliverySector(deliveryAddress) ||
    (finalTeam[0]?.place.city ? `${finalTeam[0].place.city}` : `lat ${lat.toFixed(4)}, lng ${lng.toFixed(4)}`);

  // Guarda os backups pra TOP-UP ADITIVO: se em ~3min o pedido estiver em VÁCUO TOTAL
  // (zero sinal de vida), adiciona mais farmácias do backup — sem NUNCA matar nem punir
  // as originais (elas podem responder em 15-60min). Estado local (single-instance, como o
  // debounce; deploy no meio só pula o top-up daquele pedido).
  pharmacyBackups.set(orderId, {
    candidates: backupCandidates,
    items,
    userNeighborhood,
    paymentMethod,
    userConversationId: ctx.conversationId,
    userPhoneE164: ctx.phoneE164,
    traceId: ctx.traceId,
    createdAt: Date.now(),
  });
  scheduleTopUpCheck(orderId);

  // Initiate negotiations staggered by 2s each to avoid hammering the LLM
  for (let i = 0; i < quoteIds.length; i++) {
    const quoteId = quoteIds[i] as string;
    const delay = i * 2000;
    setTimeout(() => {
      initiatePharmacyNegotiation(
        quoteId,
        orderId,
        items,
        userNeighborhood,
        paymentMethod,
        ctx.conversationId,
        ctx.phoneE164,
        ctx.traceId,
      ).catch(console.error);
    }, delay);
  }

  // Schedule a 10-minute hard timeout — pharmacies that don't respond by then
  // get marked as `timeout` and we consolidate with whatever quotes we have.
  scheduleQuoteTimeout(orderId, ctx.conversationId, ctx.phoneE164, ctx.traceId);
}

async function handleGetOrderStatus(ctx: ToolContext) {
  // Pega o pedido MAIS RECENTE do usuário nas últimas 24h — INCLUI 'failed' (guarda
  // anti-alucinação, incidente 07/07): antes 'failed' ficava de fora e a Xarlote pegava
  // um pedido 'handed_off' ANTIGO e dizia "seu pedido já foi confirmado" pra um pedido que
  // na verdade FALHOU hoje. A janela de 24h evita reportar um pedido velho.
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: order } = await db
    .from('orders')
    .select('id, status')
    .eq('user_id', ctx.userId)
    .in('status', ['quoting', 'quoted', 'confirming', 'handed_off', 'failed'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!order) {
    await sendOutbound(
      ctx.conversationId,
      ctx.phoneE164,
      'No momento não tem nenhum pedido em andamento aqui 💙 É só me falar o medicamento e o endereço que eu cuido pra você.',
      ctx.traceId,
    );
    if (ctx.observation) ctx.observation.note = 'NÃO existe pedido ativo nas últimas 24h. Você já avisou o paciente e se ofereceu pra começar um.';
    return;
  }

  // Pedido que FALHOU: seja honesta (nunca "confirmado"). O mini-relatório detalhado já
  // saiu na consolidação; aqui ofereço os caminhos de retomada (re-engajar / ampliar).
  if (order.status === 'failed') {
    await sendOutbound(
      ctx.conversationId,
      ctx.phoneE164,
      'Esse pedido não fechou — nenhuma farmácia deu certo dessa vez 😔 Quer que eu volte em alguma que respondeu ou procure num raio maior?',
      ctx.traceId,
    );
    if (ctx.observation) ctx.observation.note = 'O pedido mais recente FALHOU (nenhuma farmácia fechou). Você já foi honesta com o paciente e ofereceu re-engajar ou ampliar o raio. NUNCA diga que ele está confirmado.';
    return;
  }

  await sendCurrentOrderStatus(order.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
  // Loop ReAct: o status real vai pro MODELO, não só pro paciente. Sem isto ela "consultava"
  // o pedido e continuava chutando o estado dele na frase seguinte.
  if (ctx.observation) {
    ctx.observation.note = `Pedido ${order.id.slice(0, 8)} está em "${order.status}". O status detalhado JÁ foi enviado ao paciente — não repita, apenas complemente se tiver algo novo.`;
  }
}

/**
 * AMPLIA a busca de um pedido ativo (incidente Cefaliv 06/07 — o usuário pediu pra
 * buscar mais longe e a Xarlote não sabia). Re-descobre farmácias num raio MAIOR,
 * EXCLUI as já contatadas neste pedido (por google_place_id) e contata só as NOVAS,
 * adicionando ao mesmo pedido. Reabre o pedido pra 'quoting' (modo eager) pra as novas
 * cotações serem apresentadas conforme chegam.
 */
async function handleExpandPharmacySearch(ctx: ToolContext) {
  // UMA VOZ (incidente Vadivino: saiu "Ampliei a busca!" + "Vou ampliar a busca" no mesmo
  // turno). Este handler é auto-contido → suprime o texto do LLM (senão contradiz/duplica).
  const say = async (text: string) => {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, text, ctx.traceId);
    if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
  };
  if (!loadPrompts().pharmacy_outbound_enabled) {
    await say('O disparo pra farmácias está pausado no momento 💙 Já já volto a buscar pra você.');
    return;
  }
  const { data: order } = await db
    .from('orders')
    .select('id, status, delivery_lat, delivery_lng, delivery_address, items, payment_method')
    .eq('user_id', ctx.userId)
    .in('status', ['quoting', 'quoted', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!order?.id || order.delivery_lat == null || order.delivery_lng == null) {
    await say('Não achei um pedido ativo pra ampliar a busca 💙 Me fala o medicamento e o endereço que eu começo uma busca nova.');
    return;
  }
  const lat = Number(order.delivery_lat);
  const lng = Number(order.delivery_lng);

  // Farmácias JÁ contatadas neste pedido — nunca repetir. Exclui por place_id E por
  // telefone (review L1: fornecedor de indicação não tem place_id; e a mesma loja pode
  // aparecer com place_ids diferentes no Google).
  const { data: existing } = await db.from('quotes').select('suppliers(google_place_id, whatsapp_e164, phone_e164)').eq('order_id', order.id);
  const contacted = new Set(
    (existing ?? []).map((q) => (q.suppliers as { google_place_id?: string } | null)?.google_place_id).filter(Boolean),
  );
  const contactedPhones = new Set(
    (existing ?? [])
      .flatMap((q) => { const s = q.suppliers as { whatsapp_e164?: string; phone_e164?: string } | null; return [s?.whatsapp_e164, s?.phone_e164]; })
      .filter((p): p is string => !!p).map((p) => p.replace(/\D/g, '')),
  );

  // Raio MAIOR (10km).
  let pharmacies: Awaited<ReturnType<typeof findNearbyPharmacies>> = [];
  try {
    pharmacies = await findNearbyPharmacies(lat, lng, 10000);
  } catch (err) {
    await writeLog('error', 'places', `expand: Google Places falhou: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId, orderId: order.id });
  }
  const novas = pharmacies.filter((p) => !contacted.has(p.placeId));
  const byDist = (a: (typeof novas)[number], b: (typeof novas)[number]) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  const top = [
    ...novas.filter((p) => !isPharmacyChain(p.name)).sort(byDist),
    ...novas.filter((p) => isPharmacyChain(p.name)).sort(byDist),
  ].slice(0, 5);

  if (top.length === 0) {
    await say('Procurei num raio maior mas não achei farmácias NOVAS além das que já falei por aqui 😕 Se quiser, me manda outro endereço que eu busco numa região diferente.');
    return;
  }

  // Reabre o pedido pra 'quoting'. created_at=now reinicia o relógio do rescue-worker
  // (review H1: senão o rescue de 45min mataria o pedido reaberto na hora, já que
  // created_at é imutável e o pedido é antigo). status_5min_done=false (review M1: NÃO
  // eager — deixa os 3/5min juntarem um LOTE das novas, senão a 1ª que responder mata as outras).
  await db.from('orders').update({ status: 'quoting', status_5min_done: false, created_at: new Date().toISOString() }).eq('id', order.id);

  const items = (order.items ?? []) as OrderItem[];
  const userNeighborhood = extractDeliverySector((order.delivery_address as string | null) ?? null) || `lat ${lat.toFixed(4)}, lng ${lng.toFixed(4)}`;
  const quoteIds: string[] = [];
  for (const pharmacy of top) {
    let phoneE164: string | null = null;
    try { phoneE164 = toE164BR(await getPlacePhone(pharmacy.placeId)); } catch { /* sem telefone → pula */ }
    // Dedup por telefone (review L1): a mesma loja pode reaparecer com place_id diferente
    // ou já ter sido contatada por indicação (sem place_id).
    if (phoneE164 && contactedPhones.has(phoneE164.replace(/\D/g, ''))) continue;
    const upsertData: Record<string, unknown> = {
      type: 'pharmacy', name: pharmacy.name, google_place_id: pharmacy.placeId,
      address: pharmacy.address, city: pharmacy.city, state: pharmacy.state,
      latitude: pharmacy.lat, longitude: pharmacy.lng, rating: pharmacy.rating,
      reviews: pharmacy.userRatingCount, status: 'active',
    };
    if (phoneE164) { upsertData['phone_e164'] = phoneE164; upsertData['whatsapp_e164'] = phoneE164; }
    const { data: supplier } = await db.from('suppliers').upsert(upsertData, { onConflict: 'google_place_id' }).select('id, whatsapp_e164, phone_e164').single();
    if (!supplier?.id) continue;
    const reachable = supplier.whatsapp_e164 || supplier.phone_e164;
    if (!reachable || isPlaceholderPhone(reachable) || isServiceNumber(reachable)) continue;
    const { data: quote } = await db.from('quotes').insert({ order_id: order.id, supplier_id: supplier.id, status: 'pending', distance_km: pharmacy.distanceKm }).select('id').single();
    if (quote?.id) quoteIds.push(quote.id);
  }

  if (quoteIds.length === 0) {
    await say('Achei farmácias novas mais longe, mas nenhuma com WhatsApp pra eu cotar agora 😕');
    return;
  }

  await writeLog('info', 'order', `Busca ampliada: +${quoteIds.length} farmácias novas (raio 10km)`, { traceId: ctx.traceId, orderId: order.id });
  await say(`Ampliei a busca! 🔎 Contatei mais ${quoteIds.length} farmácia${quoteIds.length > 1 ? 's' : ''} nova${quoteIds.length > 1 ? 's' : ''} num raio maior. Assim que responderem, te aviso na hora 💙`);

  for (let i = 0; i < quoteIds.length; i++) {
    const quoteId = quoteIds[i] as string;
    setTimeout(() => {
      initiatePharmacyNegotiation(quoteId, order.id, items, userNeighborhood, (order.payment_method as string | null) ?? null, ctx.conversationId, ctx.phoneE164, ctx.traceId).catch(console.error);
    }, i * 2000);
  }
  scheduleQuoteTimeout(order.id, ctx.conversationId, ctx.phoneE164, ctx.traceId, true); // force: re-arma os timers do lote novo
}

/**
 * RE-ENGAJAMENTO DIRIGIDO (pedido do fundador — incidente São Benedito 07/07): manda uma
 * mensagem PERSONALIZADA a UMA farmácia específica de um pedido ativo OU recente (mesmo
 * 'failed'), retomando a conversa dentro da janela de 24h. Ex.: a São Benedito tinha o
 * Cefaliv e ofereceu despachar por Uber → o usuário pede "fala que topo o Uber" → aqui a
 * Xarlote volta na conversa daquela farmácia, manda o recado e reabre a negociação.
 *
 * Fecha os gaps do incidente: a Xarlote não sabia "voltar" numa farmácia; o pedido 'failed'
 * nem aparecia como ativo; e a conversa da farmácia seguia viva (dentro das 24h).
 */
async function handleMessageSupplier(args: { supplier_hint?: string; message?: string }, ctx: ToolContext) {
  // Toda resposta deste handler é AUTO-CONTIDA → suprime o texto do LLM do turno
  // (uma voz só; senão sai "Não tenho certeza…" + "Deixa eu mandar mensagem 💙" juntos).
  // `dedup:true` SÓ nos galhos de ERRO ENLATADO ("ainda não respondeu", "não achei pedido"):
  // se o usuário INSISTE (o Arthur mandou 2× em 50s), a LLM re-chama a tool e sairia texto
  // IDÊNTICO de novo — a "bugada" que ele viu. Janela 180s (maior que os 12s conversacionais)
  // porque a repetição vem de insistência humana. NÃO dedupa os `say()` de SUCESSO/re-cobra
  // (default): lá um side-effect REAL aconteceu (mandei à farmácia) e dois follow-ups distintos
  // podem gerar a MESMA confirmação — suprimir deixaria o paciente no escuro (review Leva 1 #3).
  // ⚠️ Só cala o texto do LLM se a mensagem REALMENTE saiu. Quando o dedup engole (o
  // paciente insistiu e o enlatado é idêntico), suprimir deixava o turno MUDO — e o turno
  // mudo destrava o narrador de follow-up, que INVENTAVA a ação ("Falei com as 5 redes",
  // incidente Vadivino 17/07). Engolida → deixa o LLM falar: uma voz é melhor que nenhuma.
  const say = async (text: string, opts: { dedup?: boolean } = {}) => {
    const sent = await sendOutbound(ctx.conversationId, ctx.phoneE164, text, ctx.traceId, {}, opts.dedup ? { dedup: true, dedupWindowMs: 180_000 } : {});
    if (sent && ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
    return sent;
  };
  // Kill-switch de disparo (a msg vai pra uma farmácia) — freio de emergência.
  if (!loadPrompts().pharmacy_outbound_enabled) {
    await say('O contato com farmácias está pausado no momento 💙 Já já volto a falar com elas pra você.', { dedup: true });
    return;
  }
  const hint = (args.supplier_hint ?? '').trim();
  const message = (args.message ?? '').trim();
  if (!message) {
    await say('Me diz o que você quer que eu fale pra farmácia que eu mando na hora 💙', { dedup: true });
    return;
  }

  const state = await loadLatestOrderState(ctx.userId);
  if (!state || !state.suppliers.length) {
    await say('Não achei um pedido recente com farmácias pra eu falar 💙 Se quiser, me fala o remédio e o endereço que eu começo uma busca nova.', { dedup: true });
    return;
  }

  let target = resolveTargetSupplier(state, hint);
  // Pedido FECHADO + dica que não resolveu ("a farmácia", "eles") → a ESCOLHIDA é a única
  // conversa que importa; mira nela (sem negação no hint — negação nunca vira envio).
  if (!target && ['confirming', 'handed_off'].includes(state.status) && state.selectedQuoteId
      && !/\b(n[ãa]o|nunca|nem|menos|exceto)\b/i.test(hint)) {
    target = state.suppliers.find((s) => s.quoteId === state.selectedQuoteId) ?? null;
  }

  // 🧭 DISCERNIMENTO NOME→CANAL (diretriz do fundador, incidente Arthur 16/07): se o usuário
  // NOMEIA uma GRANDE REDE (Drogasil, Pacheco, Nissei…), ela NÃO se cota por WhatsApp — tem
  // vitrine online (scraper/REST). Cota direto no site em vez de mandar WhatsApp pra uma loja
  // física que não atende (o que gerou o "faz 24h" falso). Farmácia de BAIRRO (fora do registry)
  // segue no WhatsApp normal. Guardas contra desvio errado:
  //   • EXCLUSÃO: "menos a Ultrafarma", "exceto a Pacheco" — o usuário está TIRANDO a rede, não
  //     pedindo. (NÃO barra "não dá pra cotar na Drogasil?" — "não" aqui é pedido positivo.)
  //   • FALSO-POSITIVO de bairro: "Farmácia São João da Vila" (loja local) casa o alias "são joão"
  //     da REDE. Só desvia pro scraper quando NÃO há alvo de bairro, OU o alvo é RECONHECIDAMENTE
  //     uma rede (isPharmacyChain) E está morto (não respondeu E fora da janela). Loja de bairro
  //     (isPharmacyChain=false) OU reengajável (respondeu/janela aberta) → respeita o WhatsApp.
  const excluded = /\b(menos|exceto|tirando|fora a|afora|sem ser)\b/i.test(hint);
  const namedNet = excluded ? null : matchPlatformNetworkByName(hint);
  if (namedNet && (!target || (isPharmacyChain(target.supplierName) && !target.responded && !target.contactableFreeText))) {
    const itensTxt = state.items.map((it) => itemDisplayName(it.name, it.dosage)).filter(Boolean).join(', ') || 'seu remédio';
    // CEP: do endereço e, se não vier (pedido por PIN), reverse-geocode das coords (espelha o
    // startPharmacyDiscovery — senão o usuário que mandou PIN fica preso num "me manda o CEP" que
    // a tool nem sabe receber; review Leva 2 #2).
    let cep = extractCep(state.deliveryAddress);
    if (!cep && state.deliveryLat != null && state.deliveryLng != null) {
      try {
        const rg = await reverseGeocodeNominatim(state.deliveryLat, state.deliveryLng, 4000);
        cep = extractCep(rg?.postcode ?? null);
      } catch { /* segue sem CEP */ }
    }
    if (!cep) {
      await say(`Pra cotar direto na ${namedNet.label} eu preciso do seu CEP 💙 Me manda que já busco lá pra você.`, { dedup: true });
      return;
    }
    const pres = await presentPlatformQuotes({
      orderId: state.orderId, items: state.items, cep,
      conversationId: ctx.conversationId, phoneE164: ctx.phoneE164, traceId: ctx.traceId,
      networkIds: [namedNet.id],
      introText: `Cotei ${state.items.length > 1 ? 'os itens' : itensTxt} direto na ${namedNet.label} pra você — é só tocar e finalizar o pagamento no site 👇\n\n`,
      outroText: '\n\nSe quiser que eu veja em mais alguma rede ou em farmácias perto de você, é só falar 💙',
    }).catch(async (err) => {
      await writeLog('warn', 'platform', `Cotação por nome (${namedNet.label}) falhou: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId, orderId: state.orderId });
      return { networksPresented: 0, itemsCovered: 0 };
    });
    if (pres.networksPresented > 0) {
      // presentPlatformQuotes já falou com o paciente → o texto do LLM seria 2ª voz.
      if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
    } else {
      // Nada apresentado: quem cala o turno é o próprio `say` — e SÓ se a mensagem sair.
      // Suprimir aqui de forma incondicional deixaria o turno mudo quando o dedup engolisse
      // (paciente insistindo), reabrindo a porta do narrador inventar (review).
      await say(`Procurei ${itensTxt} na ${namedNet.label} agora e não achei disponível no site dela 😕 Quer que eu veja em outras redes ou em farmácias perto de você?`, { dedup: true });
    }
    return;
  }

  if (!target) {
    if (hint) {
      // O usuário NOMEOU uma farmácia/rede que não está no pedido NEM no registro de redes que
      // eu coto (ex.: "Drogamaris"). Honestidade: não fingir que "não entendi" (incidente Vadivino
      // 21/07: "tenta na Drogamarys" → "não sei qual você quer") — dizer que não a cubro e oferecer
      // o que dá. `hint` já é o que ele digitou, então ecoa o nome dele.
      await say(`Não consegui cotar na ${hint} 😕 não tenho ela no meu sistema. Mas posso ver nas grandes redes que eu cubro (Drogasil, Pacheco, Raia, Pague Menos, Ultrafarma…) ou em farmácias perto de você. O que você prefere?`, { dedup: true });
    } else {
      const nomes = state.suppliers.map((s) => s.supplierName).slice(0, 6).join(', ');
      await say(`Não tenho certeza de qual farmácia você quer que eu fale 🤔 As do seu pedido são: ${nomes}. Me diz o nome que eu mando na hora.`, { dedup: true });
    }
    return;
  }

  if (!target.conversationId || !target.phoneE164 || isPlaceholderPhone(target.phoneE164)) {
    await say(`Não tenho um WhatsApp válido da ${target.supplierName} pra falar direto com ela 😕 Quer que eu procure em outras farmácias?`, { dedup: true });
    return;
  }

  // 🧠 ESTADO ANTES DE FALAR (caso Ludmila, 10/09): a Xarlote perguntou o frete à Coimbra três
  // vezes — a farmácia já tinha respondido "5 reais de frete". Se a cotação JÁ responde o que a
  // mensagem pergunta, a mensagem não sai: o fato volta pro modelo, que responde ao paciente.
  {
    const fato = perguntaJaRespondida(message, { supplierName: target.supplierName, total: target.total, deliveryFee: target.deliveryFee, etaMinutes: target.etaMinutes });
    if (fato) {
      await writeLog('info', 'order', `message_supplier NÃO enviado — a pergunta já está respondida na cotação (${target.supplierName})`, { traceId: ctx.traceId, orderId: state.orderId, quoteId: target.quoteId });
      throw new ToolFailure(`Mensagem NÃO enviada (não precisa): ${fato}`);
    }
  }

  // Fora da janela de texto livre (WABA/zpro): seja HONESTA sobre o PORQUÊ. O copy antigo dizia
  // "faz mais de 24h" pra QUALQUER caso — inclusive uma farmácia contatada agora há pouco que
  // simplesmente não respondeu (incidente Arthur 16/07: contato às 11h36, e às 13h ela afirmou
  // "faz mais de 24h" — o paciente pegou na hora: "tem nem 4h isso"). Distingue os dois casos:
  //   • nunca respondeu (lastSupplierInboundAt=null) → a janela nunca abriu; não é questão de 24h.
  //   • respondeu antes, mas há >24h → a janela de sessão do Meta realmente expirou.
  if (!target.contactableFreeText) {
    const neverReplied = !target.lastSupplierInboundAt;
    const msg = neverReplied
      ? `A ${target.supplierName} ainda não respondeu o meu contato 😕 Enquanto ela não responder, o WhatsApp não me deixa insistir por lá. Quer que eu procure em mais farmácias pra você?`
      : `A ${target.supplierName} não fala comigo há mais de 24h, então o WhatsApp não deixa eu reabrir a conversa direto com ela 😕 Quer que eu procure em outras farmácias num raio maior?`;
    await say(msg, { dedup: true });
    return;
  }

  // TOCTOU (review HIGH): entre o loadLatestOrderState e agora, um confirm_order_selection
  // concorrente pode ter DECIDIDO o pedido (sem serialização por-usuário ainda). Re-lê o
  // status FRESCO do banco ANTES de qualquer side-effect. Se o pedido já foi decidido e o
  // alvo NÃO é a farmácia escolhida, aborta (não reabre conversa com irmã congelada — Fix
  // #2 freeze). A janela restante (re-fetch → send) é mínima.
  const { data: freshOrder } = await db.from('orders').select('status, selected_quote_id').eq('id', state.orderId).maybeSingle();
  const freshStatus = freshOrder?.status;
  const isChosen = !!freshOrder?.selected_quote_id && freshOrder.selected_quote_id === target.quoteId;
  if (!freshStatus || (['confirming', 'handed_off', 'cancelled'].includes(freshStatus) && !isChosen)) {
    await say('Esse pedido já foi fechado 💙 Se quiser falar com outra farmácia, me fala que eu começo um pedido novo.', { dedup: true });
    return;
  }

  // Revive dirigido: cotação terminal (timeout/unavailable) → 'negotiating' pra reatar o
  // loop. Reabre o pedido em modo EAGER (status_5min_done=true) + created_at=now: assim,
  // quando a farmácia responder, notifyUserQuoteArrived apresenta na hora — e NÃO re-armo os
  // timers curtos de 3/5min (que consolidariam cedo e MATARIAM a revivida antes de ela
  // responder; espelha o revive de resposta tardia em inbound-supplier, que confia no eager
  // + rescue de 45min). Guards de status tornam idempotente sob concorrência.
  const revivedTerminal = ['timeout', 'unavailable'].includes(target.status);
  if (revivedTerminal) {
    await db.from('quotes').update({ status: 'negotiating', completed_at: null })
      .eq('id', target.quoteId).in('status', ['timeout', 'unavailable']);
    // Reabre 'failed' OU 'quoted' (não só failed): se ficasse 'quoted', notifyUserQuoteArrived
    // dá no-op e a cotação da revivida NUNCA apareceria. Guardado no status fresco não-decidido.
    await db.from('orders').update({ status: 'quoting', status_5min_done: true, created_at: new Date().toISOString() })
      .eq('id', state.orderId).in('status', ['failed', 'quoted', 'quoting']);
  }

  // Envia pela FILA do agente (ban-safe). A `message` pode conter PII (endereço) → NÃO logar.
  // O assunto do template é genérico DE PROPÓSITO: `message` pode carregar endereço do
  // paciente, e variável de template vai pra Meta — PII não entra ali.
  const entregue = await sendOutboundToSupplier(target.conversationId, target.phoneE164, message, ctx.traceId,
    'o pedido de medicamento de um paciente que estou ajudando');
  // ✅ ÚNICO ponto onde uma mensagem REALMENTE sai pra farmácia. É este sinal (não o nome da
  // tool) que autoriza a Xarlote a dizer "falei com a farmácia" — incidente Vadivino 17/07:
  // 15 message_supplier, 0 envios, e ela afirmou "Falei com as 5 redes".
  // ⚠️ E agora depende do DESFECHO, não da chamada: com a janela de 24h fechada e sem
  // template disponível, nada sai — e carimbar `supplierMessaged` ali reintroduziria
  // exatamente a mentira que este sinal existe pra impedir.
  if (!entregue) {
    throw new ToolFailure(`A mensagem NÃO chegou em ${target.supplierName}: a janela de 24h do WhatsApp com eles está fechada e não houve como reabrir agora. NÃO diga que falou com a farmácia nem que já pediu a cotação. Seja honesta com o paciente: diga que está tentando alcançá-los e que avisa assim que conseguir.`);
  }
  if (ctx.turnFlags) ctx.turnFlags.supplierMessaged = true;
  // Loop ReAct: o modelo precisa saber PRA QUEM foi e que já foi — senão, ao ver o turno de
  // novo, ele "reforça" mandando uma SEGUNDA mensagem real pra mesma farmácia.
  if (ctx.observation) {
    ctx.observation.note = `Mensagem REALMENTE enviada para ${target.supplierName}. Não envie de novo nesta conversa; agora é aguardar a resposta deles.`;
  }

  await writeLog('info', 'order', `message_supplier → ${target.supplierName} (re-engajamento dirigido)`, {
    traceId: ctx.traceId, orderId: state.orderId, quoteId: target.quoteId, revived: revivedTerminal,
  });
  // STATUS HONESTO pós-fechamento (incidente Vadivino): se o pedido já está fechado com ESTA
  // farmácia, NÃO devolve o enlatado "assim que responderem te aviso". Usa sinal ORDER-SCOPED
  // (orders.supplier_confirmed_at, setado só por record_order_confirmation DESTE pedido) — NÃO
  // o texto cru da conversa, que é COMPARTILHADA por telefone e poderia vazar a msg de OUTRO
  // cliente da mesma farmácia (review 09/07). O status real de entrega já chega ao cliente pelo
  // relay pós-fechamento (notify_customer/backstop) quando a farmácia fala.
  const closedChosen = ['confirming', 'handed_off'].includes(freshStatus ?? '') && isChosen;
  if (closedChosen) {
    const { data: ordConf } = await db.from('orders').select('supplier_confirmed_at').eq('id', state.orderId).maybeSingle();
    if (ordConf?.supplier_confirmed_at) {
      await say(`Cobrei a ${target.supplierName} de novo agora. Eles já confirmaram que tão cuidando do seu pedido, tá? Fico de olho e te aviso assim que sair pra entrega 💙`);
    } else {
      await say(`Cobrei a ${target.supplierName} agora de novo. Sendo sincera, eles ainda não me confirmaram o preparo desde que fechamos. Vou continuar em cima e te trago qualquer resposta na hora 💙`);
    }
    return;
  }
  await say(`Prontinho, mandei pra ${target.supplierName} 💬 Assim que responderem eu te aviso aqui!`);
}

/** Escapa curingas de LIKE/ILIKE (% e _) num valor vindo da LLM/usuário. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * O remédio do perfil que este título nomeia — ou `null`.
 *
 * Só devolve em casamento inequívoco: um candidato, achado por token de ≥4 letras do nome
 * do medicamento dentro do título do lembrete. Dois candidatos devolvem `null`, porque
 * escolher errado carimbaria adesão no remédio errado — pior que não carimbar nenhuma.
 */
async function acharRemedioDoTitulo(titulo: string, userId: string): Promise<string | null> {
  const t = (titulo ?? '').trim();
  if (t.length < 3) return null;
  const { data: meds } = await db
    .from('user_medications')
    .select('id, medication_name')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(40);
  if (!meds?.length) return null;

  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const alvo = fold(t);
  const hits = meds.filter((m) => {
    const nome = fold(String(m.medication_name ?? ''));
    // Tokens de 4+ letras: "ac" e "de" casariam com qualquer coisa.
    const tokens = nome.split(/\W+/).filter((w) => w.length >= 4);
    return tokens.length > 0 && tokens.some((w) => alvo.includes(w));
  });
  return hits.length === 1 ? (hits[0]!.id as string) : null;
}

async function handleCreateReminder(
  args: { type: string; title?: string; body?: string; scheduled_at?: string; rrule?: string; dia_do_mes?: number; payload?: Record<string, unknown>; depends_on_title?: string; event_at?: string; duration_days?: number | string },
  ctx: ToolContext
) {
  // next_run_at é o que o dispatcher olha. Recorrente sem scheduled_at calcula
  // o primeiro disparo pelo rrule (horário de Brasília) — antes ficava NULL e
  // o lembrete NUNCA disparava.
  // Timezone do usuário (default Brasília): "8h30" tem que disparar 8h30 no fuso DELE.
  const { data: uTz } = await db.from('users').select('timezone').eq('id', ctx.userId).maybeSingle();
  const userTz = (uTz?.timezone as string | null) || undefined;

  // CASO REAL (Glauber): a LLM chamou create_reminder sem title → a mensagem de
  // refuse interpolava `args.title` e o usuário leu literalmente "undefined".
  const title = (args.title ?? '').trim();
  const titleForMsg = title || 'esse lembrete';

  // BUG CRÍTICO (Antônia Flávia): a LLM manda `scheduled_at: ""` (string vazia)
  // junto com o rrule em lembrete recorrente. `"" ?? x` devolve `""` (nullish
  // coalescing NÃO trata string vazia como nulo) → firstRun="" → cai no refuse e
  // o nextOccurrence NUNCA era chamado. Normalizamos vazio/whitespace → null.
  let scheduledAt = args.scheduled_at?.trim() ? args.scheduled_at.trim() : null;
  const rrule = args.rrule?.trim() ? args.rrule.trim() : null;

  // 📅 "DIA N" É CONTA DO SERVIDOR, NÃO DO MODELO (incidente Glauber, 31/08/2026).
  //
  // Ele pediu "me lembrar no dia 02" e o modelo agendou 02/10 em vez de 02/09 — um mês de
  // atraso num resultado de exame de oncologia. O modelo acerta a HORA e erra o MÊS, então
  // aproveitamos a hora do palpite dele e recalculamos a data aqui, com a mesma máquina de
  // fuso dos recorrentes. Sem `rrule`, porque "dia 2" dito uma vez é evento único.
  if (args.dia_do_mes != null && !rrule) {
    const hora = horaDeIso(scheduledAt) ?? { h: 8, m: 0 };
    const calculado = proximoDiaDoMes(args.dia_do_mes, hora, new Date(), userTz);
    if (calculado) {
      // Loga QUANDO discorda: é a prova de que a trava está trabalhando, e o único jeito de
      // saber que o modelo continua errando (ou parou) sem esperar outro paciente reclamar.
      if (scheduledAt && scheduledAt.slice(0, 10) !== calculado.slice(0, 10)) {
        await writeLog('warn', 'tool', `create_reminder: modelo disse ${scheduledAt.slice(0, 10)} pra "dia ${args.dia_do_mes}", servidor corrigiu pra ${calculado.slice(0, 10)}`, {
          traceId: ctx.traceId, userId: ctx.userId,
        });
      }
      scheduledAt = calculado;
    }
  }

  // 🕒 DOIS HORÁRIOS COM MINUTOS DIFERENTES NÃO CABEM NUM RRULE (auditoria 10/09/2026).
  // `BYHOUR=11,20;BYMINUTE=30,0` queria dizer "11h30 e 20h"; em RFC 5545 é produto
  // cartesiano (4 disparos/dia), e o motor recusa. Aqui a recusa vira instrução PRECISA — a
  // genérica ("não entendi o horário") fazia o modelo tentar a mesma coisa de novo.
  if (ehRruleComListaDeMinutos(rrule)) {
    await writeLog('warn', 'tool', `create_reminder com BYMINUTE em lista (${rrule}) — recusado, modelo instruído a criar um lembrete por horário`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
    throw new ToolFailure(`NÃO criei "${titleForMsg}": o rrule "${rrule}" tem dois minutos diferentes (BYMINUTE em lista), e isso significaria disparar em TODAS as combinações de hora e minuto. Dois horários diferentes do mesmo remédio = DOIS lembretes. Chame create_reminder duas vezes, um por horário (ex.: "${title} (almoço)" com BYHOUR=11;BYMINUTE=30 e "${title} (jantar)" com BYHOUR=20;BYMINUTE=0), com o mesmo duration_days nos dois.`);
  }

  let firstRun = resolveReminderFirstRun(scheduledAt, rrule, new Date(), userTz);

  // CASO REAL (rajada das 10:50): a LLM manda scheduled_at de HOJE já passado
  // ("começa às 8h" dito às 10:50) junto do rrule → next_run_at no passado →
  // o dispatcher dispara TUDO de uma vez no próximo tick. Clamp pro futuro:
  // recorrente recalcula pelo rrule; one-shot no passado é recusado com franqueza.
  const GRACE_MS = 2 * 60_000;
  if (firstRun) {
    const t = new Date(firstRun).getTime();
    if (Number.isNaN(t)) {
      // scheduled_at ilegível (a LLM inventou formato) — tenta o rrule, senão recusa.
      firstRun = rrule ? resolveReminderFirstRun(null, rrule, new Date(), userTz) : null;
    } else if (t < Date.now() - GRACE_MS) {
      if (rrule) {
        firstRun = resolveReminderFirstRun(null, rrule, new Date(), userTz);
      } else {
        await writeLog('warn', 'tool', `create_reminder one-shot no PASSADO (${firstRun}) — recusado, usuário avisado`, {
          traceId: ctx.traceId, userId: ctx.userId,
        });
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          `Hmm, esse horário pra "${titleForMsg}" já passou 😅 Me fala uma data/hora futura que eu agendo certinho!`,
          ctx.traceId);
        return;
      }
    }
  }

  if (!firstRun || !title) {
    // Sem horário utilizável (ou sem título) → NÃO cria lembrete morto/anônimo
    // e AVISA o usuário com franqueza — antes ele achava que estava agendado.
    await writeLog('warn', 'tool', `create_reminder sem ${!title ? 'título' : 'horário'} utilizável (title=${args.title ?? '∅'}, scheduled_at=${args.scheduled_at ?? '∅'}, rrule=${args.rrule ?? '∅'}) — lembrete NÃO criado, usuário avisado`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
    // Sem título a frase antiga saía 'o lembrete "esse lembrete"' (Glauber, 08/09 16:16) —
    // interpolação de fallback na cara do paciente. Duas frases, uma pra cada falta.
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      title
        ? `Opa, não consegui entender o horário pro lembrete "${title}" 😅 Me fala de novo o horário certinho? Ex: "todo dia às 8h" ou "amanhã às 14h".`
        : 'Opa, me perdi aqui 😅 Me fala de novo o que você quer que eu lembre e em que horário? Ex: "Nimesulida todo dia às 8h e às 20h".',
      ctx.traceId);
    return;
  }

  // ⏳ FIM DA RECORRÊNCIA — CONTA DO SERVIDOR (auditoria 08/09/2026, caso Levofloxacino).
  //
  // O modelo dizia "por 10 dias" de três jeitos — `COUNT=10` no rrule, `duration_days: 10`
  // na tool, e "até acabar a caixa" na conversa — e nenhum dos três chegava ao banco: o
  // motor ignorava COUNT/UNTIL e `duration_days` nem era lido aqui. Todo antibiótico era
  // um lembrete eterno; a Domperidona "de 45 dias" idem. Agora:
  //   • COUNT/UNTIL no rrule são honrados (rrule.ts) e COUNT vira UNTIL explícito, ancorado
  //     no PRIMEIRO disparo — a forma que qualquer leitor entende, inclusive o app;
  //   • `duration_days: N` = N dias INCLUINDO o dia do primeiro disparo → UNTIL 23:59 do
  //     último dia;
  //   • o modelo recebe na observação o fim REAL ("10 disparos, o último em 13/09") — é
  //     daí que ele fala "por 10 dias", não de um "X" que ninguém preenche.
  let rruleFinal = rrule;
  let fimDaSerie: Date | null = null;
  if (rrule && firstRun) {
    const parsed = parseRrule(rrule);
    const ancora = new Date(firstRun);
    if (parsed?.count || parsed?.until) fimDaSerie = fimDaRecorrencia(rrule, ancora, userTz);
    const dur = Number(args.duration_days);
    if (!fimDaSerie && Number.isFinite(dur) && dur >= 1 && dur <= 366) {
      fimDaSerie = fimDoDiaLocal(ancora, Math.floor(dur) - 1, userTz);
    }
    if (fimDaSerie) {
      if (fimDaSerie.getTime() < ancora.getTime()) {
        await writeLog('warn', 'tool', `create_reminder: fim (${fimDaSerie.toISOString().slice(0, 10)}) anterior ao primeiro disparo — lembrete NÃO criado`, { traceId: ctx.traceId, userId: ctx.userId });
        throw new ToolFailure(`NÃO criei o lembrete "${titleForMsg}": o fim informado (${fimDaSerie.toISOString().slice(0, 10)}) vem antes do primeiro disparo. Confirme com o paciente por quantos dias é e chame de novo.`);
      }
      rruleFinal = rruleComFim(rrule, fimDaSerie, userTz);
    }
  }
  // Sem fim explícito, o modelo pode ter passado COUNT e o motor entende via âncora;
  // com fim explícito, `resolveReminderFirstRun` continua válido (UNTIL ≥ primeiro disparo).

  // GUARD DE DUPLICATA (caso real: LLM re-chamou create_reminder 3x → usuário ia
  // receber o mesmo lembrete triplicado). Mesmo user + mesmo título + mesma
  // recorrência/horário ainda pendente = idempotente, não duplica.
  // escapeLike: título com % ou _ virava padrão curinga e casava com QUALQUER
  // lembrete → criação silenciosamente ignorada.
  const dupQuery = db.from('reminders')
    .select('id')
    .eq('user_id', ctx.userId)
    .eq('status', 'pending')
    .ilike('title', escapeLike(title));
  const { data: dup } = await (rruleFinal
    ? dupQuery.eq('rrule', rruleFinal)
    : dupQuery.eq('scheduled_at', scheduledAt ?? ''))
    .limit(1).maybeSingle();
  if (dup?.id) {
    await writeLog('info', 'tool', `create_reminder duplicado ("${title}") — já existe pendente, ignorando (idempotência)`, {
      traceId: ctx.traceId, userId: ctx.userId, existingId: dup.id,
    });
    return;
  }

  /**
   * ⚠️ MESMO TÍTULO, OUTRA RECORRÊNCIA (auditoria 10/09/2026 — três Nimesulidas).
   *
   * O guard acima só pega rrule IDÊNTICO. Em 08/09 o modelo criou "Nimesulida 100mg" com
   * `BYHOUR=8,20` e, dois minutos depois, mais duas com `BYHOUR=8;COUNT=6` e
   * `BYHOUR=20;COUNT=6` — sem cancelar a primeira. Às 20:00 saíram duas mensagens iguais.
   * Não bloqueia (dois horários do mesmo remédio em dois lembretes é o caminho CERTO), mas
   * conta ao modelo o que já existe, com o horário, pra ele cancelar o velho se for o mesmo
   * plano. O dispatcher ainda funde o que escapar (agruparDuplicatasDeDisparo).
   */
  const { data: homonimos } = await db.from('reminders')
    .select('id, title, rrule, next_run_at')
    .eq('user_id', ctx.userId)
    .eq('status', 'pending')
    .ilike('title', escapeLike(title))
    .limit(5);
  const avisoHomonimo = (homonimos ?? []).length
    ? ` ⚠️ JÁ EXISTE${(homonimos ?? []).length > 1 ? 'M' : ''} lembrete(s) ativo(s) com este mesmo título: ${(homonimos ?? []).map((h) => `"${h.title}" (${describeReminder(h.rrule as string | null, h.next_run_at as string)})`).join('; ')}. Se este novo SUBSTITUI aquele, chame cancel_reminders(title_query:"${title}") AGORA — senão o paciente recebe em dobro. Se são horários diferentes do mesmo remédio, está certo, deixe os dois.`
    : '';

  // LEMBRETE CONDICIONAL (0020 — incidente Glauber): backup "só se não confirmar" o primário.
  // Resolve o id do primário (best-effort); se ainda não existe (tool calls do mesmo turno em
  // ordem inversa), grava só o título e o dispatcher resolve por título no disparo.
  let condPayload: Record<string, unknown> = {};
  const dep = args.depends_on_title?.trim();
  if (dep) {
    const { data: primary } = await db.from('reminders')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('status', 'pending')
      .ilike('title', escapeLike(dep))
      .neq('title', title) // não se auto-referencia
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    condPayload = { condition: 'if_not_confirmed', depends_on_title: dep, depends_on_reminder_id: primary?.id ?? null };
  }

  // 🕐 RE-ANCORAGEM DE DÊITICO (incidente Elizabeth 09/07): o body é redigido AGORA mas
  // lido NO DISPARO — "amanhã" copiado da fala do usuário chega errado no dia do evento
  // ("Amanhã é dia da quimioterapia" entregue NO dia da quimio). Normaliza da perspectiva
  // do disparo; event_at (quando o LLM passou) ancora véspera legítima. Conservador:
  // fora do alcance dêitico o texto fica intacto (ver packages/shared/reminder-deictics.ts).
  const eventAt = args.event_at?.trim() || null;
  let body = args.body?.trim() ? args.body.trim() : null;
  // SÓ one-shot: recorrente com dêitico genérico ("separar os remédios de AMANHÃ" todo dia
  // às 21h) seria corrompido permanentemente ("de hoje") ao normalizar contra o 1º disparo
  // — o dêitico de recorrente é atemporal por escolha do autor (review 10/07).
  // Log SEM o conteúdo do body (regra 3 do CLAUDE.md: dado clínico não vai a log ≥ info).
  if (body && !rrule) {
    const norm = normalizeReminderBody(body, {
      authoredAtIso: new Date().toISOString(),
      fireAtIso: firstRun,
      eventAtIso: eventAt,
      timeZone: userTz,
    });
    if (norm.changed) {
      await writeLog('info', 'tool', `create_reminder: body re-ancorado pro momento do disparo (dêitico corrigido) — "${title}"`, {
        traceId: ctx.traceId, userId: ctx.userId,
      });
      body = norm.body;
    }
  }

  // 🧹 PLACEHOLDER NÃO SAI PRO PACIENTE (auditoria 08/09/2026): "Faltam X dias pra acabar a
  // caixa!" foi entregue com o X literal, cinco dias seguidos. A oração com marca de
  // preenchimento cai aqui; o modelo fica sabendo pela observação (abaixo) e o fim real da
  // série chega junto — é ele que responde "quantos dias faltam".
  const saneado = sanitizarCorpoDeLembrete(body);
  const placeholdersRemovidos = saneado.removidas.length;
  if (placeholdersRemovidos) {
    await writeLog('warn', 'tool', `create_reminder: ${placeholdersRemovidos} oração(ões) com placeholder removida(s) do body — "${title}"`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
    body = saneado.body;
  }

  // 💊 LIGA O LEMBRETE AO REMÉDIO DO PERFIL, quando dá pra ter certeza.
  //
  // `medication_log` — a fonte da adesão do app e do `calc_adherence_score` — tem
  // `medication_id` NOT NULL. Um lembrete sem esse vínculo nunca vira linha de adesão:
  // o paciente responde "tomei" no WhatsApp e o número na tela dele não se mexe.
  // Em 26/08 eram 2 de 30 lembretes de remédio ligados; os outros 28 confirmavam no vazio.
  //
  // A resolução é contra os remédios QUE JÁ EXISTEM no perfil dele, e só em casamento
  // INEQUÍVOCO. Zero ou vários candidatos ⇒ não liga. Foi tentar adivinhar pelo título que
  // criou `user_medications` fantasma antes ("Hora do Dipirona 500mg" virou remédio) —
  // aqui nada é criado, só reconhecido.
  const medicationId = args.type === 'medication' ? await acharRemedioDoTitulo(title, ctx.userId) : null;

  const { error: insErr } = await db.from('reminders').insert({
    user_id: ctx.userId,
    type: args.type,
    title,
    ...(medicationId ? { medication_id: medicationId } : {}),
    // body:"" (string vazia da LLM) → null, senão o dispatcher mandaria msg vazia.
    body,
    scheduled_at: scheduledAt,
    rrule: rruleFinal,
    next_run_at: firstRun,
    status: 'pending',
    // event_at no payload → o dispatcher re-ancora rows de véspera no disparo também.
    payload: { ...(args.payload ?? {}), ...(eventAt ? { event_at: eventAt } : {}), ...condPayload },
  });
  if (!insErr) {
    // Loop ReAct: confirma AO MODELO o que ficou agendado, com a recorrência real. Sem isto
    // ele só "acha" que criou — e é assim que nascem o lembrete duplicado e o "já agendei"
    // quando nada foi criado.
    if (ctx.observation) {
      const fimTxt = describeReminderEnd(rruleFinal, firstRun, userTz);
      const aviso = placeholdersRemovidos
        ? ` ⚠️ Removi do body ${placeholdersRemovidos} frase(s) com placeholder não preenchido (ex.: "X dias") — NUNCA escreva contagens que você não sabe; o fim da série está acima, use ele se quiser falar em dias.`
        : '';
      ctx.observation.note = `Lembrete criado: "${title}" — ${describeReminder(rruleFinal, firstRun)}${fimTxt}. Já está ativo; não crie de novo.${aviso}${avisoHomonimo}`;
    }
  }
  if (insErr) {
    // Insert falhou (ex: enum inválido) — o turno da LLM já pode ter dito "agendei".
    // Ser honesto > ficar bonito: avisa que NÃO ficou agendado.
    await writeLog('error', 'tool', `create_reminder INSERT falhou: ${insErr.message}`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Opa, deu um probleminha técnico ao salvar o lembrete "${titleForMsg}" 😔 Pode me pedir de novo? Prometo que registro certinho.`,
      ctx.traceId);
  }
}

/**
 * Cancela lembretes pendentes por busca de título (E3 — caso real: usuária pediu
 * pra REDIVIDIR o plano de água; a Xarlote criou o plano novo mas não tinha como
 * apagar o antigo → 15 pings/dia). A LLM enxerga os lembretes ativos no contexto
 * do system prompt e chama esta tool ANTES de criar um plano substituto.
 */
/** Remove acentos + minúsculas — pra casar "água" com "agua" (ILIKE não dobra diacrítico). */
function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Descreve um lembrete pro usuário SEM mentir a frequência (semanal ≠ "todo dia"). */
function describeReminder(rrule: string | null, nextRunAtIso: string): string {
  const hora = new Date(nextRunAtIso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  if (!rrule) {
    const data = new Date(nextRunAtIso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${data} às ${hora}`;
  }
  const parsed = parseRrule(rrule);
  if (parsed?.freq === 'WEEKLY' && parsed.byDays?.length) {
    const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const dias = [...parsed.byDays].sort((a, b) => a - b).map((d) => nomes[d]).join('/');
    return `${dias} às ${hora}`;
  }
  if (parsed?.freq === 'DAILY') return `todo dia às ${hora}`;
  return `recorrente, próximo às ${hora}`;
}

/**
 * O FIM da série, pra confirmação ao modelo: ", 10 disparos, o último em 13/09". Vazio quando
 * não há fim (rotina contínua). É esta linha que permite dizer "por 10 dias" sem inventar.
 */
function describeReminderEnd(rrule: string | null, firstRunIso: string, tz?: string): string {
  if (!rrule) return '';
  const ancora = new Date(firstRunIso);
  const fim = fimDaRecorrencia(rrule, ancora, tz);
  if (!fim) return '';
  const n = contarOcorrencias(rrule, ancora, tz);
  const data = fim.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: tz ?? 'America/Sao_Paulo' });
  return n ? `, ${n} disparo(s), o último em ${data}` : `, até ${data}`;
}

async function handleCancelReminders(args: { title_query?: string; all?: boolean }, ctx: ToolContext) {
  const q = (args.title_query ?? '').trim();
  if (!q && !args.all) {
    await writeLog('warn', 'tool', 'cancel_reminders sem title_query e sem all — ignorado', { traceId: ctx.traceId, userId: ctx.userId });
    throw new ToolFailure('NENHUM lembrete foi cancelado: você não disse QUAL (title_query) nem pediu todos (all). Pergunte ao paciente qual lembrete ele quer cancelar — e não diga que cancelou.');
  }
  // 🔴 SELECIONA ANTES DE CANCELAR (auditoria 04/08 — caso Ciro).
  // Antes isto era um UPDATE direto com `ilike('title', '%…%')`. Em 03/08 o Ciro pediu
  // "me lembra na semana da consulta" — um ADICIONAR — e o modelo, seguindo a própria
  // instrução do prompt ("cancele antes de criar os novos"), chamou
  // `cancel_reminders({title_query: "Consulta"})`. O curinga casou os DOIS lembretes da
  // consulta e apagou o de "Consulta em 2 horas", o único que avisaria no dia. O handler
  // devolveu ao modelo apenas a CONTAGEM ("2 cancelados"), jogando os títulos no lixo —
  // então o modelo não soube o que destruiu, não avisou o paciente e não recriou.
  // Agora: lê os candidatos, PROTEGE o que pertence a uma consulta viva, e devolve ao
  // modelo os títulos exatos do que caiu e do que foi preservado.
  const CANDIDATE_CAP = 200;
  const { data: pendentes, error } = await db.from('reminders')
    .select('id, title, type, payload')
    .eq('user_id', ctx.userId)
    .eq('status', 'pending')
    .limit(CANDIDATE_CAP);
  // Teto silencioso é indistinguível de "considerei tudo" — se encostar, diz.
  if ((pendentes?.length ?? 0) >= CANDIDATE_CAP) {
    await writeLog('warn', 'tool', `cancel_reminders: teto de ${CANDIDATE_CAP} candidatos atingido — pode haver lembrete fora da varredura`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
  }

  if (error) {
    await writeLog('error', 'tool', `cancel_reminders falhou: ${error.message}`, { traceId: ctx.traceId, userId: ctx.userId });
    throw new ToolFailure('NENHUM lembrete foi cancelado (falha técnica ao ler seus lembretes) — eles vão continuar disparando. NÃO diga que cancelou; avise que deu um problema e que ele pode pedir de novo.');
  }

  /**
   * 🔴 `all: true` JUNTO COM `title_query` APAGOU O PRONTUÁRIO INTEIRO (Glauber, 08 e 09/09).
   *
   * A linha era `filter((r) => args.all || …includes(qn))`. O `||` faz curto-circuito: com
   * `all` verdadeiro, TODO lembrete casa e o `title_query` é jogado fora. O modelo chamou
   * `{all: true, title_query: "Nimesulida"}` achando que o título limitava o escopo — e o
   * paciente perdeu, de uma vez, Esomeprazol, Domperidona (almoço e jantar) e Levofloxacino.
   * No dia seguinte a mesma chamada com `{all: true, title_query: "Domperidona"}` levou a
   * Nimesulida, que ele estava tomando de 12 em 12 horas até 14/09. Ele saiu de quatro
   * medicações lembradas para uma — e ouviu "cancelei os lembretes antigos da Nimesulida",
   * porque nem a Xarlote sabia o que tinha destruído.
   *
   * Nas outras 13 chamadas da história do produto o modelo mandou só `title_query`. As duas
   * que mandaram os dois campos são de 08 e 09/09 — comportamento novo, e caro.
   *
   * A regra agora: **escopo explícito vence**. `all` só significa "todos" quando NÃO há
   * título; havendo os dois, o título manda, porque é o sinal mais específico da intenção.
   * Cancelar tudo é destrutivo e irreversível pro paciente: na dúvida entre apagar tudo e
   * apagar um grupo, apaga-se o grupo.
   */
  const cancelarTudo = Boolean(args.all) && !q;
  if (args.all && q) {
    await writeLog('warn', 'tool', `cancel_reminders recebeu all=true E title_query="${q}" — o título vence (all ignorado)`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
  }
  /**
   * 🔴 "TODOS" SÓ COM A FALA DO PACIENTE (auditoria 10/09/2026).
   *
   * Com o título vencendo, o que sobra é `{all: true}` SOZINHO — e nada impedia o modelo de
   * mandar isso por conta própria, do mesmo jeito que mandou junto com o título. Apagar o
   * prontuário de lembretes é a ação mais destrutiva que esta ferramenta tem, e ela é
   * irreversível para quem depende do lembrete pra tomar remédio.
   *
   * Então a prova é a fala DELE, não a decisão do modelo — a mesma escola do gate de
   * consentimento do laboratório. `pediuCancelarTudo` é puro e determinístico; quando não
   * há esse pedido, a ferramenta recusa e devolve a lista pro modelo perguntar QUAL.
   */
  if (cancelarTudo && !pediuCancelarTudo(ctx.textoDoPaciente)) {
    const { data: ativos } = await db.from('reminders').select('title').eq('user_id', ctx.userId).eq('status', 'pending').limit(20);
    const lista = (ativos ?? []).map((r) => `"${r.title}"`).join(', ') || '(nenhum)';
    await writeLog('warn', 'tool', `cancel_reminders all=true RECUSADO — o paciente não pediu "todos" nesta mensagem`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
    throw new ToolFailure(`NENHUM lembrete foi cancelado: você pediu all=true, mas o paciente NÃO disse que quer cancelar TODOS os lembretes nesta mensagem. Os ativos são: ${lista}. Se ele quer parar UM grupo, chame de novo com title_query (ex.: "Nimesulida"). Se quer parar todos, pergunte e espere ele confirmar com as palavras dele. NÃO diga que cancelou nada.`);
  }

  // Match acento-insensível em JS: o ILIKE do Postgres não dobra diacríticos, e a LLM
  // manda "agua" sem acento — casava 0 rows EM SILÊNCIO (o antigo E3, planos duplicados).
  const qn = foldAccents(q);
  const casaram = (pendentes ?? []).filter((r) => cancelarTudo || foldAccents(r.title ?? '').includes(qn));

  // 🛡️ INVARIANTE: lembrete de consulta VIVA pertence ao ciclo de vida da consulta, não
  // ao curinga de título. Pra parar de ser lembrado de uma consulta o caminho é
  // `cancel_consultation` (que cancela os lembretes dela e avisa o consultório).
  const idsConsultaViva = new Set<string>();
  const consultaDe = (r: { payload: unknown }) => ((r.payload ?? {}) as Record<string, unknown>)['consultation_id'] as string | undefined;
  const candidatasConsulta = casaram.filter((r) => r.type === 'appointment' && consultaDe(r));
  if (candidatasConsulta.length > 0) {
    const ids = [...new Set(candidatasConsulta.map((r) => consultaDe(r)!))];
    const { data: vivas } = await db.from('consultations')
      .select('id, status')
      .in('id', ids)
      .in('status', ['confirming', 'scheduled']);
    const vivasSet = new Set((vivas ?? []).map((c) => c.id as string));
    for (const r of candidatasConsulta) {
      if (vivasSet.has(consultaDe(r)!)) idsConsultaViva.add(r.id as string);
    }
  }

  const protegidos = casaram.filter((r) => idsConsultaViva.has(r.id as string));
  const aCancelar = casaram.filter((r) => !idsConsultaViva.has(r.id as string));

  let count = 0;
  if (aCancelar.length > 0) {
    const { data: c2, error: upErr } = await db.from('reminders')
      .update({ status: 'cancelled' })
      .in('id', aCancelar.map((r) => r.id))
      .select('id');
    if (upErr) {
      await writeLog('error', 'tool', `cancel_reminders: update falhou: ${upErr.message}`, { traceId: ctx.traceId, userId: ctx.userId });
      throw new ToolFailure('NENHUM lembrete foi cancelado (falha técnica ao gravar) — eles vão continuar disparando. NÃO diga que cancelou; avise que deu um problema e que ele pode pedir de novo.');
    }
    count = c2?.length ?? 0;
  }
  const cancelled = aCancelar;

  if (protegidos.length > 0) {
    await writeLog('warn', 'tool', `cancel_reminders: ${protegidos.length} lembrete(s) de consulta VIVA protegidos do curinga "${cancelarTudo ? '*' : q}"`, {
      traceId: ctx.traceId, userId: ctx.userId, protegidos: protegidos.map((r) => r.title),
    });
  }

  // AINDA 0: NÃO fica em silêncio (a LLM já pode ter dito "cancelei"). Fala a verdade.
  // Mas se houve PROTEGIDOS, "não achei lembrete com X" seria mentira — achamos e
  // preservamos de propósito. Nesse caso quem fala é o modelo, com a nota da observation.
  if (count === 0 && !cancelarTudo && protegidos.length === 0) {
    const { data: ativos } = await db.from('reminders')
      .select('title').eq('user_id', ctx.userId).eq('status', 'pending').limit(15);
    if (ativos?.length) {
      const lista = ativos.map((r) => `• ${r.title}`).join('\n');
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Não achei lembrete com "${q}" 🤔 Seus ativos são:\n\n${lista}\n\nQual desses você quer cancelar?`, ctx.traceId);
    } else {
      await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Você não tem lembretes ativos pra cancelar 💙', ctx.traceId);
    }
  }

  // Loop ReAct: o modelo precisa ver O QUE caiu, não só QUANTOS. Devolver apenas a
  // contagem foi o que permitiu o modelo apagar o lembrete do dia da consulta do Ciro
  // sem perceber, sem avisar e sem recriar. Título é o único jeito de ele conferir se o
  // que ele cancelou é o que ele quis cancelar.
  if (ctx.observation) {
    const lista = cancelled.map((r) => `"${r.title}"`).join(', ');
    const protegidosTxt = protegidos.length > 0
      ? ` ATENÇÃO: ${protegidos.length} lembrete(s) NÃO foram cancelados porque pertencem a uma consulta que está de pé — ${protegidos.map((r) => `"${r.title}"`).join(', ')}. Eles continuam ativos de propósito: perder o aviso do dia da consulta faz o paciente faltar. Se ele quer DESMARCAR a consulta, use \`cancel_consultation\`; se ele só não quer o aviso, explique que mantive pra ele não perder o horário.`
      : '';
    ctx.observation.note = count > 0
      ? `${count} lembrete(s) cancelado(s) de verdade: ${lista}. Confira se é isso que o paciente pediu — se você apagou algo que ele NÃO pediu pra apagar, recrie agora e conte a ele.${protegidosTxt}`
      : `NENHUM lembrete foi cancelado (nada casou com "${cancelarTudo ? '*' : q}").${protegidosTxt || ' NÃO diga que cancelou. O paciente já recebeu a lista dos ativos pra escolher.'}`;
  }
  await writeLog('info', 'tool', `cancel_reminders: ${count} lembrete(s) cancelado(s) (query="${cancelarTudo ? '*' : q}")`, {
    traceId: ctx.traceId, userId: ctx.userId,
  });
  await writeAudit({
    actorType: 'xarlote',
    action: 'reminder.cancelled',
    userId: ctx.userId,
    targetTable: 'reminders',
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { count, query: cancelarTudo ? '*' : q },
  });
}

/**
 * Lista os lembretes pendentes DIRETO pro usuário (execução de tool é
 * fire-and-forget — a LLM não vê o resultado, então o handler responde).
 */
async function handleListReminders(ctx: ToolContext) {
  const { data: rows } = await db.from('reminders')
    .select('title, rrule, scheduled_at, next_run_at')
    .eq('user_id', ctx.userId)
    .eq('status', 'pending')
    .order('next_run_at', { ascending: true })
    .limit(30);

  if (!rows?.length) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Você não tem nenhum lembrete ativo no momento 💙 Quer criar algum?', ctx.traceId);
    // Loop ReAct: o modelo PRECISA saber o que a leitura devolveu — senão ele "consulta" e
    // segue chutando (era uma tool que só falava com o paciente e não retornava nada a ela).
    if (ctx.observation) ctx.observation.note = 'Nenhum lembrete ativo. Você já avisou o paciente e ofereceu criar um.';
    return;
  }
  const lines = rows.map((r) => `• *${r.title}* — ${describeReminder(r.rrule, r.next_run_at)}`);
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Seus lembretes ativos 📋\n\n${lines.join('\n')}\n\nQuer mudar ou cancelar algum? É só falar!`, ctx.traceId);
  if (ctx.observation) {
    ctx.observation.note = `${rows.length} lembrete(s) ativo(s): ${rows.map((r) => r.title).join('; ')}. A lista JÁ foi enviada ao paciente — não repita.`;
  }
}

async function handleConfirmOrder(args: { order_id: string; quote_id: string }, ctx: ToolContext) {
  // 0. IDEMPOTÊNCIA: se o pedido já saiu de 'quoted' (já foi confirmado por outro
  // turno concorrente / backstop), NÃO re-executa — senão manda 2ª msg à farmácia +
  // 2ª msg de pagamento ao usuário. Só segue se a transição quoted/quoting→confirming
  // pegar de fato (ou se já é este mesmo quote sendo re-tentado no mesmo estado).
  // O `order_id` vem do modelo: resolve dentro dos pedidos DESTE paciente (uuid de outro
  // paciente nunca entra na lista) antes de qualquer leitura/transição.
  const ord0 = await resolveOrderForUser(args.order_id, ctx.userId, { action: 'confirmado', traceId: ctx.traceId });
  const orderId = ord0.id;
  if (['confirming', 'handed_off', 'cancelled'].includes(ord0.status)) {
    await writeLog('info', 'order', `confirm_order_selection ignorado — pedido já '${ord0.status}' (idempotência)`, {
      traceId: ctx.traceId, orderId, quoteId: args.quote_id,
    });
    return;
  }

  // 1. CARREGA + VALIDA a quote ANTES de qualquer transição/freeze (review HIGH): um
  // quote_id ALUCINADO pelo LLM (ou de outro pedido) não pode transicionar o pedido pra
  // 'confirming' e matar TODAS as cotações irmãs pra só depois descobrir que a quote não
  // existe — isso bricava o pedido sem recuperação. Aqui nada é alterado até validar.
  const { data: quote } = await db
    .from('quotes')
    .select('*, suppliers(id, name, whatsapp_e164, phone_e164)')
    .eq('id', args.quote_id)
    .eq('order_id', orderId)   // escopo: a cotação TEM que ser deste pedido (não confia no id solto)
    .maybeSingle();

  if (!quote) {
    // Antes: `return` mudo com a task carimbada success — o modelo anunciava a compra
    // fechada e nada tinha sido confirmado. Agora o motivo volta pra ele.
    await writeLog('error', 'order', `Quote ${args.quote_id} inexistente ou de outro pedido — pedido intacto`, { traceId: ctx.traceId, orderId });
    throw new ToolFailure('NADA FOI CONFIRMADO: essa opção de farmácia não existe neste pedido. Releia as opções do PEDIDO ATIVO no seu contexto e peça ao paciente pra escolher de novo — não afirme que fechou a compra.');
  }

  // 🧾 SUBSTITUTO SÓ COM ACEITE DITO PELO PACIENTE (caso Ludmila): a cotação carrega o que a
  // farmácia tem; se é um similar, fechar exige que a fala do paciente aceite o similar — o
  // modelo não decide isso por ele.
  const produtoCotado = ((quote.items_available as ProdutoCotado[] | null) ?? [])[0] ?? null;
  if (produtoCotado?.substituto === true && !aceitouSubstituto(ctx.textoDoPaciente)) {
    const supNome = (quote.suppliers as { name?: string } | null)?.name ?? 'a farmácia';
    throw new ToolFailure(`NADA FOI CONFIRMADO: a ${supNome} NÃO tem o ${produtoCotado.pedido} — cotou ${linhaDoProduto(produtoCotado)}. O paciente ainda não disse que aceita o similar. Pergunte de forma clara: "a ${supNome} só tem o ${produtoCotado.cotado ?? 'similar'}; quer fechar com ele ou prefere que eu procure o ${produtoCotado.pedido}?" e só confirme quando ele aceitar o similar.`);
  }

  // 2. Só AGORA transiciona o pedido pra 'confirming' + registra a escolha — via CAS ATÔMICO.
  // O guard de leitura no passo 0 tem um TOCTOU: entre ele e este update, um turno concorrente
  // (duplo "sim", ou backstop + tool do LLM em turnos distintos) podia passar os dois pelo guard e
  // AMBOS mandarem "pode preparar" à farmácia + 2× handoff. O CAS (update só se o status ainda NÃO
  // é confirming/handed_off/cancelled) garante que só UM turno vence a transição; o perdedor aborta.
  const { data: won } = await db
    .from('orders')
    .update({ status: 'confirming', selected_quote_id: args.quote_id })
    .eq('id', orderId)
    .not('status', 'in', '(confirming,handed_off,cancelled)')
    .select('id');
  if (!won || won.length === 0) {
    await writeLog('info', 'order', `confirm_order_selection: transição perdida p/ turno concorrente — abortando (idempotência CAS)`, {
      traceId: ctx.traceId, orderId: orderId, quoteId: args.quote_id,
    });
    return;
  }

  // 3. CONGELA as cotações IRMÃS (Fix #2 — freeze): o usuário escolheu; as outras
  // farmácias do MESMO pedido param de negociar (senão uma retardatária reabre a
  // decisão com "aceita 20 em vez de 30?" ou registra preço e polui o estado).
  // Fecha por order_id (não conversation_id — telefone compartilhado pode ter outro
  // pedido) e só as que ainda estão vivas; limpa clarificação pendente das irmãs.
  await db.from('quotes')
    .update({ status: 'timeout', completed_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .neq('id', args.quote_id)
    .in('status', ['pending', 'contacting', 'negotiating']);
  // Fecha clarificação pendente em TODAS as cotações do pedido — INCLUSIVE a escolhida
  // (review): senão a quote escolhida fica 'awaiting_user' e o nudge-worker re-cutuca o
  // cliente sobre um pedido JÁ FECHADO. Sem .neq de propósito.
  await db.from('quotes')
    .update({ clarification_status: 'closed' })
    .eq('order_id', orderId)
    .eq('clarification_status', 'awaiting_user');

  // 4. Load order items + delivery address + payment method (+ endereço salvo com nº/complemento)
  const { data: order } = await db
    .from('orders')
    .select('items, delivery_address, delivery_lat, delivery_lng, payment_method, user_address_id')
    .eq('id', orderId)
    .single();
  const items = (order?.items ?? []) as OrderItem[];
  const deliveryAddress =
    (order?.delivery_address as string | null) ??
    (order?.delivery_lat && order?.delivery_lng
      ? `lat ${Number(order.delivery_lat).toFixed(5)}, lng ${Number(order.delivery_lng).toFixed(5)}`
      : null);
  const userPaymentMethod = (order?.payment_method as string | null) ?? null;

  // CONDIÇÕES DO ACEITE (incidente Santa Lúcia 07/07): "só que tem que entregar antes das
  // 19:00" era DESCARTADO — o fechamento ia sem o prazo e o aviso posterior morria. Agora a
  // condição viaja NA mensagem de fechamento e o prazo fica no pedido (worker de follow-up).
  const acceptText = ctx.inbound?.text ?? '';
  const conditions = extractAcceptConditions(acceptText);
  const deadlineIso = (() => {
    if (conditions.deadlineHour == null) return null;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // YYYY-MM-DD
    const hh = String(conditions.deadlineHour).padStart(2, '0');
    const mm = String(conditions.deadlineMinute).padStart(2, '0');
    return new Date(`${today}T${hh}:${mm}:00-03:00`).toISOString();
  })();

  // ENDEREÇO ENTREGÁVEL: prioriza o endereço SALVO (tem número/quadra/lote/complemento);
  // senão usa o texto do pedido. "Rua 14, Setor Oeste" sem número NÃO entrega — se faltar,
  // fecha mesmo assim (não perde a farmácia) mas pede o complemento ao cliente na sequência
  // (o relay pós-fechamento leva; message_supplier agora funciona em handed_off).
  let addrHuman: string | null = null;
  let addrHasUnit = false;
  if (order?.user_address_id) {
    const { data: savedAddr } = await db
      .from('user_addresses')
      .select('street, number, complement, neighborhood')
      .eq('id', order.user_address_id)
      .maybeSingle();
    if (savedAddr?.street) {
      const parts = [
        `${savedAddr.street}${savedAddr.number ? `, ${savedAddr.number}` : ''}`,
        savedAddr.complement || null,
        savedAddr.neighborhood || null,
      ].filter(Boolean);
      addrHuman = parts.join(', ');
      addrHasUnit = !!(savedAddr.number || savedAddr.complement);
    }
  }
  if (!addrHuman && deliveryAddress && !/Localização compartilhada|^lat\s/i.test(deliveryAddress)) {
    addrHuman = shortSupplierAddress(deliveryAddress);
    // Tem número/qd/lt no texto? (segmento só-número ou marcador qd/lt/nº/apto/casa)
    addrHasUnit = /,\s*\d+[a-zA-Z]?\s*(,|$)/.test(deliveryAddress) || /\b(qd|quadra|lt|lote|n[ºo°]\s*\d|apto|apart|bloco|casa\s*\d)/i.test(deliveryAddress);
  }

  // 4b. Fechamento HUMANO (incidente Santa Lúcia: o formato-formulário com lista, rótulos e
  // link do Maps fez a farmácia achar que era robô e NÃO ENTREGAR). Agora: 2 mensagens
  // curtas de gente, sem bullets, sem "Endereço de entrega:", SEM link do Maps (humano não
  // manda URL crua; se a farmácia pedir a localização, o agente manda na conversa).
  const supplier = quote.suppliers as { id: string; name: string; whatsapp_e164?: string; phone_e164?: string } | null;
  // 🛑 Só confirma com fornecedor de telefone REAL (nunca fabrica número fake — ver
  // incidente 2026-07-01). Sem telefone válido → pula (não há farmácia real pra avisar).
  const supplierPhone = supplier?.whatsapp_e164 || supplier?.phone_e164 || null;
  if (supplier && quote.conversation_id && supplierPhone && !isPlaceholderPhone(supplierPhone)) {
    const itemsInline = items
      .map((i: OrderItem) => `${i.quantity ? `${i.quantity} de ` : ''}${itemDisplayName(i.name, i.dosage)}`)
      .join(' e ') || 'o pedido';
    const paymentLabel = humanizePaymentLabel(userPaymentMethod || ((quote.payment_methods ?? ['pix']) as string[])[0] || 'pix');

    // NOME DE QUEM RECEBE (incidente Vadivino: o motoboy chegou e não sabia procurar quem →
    // entrega falhou). Vai no fechamento pra a farmácia já saber o destinatário. Só o 1º nome.
    const { data: uName } = await db.from('users').select('preferred_name, full_name').eq('id', ctx.userId).maybeSingle();
    const recipient = (((uName?.preferred_name as string | null)?.trim()) || ((uName?.full_name as string | null)?.trim()) || '').split(' ')[0] || '';
    const recipientPart = recipient ? ` o pedido é pro ${recipient}, é ele que recebe.` : '';

    // Variação leve pra não soar template (mesma pessoa não fala igual sempre).
    const openings = ['fechou! pode preparar', 'show, fechado! pode separar', 'fechou então, pode preparar'];
    const opening = openings[Math.abs(orderId.charCodeAt(0) + orderId.charCodeAt(3)) % openings.length] as string;
    // Nome do destinatário JÁ na 1ª msg (associado ao pedido) + de novo no recipientPart da 2ª
    // (auditoria 1º pedido: farmácia anotou "Igor" no lugar de "Hiago" — o nome aparecer cedo
    // e 2× reduz o erro de anotação humana da farmácia).
    // O produto que a farmácia DISSE que tem (similar/apresentação) vai no fechamento — a
    // farmácia separa o que cotou, não o que estava na receita (caso Ludmila: Venaflon ≠ Daflon Flex).
    const produtoFechado = produtoCotado?.cotado
      ? `${produtoCotado.cotado}${produtoCotado.apresentacao ? ` (${produtoCotado.apresentacao})` : ''}${produtoCotado.substituto ? ', o similar que você me passou' : ''}`
      : itemsInline;
    const msg1 = `${opening} ${produtoFechado}${recipient ? ` pro ${recipient}` : ' pra mim'}`;

    // Prazo em fala natural — SÓ quando extraímos uma HORA clara do aceite. Cláusula livre
    // (ex.: "vai ser cartão", "obrigado") NÃO vai pra farmácia (review: mandaria ruído tipo
    // "Só uma coisa: obrigado" — o exato tell de robô). A cláusula fica só no estado interno.
    const deadlinePart = conditions.deadlineHour != null
      ? ` ah, e preciso que chegue até as ${conditions.deadlineHour}${conditions.deadlineMinute ? `:${String(conditions.deadlineMinute).padStart(2, '0')}` : ''}h, consegue?`
      : '';
    const addrPart = addrHuman ? `o endereço é ${addrHuman}` : 'já te passo o endereço certinho';
    const msg2 = `${addrPart} — pagamento no ${paymentLabel}, tá?${recipientPart}${deadlinePart} me avisa quando sair pra entrega 🙏`;

    await sendOutboundToSupplier(quote.conversation_id as string, supplierPhone, msg1, ctx.traceId);
    await sendOutboundToSupplier(quote.conversation_id as string, supplierPhone, msg2, ctx.traceId);
    await writeLog('info', 'order', `Confirmação (humanizada, 2 msgs) enviada para ${supplier.name}`, {
      traceId: ctx.traceId,
      quoteId: args.quote_id,
      hasDeadline: conditions.deadlineHour != null,
      addrHasUnit,
    });
  } else {
    await writeLog('warn', 'order', `Confirmação NÃO enviada — supplier ou conversation_id ausente`, {
      traceId: ctx.traceId,
      quoteId: args.quote_id,
      hasSupplier: !!supplier,
      hasConversation: !!quote.conversation_id,
    });
  }

  // 5. Update order to handed_off + memória do fechamento (worker de follow-up usa).
  await db.from('orders').update({
    status: 'handed_off',
    closed_at: new Date().toISOString(),
    close_conditions: conditions.clause ?? (conditions.deadlineHour != null ? `entregar até ${conditions.deadlineHour}h` : null),
    delivery_deadline: deadlineIso,
  }).eq('id', orderId);

  // 6. Send payment details to user
  const supplierName = supplier?.name ?? 'farmácia selecionada';
  const paymentMsg = buildPaymentMessage(quote, supplierName, conditions.deadlineHour);
  await sendOutbound(ctx.conversationId, ctx.phoneE164, paymentMsg, ctx.traceId);

  // 6b. Endereço SEM número/complemento → pede ao cliente AGORA (a farmácia não entrega em
  // "Rua 14" sem número; quando ele responder, a Xarlote repassa via message_supplier —
  // que agora funciona pós-fechamento).
  if (!addrHasUnit) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Só me confirma o número (ou quadra/lote e complemento) do endereço pra eu passar certinho pra entrega 💙', ctx.traceId);
  }

  // Loop ReAct: o fechamento é IRREVERSÍVEL (a farmácia já foi avisada e vai despachar).
  // O modelo precisa ver isso pra nunca re-confirmar nem prometer algo fora do combinado.
  if (ctx.observation) {
    ctx.observation.note = `Pedido FECHADO com ${supplierName} (handed_off) — a farmácia já recebeu o pedido. NÃO confirme de novo. Daqui pra frente é acompanhamento de entrega.`;
  }
  await writeLog('info', 'order', `Pedido finalizado — handed_off para ${supplierName}`, {
    traceId: ctx.traceId, orderId: orderId, quoteId: args.quote_id,
  });
}

function buildPaymentMessage(quote: Record<string, unknown>, supplierName: string, deadlineHour?: number | null): string {
  const lines: string[] = [`✅ *Pedido confirmado com ${supplierName}!*\n`];

  if (quote['pix_key']) {
    lines.push(`📱 *Chave Pix:* ${quote['pix_key']}`);
  }
  if (quote['payment_link']) {
    lines.push(`🔗 *Link de pagamento:* ${quote['payment_link']}`);
  }

  const methods = ((quote['payment_methods'] as string[]) ?? []).map((m) => humanizePaymentLabel(m)).join('/');
  if (methods) {
    lines.push(`💳 *Pagamento:* ${methods}`);
  }

  const total = quote['total'] as number | null;
  const deliveryFee = quote['delivery_fee'] as number | null;
  if (total != null) {
    // Total FINAL = remédios + frete (auditoria 1º pedido: cliente via "R$28,89" mas pagava R$35,89).
    lines.push(`💰 *Total:* ${formatOrderTotal(total, deliveryFee)}`);
  }

  const eta = quote['eta_minutes'] as number | null;
  if (eta) {
    lines.push(`⏱️ *Previsão de entrega:* ~${eta} minutos`);
  }
  if (deadlineHour != null) {
    lines.push(`⏰ Já pedi pra chegar até as ${deadlineHour}h — fico de olho e te aviso.`);
  }

  lines.push('\nA farmácia foi notificada. Qualquer dúvida, é só me chamar! 💙');
  return lines.join('\n');
}

// ─── Buscar exames no portal do laboratório ──────────────────────────────────
// Desenho e recusas de princípio: docs/PLANO_EXAMES_LAB.md.

interface FetchLabArgs {
  laboratorio?: string;
  portal_url?: string;
  login?: string;
  senha?: string;
  protocolo?: string;
}

const LAB_FETCH_POLICY = 'lab-fetch-1.0';
const LAB_FETCH_MAX_POR_DIA = 3;

/** A pessoa disse SIM, com as palavras dela, nesta mensagem? Determinístico, sem modelo. */
export function autorizouBuscaNoPortal(texto: string | null | undefined): boolean {
  const t = (texto ?? '').trim().toLowerCase();
  if (!t) return false;
  // Negação em qualquer lugar vence: "não, pode deixar" / "sim, mas não agora".
  // Fronteira só ANTES da palavra e por `(^|\s)`: "deixa" precisa casar "deixar", e o `\b`
  // do JavaScript não conhece acento (regra da casa — 3 alternativas do regex de emergência
  // ficaram mortas meses por isso).
  if (/(^|\s)(n[ãa]o|nunca|deix|depois|espera)/.test(t)) return false;
  return /^(sim|pode|autorizo|autorizado|ok|okay|claro|vai|bora|isso|quero|confirmo|beleza|manda|busca)(\s|$|[!.,])/.test(t);
}

async function handleFetchLabResults(args: FetchLabArgs, ctx: ToolContext): Promise<void> {
  if (!labFetchDisponivel()) {
    throw new ToolFailure('NADA FOI FEITO: buscar exames no site do laboratório não está disponível agora. Diga que ela pode mandar o PDF que você lê e guarda.');
  }
  const login = (args.login ?? '').trim();
  const senha = (args.senha ?? '').trim();
  const laboratorio = (args.laboratorio ?? '').trim() || null;
  if (!login || !senha) {
    throw new ToolFailure('NADA FOI FEITO: faltou login ou senha. Se a foto não deixou claro, PERGUNTE à pessoa — não invente.');
  }

  // 🔐 GATE DE CONSENTIMENTO — a prova é a fala da pessoa, não a sua afirmação de que ela
  // concordou. A mensagem de entrada DESTE turno precisa ser um "sim" inequívoco.
  const textoDaPessoa = ctx.inboundMsg?.content ?? '';
  if (!autorizouBuscaNoPortal(textoDaPessoa)) {
    throw new ToolFailure(
      'NADA FOI FEITO: a pessoa ainda NÃO autorizou explicitamente nesta mensagem. Pergunte: '
      + '"Quer que eu entre no site do laboratório com esse acesso e busque seus resultados? Uso o login uma vez e não guardo a senha. Responde sim pra autorizar." '
      + 'Só chame de novo quando ela responder sim.',
    );
  }

  // Rate limit por pessoa: 3/dia. Cada busca abre um navegador e digita uma senha em site
  // de terceiro — não é coisa de repetir em loop.
  const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await db.from('lab_fetches').select('id', { count: 'exact', head: true })
    .eq('user_id', ctx.userId).gte('created_at', desde).in('status', ['na_fila', 'rodando', 'concluida']);
  if ((count ?? 0) >= LAB_FETCH_MAX_POR_DIA) {
    throw new ToolFailure('NADA FOI FEITO: já foram 3 buscas hoje para esta pessoa. Diga que amanhã dá pra tentar de novo, ou que ela pode mandar o PDF.');
  }

  // Consentimento registrado ANTES de enfileirar, apontando para a mensagem dela.
  const { data: consent } = await db.from('consent_events').insert({
    user_id: ctx.userId, event_type: 'accept', policy_version: LAB_FETCH_POLICY, channel: 'whatsapp',
    evidence_message_id: ctx.inboundMsg?.id ?? null, evidence_text: textoDaPessoa.slice(0, 300),
  }).select('id').single();

  const { data: fetch, error } = await db.from('lab_fetches').insert({
    user_id: ctx.userId, conversation_id: ctx.conversationId, laboratorio,
    status: 'na_fila', consent_event_id: (consent?.id as string | undefined) ?? null,
  }).select('id').single();
  if (error || !fetch?.id) {
    throw new ToolFailure('NADA FOI FEITO: não consegui registrar a busca. Diga que houve um problema do seu lado e que ela pode mandar o PDF.');
  }

  const chave = chaveDoCofre();
  if (!chave) throw new ToolFailure('NADA FOI FEITO: cofre indisponível.');
  const credenciaisCifradas = cifrar(JSON.stringify({ login, senha, protocolo: (args.protocolo ?? '').trim() || null }), chave);

  await enqueueLabFetch({
    fetchId: fetch.id as string, userId: ctx.userId, conversationId: ctx.conversationId, phoneE164: ctx.phoneE164,
    traceId: ctx.traceId, laboratorio, portalUrl: (args.portal_url ?? '').trim() || null, credenciaisCifradas,
  });

  await writeAudit({
    actorType: 'user', actorId: ctx.userId, action: 'lab_fetch.requested', userId: ctx.userId,
    conversationId: ctx.conversationId, targetTable: 'lab_fetches', targetId: fetch.id as string,
    messageId: ctx.inboundMsg?.id ?? null, traceId: ctx.traceId,
    metadata: { laboratorio, consentEventId: consent?.id ?? null },
  });
  await writeLog('info', 'lab', 'busca de exames enfileirada (consentimento registrado)', { traceId: ctx.traceId, userId: ctx.userId });
}
