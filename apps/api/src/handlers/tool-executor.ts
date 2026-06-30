import { db, writeLog, auditToolCall, writeAudit, saveMemoryCard } from '@iasaude/db';
import { extractStructured } from '@iasaude/llm';
import { PRESCRIPTION_OCR_PROMPT } from '@iasaude/llm';
import type { ToolCall } from '@iasaude/llm';
import type { NormalizedInbound, Message, OrderItem } from '@iasaude/shared';
import { nextOccurrence } from '@iasaude/shared';
import { findNearbyPharmacies, geocodeAddress, reverseGeocode, reverseGeocodeNominatim } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';
import { scheduleQuoteTimeout, sendCurrentOrderStatus } from './quote-consolidation.js';
import { relayUserAnswerToEstablishment } from './clarification.js';
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
        await handleStartPharmacyOrder(tc.args as { items: OrderItem[]; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string }, ctx);
        break;
      case 'create_reminder':
        await handleCreateReminder(tc.args as { type: string; title: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> }, ctx);
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
      case 'confirm_order_selection':
        await handleConfirmOrder(tc.args as { order_id: string; quote_id: string }, ctx);
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

async function handleStartPharmacyOrder(
  args: { items: OrderItem[]; location?: { lat?: number; lng?: number; address?: string }; payment_method?: string },
  ctx: ToolContext
) {
  // ─── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────
  // Se já existe uma order ativa (quoting/quoted/confirming) pra esse usuário,
  // NÃO cria outra e NÃO reinicia contato com farmácias. Apenas atualiza status.
  // (Xarlote costuma re-chamar essa tool quando usuário pressiona — proteção essencial.)
  const { data: existingActive } = await db
    .from('orders')
    .select('id, status')
    .eq('user_id', ctx.userId)
    .in('status', ['quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingActive) {
    await writeLog('warn', 'order', `start_pharmacy_order ignorado — já há pedido ativo (${existingActive.status})`, {
      traceId: ctx.traceId, existingOrderId: existingActive.id,
    });
    await sendCurrentOrderStatus(existingActive.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
    return;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  let deliveryAddress: string | null = null;
  let locationSource = 'unknown';

  // Prioridade: endereço de texto > localização do WhatsApp > lat/lng dos args do LLM.
  // (LLM costuma reaproveitar coords antigas do histórico — texto fresco é mais confiável.)
  if (args.location?.address) {
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
    payment_method: args.payment_method ?? null,
  }).select('id').single();

  if (!order?.id) return;

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

  const top = pharmacies.slice(0, 5);
  const quoteIds: string[] = [];

  for (const pharmacy of top) {
    const { data: supplier } = await db.from('suppliers').upsert({
      type: 'pharmacy',
      name: pharmacy.name,
      google_place_id: pharmacy.placeId,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      latitude: pharmacy.lat,
      longitude: pharmacy.lng,
      rating: pharmacy.rating,
      reviews: pharmacy.userRatingCount,
      status: 'active',
    }, { onConflict: 'google_place_id' }).select('id').single();

    if (!supplier?.id) continue;

    const { data: quote } = await db.from('quotes').insert({
      order_id: orderId,
      supplier_id: supplier.id,
      status: 'pending',
      distance_km: pharmacy.distanceKm,
    }).select('id').single();

    if (quote?.id) quoteIds.push(quote.id);
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
  // Pega o pedido ativo mais recente do usuário (qualquer status não-terminal).
  const { data: order } = await db
    .from('orders')
    .select('id, status')
    .eq('user_id', ctx.userId)
    .in('status', ['quoting', 'quoted', 'confirming', 'handed_off'])
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

  await sendCurrentOrderStatus(order.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
}

async function handleCreateReminder(
  args: { type: string; title: string; body?: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> },
  ctx: ToolContext
) {
  // next_run_at é o que o dispatcher olha. Recorrente sem scheduled_at calcula
  // o primeiro disparo pelo rrule (horário de Brasília) — antes ficava NULL e
  // o lembrete NUNCA disparava.
  const firstRun =
    args.scheduled_at ??
    (args.rrule ? nextOccurrence(args.rrule)?.toISOString() ?? null : null);

  if (!firstRun) {
    await writeLog('warn', 'tool', `create_reminder sem horário utilizável (scheduled_at=${args.scheduled_at ?? '∅'}, rrule=${args.rrule ?? '∅'}) — lembrete não agendado`, {
      traceId: ctx.traceId, userId: ctx.userId,
    });
  }

  await db.from('reminders').insert({
    user_id: ctx.userId,
    type: args.type,
    title: args.title,
    body: args.body ?? null,
    scheduled_at: args.scheduled_at ?? null,
    rrule: args.rrule ?? null,
    next_run_at: firstRun,
    status: 'pending',
    payload: args.payload ?? {},
  });
}

async function handleConfirmOrder(args: { order_id: string; quote_id: string }, ctx: ToolContext) {
  // 1. Update order to confirming
  await db.from('orders').update({ status: 'confirming', selected_quote_id: args.quote_id }).eq('id', args.order_id);

  // 2. Load quote + supplier
  const { data: quote } = await db
    .from('quotes')
    .select('*, suppliers(id, name, whatsapp_e164, phone_e164)')
    .eq('id', args.quote_id)
    .single();

  if (!quote) {
    await writeLog('error', 'order', `Quote ${args.quote_id} not found for confirmation`, { traceId: ctx.traceId });
    return;
  }

  // 3. Load order items + delivery address + payment method
  const { data: order } = await db
    .from('orders')
    .select('items, delivery_address, delivery_lat, delivery_lng, payment_method')
    .eq('id', args.order_id)
    .single();
  const items = (order?.items ?? []) as OrderItem[];
  const deliveryAddress =
    (order?.delivery_address as string | null) ??
    (order?.delivery_lat && order?.delivery_lng
      ? `lat ${Number(order.delivery_lat).toFixed(5)}, lng ${Number(order.delivery_lng).toFixed(5)}`
      : null);
  const userPaymentMethod = (order?.payment_method as string | null) ?? null;

  // 4. Send confirmation message to pharmacy via agent (tom humano, sem emojis)
  const supplier = quote.suppliers as { id: string; name: string; whatsapp_e164?: string; phone_e164?: string } | null;
  if (supplier && quote.conversation_id) {
    // Fallback to fake simulator phone (same scheme used in initiatePharmacyNegotiation)
    const supplierPhone =
      supplier.whatsapp_e164 || supplier.phone_e164 || `+555500000${supplier.id.slice(0, 4)}`;
    const itemsList = items
      .map((i: OrderItem) => `- ${i.name}${i.dosage ? ` ${i.dosage}` : ''}${i.quantity ? ` (${i.quantity})` : ''}`)
      .join('\n');
    const paymentLabel = (userPaymentMethod || ((quote.payment_methods ?? ['pix']) as string[])[0] || 'pix').toString();
    // Aqui já vai TUDO: endereço completo + link do Google Maps com a localização exata
    // (no momento da cotação a gente passa só rua/setor pra não vazar info do cliente sem fechar pedido).
    const mapsLink =
      order?.delivery_lat != null && order?.delivery_lng != null
        ? `https://www.google.com/maps?q=${Number(order.delivery_lat).toFixed(6)},${Number(order.delivery_lng).toFixed(6)}`
        : null;
    const addressParts: string[] = [];
    if (deliveryAddress && !/Localização compartilhada|^lat\s/i.test(deliveryAddress)) {
      addressParts.push(`Endereço de entrega: ${deliveryAddress}`);
    }
    if (mapsLink) addressParts.push(`Localização no mapa: ${mapsLink}`);
    const addressLine = addressParts.length ? `\n${addressParts.join('\n')}` : '';
    const confirmToPharmacy = `Oi, voltando aqui, o cliente fechou com vocês. Pode preparar pra entrega, por favor:\n${itemsList}${addressLine}\nForma de pagamento: ${paymentLabel}.\nMe avisa quando o pedido estiver pronto ou saindo, por favor. Obrigada!`;
    await sendOutboundToSupplier(quote.conversation_id as string, supplierPhone, confirmToPharmacy, ctx.traceId);
    await writeLog('info', 'order', `Confirmação enviada para ${supplier.name}`, {
      traceId: ctx.traceId,
      quoteId: args.quote_id,
      deliveryAddress,
      paymentMethod: paymentLabel,
    });
  } else {
    await writeLog('warn', 'order', `Confirmação NÃO enviada — supplier ou conversation_id ausente`, {
      traceId: ctx.traceId,
      quoteId: args.quote_id,
      hasSupplier: !!supplier,
      hasConversation: !!quote.conversation_id,
    });
  }

  // 5. Update order to handed_off
  await db.from('orders').update({ status: 'handed_off' }).eq('id', args.order_id);

  // 6. Send payment details to user
  const supplierName = supplier?.name ?? 'farmácia selecionada';
  const paymentMsg = buildPaymentMessage(quote, supplierName);
  await sendOutbound(ctx.conversationId, ctx.phoneE164, paymentMsg, ctx.traceId);

  await writeLog('info', 'order', `Pedido finalizado — handed_off para ${supplierName}`, {
    traceId: ctx.traceId, orderId: args.order_id, quoteId: args.quote_id,
  });
}

function buildPaymentMessage(quote: Record<string, unknown>, supplierName: string): string {
  const lines: string[] = [`✅ *Pedido confirmado com ${supplierName}!*\n`];

  if (quote['pix_key']) {
    lines.push(`📱 *Chave Pix:* ${quote['pix_key']}`);
  }
  if (quote['payment_link']) {
    lines.push(`🔗 *Link de pagamento:* ${quote['payment_link']}`);
  }

  const methods = ((quote['payment_methods'] as string[]) ?? []).join('/');
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

  lines.push('\nA farmácia foi notificada. Qualquer dúvida, é só me chamar! 💙');
  return lines.join('\n');
}
