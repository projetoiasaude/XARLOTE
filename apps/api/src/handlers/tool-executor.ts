import { db, writeLog, auditToolCall, writeAudit, saveMemoryCard } from '@iasaude/db';
import { extractStructured } from '@iasaude/llm';
import { PRESCRIPTION_OCR_PROMPT } from '@iasaude/llm';
import type { ToolCall } from '@iasaude/llm';
import type { NormalizedInbound, Message, OrderItem } from '@iasaude/shared';
import { resolveReminderFirstRun, isPlaceholderPhone, toE164BR, parseRrule, isPharmacyChain, sameMedication, shortSupplierAddress, itemDisplayName, extractAcceptConditions, humanizePaymentLabel, isServiceNumber } from '@iasaude/shared';
import { findNearbyPharmacies, geocodeAddress, reverseGeocode, reverseGeocodeNominatim, getPlacePhone } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { loadPrompts } from '../config/prompts.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';
import { scheduleQuoteTimeout, sendCurrentOrderStatus } from './quote-consolidation.js';
import { relayUserAnswerToEstablishment } from './clarification.js';
import { handleFindByName, handleContactEstablishment } from './reach-out.js';
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

/**
 * Extrai um identificador curto do endereço pra usar na cotação com a farmácia:
 * formato "Rua/Avenida X, Setor/Bairro Y" (sem número, sem CEP, sem cidade/UF).
 * Endereço completo + lat/lng só são repassados na confirmação do pedido.
 *
 * Nominatim típico: "Avenida Interligação, Setor Santa Rita VII, Goiânia, Região..., Goiás, 74999-999, Brasil"
 * ViaCEP típico:    "R. 14, 201, St. Oeste, Goiânia, Goiás"
 */
function extractDeliverySector(fullAddress: string | null): string | null {
  if (!fullAddress) return null;
  // Strings sintéticas (sem reverse geocoding) não rendem extração — caller usa fallback.
  if (/Localização compartilhada|^lat\s|coordenadas?\b/i.test(fullAddress)) return null;

  const parts = fullAddress.split(',').map((s) => s.trim()).filter(Boolean);
  const ignoreLow = /^(região|brasil|brazil|região centro-oeste|mesorregião|microrregião)/i;
  const isStreet = /^(rua|r\.?|avenida|av\.?|alameda|al\.?|travessa|tv\.?|rodovia|rod\.?|praça|pç\.?|estrada|via|quadra|qd\.?)\b/i;
  const isOnlyNumber = /^\d+[a-zA-Z]?$/;
  const isCep = /^\d{5}-?\d{3}$/;
  const isUf = /^([A-Z]{2}|Goiás|Goias|São Paulo|Rio de Janeiro|Minas Gerais|Bahia|Paraná|Pernambuco|Ceará|Pará|Distrito Federal|Mato Grosso|Mato Grosso do Sul|Espírito Santo|Santa Catarina|Rio Grande do Sul|Rio Grande do Norte|Alagoas|Sergipe|Paraíba|Piauí|Maranhão|Tocantins|Acre|Amapá|Amazonas|Rondônia|Roraima)$/i;

  let street: string | null = null;
  let sector: string | null = null;

  for (const p of parts) {
    if (ignoreLow.test(p) || isCep.test(p) || isOnlyNumber.test(p) || isUf.test(p)) continue;
    if (isStreet.test(p)) {
      if (!street) street = p;
      continue;
    }
    if (!sector) {
      sector = p;
      if (street) break;
    }
  }

  const result = [street, sector].filter(Boolean).join(', ');
  return result || null;
}

interface ToolContext {
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  inboundMsg: Message;
  inbound: NormalizedInbound;
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
  turnFlags?: { suppressLlmText: boolean };
}

