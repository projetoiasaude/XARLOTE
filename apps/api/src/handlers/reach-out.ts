/**
 * BUSCA POR NOME (médico/clínica no Google) + CONTATO DIRECIONADO a um número
 * específico (contato compartilhado pelo usuário, ou clínica achada por nome).
 *
 *  - Feature 2: `handleFindByName` — Places Text Search por nome+cidade, apresenta
 *    o candidato + telefone e guarda em `conversations.pending_lookup` pro usuário
 *    CONFIRMAR a identidade antes de a Xarlote contatar.
 *  - Feature 3: `handleContactEstablishment` — dado um telefone (do pending_lookup
 *    OU explícito de um contato compartilhado/digitado), valida, SALVA na memória e
 *    dispara o fluxo certo: clínica (consulta direcionada) ou farmácia (pedido
 *    direcionado). Reaproveita os mesmos initiate*Negotiation dos fluxos normais
 *    (com relay bidirecional já pronto).
 */
import { db, writeLog, writeAudit, saveMemoryCard } from '@iasaude/db';
import { findPlacesByTextSearch, getPlacePhone } from '@iasaude/integrations';
import { toE164BR, isPlaceholderPhone, brPhoneVariants, isServiceNumber, sameMedication, itemDisplayName, type OrderItem } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { initiateClinicNegotiation } from './agent-clinic.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';
import { scheduleConsultationTimeout } from './consultation-consolidation.js';

interface ReachCtx {
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  /** UMA VOZ: handlers auto-contidos setam suppressLlmText (ver ToolContext). */
  turnFlags?: { suppressLlmText: boolean; supplierMessaged?: boolean };
}

/** E.164 SÓ se for BR plausível — rejeita país estrangeiro explícito (não fabrica número BR). */
function toBrE164OrNull(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') && !digits.startsWith('55')) return null;       // "+1 202..." etc
  if (digits.length >= 12 && !digits.startsWith('55')) return null;      // país estrangeiro embutido
  const e164 = toE164BR(s);
  return e164 && !isPlaceholderPhone(e164) ? e164 : null;
}

/** Salva contato(s) compartilhado(s) na memória do usuário pra reusar depois. */
export async function saveContactsToMemory(
  contacts: Array<{ name: string; phoneE164: string; org?: string }>,
  ctx: ReachCtx,
): Promise<void> {
  for (const c of contacts) {
    if (!c.phoneE164 || isPlaceholderPhone(c.phoneE164)) continue;
    // texto do card SEM expor o telefone em claro pra logs (PII) — o número fica
    // no próprio texto do card (fonte canônica), mas não vai pra log ≥info.
    await saveMemoryCard({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: 'fact',
      text: `Contato: ${c.name}${c.org ? ` (${c.org})` : ''} — WhatsApp ${c.phoneE164}`,
      tags: ['contact', 'phone', ...(c.org ? ['business'] : [])],
      confidence: 0.9,
      source: 'self_reported',
    }).catch(() => { /* memória é best-effort, não trava o fluxo */ });
  }
  await writeLog('info', 'contact', `${contacts.length} contato(s) salvo(s) na memória`, { traceId: ctx.traceId });
}

/**
 * Feature 2 — busca um médico/clínica pelo NOME no Google (Text Search), pega o
 * telefone (Place Details) e APRESENTA pro usuário confirmar antes de contatar.
 * Guarda o candidato em conversations.pending_lookup.
 */
