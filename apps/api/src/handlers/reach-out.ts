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
import { toE164BR, isPlaceholderPhone, brPhoneVariants, isServiceNumber, sameMedication, itemDisplayName, specialtyPhrase, type OrderItem } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { initiateClinicNegotiation } from './agent-clinic.js';
import { sendOutboundToClinic } from './outbound-agent.js';
import { initiatePharmacyNegotiation } from './inbound-supplier.js';
import { scheduleConsultationTimeout, closeConsultationQuotes } from './consultation-consolidation.js';

/** Mesmo médico? Compara TOKENS de nome ≥4 letras (não substring solto: "Ana" ⊄ "Mariana"). */
function doctorMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = String(a ?? '').trim().toLowerCase();
  const B = String(b ?? '').trim().toLowerCase();
  if (!A || !B) return false;
  if (A === B) return true;
  const toks = (s: string) => s.split(/\s+/).filter((t) => t.replace(/[^a-zà-ú]/gi, '').length >= 4);
  const aT = toks(A), bT = toks(B);
  return aT.length > 0 && bT.length > 0 && aT.some((t) => bT.includes(t));
}

interface ReachCtx {
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  /** UMA VOZ: handlers auto-contidos setam suppressLlmText (ver ToolContext). */
  turnFlags?: { suppressLlmText: boolean; supplierMessaged?: boolean };
  /** Observação pro MODELO no loop ReAct (ver ToolContext.observation). */
  observation?: { note: string | null };
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
  // UMA VOZ (auditoria 26/07 — caso Ciro/Dr. Rafael, ao vivo 25/07): os 3 caminhos deste
  // handler respondem ao paciente por conta própria, mas ele era o ÚNICO que esquecia de
  // suprimir o texto do LLM (handleContactEstablishment e handleNudgeConsultation setam).
  // Resultado visível ao paciente: "Achei o Dr. Rafael… É essa mesma?" (pedindo confirmação)
  // seguido de "Vou procurar o Dr. Rafael, já vou buscando" (dizendo que já faz) — duas
  // vozes se contradizendo no mesmo turno.
  if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;
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

  // 🔁 REJEIÇÃO AVANÇA PRA O PRÓXIMO (auditoria 30/07 — caso Glauber).
  // Antes, "Não"/"Errado" fazia o LLM re-chamar esta tool com a MESMA busca, que devolvia o
  // MESMO primeiro resultado — o paciente recebeu duas vezes seguidas "Achei Dra. Marilia
  // Oliveira Ribeiro… é essa?" depois de já ter dito que não era. O Google devolve 5
  // candidatos e nós usávamos só o primeiro, jogando os outros 4 fora.
  // Agora os descartados ficam registrados e a próxima chamada pula quem já foi recusado.
  const { data: convRow } = await db.from('conversations').select('pending_lookup').eq('id', ctx.conversationId).maybeSingle();
  const prev = (convRow?.pending_lookup ?? null) as { query?: string; rejected?: string[]; place_id?: string } | null;
  // Mesma busca de antes ⇒ o candidato que estava na mesa foi recusado.
  const rejected = new Set<string>(
    prev?.query === query ? [...(prev.rejected ?? []), ...(prev.place_id ? [prev.place_id] : [])] : [],
  );

