import { db, writeLog } from '@iasaude/db';
import { extractStructured } from '@iasaude/llm';
import { PRESCRIPTION_OCR_PROMPT } from '@iasaude/llm';
import type { ToolCall } from '@iasaude/llm';
import type { NormalizedInbound, Message, OrderItem } from '@iasaude/shared';
import { findNearbyPharmacies, geocodeAddress } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';

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

  try {
    switch (tc.name) {
      case 'save_user_profile_fact':
        await handleSaveProfileFact(tc.args as { category: string; payload: Record<string, unknown> }, ctx);
        break;
      case 'request_user_location':
        // Sara will say it in text; nothing else needed
        break;
      case 'parse_prescription_image':
        await handleParsePrescription(tc.args as { message_id: string }, ctx);
        break;
      case 'start_pharmacy_order':
        await handleStartPharmacyOrder(tc.args as { items: OrderItem[]; location?: { lat?: number; lng?: number; address?: string } }, ctx);
        break;
      case 'create_reminder':
        await handleCreateReminder(tc.args as { type: string; title: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> }, ctx);
        break;
      case 'send_emergency_orientation':
        await sendOutbound(ctx.conversationId, ctx.phoneE164, '⚠️ Se for uma emergência, liga agora pro SAMU: *192*. Não espere! Estou aqui se precisar de mais ajuda. 💙', ctx.traceId);
        break;
      case 'get_order_status':
        // Read-only, Gemini will get the response in text
        break;
      case 'confirm_order_selection':
        await handleConfirmOrder(tc.args as { order_id: string; quote_id: string }, ctx);
        break;
      default:
        break;
    }
    await db.from('assistant_tasks').update({ status: 'success', tool_output: tc.args, completed_at: new Date().toISOString() }).eq('id', taskId);
  } catch (err) {
    await db.from('assistant_tasks').update({ status: 'error', error: String(err), completed_at: new Date().toISOString() }).eq('id', taskId);
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
  switch (args.category) {
    case 'condition':
      await db.from('user_health_conditions').insert({ user_id: ctx.userId, name: String(args.payload['name'] ?? ''), ...args.payload });
      break;
    case 'allergy':
      await db.from('user_allergies').insert({ user_id: ctx.userId, substance: String(args.payload['substance'] ?? ''), ...args.payload });
      break;
    case 'medication':
      await db.from('user_medications').insert({ user_id: ctx.userId, medication_name: String(args.payload['medication_name'] ?? args.payload['name'] ?? ''), ...args.payload });
      break;
    case 'address': {
      const addr = args.payload;
      await db.from('user_addresses').insert({ user_id: ctx.userId, label: String(addr['label'] ?? 'principal'), ...addr });
      break;
    }
    default:
      await db.from('users').update({ metadata: args.payload }).eq('id', ctx.userId);
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

async function handleStartPharmacyOrder(
  args: { items: OrderItem[]; location?: { lat?: number; lng?: number; address?: string } },
  ctx: ToolContext
) {
  let lat: number | null = null;
  let lng: number | null = null;
  let locationSource = 'unknown';

  if (args.location?.lat && args.location?.lng) {
    lat = args.location.lat;
    lng = args.location.lng;
    locationSource = 'llm_args';
  } else if (args.location?.address) {
    await writeLog('info', 'geocoding', `Geocodificando endereço: ${args.location.address}`, { traceId: ctx.traceId });
    const geo = await geocodeAddress(args.location.address);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      locationSource = `geocoded:${geo.formattedAddress}`;
      await writeLog('info', 'geocoding', `Endereço localizado: ${geo.formattedAddress} → ${lat.toFixed(5)},${lng.toFixed(5)}`, { traceId: ctx.traceId, lat, lng });
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
  }).select('id').single();

  if (!order?.id) return;

  await startPharmacyDiscovery(order.id, lat, lng, args.items, ctx);
}

async function startPharmacyDiscovery(
  orderId: string,
  lat: number,
  lng: number,
  items: OrderItem[],
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

  // Initiate negotiations staggered by 2s each to avoid hammering the LLM
  const locationText = top[0]?.city ? `${top[0].city}` : `lat ${lat.toFixed(4)}, lng ${lng.toFixed(4)}`;
  for (let i = 0; i < quoteIds.length; i++) {
    const quoteId = quoteIds[i] as string;
    const delay = i * 2000;
    setTimeout(() => {
      initiatePharmacyNegotiation(
        quoteId,
        orderId,
        items,
        locationText,
        ctx.conversationId,
        ctx.phoneE164,
        ctx.traceId,
      ).catch(console.error);
    }, delay);
  }
}

async function handleCreateReminder(
  args: { type: string; title: string; scheduled_at?: string; rrule?: string; payload?: Record<string, unknown> },
  ctx: ToolContext
) {
  await db.from('reminders').insert({
    user_id: ctx.userId,
    type: args.type,
    title: args.title,
    scheduled_at: args.scheduled_at ?? null,
    rrule: args.rrule ?? null,
    next_run_at: args.scheduled_at ?? null,
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

  // 3. Load order items
  const { data: order } = await db.from('orders').select('items').eq('id', args.order_id).single();
  const items = (order?.items ?? []) as OrderItem[];

  // 4. Send confirmation message to pharmacy via agent
  const supplier = quote.suppliers as { id: string; name: string; whatsapp_e164?: string; phone_e164?: string } | null;
  if (supplier && quote.conversation_id) {
    const supplierPhone = supplier.whatsapp_e164 || supplier.phone_e164;
    if (supplierPhone) {
      const itemsList = items.map((i: OrderItem) => `• ${i.name}${i.dosage ? ` ${i.dosage}` : ''}${i.quantity ? ` (${i.quantity})` : ''}`).join('\n');
      const paymentMethod = ((quote.payment_methods ?? ['pix']) as string[])[0] ?? 'pix';
      const confirmToPharmacy = `Olá! 🙏 O cliente confirmou o pedido. Por favor, prepare para entrega:\n${itemsList}\n\nPagamento: ${paymentMethod.toUpperCase()}\nSe possível, confirme quando estiver pronto!`;
      await sendOutboundToSupplier(quote.conversation_id as string, supplierPhone, confirmToPharmacy, ctx.traceId);
      await writeLog('info', 'order', `Confirmação enviada para ${supplier.name}`, { traceId: ctx.traceId, quoteId: args.quote_id });
    }
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