export async function handleFindByName(
  args: { name: string; city?: string; kind?: 'clinic' | 'pharmacy'; specialty?: string },
  ctx: ReachCtx,
): Promise<void> {
  const name = (args.name ?? '').trim();
  if (!name) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Me diz o nome do médico ou da clínica que eu procuro 🙂', ctx.traceId);
    return;
  }
  // cidade: do arg, senão do perfil (home_city)
  let city = (args.city ?? '').trim();
  if (!city) {
    const { data: u } = await db.from('users').select('home_city').eq('id', ctx.userId).maybeSingle();
    city = (u?.home_city as string | null)?.trim() ?? '';
  }
  const query = [name, args.specialty, city].filter(Boolean).join(' ');

  let candidate: { placeId: string; name: string; address: string; city: string; phone: string } | null = null;
  try {
    const results = await findPlacesByTextSearch(query, 5);
    for (const r of results) {
      const phone = toE164BR(await getPlacePhone(r.placeId).catch(() => null));
      if (phone && !isPlaceholderPhone(phone)) {
        candidate = { placeId: r.placeId, name: r.name, address: r.address, city: r.city || city, phone };
        break;
      }
    }
  } catch (err) {
    await writeLog('warn', 'lookup', `Text Search falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId });
  }

  if (!candidate) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Procurei "${name}"${city ? ` em ${city}` : ''} mas não achei um contato confiável no Google 😕 Você tem o telefone/WhatsApp deles? Aí eu falo direto.`,
      ctx.traceId);
    return;
  }

  // Guarda o candidato pra confirmação (NÃO contata ainda — o usuário confirma a identidade).
  await db.from('conversations').update({
    pending_lookup: {
      kind: args.kind ?? 'clinic',
      name: candidate.name,
      phone: candidate.phone,
      place_id: candidate.placeId,
      city: candidate.city,
      specialty: args.specialty ?? null,
      at: new Date().toISOString(),
    },
  }).eq('id', ctx.conversationId);

  const cityLabel = candidate.city ? ` em ${candidate.city}` : '';
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Achei *${candidate.name}*${cityLabel} 📍 e consegui o WhatsApp deles ✅\n\nÉ essa mesma? Se sim, eu já falo com eles${args.specialty ? ` pra ver ${args.specialty}` : ''} 💙`,
    ctx.traceId);
  await writeLog('info', 'lookup', `Candidato apresentado: ${candidate.name}`, { traceId: ctx.traceId, placeId: candidate.placeId });
}

/**
 * Feature 2 (confirmação) + Feature 3 — CONTATA um estabelecimento específico.
 * Telefone vem do `pending_lookup` (após o usuário confirmar a busca por nome) OU
 * explícito em `phone` (contato compartilhado / número digitado). Roteia:
 *   - kind='clinic' → consulta direcionada (1 clínica) + initiateClinicNegotiation.
 *   - kind='pharmacy' → pedido direcionado (1 farmácia) + initiatePharmacyNegotiation.
 */
export async function handleContactEstablishment(
  args: {
    phone?: string; name?: string; kind?: 'clinic' | 'pharmacy';
    specialty?: string; items?: OrderItem[]; note?: string;
  },
  ctx: ReachCtx,
): Promise<void> {
  // UMA VOZ (incidente Glauber 09/07 à noite): TODO caminho deste handler manda a própria
  // resposta (anexo ao pedido, call-center, dedup, telefone inválido, contato novo…) —
  // sem isto o texto do LLM saía JUNTO ("Vou falar com a Pague Menos agora!" + a recusa
  // enlatada no mesmo segundo, 2 vozes se contradizendo na frente do usuário).
  if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
  // 1. Resolve telefone + metadados. Um phone EXPLÍCITO (contato compartilhado /
  //    número digitado) SEMPRE ganha. O pending_lookup (confirmação da busca por nome)
  //    só vale se for RECENTE (≤30min) — senão um "sim" a outra coisa, horas depois,
  //    contataria o candidato velho por engano.
  const { data: conv } = await db.from('conversations').select('pending_lookup').eq('id', ctx.conversationId).maybeSingle();
  const pendingRaw = (conv?.pending_lookup ?? null) as
    | { kind?: string; name?: string; phone?: string; specialty?: string | null; at?: string } | null;
  const pendingFresh = pendingRaw?.at ? (Date.now() - new Date(pendingRaw.at).getTime()) < 30 * 60_000 : false;
  const pending = pendingFresh ? pendingRaw : null;
  if (pendingRaw && !pendingFresh && !args.phone) {
    // pendente velho e sem phone novo → limpa e pede de novo (não contata o velho).
    await db.from('conversations').update({ pending_lookup: null }).eq('id', ctx.conversationId);
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Essa busca já ficou um tempo pra trás 🙈 Me diz de novo o nome do médico/clínica (ou o número) que eu procuro na hora.', ctx.traceId);
    return;
  }

  const phoneRaw = args.phone ?? pending?.phone ?? null;
  const phone = toBrE164OrNull(phoneRaw);
  const name = (args.name ?? pending?.name ?? 'contato').toString().slice(0, 80);
  const kind = (args.kind ?? (pending?.kind as 'clinic' | 'pharmacy' | undefined) ?? 'clinic');
  const specialty = (args.specialty ?? pending?.specialty ?? undefined) || undefined;

  if (!phone || isPlaceholderPhone(phone)) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Não consegui identificar um número válido pra falar 🙈 Me manda o WhatsApp (com DDD) ou compartilha o contato de novo.',
      ctx.traceId);
    return;
  }

  // 📞 NÚMERO DE CALL-CENTER (incidente Glauber 09/07: contato "Pague Menos" era o 4002-8282
  // nacional): 4002/0800/3003 não recebe WhatsApp — mandar cotação pra ele é jogar no void.
  // Antes esse caso ou virava supplier-fantasma ou era recusado em silêncio enquanto o LLM
  // narrava "vou falar com eles!". Honestidade: explica e pede o número de uma LOJA.
  if (isServiceNumber(phone)) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Esse número de *${name}* é um televendas/call-center (tipo 4002/0800) — ele não recebe WhatsApp, então por aqui eu não consigo falar com eles 😔 Se você tiver o WhatsApp de uma LOJA (unidade), me manda que eu falo na hora. Ou me diz o bairro que eu procuro uma unidade perto!`,
      ctx.traceId);
    await writeLog('info', 'lookup', `contact_establishment bloqueado: número de serviço (${phone.slice(0, 6)}***) — usuário avisado com honestidade`, { traceId: ctx.traceId });
    return;
  }

  // 2. Limpa o pending_lookup (já resolvido) e salva o contato na memória.
  if (pending) await db.from('conversations').update({ pending_lookup: null }).eq('id', ctx.conversationId);
  await saveContactsToMemory([{ name, phoneE164: phone }], ctx);

  if (kind === 'pharmacy') {
    await contactPharmacy(phone, name, args.items ?? [], ctx);
  } else {
    await contactClinic(phone, name, specialty, ctx);
  }
}