  let candidate: { placeId: string; name: string; address: string; city: string; phone: string } | null = null;
  let exhausted = false;
  try {
    const results = await findPlacesByTextSearch(query, 5);
    const fresh = results.filter((r) => !rejected.has(r.placeId));
    exhausted = results.length > 0 && fresh.length === 0;
    for (const r of fresh) {
      // Resolve o telefone SÓ do candidato da vez (lazy): fetchar os 5 de uma vez
      // multiplicaria por 5 o custo de Place Details sem necessidade.
      const phone = toE164BR(await getPlacePhone(r.placeId).catch(() => null));
      // Central (4002/4009/0800…) NUNCA é WhatsApp de consultório: o caso Glauber mostrou
      // 5 mensagens no vácuo pro +55 62 4009-1919 do IAD. Descarta o candidato e segue pro
      // próximo em vez de queimar a busca num número que não atende.
      if (phone && !isPlaceholderPhone(phone) && !isServiceNumber(phone)) {
        candidate = { placeId: r.placeId, name: r.name, address: r.address, city: r.city || city, phone };
        break;
      }
    }
  } catch (err) {
    await writeLog('warn', 'lookup', `Text Search falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId });
  }

  if (!candidate) {
    // 🪜 ESCADA DE FALLBACK: nunca terminar em beco sem saída. Se acabaram os candidatos
    // (ou nenhum tinha telefone), volta ao paciente pedindo o que destrava o contato —
    // nome da clínica onde o médico atende, ou o telefone direto, que é o caminho curto.
    const msg = exhausted
      ? `Já te mostrei as opções que o Google me deu pra "${name}" e nenhuma era a certa 😕\n\nMe ajuda a chegar nele(a): você sabe o **nome da clínica** onde atende? Ou, melhor ainda, tem o **telefone/WhatsApp** deles? Com o número eu falo direto agora.`
      : `Procurei "${name}"${city ? ` em ${city}` : ''} mas não achei um contato confiável 😕\n\nVocê sabe o **nome da clínica** onde atende, ou tem o **telefone/WhatsApp** deles? Com qualquer um dos dois eu consigo seguir.`;
    await sendOutbound(ctx.conversationId, ctx.phoneE164, msg, ctx.traceId);
    // Guarda os recusados pra uma próxima tentativa não repetir os mesmos.
    await db.from('conversations').update({
      pending_lookup: { kind: args.kind ?? 'clinic', query, rejected: [...rejected], awaiting: 'clinic_name_or_phone', at: new Date().toISOString() },
    }).eq('id', ctx.conversationId);
    if (ctx.observation) ctx.observation.note = `Busca por "${name}" sem candidato novo. Você JÁ pediu ao paciente o nome da clínica ou o telefone — não repita a busca com o mesmo nome, espere a resposta dele.`;
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
      // `query` + `rejected` sustentam o avanço na próxima recusa (ver acima).
      query,
      rejected: [...rejected],
      at: new Date().toISOString(),
    },
  }).eq('id', ctx.conversationId);

  const cityLabel = candidate.city ? ` em ${candidate.city}` : '';
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Achei *${candidate.name}*${cityLabel} 📍 e consegui o WhatsApp deles ✅\n\nÉ essa mesma? Se sim, eu já falo com eles${specialtyPhrase(args.specialty) ? ` pra ver ${specialtyPhrase(args.specialty)}` : ''} 💙`,
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
    specialty?: string; professional?: string; items?: OrderItem[]; note?: string;
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
  const professional = (args.professional ?? undefined) || undefined; // médico específico pedido (kind=clinic)

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
    await contactClinic(phone, name, specialty, ctx, professional);
  }
}

/**
 * INSISTIR/CONTINUAR uma consulta em andamento (incidente Vadivino 22/07: "insiste em marcar" caía
 * no fluxo de FARMÁCIA). Dá ao LLM uma ação de CONSULTA de verdade: re-cutuca o consultório e
 * tranquiliza o paciente; retoma uma consulta recém-encerrada sem duplicar. Auto-contido (uma voz).
 */
export async function handleNudgeConsultation(ctx: ReachCtx): Promise<void> {
  // ⚠️ NÃO amordaçar o modelo aqui (auditoria 30/07 — caso Ciro).
  // Antes, `suppressLlmText = true` era setado INCONDICIONALMENTE na 1ª linha, antes de
  // saber qualquer coisa. Nos estados informativos o handler despejava um texto FIXO e a
  // resposta real do modelo era jogada fora. Resultado ao vivo: o Ciro recebeu 7× seguidas
  // "As opções de horário ainda estão de pé…" — inclusive quando escreveu "Pode confirmar
  // terça feira 09:30". Ele estava CONFIRMANDO e ela respondia com o enlatado.
  //
  // Princípio novo: em estado INFORMATIVO o handler entrega FATOS ao modelo (observation) e
  // NÃO fala pelo paciente. Texto pronto só sobrevive onde o handler executa uma AÇÃO que o
  // modelo não tem como narrar sozinho — e, mesmo lá, a supressão é setada na hora do envio.
  const { data: c } = await db.from('consultations')
    .select('id, status, specialty, preferences, created_at')
    .eq('user_id', ctx.userId)
    .in('status', ['searching', 'quoting', 'quoted', 'confirming', 'failed'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!c || (c.status === 'failed' && Date.now() - new Date(c.created_at as string).getTime() > 24 * 60 * 60_000)) {
    if (ctx.observation) ctx.observation.note = 'NÃO existe consulta em andamento pra retomar. Diga isso ao paciente com suas palavras e ofereça começar uma (peça o médico ou a especialidade).';
    return;
  }
  const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
  const doctor = prefs['requested_doctor'] as string | null;
  const alvo = doctor ? `com ${doctor}` : (c.specialty && c.specialty !== 'consulta' ? `de ${c.specialty}` : '');

  if (c.status === 'quoted') {
    // Entrega os horários REAIS que a clínica ofereceu pro modelo responder com precisão —
    // inclusive pra reconhecer quando o paciente ESTÁ escolhendo um deles.
    const { data: opts } = await db.from('consultation_quotes')
      .select('proposed_datetime, alternative_datetimes, price_brl, clinics(name)')
      .eq('consultation_id', c.id)
      .not('proposed_datetime', 'is', null)
      .order('created_at', { ascending: false }).limit(3);
    const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const linhas = (opts ?? []).flatMap((o) => {
      const base = o.proposed_datetime ? [fmt(o.proposed_datetime as string)] : [];
      const alts = Array.isArray(o.alternative_datetimes) ? (o.alternative_datetimes as string[]).map(fmt) : [];
      return [...base, ...alts];
    });
    const preco = (opts ?? [])[0]?.price_brl;
    if (ctx.observation) {
      ctx.observation.note =
        `Consulta ${alvo || ''} está AGUARDANDO A ESCOLHA do paciente.`
        + (linhas.length ? ` Horários que a clínica ofereceu: ${linhas.join(' | ')}.` : '')
        + (preco ? ` Valor: R$${preco}.` : '')
        + ` ⚠️ LEIA a mensagem dele: se ele ESCOLHEU um horário ou disse que quer confirmar,`
        + ` NÃO repita as opções — chame \`confirm_consultation_selection\` e feche.`
        + ` Se ele pediu OUTRA data, diga que vai checar e use \`message_supplier\` pra perguntar à clínica de verdade.`;
    }
    return;
  }
  if (c.status === 'confirming') {
    if (ctx.observation) ctx.observation.note = `A reserva ${alvo || ''} já está em confirmação com a clínica — aguardando o retorno deles. Tranquilize o paciente com suas palavras, sem prometer horário que ainda não foi confirmado.`;
    return;
  }

  // Daqui pra baixo o handler EXECUTA uma ação (cutuca a clínica / revive a consulta) e conta
  // isso ao paciente com uma frase que depende do resultado da ação — coisa que o modelo não
  // teria como narrar com precisão. SÓ AQUI a supressão se justifica; nos estados informativos
  // acima ela era o que produzia o loop de enlatado.
  if (ctx.turnFlags) ctx.turnFlags.suppressLlmText = true;

  // searching/quoting/failed → dá um alô no consultório e (se falhou) retoma a MESMA consulta.
  const { data: q } = await db.from('consultation_quotes')
    .select('id, clinic_id, conversation_id, clinics(name, whatsapp_e164, phone_e164)')
    .eq('consultation_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const clinic = q?.clinics as { name?: string; whatsapp_e164?: string; phone_e164?: string } | null;
  const clinicPhone = clinic?.whatsapp_e164 ?? clinic?.phone_e164 ?? null;

  if (c.status === 'failed') {
    if (clinicPhone && q?.id) {
      // Revive a MESMA consulta (não duplica). **created_at = agora** é OBRIGATÓRIO: o rescue de 6h
      // decide falhar pela IDADE (created_at); sem resetar, uma consulta que falhou POR ter 6h+
      // seria re-morta no próximo tick de 30s (o "retomando 💙" seguido de "não consegui fechar 😕"
      // que essa frente existe pra matar — pego no review). O .select() torna idempotente: 2 turnos
      // concorrentes (lock fail-open) não re-iniciam a negociação 2×.
      const { data: revived } = await db.from('consultations')
        .update({ status: 'searching', cancelled_reason: null, created_at: new Date().toISOString() })
        .eq('id', c.id).eq('status', 'failed').select('id');
      if (!revived?.length) {
        await sendOutbound(ctx.conversationId, ctx.phoneE164, `Já tô retomando com o consultório ${alvo} 💙 assim que responderem, te aviso!`, ctx.traceId);
        return;
      }
      await db.from('consultation_quotes').update({ status: 'pending', clarification_status: null }).eq('id', q.id);
      const patientName = (await db.from('users').select('preferred_name, full_name').eq('id', ctx.userId).maybeSingle())
        .data as { preferred_name?: string | null; full_name?: string | null } | null;
      const pn = ((patientName?.preferred_name || patientName?.full_name) ?? '').split(' ')[0] || null;
      setImmediate(() => {
        initiateClinicNegotiation({
          quoteId: q.id as string, consultationId: c.id, clinicId: q.clinic_id as string, clinicName: clinic?.name ?? 'consultório',
          clinicWhatsApp: clinicPhone, ctx: { specialty: (c.specialty as string) || 'consulta', urgency: 'rotina', modality: 'indiferente', patientCity: null, plan: (prefs['patient_data'] as { health_plan?: string } | undefined)?.health_plan ?? null, patientName: pn, requestedProfessional: doctor, singleTarget: prefs['single_target'] === true },
          userConversationId: ctx.conversationId, userPhoneE164: ctx.phoneE164, traceId: ctx.traceId,
        }).catch((err) => writeLog('error', 'lookup', `nudge_consultation revive falhou: ${String(err).slice(0, 160)}`, { traceId: ctx.traceId }));
      });
      scheduleConsultationTimeout(c.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
      await sendOutbound(ctx.conversationId, ctx.phoneE164, `Tô retomando com o consultório ${alvo} 💙 dei um alô lá agora — assim que responderem com horário, te aviso!`, ctx.traceId);
    } else {
      await sendOutbound(ctx.conversationId, ctx.phoneE164, `A última tentativa ${alvo} não fechou 💙 me manda de novo o WhatsApp do consultório que eu falo com eles na hora.`, ctx.traceId);
    }
    return;
  }

  // searching/quoting: re-cutuca a clínica (se dá) + tranquiliza
  if (clinicPhone && q?.conversation_id) {
    await sendOutboundToClinic(q.conversation_id, clinicPhone, 'Oi! Só passando pra saber se conseguiu ver um horário — o paciente tá bem interessado 🙂 obrigada!', ctx.traceId).catch(() => { /* best-effort */ });
  }
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Tô insistindo com o consultório ${alvo} 💙 dei mais um alô lá agora — assim que responderem com horário, te aviso na hora!`, ctx.traceId);
}

/** Consulta DIRECIONADA a uma clínica específica (reusa o fluxo de clínica). */
async function contactClinic(phone: string, clinicName: string, specialty: string | undefined, ctx: ReachCtx, professional?: string | null): Promise<void> {
  // Idempotência: não abre uma 2ª busca se já há consulta ativa. Carrega especialidade/médico/
  // preferências pra comparar o ALVO (mesmo médico ou mesmo telefone = NÃO é contato novo).
  const { data: activeC } = await db.from('consultations').select('id, status, specialty, preferences')
    .eq('user_id', ctx.userId).in('status', ['searching', 'quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (activeC) {
    const activePrefs = (activeC.preferences as Record<string, unknown> | null) ?? {};
    // 🎯 MESMO ALVO? (incidente Vadivino 22/07): o paciente perguntou "qual telefone você usou?" e
    // o LLM RE-DISPAROU contact_establishment → guard cancelava+recriava a consulta (4 criadas, 3
    // canceladas) e PERDIA a especialidade (virou "consulta de consulta"). Se o médico pedido OU o
    // telefone da clínica é o MESMO que já está em andamento, isto NÃO é contato novo — é re-envio/
    // pergunta sobre o MESMO. Tranquiliza e NÃO recria (idempotente).
    const sameDoctor = doctorMatch(activePrefs['requested_doctor'] as string | null, professional);
    const newPhoneVariants = brPhoneVariants(phone);
    const { data: activeQuotes } = await db.from('consultation_quotes')
      .select('clinics(whatsapp_e164, phone_e164)').eq('consultation_id', activeC.id);
    const samePhone = (activeQuotes ?? []).some((qq) => {
      const cl = qq.clinics as { whatsapp_e164?: string; phone_e164?: string } | null;
      const cw = cl?.whatsapp_e164 ?? cl?.phone_e164 ?? '';
      return !!cw && newPhoneVariants.includes(cw);
    });
    if (sameDoctor || samePhone) {
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Pode deixar — já tô falando com *${clinicName}*${professional ? ` pra marcar com ${professional}` : ''} 💙 Assim que eles responderem com horário, te aviso na hora. Não precisa reenviar 🙂`,
        ctx.traceId);
      await writeLog('info', 'lookup', 'contactClinic: mesmo alvo já em andamento — tranquiliza, não recria (idempotente)', { traceId: ctx.traceId, consultationId: activeC.id });
      return;
    }
    if (['quoted', 'confirming'].includes(activeC.status as string)) {
      // Já tem OPÇÕES apresentadas / escolha em curso — aí sim pede pra terminar essa antes.
      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Você já tem uma consulta em andamento com opções pra escolher 💙 Deixa eu terminar essa aqui antes, tá?`, ctx.traceId);
      return;
    }
    // Alvo GENUINAMENTE diferente + busca velha em 'searching'/'quoting' → REDIRECIONA (a anterior
    // pode estar travada). Carrega a ESPECIALIDADE da velha se o contato novo não trouxe uma
    // (não deixa a nova virar "consulta" genérica — bug do "consulta de consulta").
    if ((!specialty || specialty === 'consulta') && activeC.specialty && activeC.specialty !== 'consulta') {
      specialty = activeC.specialty as string;
    }
    await db.from('consultations')
      .update({ status: 'cancelled', cancelled_reason: 'redirecionado — paciente forneceu contato direto da clínica' })
      .eq('id', activeC.id).in('status', ['searching', 'quoting']);
    await closeConsultationQuotes(activeC.id, 'redirecionado pra outro contato'); // fecha órfãs (anti "N cotações abertas")
  }

  // R2a — HERANÇA DE CONTEXTO no RETOMAR (incidente Vadivino 22/07): a consulta de neuro FALHOU
  // (rescue 6h) e o "estou dando sequência" nasceu genérica ("consulta de consulta") + re-perguntou
  // convênio. Se há uma consulta RECENTE (<24h) do MESMO médico (viva/falhada/cancelada), herda a
  // especialidade e os dados já coletados (convênio/carteirinha) — o guard de ativos acima já cobriu
  // a MESMA em andamento; aqui cobrimos a retomada de uma encerrada.
  let inheritedPatientData: Record<string, unknown> | undefined;
  if (professional) {
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data: prior } = await db.from('consultations')
      .select('specialty, preferences, created_at')
      .eq('user_id', ctx.userId).gt('created_at', since)
      .order('created_at', { ascending: false }).limit(10);
    for (const p of prior ?? []) {
      const pPrefs = (p.preferences as Record<string, unknown> | null) ?? {};
      if (!doctorMatch(pPrefs['requested_doctor'] as string | null, professional)) continue;
      if ((!specialty || specialty === 'consulta') && p.specialty && p.specialty !== 'consulta') specialty = p.specialty as string;
      if (pPrefs['patient_data'] && typeof pPrefs['patient_data'] === 'object') inheritedPatientData = pPrefs['patient_data'] as Record<string, unknown>;
      break;
    }
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
    // single_target=true: o paciente deu o contato DESTE consultório — a clínica-agent e a
    // consolidação sabem que é alvo único (nunca sugerem outra clínica/médico; agenda distante
    // vira decisão do paciente, não 'unavailable'). guarda o médico pedido → abertura por ELE.
    preferences: {
      single_target: true,
      ...(professional ? { requested_doctor: professional } : {}),
      ...(inheritedPatientData ? { patient_data: inheritedPatientData } : {}),
    } as never,
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
    `Show! Já tô falando com *${clinicName}*${professional ? ` pra marcar com ${professional}` : specialtyPhrase(specialty) ? ` pra ver ${specialtyPhrase(specialty)}` : ''} 🔍 Assim que eles responderem com horário e valor, te aviso 💙`,
    ctx.traceId);
  // 🎯 HONESTIDADE DO QUE FOI DITO (auditoria 30/07). Ela afirmou ao Glauber, duas vezes,
  // "já informei que é pelo IPASGO" — sendo que o contato saíra 10 SEGUNDOS ANTES de ele
  // mencionar o plano, e a mensagem não citava plano nenhum. O modelo não tinha como saber
  // o conteúdo real do que saiu, então preencheu com o que parecia razoável.
  // Agora ele recebe o inventário EXATO do que foi (e do que não foi) dito.
  if (ctx.observation) {
    const foi: string[] = [];
    if (professional) foi.push(`o nome do profissional (${professional})`);
    if (specialtyPhrase(specialty)) foi.push(`a especialidade (${specialtyPhrase(specialty)})`);
    ctx.observation.note =
      `Abertura enviada para ${clinicName}. INCLUÍA: ${foi.length ? foi.join(', ') : 'apenas o pedido genérico de consulta'}.`
      + ` NÃO INCLUÍA o convênio/plano do paciente — esta abertura nunca leva plano.`
      + ` NÃO afirme ao paciente que passou nada além do que está nesta lista.`
      + ` Se ele perguntar do convênio ou disser o plano agora, a verdade é que a clínica AINDA NÃO sabe:`
      + ` use \`message_supplier\` pra complementar de verdade e SÓ DEPOIS diga que informou.`;
  }
  await writeAudit({
    actorType: 'xarlote', action: 'consultation.targeted_contact', userId: ctx.userId,
    targetTable: 'consultation_quotes', targetId: q.id, conversationId: ctx.conversationId,
    traceId: ctx.traceId, metadata: { clinic: clinicName, phone: phone.slice(0, 6) + '***' },
  });

  const patientName = ((profile?.preferred_name as string | null) || (profile?.full_name as string | null) || '').split(' ')[0] || null;
  setImmediate(() => {
    initiateClinicNegotiation({
      quoteId: q.id, consultationId: consult.id, clinicId: clinic.id, clinicName, clinicWhatsApp: phone,
      ctx: { specialty: specialty ?? 'consulta', urgency: 'rotina', modality: 'indiferente', patientCity: city, plan: null, patientName, requestedProfessional: professional ?? null, singleTarget: true },
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
