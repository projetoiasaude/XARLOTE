import { db, writeLog, auditToolCall, writeAudit, saveMemoryCard } from '@iasaude/db';
import { extractStructured } from '@iasaude/llm';
import { PRESCRIPTION_OCR_PROMPT } from '@iasaude/llm';
import type { ToolCall } from '@iasaude/llm';
import type { NormalizedInbound, Message, OrderItem } from '@iasaude/shared';
import { resolveReminderFirstRun, isPlaceholderPhone, toE164BR, parseRrule, isPharmacyChain, sameMedication, shortSupplierAddress, itemDisplayName, extractAcceptConditions, humanizePaymentLabel, isServiceNumber, normalizeReminderBody, classifyBrPhone, extractWaMeNumber, PLATFORM_HANDOFF_SUMMARY, formatOrderTotal } from '@iasaude/shared';
import { findNearbyPharmacies, geocodeAddress, reverseGeocode, reverseGeocodeNominatim, getPlacePhone, getPlaceContact, fetchWebsiteHtml, type PlaceResult } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { markSupplierVerifiedById } from './supplier-directory.js';
import { presentPlatformQuotes, extractCep } from './platform-quotes.js';
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
        await handleStartPharmacyOrder(tc.args as { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string; preferred_pharmacy_names?: string[] }, ctx);
        break;
      case 'create_reminder':
        await handleCreateReminder(tc.args as { type: string; title: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown>; depends_on_title?: string; event_at?: string }, ctx);
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
        await handleSaveAddress(tc.args as unknown as { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean; confirmed_residential?: boolean }, ctx);
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
    case 'identity': {
      // PONTO 8 (Valdivino→Vadivino): o usuário disse/corrigiu o próprio nome → persiste no
      // perfil (senão a saudação seguia com o pushName do WhatsApp). Só nomes plausíveis.
      const patch: Record<string, unknown> = {};
      const pn = String(args.payload['preferred_name'] ?? '').trim();
      const fn = String(args.payload['full_name'] ?? '').trim();
      if (pn && pn.length <= 40) patch['preferred_name'] = pn.slice(0, 40);
      if (fn && fn.length <= 120) patch['full_name'] = fn.slice(0, 120);
      if (Object.keys(patch).length) await db.from('users').update(patch).eq('id', ctx.userId);
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
      if (byId && byId.user_id === ctx.userId && CANCELLABLE_ORDER_STATUSES.includes(byId.status as string)) {
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
      .in('status', CANCELLABLE_ORDER_STATUSES)
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
  args: { label: string; full_address?: string; complement?: string; notes?: string; set_default?: boolean; confirmed_residential?: boolean },
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
}

async function handleStartPharmacyOrder(
  args: { items: OrderItem[]; saved_address_label?: string; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string; preferred_pharmacy_names?: string[] },
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
    await writeLog('info', 'geocoding', `Geocodificando endereço do usuário`, { traceId: ctx.traceId, address: args.location.address });
    const geo = await geocodeAddress(args.location.address);
    if (geo && geo.confidence === 'precise') {
      lat = geo.lat;
      lng = geo.lng;
      deliveryAddress = geo.formattedAddress || args.location.address;
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

  for (const pharmacy of rankedAll) {
    const isPref = preferredSet.has(pharmacy);
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
  await writeLog('info', 'places', `Time final (${finalTeam.length}): ${finalTeam.map((e) => `${e.place.name} [${e.tier}]`).join(' · ') || 'nenhuma'} — ${detailsCalls} Details, ${wameCalls} site(s) minerado(s), ${backupCandidates.length} backup(s)`, {
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

  // Notifica o usuário — com HONESTIDADE NOTURNA: se a maioria das escolhidas está
  // fechada agora (open_now), avisa que a resposta vem quando abrirem (senão ele fica
  // esperando resposta de loja fechada, caso Glauber 22h).
  const openKnown = finalTeam.filter((e) => e.place.isOpen !== undefined);
  const allClosed = openKnown.length >= 3 && openKnown.every((e) => e.place.isOpen === false);
  const nightNote = allClosed
    ? ' Ah, esse horário a maioria já tá fechada — deixei a mensagem lá e assim que abrirem elas costumam responder cedinho, tá?'
    : '';
  await sendOutbound(
    ctx.conversationId,
    ctx.phoneE164,
    `Achei ${quoteIds.length} farmácia${quoteIds.length > 1 ? 's' : ''} aqui na sua região e já entrei em contato com ${quoteIds.length > 1 ? 'elas' : 'ela'} ✨ assim que chegarem as respostas eu te aviso na hora.${nightNote}`,
    ctx.traceId,
  );

  // Em PARALELO (não bloqueia as negociações): cota nas grandes redes e apresenta o pool com
  // link pra pagar agora. Fire-and-forget — a mensagem chega em ~2s, junto do WhatsApp do bairro.
  if (userCep) {
    presentPlatformQuotes({
      orderId, items, cep: userCep,
      conversationId: ctx.conversationId, phoneE164: ctx.phoneE164, traceId: ctx.traceId,
      soleChannel: false,
    }).catch((err) => writeLog('warn', 'platform', `Falha apresentando plataformas (paralelo): ${String(err).slice(0, 140)}`, { traceId: ctx.traceId, orderId }));
  }

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

async function handleCreateReminder(
  args: { type: string; title?: string; body?: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown>; depends_on_title?: string; event_at?: string },
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

  const { error: insErr } = await db.from('reminders').insert({
    user_id: ctx.userId,
    type: args.type,
    title,
    // body:"" (string vazia da LLM) → null, senão o dispatcher mandaria msg vazia.
    body,
    scheduled_at: scheduledAt,
    rrule,
    next_run_at: firstRun,
    status: 'pending',
    // event_at no payload → o dispatcher re-ancora rows de véspera no disparo também.
    payload: { ...(args.payload ?? {}), ...(eventAt ? { event_at: eventAt } : {}), ...condPayload },
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

    // NOME DE QUEM RECEBE (incidente Vadivino: o motoboy chegou e não sabia procurar quem →
    // entrega falhou). Vai no fechamento pra a farmácia já saber o destinatário. Só o 1º nome.
    const { data: uName } = await db.from('users').select('preferred_name, full_name').eq('id', ctx.userId).maybeSingle();
    const recipient = (((uName?.preferred_name as string | null)?.trim()) || ((uName?.full_name as string | null)?.trim()) || '').split(' ')[0] || '';
    const recipientPart = recipient ? ` o pedido é pro ${recipient}, é ele que recebe.` : '';

    // Variação leve pra não soar template (mesma pessoa não fala igual sempre).
    const openings = ['fechou! pode preparar', 'show, fechado! pode separar', 'fechou então, pode preparar'];
    const opening = openings[Math.abs(args.order_id.charCodeAt(0) + args.order_id.charCodeAt(3)) % openings.length] as string;
    // Nome do destinatário JÁ na 1ª msg (associado ao pedido) + de novo no recipientPart da 2ª
    // (auditoria 1º pedido: farmácia anotou "Igor" no lugar de "Hiago" — o nome aparecer cedo
    // e 2× reduz o erro de anotação humana da farmácia).
    const msg1 = `${opening} ${itemsInline}${recipient ? ` pro ${recipient}` : ' pra mim'}`;

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