/** Consulta DIRECIONADA a uma clínica específica (reusa o fluxo de clínica). */
async function contactClinic(phone: string, clinicName: string, specialty: string | undefined, ctx: ReachCtx): Promise<void> {
  // Idempotência (paridade com handleStartConsultationSearch): não abre uma 2ª busca
  // se já há consulta ativa — senão viram consultas paralelas e a rescue de 45min
  // manda "nenhuma clínica respondeu" pra uma que o usuário nem lembra (review).
  const { data: activeC } = await db.from('consultations').select('id')
    .eq('user_id', ctx.userId).in('status', ['searching', 'quoting', 'quoted', 'confirming']).limit(1).maybeSingle();
  if (activeC) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Você já tem uma busca de consulta em andamento 💙 Deixa eu terminar essa aqui antes de começar outra, tá?`, ctx.traceId);
    return;
  }

  const { data: profile } = await db.from('users').select('home_city, home_state, preferred_name, full_name').eq('id', ctx.userId).maybeSingle();
  const city = (profile?.home_city as string | null) ?? null;

  const { data: clinic, error: cErr } = await db.from('clinics').insert({
    type: 'clinic', name: clinicName, whatsapp_e164: phone, phone_e164: phone,
    city: city ?? '', state: (profile?.home_state as string | null) ?? '',
  }).select('id').single();
  if (cErr || !clinic?.id) {
    await writeLog('error', 'lookup', `contactClinic: falha ao criar clínica: ${cErr?.message ?? 'sem id'}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Tive um problema técnico aqui pra iniciar o contato 😔 tenta de novo daqui a pouco?', ctx.traceId);
    return;
  }

  const { data: consult, error: coErr } = await db.from('consultations').insert({
    user_id: ctx.userId, conversation_id: ctx.conversationId, status: 'searching',
    specialty: specialty ?? 'consulta', urgency: 'rotina', modality: 'indiferente', city,
  }).select('id').single();
  const { data: q, error: qErr } = consult?.id
    ? await db.from('consultation_quotes').insert({ consultation_id: consult.id, clinic_id: clinic.id, status: 'pending' }).select('id').single()
    : { data: null, error: coErr };
  if (coErr || qErr || !consult?.id || !q?.id) {
    await writeLog('error', 'lookup', `contactClinic: falha ao criar consulta/quote: ${(coErr ?? qErr)?.message ?? 'sem id'}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Deu um probleminha aqui pra iniciar a consulta 😔 tenta de novo daqui a pouco?', ctx.traceId);
    return;
  }

  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Show! Já tô falando com *${clinicName}*${specialty ? ` pra ver ${specialty}` : ''} 🔍 Assim que eles responderem com horário e valor, te aviso 💙`,
    ctx.traceId);
  await writeAudit({
    actorType: 'xarlote', action: 'consultation.targeted_contact', userId: ctx.userId,
    targetTable: 'consultation_quotes', targetId: q.id, conversationId: ctx.conversationId,
    traceId: ctx.traceId, metadata: { clinic: clinicName, phone: phone.slice(0, 6) + '***' },
  });

  const patientName = ((profile?.preferred_name as string | null) || (profile?.full_name as string | null) || '').split(' ')[0] || null;
  setImmediate(() => {
    initiateClinicNegotiation({
      quoteId: q.id, consultationId: consult.id, clinicId: clinic.id, clinicName, clinicWhatsApp: phone,
      ctx: { specialty: specialty ?? 'consulta', urgency: 'rotina', modality: 'indiferente', patientCity: city, plan: null, patientName },
      userConversationId: ctx.conversationId, userPhoneE164: ctx.phoneE164, traceId: ctx.traceId,
    }).catch((err) => writeLog('error', 'lookup', `Contato clínica falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId }));
  });
  scheduleConsultationTimeout(consult.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
}

/** Pedido DIRECIONADO a uma farmácia específica (reusa o fluxo de farmácia). */
async function contactPharmacy(phone: string, pharmacyName: string, items: OrderItem[], ctx: ReachCtx): Promise<void> {
  if (!items.length) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Beleza! Qual medicamento você quer pedir pra *${pharmacyName}*? (nome e quantidade) 💊`, ctx.traceId);
    return;
  }
  // 🔗 PEDIDO ATIVO + contato específico = ANEXA ao pedido (incidente Glauber 09/07 à noite):
  // o usuário compartilhou o contato da farmácia e pediu "cota com esse" — a resposta era uma
  // recusa enlatada ("já tem pedido em andamento", 11x na mesma conversa) ENQUANTO o LLM
  // narrava "vou falar com a Pague Menos!" — e o contato NUNCA era cotado. Um contato
  // específico do usuário durante um pedido ativo do MESMO remédio é instrução de cotação,
  // não pedido novo → entra como cotação nova no pedido ativo (mesmo espírito do
  // record_referral, que já faz isso quando a INDICAÇÃO vem da farmácia).
  const { data: activeO } = await db.from('orders')
    .select('id, items, delivery_address, conversation_id, status')
    .eq('user_id', ctx.userId).in('status', ['quoting', 'quoted', 'confirming']).limit(1).maybeSingle();
  if (activeO) {
    const orderItems = (activeO.items ?? []) as OrderItem[];
    const itemName = orderItems.map((i) => itemDisplayName(i.name, i.dosage)).filter(Boolean).join(', ') || 'seu pedido';

    // Anexo direto SÓ em 'quoting' (espelha o guard do record_referral — review 10/07 #14):
    // em 'quoted' a apresentação já rodou e uma cotação nova chegaria num beco sem saída
    // (notifyUserQuoteArrived/consolidação têm guard de status → o "te aviso" viraria
    // promessa quebrada); em 'confirming' a farmácia escolhida já foi acionada.
    if (activeO.status === 'quoted') {
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Já te mostrei as opções do pedido de ${itemName} 💙 Se nenhuma te serviu, me diz "amplia a busca" que eu procuro mais farmácias (aí já incluo outras), ou escolhe uma das opções que te mandei.`, ctx.traceId);
      return;
    }
    if (activeO.status === 'confirming') {
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Seu pedido de ${itemName} já tá sendo fechado com a farmácia escolhida 💙 Quer que eu cancele pra cotar nesse contato novo? Me confirma que eu resolvo.`, ctx.traceId);
      return;
    }

    // Remédio DIFERENTE do pedido ativo → aí sim é pedido novo; recusa com clareza e caminho.
    // (sameMedication é conservador: na dúvida devolve true = anexa — melhor cotar a mais
    // do que recusar o contato que o usuário pediu explicitamente. A msg de sucesso NOMEIA
    // o pedido, então um anexo errado é visível e corrigível na hora.)
    const sameOrder = !items.length || sameMedication(orderItems, items);
    if (!sameOrder) {
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Você já tem um pedido de ${itemName} em andamento 💙 Esse aí é outro medicamento — quer que eu finalize (ou cancele) o pedido atual primeiro? Me diz que eu resolvo.`, ctx.traceId);
      return;
    }

    // Dedup: essa farmácia já está neste pedido? Suppliers duplicam por telefone (37
    // "Drogasil" no banco) → casa TODOS os ids das variantes, não limit(1) arbitrário
    // (review 10/07 #18). E o STATUS da quote existente decide a resposta (review #15):
    // viva → "já tô falando"; cotada → "já responderam"; morta (timeout/unavailable) →
    // REABRE e tenta de novo (o usuário conseguiu o contato justamente porque a rodada
    // anterior falhou — responder "já tô falando" seria mentira determinística).
    const variantsA = brPhoneVariants(phone);
    const { data: supMatches } = await db.from('suppliers').select('id')
      .or(variantsA.map((p) => `whatsapp_e164.eq.${p}`).join(','));
    const supIds = (supMatches ?? []).map((s) => s.id as string);
    let quoteIdToUse: string | null = null;
    let reopened = false;
    if (supIds.length) {
      const { data: qDup } = await db.from('quotes').select('id, status, supplier_id')
        .eq('order_id', activeO.id).in('supplier_id', supIds)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (qDup && ['pending', 'contacting', 'negotiating'].includes(qDup.status as string)) {
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          `Já tô falando com *${pharmacyName}* nesse pedido 💙 assim que responderem eu te aviso!`, ctx.traceId);
        return;
      }
      if (qDup && qDup.status === 'quoted') {
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          `A *${pharmacyName}* já me passou o preço nesse pedido 💙 já já te mostro as opções!`, ctx.traceId);
        return;
      }
      if (qDup && ['timeout', 'unavailable'].includes(qDup.status as string)) {
        const { data: ro } = await db.from('quotes')
          .update({ status: 'pending', completed_at: null, notes: 'contato indicado pelo cliente (reaberto)' })
          .eq('id', qDup.id).in('status', ['timeout', 'unavailable']).select('id');
        if (ro?.length) { quoteIdToUse = qDup.id as string; reopened = true; }
      }
    }

    let supId = supIds[0];
    if (!quoteIdToUse) {
      if (!supId) {
        const { data: sup } = await db.from('suppliers').insert({
          type: 'pharmacy', name: pharmacyName, whatsapp_e164: phone, phone_e164: phone, status: 'active',
        }).select('id').single();
        supId = sup?.id as string | undefined;
      }
      if (!supId) {
        await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Deu um probleminha aqui pra falar com a farmácia 😔 tenta de novo daqui a pouco?', ctx.traceId);
        return;
      }
      const { data: newQuote, error: nqErr } = await db.from('quotes').insert({
        order_id: activeO.id, supplier_id: supId, status: 'pending', notes: 'contato indicado pelo cliente',
      }).select('id').single();
      if (nqErr || !newQuote?.id) {
        await writeLog('error', 'lookup', `contactPharmacy(anexo): falha ao criar quote: ${nqErr?.message ?? 'sem id'}`, { traceId: ctx.traceId });
        await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Deu um probleminha aqui pra falar com a farmácia 😔 tenta de novo daqui a pouco?', ctx.traceId);
        return;
      }
      quoteIdToUse = newQuote.id as string;
    }

    // Bairro pro texto da abertura: parte do endereço que NÃO é número puro nem CEP
    // (split(',')[1] cru mandava o NÚMERO da casa como "região" — review 10/07 #19).
    const addrParts = ((activeO.delivery_address as string | null) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hood = addrParts.slice(1).find((p) => !/^\d+[a-zA-Z]?$/.test(p) && !/^\d{5}-?\d{3}$/.test(p)) ?? 'sua região';

    // AWAIT (não setImmediate) + verificação pós-inicio (review 10/07 #16): a conversa da
    // farmácia pode estar TRAVADA com pedido de outro cliente (trava de isolamento) — a
    // negociação seria pulada em silêncio e o "já tô falando com eles" viraria mentira.
    // Iniciamos primeiro e mensageamos conforme o que REALMENTE aconteceu.
    const orderId = activeO.id as string;
    try {
      await initiatePharmacyNegotiation(quoteIdToUse, orderId, orderItems, hood, null, ctx.conversationId, ctx.phoneE164, ctx.traceId);
    } catch (err) {
      await writeLog('error', 'lookup', `Anexo de farmácia ao pedido falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId });
    }
    const { data: qAfter } = await db.from('quotes').select('status').eq('id', quoteIdToUse).maybeSingle();
    const alive = qAfter && ['pending', 'contacting', 'negotiating'].includes(qAfter.status as string);
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      alive
        ? (reopened
          ? `Tentei de novo com a *${pharmacyName}* no pedido de ${itemName} 💊 dessa vez pelo contato que você me passou — te aviso assim que responderem 💙`
          : `Boa! Adicionei *${pharmacyName}* na cotação do seu pedido de ${itemName} 💊 já falei com eles — assim que responderem, te aviso 💙`)
        : `Tentei falar com a *${pharmacyName}* agora, mas o canal deles tá ocupado nesse momento 😔 Sigo com as outras farmácias do seu pedido de ${itemName} e qualquer novidade te aviso!`,
      ctx.traceId);
    await writeAudit({
      actorType: 'xarlote', action: 'order.contact_attached', userId: ctx.userId,
      targetTable: 'quotes', targetId: quoteIdToUse, conversationId: ctx.conversationId,
      traceId: ctx.traceId, metadata: { pharmacy: pharmacyName, phone: phone.slice(0, 6) + '***', orderId, reopened, initiated: Boolean(alive) },
    });
    return;
  }
  // Localização: endereço padrão salvo → último pedido.
  let lat: number | null = null, lng: number | null = null, addr: string | null = null, userAddressId: string | null = null;
  const { data: def } = await db.from('user_addresses')
    .select('id, latitude, longitude, street, neighborhood, city').eq('user_id', ctx.userId).eq('is_default', true).maybeSingle();
  if (def?.latitude != null && def?.longitude != null) {
    lat = def.latitude as number; lng = def.longitude as number; userAddressId = def.id as string;
    addr = [def.street, def.neighborhood, def.city].filter(Boolean).join(', ') || null;
  } else {
    const { data: ord } = await db.from('orders').select('delivery_lat, delivery_lng, delivery_address')
      .eq('user_id', ctx.userId).not('delivery_lat', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (ord?.delivery_lat != null) { lat = ord.delivery_lat as number; lng = ord.delivery_lng as number; addr = ord.delivery_address as string | null; }
  }
  if (lat == null || lng == null) {
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Pra pedir na *${pharmacyName}* eu preciso saber pra onde entregar 🙂 Me manda o endereço (com CEP) ou compartilha sua localização 📍.`, ctx.traceId);
    return;
  }

  const { data: order, error: oErr } = await db.from('orders').insert({
    user_id: ctx.userId, conversation_id: ctx.conversationId, origin: 'user_text', status: 'quoting',
    items, delivery_lat: lat, delivery_lng: lng, delivery_address: addr, user_address_id: userAddressId,
  }).select('id').single();
  if (oErr || !order?.id) {
    await writeLog('error', 'lookup', `contactPharmacy: falha ao criar pedido: ${oErr?.message ?? 'sem id'}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Deu um probleminha aqui pra iniciar o pedido 😔 tenta de novo daqui a pouco?', ctx.traceId);
    return;
  }

  const variants = brPhoneVariants(phone);
  const { data: existingSup } = await db.from('suppliers').select('id')
    .or(variants.map((p) => `whatsapp_e164.eq.${p}`).join(',')).limit(1).maybeSingle();
  let supplierId = existingSup?.id as string | undefined;
  if (!supplierId) {
    const { data: sup } = await db.from('suppliers').insert({
      type: 'pharmacy', name: pharmacyName, whatsapp_e164: phone, phone_e164: phone, status: 'active',
    }).select('id').single();
    supplierId = sup?.id as string | undefined;
  }
  const { data: quote, error: qErr } = supplierId
    ? await db.from('quotes').insert({ order_id: order.id, supplier_id: supplierId, status: 'pending', notes: 'contato indicado pelo cliente' }).select('id').single()
    : { data: null, error: { message: 'sem supplier' } as { message: string } };
  if (qErr || !quote?.id) {
    await writeLog('error', 'lookup', `contactPharmacy: falha ao criar supplier/quote: ${qErr?.message ?? 'sem id'}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164, 'Deu um probleminha aqui pra falar com a farmácia 😔 tenta de novo daqui a pouco?', ctx.traceId);
    // pedido órfão sem quote → marca failed pra rescue não cutucar
    await db.from('orders').update({ status: 'failed' }).eq('id', order.id);
    return;
  }

  const neighborhood = (addr ?? '').split(',').map((s) => s.trim()).filter(Boolean)[1] ?? 'sua região';
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Fechou! Já tô falando com *${pharmacyName}* pra cotar seu pedido 💊 assim que responderem, te aviso 💙`, ctx.traceId);
  await writeAudit({
    actorType: 'xarlote', action: 'order.targeted_contact', userId: ctx.userId,
    targetTable: 'quotes', targetId: quote.id, conversationId: ctx.conversationId,
    traceId: ctx.traceId, metadata: { pharmacy: pharmacyName, phone: phone.slice(0, 6) + '***' },
  });
  setImmediate(() => {
    initiatePharmacyNegotiation(quote.id, order.id, items, neighborhood, null, ctx.conversationId, ctx.phoneE164, ctx.traceId)
      .catch((err) => writeLog('error', 'lookup', `Contato farmácia falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId }));
  });
}