export async function handleToolCall(tc: ToolCall, ctx: ToolContext): Promise<void> {
  const taskId = await recordTaskStart(tc, ctx);
  const startedAt = Date.now();

  try {
    switch (tc.name) {
      case 'save_user_profile_fact':
        await handleSaveProfileFact(tc.args as { category: string; payload: Record<string, unknown> }, ctx);
        break;
      case 'request_user_location':
        // Xarlote will say it in text; nothing else needed
        break;
      case 'parse_prescription_image':
        await handleParsePrescription(tc.args as { message_id: string }, ctx);
        break;
      case 'save_exam_result':
        await handleSaveExamResult(tc.args as unknown as SaveExamArgs, ctx);
        break;
      case 'start_pharmacy_order':
        await handleStartPharmacyOrder(tc.args as { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string }, ctx);
        break;
      case 'create_reminder':
        await handleCreateReminder(tc.args as { type: string; title: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> }, ctx);
        break;
      case 'cancel_reminders':
        await handleCancelReminders(tc.args as { title_query?: string; all?: boolean }, ctx);
        break;
      case 'list_reminders':
        await handleListReminders(ctx);
        break;
      case 'send_emergency_orientation':
        // DEPRECATED — redireciona pra red_flag_check (que envia botões).
        // Mantido como fallback compat enquanto modelos antigos do LLM ainda usam.
        await writeLog('warn', 'tool', 'send_emergency_orientation chamada (deprecated) — redirecionando pra red_flag_check', { traceId: ctx.traceId });
        await handleRedFlagCheck({
          category: 'other_critical',
          severity: 'high',
          evidence: (tc.args as { symptoms_summary?: string }).symptoms_summary ?? 'situação reportada como emergência',
        }, ctx);
        break;
      case 'get_order_status':
        await handleGetOrderStatus(ctx);
        break;
      case 'expand_pharmacy_search':
        await handleExpandPharmacySearch(ctx);
        break;
      case 'message_supplier':
        await handleMessageSupplier(tc.args as { supplier_hint?: string; message?: string }, ctx);
        break;
      case 'confirm_order_selection':
        await handleConfirmOrder(tc.args as { order_id: string; quote_id: string }, ctx);
        break;
      case 'cancel_order':
        await handleCancelOrder(tc.args as { order_id?: string; reason?: string }, ctx);
        break;
      case 'find_clinic_by_name':
        await handleFindByName(tc.args as { name: string; city?: string; specialty?: string }, ctx);
        break;
      case 'contact_establishment':
        await handleContactEstablishment(tc.args as { phone?: string; name?: string; kind?: 'clinic' | 'pharmacy'; specialty?: string; items?: OrderItem[] }, ctx);
        break;
      case 'relay_answer_to_establishment':
        // Loop agêntico: o cliente respondeu a uma pergunta de farmácia/clínica.
        // Devolve a resposta ao estabelecimento certo (farmácia ou clínica) e a
        // negociação continua de onde parou.
        await relayUserAnswerToEstablishment(ctx.conversationId, (tc.args as { answer?: string }).answer ?? '', ctx.traceId);
        break;
      // ─── Xarlote 2.0 ──────────────────────────────────────────────────────
      case 'start_treatment_from_order':
        await handleStartTreatmentFromOrder(tc.args as unknown as StartTreatmentArgs, ctx);
        break;
      case 'log_medication_taken':
        await handleLogMedicationTaken(tc.args as unknown as LogMedicationTakenArgs, ctx);
        break;
      case 'update_treatment_status':
        await handleUpdateTreatmentStatus(tc.args as unknown as UpdateTreatmentStatusArgs, ctx);
        break;
      case 'log_symptom':
        await handleLogSymptom(tc.args as unknown as LogSymptomArgs, ctx);
        break;
      case 'query_my_addresses':
        // Não faz nada server-side — a Xarlote já tem os endereços no user_360 context.
        // Tool é "marker" pra a LLM saber que o user perguntou.
        break;
      case 'set_default_address':
        await handleSetDefaultAddress(tc.args as unknown as { address_label: string }, ctx);
        break;
      case 'save_address':
        await handleSaveAddress(tc.args as unknown as { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean }, ctx);
        break;
      case 'start_consultation_search':
        await handleStartConsultationSearch(tc.args as unknown as StartConsultationArgs, ctx);
        break;
      case 'confirm_consultation_selection':
        await handleConfirmConsultation(tc.args as unknown as { consultation_id: string; quote_id: string }, ctx);
        break;
      case 'cancel_consultation':
        await handleCancelConsultation(tc.args as unknown as { consultation_id: string; reason: string }, ctx);
        break;
      case 'red_flag_check': {
        // Handler envia BOTÕES diretos pra uazapi + agenda escalation 60s.
        // Não devolve texto pra Xarlote — paciente vai responder via botão.
        await handleRedFlagCheck(tc.args as unknown as RedFlagArgs, ctx);
        break;
      }
      case 'set_emergency_contact':
        await handleSetEmergencyContact(tc.args as unknown as SetEmergencyContactArgs, ctx);
        break;
      default:
        break;
    }
    await db.from('assistant_tasks').update({ status: 'success', tool_output: tc.args, completed_at: new Date().toISOString() }).eq('id', taskId);
    await auditToolCall({
      toolName: tc.name,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      traceId: ctx.traceId,
      args: (tc.args as Record<string, unknown>) ?? {},
      result: 'success',
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    await db.from('assistant_tasks').update({ status: 'error', error: String(err), completed_at: new Date().toISOString() }).eq('id', taskId);
    await auditToolCall({
      toolName: tc.name,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      traceId: ctx.traceId,
      args: (tc.args as Record<string, unknown>) ?? {},
      result: 'failure',
      error: String(err).slice(0, 240),
      durationMs: Date.now() - startedAt,
    });
  }
}

async function recordTaskStart(tc: ToolCall, ctx: ToolContext): Promise<string> {
  const { data } = await db.from('assistant_tasks').insert({
    conversation_id: ctx.conversationId,
    user_id: ctx.userId,
    tool_name: tc.name,
    tool_input: tc.args,
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

  switch (args.category) {
    case 'condition':
      await db.from('user_health_conditions').insert({
        user_id: ctx.userId,
        name: String(args.payload['name'] ?? ''),
        ...pick(['severity', 'notes', 'active']),
        source: 'self_reported',
      });
      break;
    case 'allergy':
      await db.from('user_allergies').insert({
        user_id: ctx.userId,
        substance: String(args.payload['substance'] ?? args.payload['name'] ?? ''),
        ...pick(['severity', 'reaction']),
        source: 'self_reported',
      });
      break;
    case 'medication':
      await db.from('user_medications').insert({
        user_id: ctx.userId,
        medication_name: String(args.payload['medication_name'] ?? args.payload['name'] ?? ''),
        ...pick(['dosage', 'frequency', 'form', 'active']),
        source: 'self_reported',
      });
      break;
    case 'address': {
      await db.from('user_addresses').insert({
        user_id: ctx.userId,
        label: String(args.payload['label'] ?? 'principal'),
        ...pick(['street', 'number', 'complement', 'neighborhood', 'city', 'state', 'cep', 'is_default', 'latitude', 'longitude']),
      });
      break;
    }
    default: {
      // MERGE no metadata — substituir o objeto inteiro apagava fatos anteriores.
      const { data: u } = await db.from('users').select('metadata').eq('id', ctx.userId).maybeSingle();
      const merged = { ...((u?.metadata as Record<string, unknown>) ?? {}), ...args.payload };
      await db.from('users').update({ metadata: merged }).eq('id', ctx.userId);
    }
  }
}

async function handleParsePrescription(args: { message_id: string }, ctx: ToolContext) {
  // Find the image message
  const { data: msg } = await db.from('messages').select('*').eq('id', args.message_id).single();
  if (!msg?.media_storage_path && !ctx.inbound.mediaBase64) return;

  const base64 = ctx.inbound.mediaBase64 ?? null;
  if (!base64) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Não consegui processar a imagem da receita. Pode mandar de novo? 📋', ctx.traceId);
    return;
  }

  interface OcrResult {
    error?: string;
    items?: Array<{ medication_name: string; dosage?: string; quantity?: string; frequency?: string }>;
    doctor?: { name?: string; crm?: string; uf?: string };
    issued_at?: string;
    raw_text?: string;
  }

  const parsed = await extractStructured<OcrResult>(PRESCRIPTION_OCR_PROMPT, base64, ctx.inbound.mediaMime ?? 'image/jpeg');

  if (parsed.error === 'not_a_prescription') {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Não parece ser uma receita médica. Pode mandar a foto certinha? 📋', ctx.traceId);
    return;
  }

  const { data: prescription } = await db.from('prescriptions').insert({
    user_id: ctx.userId,
    message_id: args.message_id,
    ocr_raw_text: parsed.raw_text,
    parsed_json: parsed,
    doctor_name: parsed.doctor?.name,
    doctor_crm: parsed.doctor?.crm,
    doctor_uf: parsed.doctor?.uf,
    issued_at: parsed.issued_at,
  }).select('id').single();

  if (prescription?.id && parsed.items) {
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
  message_id?: string;
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
    return;
  }
  const findings = Array.isArray(args.findings) ? args.findings : [];
  const examDate = parseExamDate(args.exam_date);

  const { data: row, error } = await db.from('user_exam_results').insert({
    user_id: ctx.userId,
    message_id: args.message_id ?? ctx.inboundMsg?.id ?? null,
    conversation_id: ctx.conversationId,
    exam_type: args.exam_type,
    title: args.title,
    summary: args.summary ?? null,
    findings,
    exam_date: examDate,
    source: 'vision',
  }).select('id').single();

  if (error) {
    await writeLog('error', 'exam', `Falha ao salvar exame: ${error.message}`, { traceId: ctx.traceId, userId: ctx.userId });
    return;
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

/**
 * Cancela um pedido de medicamento: marca 'cancelled', congela as cotações vivas
 * e fecha clarificações pendentes — assim os workers (nudge/rescue) não re-cutucam
 * um pedido morto. Idempotente: cancelar um pedido já terminal é no-op benigno (o
 * filtro `.in(status, ACTIVE)` não casa nada). NÃO avisa as farmácias (evita spam;
 * respostas tardias caem no guard de status do inbound-supplier). Mesmo status
 * terminal 'timeout' usado no freeze de cotações irmãs do confirm_order_selection.
 */
async function cancelActiveOrder(orderId: string, reason: string, traceId: string): Promise<boolean> {
  // Checa o erro do update do PEDIDO (review hardening): se falhar (DB transiente), o
  // caller da TROCA aborta em vez de criar um 2º pedido vivo com o antigo ainda ativo.
  const { error: ordErr } = await db.from('orders')
    .update({ status: 'cancelled', cancelled_reason: reason.slice(0, 500) })
    .eq('id', orderId)
    .in('status', ACTIVE_ORDER_STATUSES);
  if (ordErr) {
    await writeLog('error', 'order', `Falha ao cancelar pedido ${orderId}: ${String(ordErr.message ?? ordErr).slice(0, 160)}`, { traceId, orderId });
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
  const createdThisTurn = ctx.ordersCreatedThisTurn;
  let targetId: string | null = null;

  if (args.order_id) {
    // order_id FOI passado (o schema exige) → é O pedido nomeado. Só cancela se ele
    // pertencer a ESTE usuário, estiver ATIVO e NÃO tiver sido criado neste turno.
    // Se foi passado mas não resolve pra ativo (já terminal / de outro usuário /
    // alucinado / recém-criado) → NO-OP. NUNCA cai no "cancela o mais recente" — era
    // o HIGH-1: na ordem start→cancel, o fallback cancelava o pedido NOVO recém-criado.
    if (!createdThisTurn?.has(args.order_id)) {
      const { data: byId } = await db
        .from('orders')
        .select('id, status, user_id')
        .eq('id', args.order_id)
        .maybeSingle();
      if (byId && byId.user_id === ctx.userId && ACTIVE_ORDER_STATUSES.includes(byId.status as string)) {
        targetId = byId.id as string;
      }
    }
  } else {
    // order_id AUSENTE (raro — schema exige) → aí sim o pedido ativo mais recente do
    // próprio usuário, EXCLUINDO qualquer um criado neste turno (blindagem HIGH-1).
    const { data: actives } = await db
      .from('orders')
      .select('id')
      .eq('user_id', ctx.userId)
      .in('status', ACTIVE_ORDER_STATUSES)
      .order('created_at', { ascending: false })
      .limit(5);
    targetId = (actives ?? []).map((o) => o.id as string).find((id) => !createdThisTurn?.has(id)) ?? null;
  }

  if (!targetId) {
    await writeLog('info', 'order', 'cancel_order — nenhum pedido ativo elegível pra cancelar (no-op)', {
      traceId: ctx.traceId, orderIdArg: args.order_id ?? null,
    });
    return;
  }

  await cancelActiveOrder(targetId, args.reason ?? 'cancelado pelo usuário', ctx.traceId);
}

/**
 * Salva/atualiza um endereço ROTULADO do usuário (casa/trabalho/outro) pra reusar
 * depois via start_pharmacy_order(saved_address_label). Fonte da localização:
 * (1) full_address se geocodifica PRECISO; senão (2) a localização EXATA do último
 * pedido (caso 📍/salvar-o-que-acabei-de-usar); senão pede o endereço.
 * NUNCA loga o endereço (PII — CLAUDE.md #3): só o label + id.
 */
async function handleSaveAddress(
  args: { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean },
  ctx: ToolContext,
): Promise<void> {
  const label = (args.label ?? '').trim() || 'principal';
  let lat: number | null = null;
  let lng: number | null = null;
  let addrText: string | null = (args.full_address ?? '').trim() || null;
  const hadText = !!addrText;

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

  // 3. Componentes estruturados (best-effort) pra exibir bonitinho depois.
  let street: string | null = null, number: string | null = null, neighborhood: string | null = null;
  let city: string | null = null, state: string | null = null, cep: string | null = null;
  try {
    const nomi = await reverseGeocodeNominatim(lat, lng);
    if (nomi) {
      street = nomi.road ?? null; number = nomi.houseNumber ?? null;
      neighborhood = nomi.neighborhood ?? null; city = nomi.city ?? null;
      state = nomi.state ?? null; cep = nomi.postcode ?? null;
    }
  } catch { /* best-effort — coords bastam */ }
  // Se o geocode não trouxe rua mas temos o texto do usuário, guarda o texto como rua.
  if (!street && addrText) street = addrText.slice(0, 180);

  // 4. Upsert por (user, label) — atualiza se já existe esse rótulo.
  const { data: existing } = await db.from('user_addresses')
    .select('id').eq('user_id', ctx.userId).ilike('label', escapeLike(label)).limit(1).maybeSingle();
  const row: Record<string, unknown> = {
    user_id: ctx.userId, label,
    street, number, complement: (args.complement ?? '').trim() || null,
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
    if (args.set_default === true || (count ?? 0) <= 1) {
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
}

async function handleStartPharmacyOrder(
  args: { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string },
  ctx: ToolContext
) {
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
    await writeLog('info', 'geocoding', `Geocodificando endereço: ${args.location.address}`, { traceId: ctx.traceId });
    const geo = await geocodeAddress(args.location.address);
    if (geo && geo.confidence === 'precise') {
      lat = geo.lat;
      lng = geo.lng;
      deliveryAddress = geo.formattedAddress || args.location.address;
      locationSource = `geocoded:${geo.formattedAddress}`;
      await writeLog('info', 'geocoding', `Endereço localizado (preciso): ${geo.formattedAddress} → ${lat.toFixed(5)},${lng.toFixed(5)}`, { traceId: ctx.traceId, lat, lng });
    } else if (geo && geo.confidence === 'low') {
      // Geocoder caiu no fallback de cidade/estado — provavelmente bairro/rua não existe.
      // Não usa pra busca local (centro da cidade pode estar a km do usuário); pede refinamento.
      await writeLog('warn', 'geocoding', `Match impreciso (só cidade/UF): ${geo.formattedAddress} — pedindo refinamento`, {
        traceId: ctx.traceId, queriedAddress: args.location.address, matched: geo.formattedAddress,
      });
      await sendOutbound(
        ctx.conversationId,
        ctx.phoneE164,
        `Hmm, não consegui achar esse endereço exato no mapa 😕 Confere pra mim o nome do bairro/setor e o CEP? Ou se preferir, compartilha sua localização pelo botão 📍 que fica mais rápido 💙`,
        ctx.traceId,
      );
      return;
    } else {
      await writeLog('warn', 'geocoding', `Endereço não encontrado: ${args.location.address}`, { traceId: ctx.traceId });
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
        await writeLog('info', 'geocoding', `Reverse geocode (Nominatim): ${nomi.shortAddress}`, {
          traceId: ctx.traceId, lat, lng,
          road: nomi.road, neighborhood: nomi.neighborhood, city: nomi.city, postcode: nomi.postcode,
        });
      } else {
        const goog = await reverseGeocode(lat, lng).catch(() => null);
        if (goog) {
          deliveryAddress = goog;
          await writeLog('info', 'geocoding', `Reverse geocode (Google fallback): ${goog}`, {
            traceId: ctx.traceId, lat, lng,
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

  // Só avisa que está buscando quando já tem coordenadas
  await sendOutbound(
    ctx.conversationId,
    ctx.phoneE164,
    'Ótimo! Estou buscando farmácias reais próximas a você agora 🔍 Aguarda alguns instantes!',
    ctx.traceId,
  );

  await writeLog('info', 'order', `Criando pedido — localização: ${lat.toFixed(5)},${lng.toFixed(5)} (fonte: ${locationSource})`, {
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

  await startPharmacyDiscovery(order.id, lat, lng, args.items, deliveryAddress, args.payment_method ?? null, ctx);
}

async function startPharmacyDiscovery(
  orderId: string,
  lat: number,
  lng: number,
  items: OrderItem[],
  deliveryAddress: string | null,
  paymentMethod: string | null,
  ctx: ToolContext
) {
  await writeLog('info', 'places', `Buscando farmácias via Google Places — centro: ${lat.toFixed(5)},${lng.toFixed(5)}, raio: 3km`, {
    traceId: ctx.traceId, orderId, lat, lng,
  });

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
  const independentes = pharmacies.filter((p) => !isPharmacyChain(p.name)).sort(byDist);
  const redes = pharmacies.filter((p) => isPharmacyChain(p.name)).sort(byDist);
  const top = [...independentes, ...redes].slice(0, 5);
  await writeLog('info', 'places', `Seleção Top-${top.length}: ${independentes.length} independente(s) priorizada(s), ${redes.length} rede(s) ao fim`, {
    traceId: ctx.traceId, orderId,
    selecionadas: top.map((p) => `${p.name}${isPharmacyChain(p.name) ? ' [rede]' : ''}`),
  });
  const quoteIds: string[] = [];
  let semTelefone = 0;

  for (const pharmacy of top) {
    // 📞 Puxa o TELEFONE REAL via Place Details — a busca básica do Places NÃO traz
    // telefone. Sem isto, a farmácia ficava sem número e o código fabricava um FAKE
    // (+555500000<id>) → disparo pra número aleatório (incidente 2026-07-01). Mesmo
    // padrão da clínica. Custa 1 request por farmácia (top-5) — aceitável.
    let phoneE164: string | null = null;
    try {
      phoneE164 = toE164BR(await getPlacePhone(pharmacy.placeId));
    } catch (err) {
      await writeLog('warn', 'places', `Falha ao buscar telefone da farmácia ${pharmacy.name}: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
    }

    // Não sobrescreve um telefone já conhecido com null (se o Details falhar agora).
    const upsertData: Record<string, unknown> = {
      type: 'pharmacy', name: pharmacy.name, google_place_id: pharmacy.placeId,
      address: pharmacy.address, city: pharmacy.city, state: pharmacy.state,
      latitude: pharmacy.lat, longitude: pharmacy.lng, rating: pharmacy.rating,
      reviews: pharmacy.userRatingCount, status: 'active',
    };
    if (phoneE164) { upsertData['phone_e164'] = phoneE164; upsertData['whatsapp_e164'] = phoneE164; }

    const { data: supplier } = await db.from('suppliers').upsert(upsertData, { onConflict: 'google_place_id' })
      .select('id, whatsapp_e164, phone_e164').single();
    if (!supplier?.id) continue;

    // Só cria cotação (= só CONTATA) farmácia com telefone REAL. Sem número → fica no
    // diretório mas NÃO é contatada. NUNCA fabricar número (ver isPlaceholderPhone).
    const reachable = supplier.whatsapp_e164 || supplier.phone_e164;
    // isServiceNumber: 4002/0800/3003 é call-center (caso Pague Menos 4002-8282) — não é
    // WhatsApp de loja; cotar ali é jogar mensagem no void.
    if (!reachable || isPlaceholderPhone(reachable) || isServiceNumber(reachable)) { semTelefone++; continue; }

    const { data: quote } = await db.from('quotes').insert({
      order_id: orderId,
      supplier_id: supplier.id,
      status: 'pending',
      distance_km: pharmacy.distanceKm,
    }).select('id').single();

    if (quote?.id) quoteIds.push(quote.id);
  }
  if (semTelefone > 0) {
    await writeLog('warn', 'places', `${semTelefone} farmácia(s) sem telefone no Places — NÃO contatadas (nunca fabricar número)`, { traceId: ctx.traceId, orderId });
  }

  // Nenhuma farmácia com telefone real → NÃO tem quem contatar. Avisa com franqueza
  // (nunca fabricar número) e encerra o pedido em vez de fingir que contatou.
  if (quoteIds.length === 0) {
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
    farmácias: top.map((p, i) => `${i + 1}. ${p.name} (${p.distanceKm?.toFixed(2)}km)`),
  });

  // Notifica o usuário que farmácias foram encontradas e contatos iniciaram
  await sendOutbound(
    ctx.conversationId,
    ctx.phoneE164,
    `Achei ${quoteIds.length} farmácia${quoteIds.length > 1 ? 's' : ''} aqui na sua região e já entrei em contato com ${quoteIds.length > 1 ? 'elas' : 'ela'} ✨ assim que chegarem as respostas eu te aviso na hora.`,
    ctx.traceId,
  );

  // Setor/bairro real do usuário pra passar pra farmácia (não a cidade da farmácia em si).
  const userNeighborhood =
    extractDeliverySector(deliveryAddress) ||
    (top[0]?.city ? `${top[0].city}` : `lat ${lat.toFixed(4)}, lng ${lng.toFixed(4)}`);

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
    return;
  }

  await sendCurrentOrderStatus(order.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
}

/**
 * AMPLIA a busca de um pedido ativo (incidente Cefaliv 06/07 — o usuário pediu pra
 * buscar mais longe e a Xarlote não sabia). Re-descobre farmácias num raio MAIOR,
 * EXCLUI as já contatadas neste pedido (por google_place_id) e contata só as NOVAS,
 * adicionando ao mesmo pedido. Reabre o pedido pra 'quoting' (modo eager) pra as novas
 * cotações serem apresentadas conforme chegam.
 */
async function handleExpandPharmacySearch(ctx: ToolContext) {
  if (!loadPrompts().pharmacy_outbound_enabled) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'O disparo pra farmácias está pausado no momento 💙 Já já volto a buscar pra você.', ctx.traceId);
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
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Não achei um pedido ativo pra ampliar a busca 💙 Me fala o medicamento e o endereço que eu começo uma busca nova.', ctx.traceId);
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
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Procurei num raio maior mas não achei farmácias NOVAS além das que já falei por aqui 😕 Se quiser, me manda outro endereço que eu busco numa região diferente.', ctx.traceId);
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
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Achei farmácias novas mais longe, mas nenhuma com WhatsApp pra eu cotar agora 😕', ctx.traceId);
    return;
  }

  await writeLog('info', 'order', `Busca ampliada: +${quoteIds.length} farmácias novas (raio 10km)`, { traceId: ctx.traceId, orderId: order.id });
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Ampliei a busca! 🔎 Contatei mais ${quoteIds.length} farmácia${quoteIds.length > 1 ? 's' : ''} nova${quoteIds.length > 1 ? 's' : ''} num raio maior. Assim que responderem, te aviso na hora 💙`, ctx.traceId);

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
  const say = async (text: string) => {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, text, ctx.traceId);
    if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
  };
  // Kill-switch de disparo (a msg vai pra uma farmácia) — freio de emergência.
  if (!loadPrompts().pharmacy_outbound_enabled) {
    await say('O contato com farmácias está pausado no momento 💙 Já já volto a falar com elas pra você.');
    return;
  }
  const hint = (args.supplier_hint ?? '').trim();
  const message = (args.message ?? '').trim();
  if (!message) {
    await say('Me diz o que você quer que eu fale pra farmácia que eu mando na hora 💙');
    return;
  }

  const state = await loadLatestOrderState(ctx.userId);
  if (!state || !state.suppliers.length) {
    await say('Não achei um pedido recente com farmácias pra eu falar 💙 Se quiser, me fala o remédio e o endereço que eu começo uma busca nova.');
    return;
  }

  let target = resolveTargetSupplier(state, hint);
  // Pedido FECHADO + dica que não resolveu ("a farmácia", "eles") → a ESCOLHIDA é a única
  // conversa que importa; mira nela (sem negação no hint — negação nunca vira envio).
  if (!target && ['confirming', 'handed_off'].includes(state.status) && state.selectedQuoteId
      && !/\b(n[ãa]o|nunca|nem|menos|exceto)\b/i.test(hint)) {
    target = state.suppliers.find((s) => s.quoteId === state.selectedQuoteId) ?? null;
  }
  if (!target) {
    const nomes = state.suppliers.map((s) => s.supplierName).slice(0, 6).join(', ');
    await say(`Não tenho certeza de qual farmácia você quer que eu fale 🤔 As do seu pedido são: ${nomes}. Me diz o nome que eu mando na hora.`);
    return;
  }

  if (!target.conversationId || !target.phoneE164 || isPlaceholderPhone(target.phoneE164)) {
    await say(`Não tenho um WhatsApp válido da ${target.supplierName} pra falar direto com ela 😕 Quer que eu procure em outras farmácias?`);
    return;
  }

  // Janela de 24h (WABA/zpro): fora dela, texto livre não é entregue — seja honesta.
  if (!target.contactableFreeText) {
    await say(`Faz mais de 24h que a ${target.supplierName} não me responde, então não consigo reabrir a conversa direto com ela 😕 Quer que eu procure em outras farmácias num raio maior?`);
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
    await say('Esse pedido já foi fechado 💙 Se quiser falar com outra farmácia, me fala que eu começo um pedido novo.');
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
  await sendOutboundToSupplier(target.conversationId, target.phoneE164, message, ctx.traceId);

  await writeLog('info', 'order', `message_supplier → ${target.supplierName} (re-engajamento dirigido)`, {
    traceId: ctx.traceId, orderId: state.orderId, quoteId: target.quoteId, revived: revivedTerminal,
  });
  await say(`Prontinho, mandei pra ${target.supplierName} 💬 Assim que responderem eu te aviso aqui!`);
}

/** Escapa curingas de LIKE/ILIKE (% e _) num valor vindo da LLM/usuário. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function handleCreateReminder(
  args: { type: string; title?: string; body?: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> },
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
  const scheduledAt = args.scheduled_at?.trim() ? args.scheduled_at.trim() : null;
  const rrule = args.rrule?.trim() ? args.rrule.trim() : null;

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
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Opa, não consegui entender o horário pro lembrete "${titleForMsg}" 😅 Me fala de novo o horário certinho? Ex: "todo dia às 8h" ou "amanhã às 14h".`,
      ctx.traceId);
    return;
  }

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
  const { data: dup } = await (rrule
    ? dupQuery.eq('rrule', rrule)
    : dupQuery.eq('scheduled_at', scheduledAt ?? ''))
    .limit(1).maybeSingle();
  if (dup?.id) {
    await writeLog('info', 'tool', `create_reminder duplicado ("${title}") — já existe pendente, ignorando (idempotência)`, {
      traceId: ctx.traceId, userId: ctx.userId, existingId: dup.id,
    });
    return;
  }

  const { error: insErr } = await db.from('reminders').insert({
    user_id: ctx.userId,
    type: args.type,
    title,
    // body:"" (string vazia da LLM) → null, senão o dispatcher mandaria msg vazia.
    body: args.body?.trim() ? args.body.trim() : null,
    scheduled_at: scheduledAt,
    rrule,
    next_run_at: firstRun,
    status: 'pending',
    payload: args.payload ?? {},
  });
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

async function handleCancelReminders(args: { title_query?: string; all?: boolean }, ctx: ToolContext) {
  const q = (args.title_query ?? '').trim();
  if (!q && !args.all) {
    await writeLog('warn', 'tool', 'cancel_reminders sem title_query e sem all — ignorado', { traceId: ctx.traceId, userId: ctx.userId });
    return;
  }
  let query = db.from('reminders')
    .update({ status: 'cancelled' })
    .eq('user_id', ctx.userId)
    .eq('status', 'pending');
  if (!args.all) query = query.ilike('title', `%${escapeLike(q)}%`);
  const { data: cancelled, error } = await query.select('id, title');

  if (error) {
    await writeLog('error', 'tool', `cancel_reminders falhou: ${error.message}`, { traceId: ctx.traceId, userId: ctx.userId });
    return;
  }
  let count = cancelled?.length ?? 0;

  // FALLBACK ACENTO-INSENSÍVEL: ILIKE do Postgres não dobra diacríticos — a LLM
  // manda "agua" (sem acento) ou sinônimo e casava 0 rows EM SILÊNCIO, reabrindo o
  // E3 (planos duplicados) com falsa sensação de resolvido. Refaz o match em JS.
  if (count === 0 && !args.all && q) {
    const { data: pend } = await db.from('reminders')
      .select('id, title').eq('user_id', ctx.userId).eq('status', 'pending').limit(50);
    const qn = foldAccents(q);
    const ids = (pend ?? []).filter((r) => foldAccents(r.title ?? '').includes(qn)).map((r) => r.id);
    if (ids.length) {
      const { data: c2 } = await db.from('reminders').update({ status: 'cancelled' }).in('id', ids).select('id');
      count = c2?.length ?? 0;
    }
  }

  // AINDA 0: NÃO fica em silêncio (a LLM já pode ter dito "cancelei"). Fala a verdade.
  if (count === 0 && !args.all) {
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

  await writeLog('info', 'tool', `cancel_reminders: ${count} lembrete(s) cancelado(s) (query="${args.all ? '*' : q}")`, {
    traceId: ctx.traceId, userId: ctx.userId,
  });
  await writeAudit({
    actorType: 'xarlote',
    action: 'reminder.cancelled',
    userId: ctx.userId,
    targetTable: 'reminders',
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { count, query: args.all ? '*' : q },
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
    return;
  }
  const lines = rows.map((r) => `• *${r.title}* — ${describeReminder(r.rrule, r.next_run_at)}`);
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Seus lembretes ativos 📋\n\n${lines.join('\n')}\n\nQuer mudar ou cancelar algum? É só falar!`, ctx.traceId);
}

async function handleConfirmOrder(args: { order_id: string; quote_id: string }, ctx: ToolContext) {
  // 0. IDEMPOTÊNCIA: se o pedido já saiu de 'quoted' (já foi confirmado por outro
  // turno concorrente / backstop), NÃO re-executa — senão manda 2ª msg à farmácia +
  // 2ª msg de pagamento ao usuário. Só segue se a transição quoted/quoting→confirming
  // pegar de fato (ou se já é este mesmo quote sendo re-tentado no mesmo estado).
  const { data: ord0 } = await db.from('orders').select('status, selected_quote_id').eq('id', args.order_id).maybeSingle();
  if (ord0 && ['confirming', 'handed_off', 'cancelled'].includes(ord0.status)) {
    await writeLog('info', 'order', `confirm_order_selection ignorado — pedido já '${ord0.status}' (idempotência)`, {
      traceId: ctx.traceId, orderId: args.order_id, quoteId: args.quote_id,
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
    .single();

  if (!quote) {
    await writeLog('error', 'order', `Quote ${args.quote_id} not found for confirmation — pedido intacto`, { traceId: ctx.traceId, orderId: args.order_id });
    return;
  }
  if (quote.order_id !== args.order_id) {
    await writeLog('error', 'order', `Quote ${args.quote_id} não pertence ao pedido ${args.order_id} — confirmação abortada (pedido intacto)`, { traceId: ctx.traceId, quoteOrderId: quote.order_id });
    return;
  }

  // 2. Só AGORA transiciona o pedido pra 'confirming' + registra a escolha.
  await db.from('orders').update({ status: 'confirming', selected_quote_id: args.quote_id }).eq('id', args.order_id);

  // 3. CONGELA as cotações IRMÃS (Fix #2 — freeze): o usuário escolheu; as outras
  // farmácias do MESMO pedido param de negociar (senão uma retardatária reabre a
  // decisão com "aceita 20 em vez de 30?" ou registra preço e polui o estado).
  // Fecha por order_id (não conversation_id — telefone compartilhado pode ter outro
  // pedido) e só as que ainda estão vivas; limpa clarificação pendente das irmãs.
  await db.from('quotes')
    .update({ status: 'timeout', completed_at: new Date().toISOString() })
    .eq('order_id', args.order_id)
    .neq('id', args.quote_id)
    .in('status', ['pending', 'contacting', 'negotiating']);
  // Fecha clarificação pendente em TODAS as cotações do pedido — INCLUSIVE a escolhida
  // (review): senão a quote escolhida fica 'awaiting_user' e o nudge-worker re-cutuca o
  // cliente sobre um pedido JÁ FECHADO. Sem .neq de propósito.
  await db.from('quotes')
    .update({ clarification_status: 'closed' })
    .eq('order_id', args.order_id)
    .eq('clarification_status', 'awaiting_user');

  // 4. Load order items + delivery address + payment method (+ endereço salvo com nº/complemento)
  const { data: order } = await db
    .from('orders')
    .select('items, delivery_address, delivery_lat, delivery_lng, payment_method, user_address_id')
    .eq('id', args.order_id)
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

    // Variação leve pra não soar template (mesma pessoa não fala igual sempre).
    const openings = ['fechou! pode preparar', 'show, fechado! pode separar', 'fechou então, pode preparar'];
    const opening = openings[Math.abs(args.order_id.charCodeAt(0) + args.order_id.charCodeAt(3)) % openings.length] as string;
    const msg1 = `${opening} ${itemsInline} pra mim`;

    // Prazo em fala natural — SÓ quando extraímos uma HORA clara do aceite. Cláusula livre
    // (ex.: "vai ser cartão", "obrigado") NÃO vai pra farmácia (review: mandaria ruído tipo
    // "Só uma coisa: obrigado" — o exato tell de robô). A cláusula fica só no estado interno.
    const deadlinePart = conditions.deadlineHour != null
      ? ` ah, e preciso que chegue até as ${conditions.deadlineHour}${conditions.deadlineMinute ? `:${String(conditions.deadlineMinute).padStart(2, '0')}` : ''}h, consegue?`
      : '';
    const addrPart = addrHuman ? `o endereço é ${addrHuman}` : 'já te passo o endereço certinho';
    const msg2 = `${addrPart} — pagamento no ${paymentLabel}, tá?${deadlinePart} me avisa quando sair pra entrega 🙏`;

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
  }).eq('id', args.order_id);

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

  await writeLog('info', 'order', `Pedido finalizado — handed_off para ${supplierName}`, {
    traceId: ctx.traceId, orderId: args.order_id, quoteId: args.quote_id,
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
    const freteStr = deliveryFee != null ? ` (frete R$${Number(deliveryFee).toFixed(2)})` : '';
    lines.push(`💰 *Total:* R$${Number(total).toFixed(2)}${freteStr}`);
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
