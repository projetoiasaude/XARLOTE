/**
 * consultation-consolidation — espelho de quote-consolidation, mas pra clínicas.
 *
 * Diferenças do pharmacy:
 *   - Timers MAIS GENEROSOS: clínicas demoram mais (recepção, secretária ocupada).
 *     5min: se ≥3 ofertas → consolida agora
 *     10min: se ≥1 oferta → consolida (vs 5min no pharmacy)
 *     Sem oferta em 10min: modo eager (próxima chegando consolida)
 *   - Ranking diferente: prioriza HORÁRIO PRÓXIMO + RATING DA CLÍNICA + PREÇO
 *     (preço pesa menos que pharmacy porque consulta é "qualidade-first")
 *   - Apresentação inclui: data+hora, médico, modalidade, plano, preço, distância
 */
import { db, writeLog, writeAudit } from '@iasaude/db';
import { sendOutbound } from './outbound.js';

const CHECK_5MIN_MS = 5 * 60 * 1000;
const CHECK_10MIN_MS = 10 * 60 * 1000;
const scheduledTimeouts = new Set<string>();

/**
 * Agenda os timers da consultation. Idempotente — só agenda uma vez.
 */
export function scheduleConsultationTimeout(
  consultationId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): void {
  if (scheduledTimeouts.has(consultationId)) return;
  scheduledTimeouts.add(consultationId);

  setTimeout(() => {
    check5min(consultationId, userConversationId, userPhoneE164, traceId).catch((err) =>
      writeLog('error', 'consultation', `5min check failed: ${String(err)}`, { traceId, consultationId }),
    );
  }, CHECK_5MIN_MS);

  setTimeout(() => {
    check10min(consultationId, userConversationId, userPhoneE164, traceId)
      .catch((err) => writeLog('error', 'consultation', `10min check failed: ${String(err)}`, { traceId, consultationId }))
      .finally(() => scheduledTimeouts.delete(consultationId));
  }, CHECK_10MIN_MS);
}

async function check5min(
  consultationId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  const { data: c } = await db.from('consultations').select('status').eq('id', consultationId).single();
  if (!c || c.status !== 'searching') return;

  const { data: quotes } = await db.from('consultation_quotes').select('status').eq('consultation_id', consultationId);
  const offered = (quotes ?? []).filter((q) => q.status === 'offered').length;

  if (offered >= 3) {
    await writeLog('info', 'consultation', `5min: ${offered} cotações de consulta — consolidando`, { traceId, consultationId });
    await consolidateConsultationQuotesEarly(consultationId, userConversationId, userPhoneE164, traceId);
  } else {
    await writeLog('info', 'consultation', `5min: ${offered} cotação(ões) de consulta — aguardando`, { traceId, consultationId });
  }
}

async function check10min(
  consultationId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  const { data: c } = await db.from('consultations').select('status').eq('id', consultationId).single();
  if (!c || c.status !== 'searching') return;

  const { data: quotes } = await db.from('consultation_quotes').select('status').eq('consultation_id', consultationId);
  const offered = (quotes ?? []).filter((q) => q.status === 'offered').length;

  if (offered >= 1) {
    await writeLog('info', 'consultation', `10min: ${offered} cotação(ões) — consolidando`, { traceId, consultationId });
    await consolidateConsultationQuotesEarly(consultationId, userConversationId, userPhoneE164, traceId);
  } else {
    // Sem ofertas — entra em modo eager via preferences
    await db.from('consultations').update({
      preferences: { eager_consolidate: true },
    }).eq('id', consultationId);
    await writeLog('info', 'consultation', `10min: 0 ofertas — modo eager ativado`, { traceId, consultationId });
  }
}

/**
 * Avisa o paciente quando uma nova oferta chega. Se modo eager, consolida.
 */
export async function notifyUserConsultationQuoteArrived(
  consultationId: string,
  clinicName: string,
  traceId: string,
): Promise<void> {
  const { data: c } = await db
    .from('consultations')
    .select('status, conversation_id, preferences')
    .eq('id', consultationId)
    .single();
  if (!c || c.status !== 'searching') return;

  const userConvId = c.conversation_id;
  if (!userConvId) return;

  const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', userConvId).single();
  const userPhone = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!userPhone) return;
  const userPhoneE164 = `+${userPhone}`;

  // Modo eager?
  const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
  if (prefs['eager_consolidate']) {
    await writeLog('info', 'consultation', `Modo eager — consolidando após resposta de ${clinicName}`, { traceId, consultationId });
    await consolidateConsultationQuotesEarly(consultationId, userConvId, userPhoneE164, traceId);
    return;
  }

  // Notificação incremental
  const { data: quotes } = await db.from('consultation_quotes').select('status').eq('consultation_id', consultationId);
  const offered = (quotes ?? []).filter((q) => q.status === 'offered').length;
  const total = (quotes ?? []).length;

  const msg = offered === 1
    ? `Recebi a primeira proposta aqui (${clinicName}) 💙 vou aguardar mais umas pra te trazer as melhores opções de horário.`
    : `Mais uma proposta de consulta chegando (${clinicName}) — ${offered} de ${total} ✨`;

  await sendOutbound(userConvId, userPhoneE164, msg, traceId);
}

/** Fecha quotes ainda pendentes e consolida. */
async function consolidateConsultationQuotesEarly(
  consultationId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  await db
    .from('consultation_quotes')
    .update({ status: 'timeout' })
    .eq('consultation_id', consultationId)
    .eq('status', 'pending');

  await consolidateConsultationQuotes(consultationId, userConversationId, userPhoneE164, traceId);
}

interface QuoteRow {
  id: string;
  status: string;
  proposed_datetime: string | null;
  alternative_datetimes: string[] | null;
  price_brl: number | null;
  plan_accepted: string | null;
  modality: string | null;
  payment_methods: string[] | null;
  notes: string | null;
  clinic_id: string;
  prescriber_id: string | null;
}

interface ClinicRow {
  id: string;
  name: string;
  rating: number | null;
  city: string | null;
  address: string | null;
}

/**
 * Consolida cotações finais e apresenta top 3 ao paciente. Ranking:
 *   score = horário_proximo * 0.4 + rating * 0.3 + preco_inverso * 0.2 + plano_aceito * 0.1
 */
export async function consolidateConsultationQuotes(
  consultationId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  // Idempotência
  const { data: c } = await db.from('consultations').select('status, specialty').eq('id', consultationId).single();
  if (!c || ['quoted', 'confirming', 'scheduled', 'cancelled', 'completed'].includes(c.status)) return;

  await db.from('consultations').update({ status: 'quoted' }).eq('id', consultationId).eq('status', 'searching');

  const { data: quotes } = await db
    .from('consultation_quotes')
    .select('id, status, proposed_datetime, alternative_datetimes, price_brl, plan_accepted, modality, payment_methods, notes, clinic_id, prescriber_id')
    .eq('consultation_id', consultationId);

  const successful = (quotes ?? []).filter((q) => q.status === 'offered' && q.proposed_datetime) as QuoteRow[];

  if (successful.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      `Infelizmente nenhuma clínica respondeu com horário pra ${c.specialty} nas próximas 10 min 😔 Quer que eu tente em outra região, ou prefere telemedicina? Posso buscar de novo se mudar algum critério.`,
      traceId,
    );
    await db.from('consultations').update({ status: 'failed' }).eq('id', consultationId);
    await writeLog('warn', 'consultation', 'Nenhuma cotação obtida pra consulta', { traceId, consultationId });
    return;
  }

  // Carrega clinics
  const clinicIds = successful.map((q) => q.clinic_id);
  const { data: clinics } = await db.from('clinics').select('id, name, rating, city, address').in('id', clinicIds);
  const clinicMap = new Map<string, ClinicRow>((clinics ?? []).map((c: any) => [c.id, c]));

  // Carrega prescribers (opcional)
  const prescriberIds = successful.map((q) => q.prescriber_id).filter((x): x is string => !!x);
  const { data: prescribers } = prescriberIds.length > 0
    ? await db.from('prescribers').select('id, name, crm').in('id', prescriberIds)
    : { data: [] };
  const prescriberMap = new Map<string, { name: string; crm: string | null }>(
    (prescribers ?? []).map((p: any) => [p.id, p]),
  );

  // Ranking
  const now = Date.now();
  const ranked = [...successful].map((q) => {
    const clinic = clinicMap.get(q.clinic_id);
    const propTime = q.proposed_datetime ? new Date(q.proposed_datetime).getTime() : Number.MAX_SAFE_INTEGER;
    const hoursAway = Math.max(0, (propTime - now) / (1000 * 60 * 60));
    // Quanto mais próximo (mas no futuro), maior score (max 100 pra <=24h, decai)
    const timeScore = hoursAway < 1 ? 50 : Math.max(0, 100 - hoursAway * 0.5);
    const ratingScore = (clinic?.rating ?? 0) * 20; // 0-100
    const priceScore = q.price_brl ? Math.max(0, 100 - q.price_brl / 5) : 50; // R$0 = 100, R$500 = 0
    const score = timeScore * 0.4 + ratingScore * 0.3 + priceScore * 0.3;
    return { q, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  if (ranked.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      'As clínicas responderam mas sem horário claro 😕 Posso tentar de novo?',
      traceId,
    );
    return;
  }

  const NUMBERS = ['1️⃣', '2️⃣', '3️⃣'];
  const lines: string[] = [`Achei algumas opções pra sua consulta de ${c.specialty} 🎉\n`];

  for (let i = 0; i < ranked.length; i++) {
    const { q } = ranked[i] as { q: QuoteRow };
    const clinic = clinicMap.get(q.clinic_id);
    const prescriber = q.prescriber_id ? prescriberMap.get(q.prescriber_id) : null;
    const dt = q.proposed_datetime ? formatDateTimeBR(q.proposed_datetime) : '(horário a confirmar)';
    const doctorPart = prescriber?.name ? ` · Dr(a). ${prescriber.name}${prescriber.crm ? ` (CRM ${prescriber.crm})` : ''}` : '';
    const modePart = q.modality ? ` · ${q.modality}` : '';
    const pricePart = q.price_brl != null ? (q.price_brl > 0 ? ` · R$${q.price_brl.toFixed(2)}` : ` · pelo plano`) : '';
    const planPart = q.plan_accepted && q.plan_accepted.toLowerCase() !== 'particular' ? ` · plano ${q.plan_accepted}` : '';
    const addressPart = clinic?.city ? `\n   📍 ${clinic.city}` : '';

    lines.push(`${NUMBERS[i] ?? `${i + 1}.`} *${clinic?.name ?? 'Clínica'}*\n   📅 ${dt}${doctorPart}${modePart}${pricePart}${planPart}${addressPart}`);
  }

  const unavail = (quotes ?? []).filter((q) => ['unavailable', 'timeout'].includes(q.status)).length;
  if (unavail > 0) {
    lines.push(`\n_(${unavail} clínica${unavail > 1 ? 's' : ''} não pôde encaixar dessa vez)_`);
  }

  lines.push('\nQual te atende melhor? Pode me dizer o número ou o nome da clínica 💙');

  await sendOutbound(userConversationId, userPhoneE164, lines.join('\n'), traceId);

  // Salva snapshot pra Xarlote referenciar quote_id quando user escolher
  const summary = {
    consultation_id: consultationId,
    status: 'quoted',
    options: ranked.map(({ q }, i) => {
      const clinic = clinicMap.get(q.clinic_id);
      const prescriber = q.prescriber_id ? prescriberMap.get(q.prescriber_id) : null;
      return {
        option: i + 1,
        quote_id: q.id,
        clinic_name: clinic?.name,
        clinic_id: q.clinic_id,
        doctor: prescriber?.name,
        crm: prescriber?.crm,
        datetime: q.proposed_datetime,
        modality: q.modality,
        price_brl: q.price_brl,
        plan: q.plan_accepted,
      };
    }),
    instructions: 'Quando o paciente escolher uma opção (ex: "quero a 1", "prefiro o Dr. X", "pode ser a do dia 02"), identifique e chame confirm_consultation_selection com consultation_id + quote_id.',
  };

  // consultations não tem column summary — salvamos em preferences
  await db.from('consultations').update({
    preferences: { ...(c as any).preferences, _consolidated_summary: summary },
  }).eq('id', consultationId);

  await writeAudit({
    actorType: 'system',
    actorId: 'consultation-consolidation',
    action: 'consultation.quoted',
    targetTable: 'consultations',
    targetId: consultationId,
    traceId,
    metadata: { options: ranked.length, top_clinic: clinicMap.get(ranked[0]!.q.clinic_id)?.name },
  });

  await writeLog('info', 'consultation', `Consolidação: ${ranked.length} opções apresentadas`, {
    traceId, consultationId,
  });
}

function formatDateTimeBR(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${day} às ${time}`;
  } catch {
    return iso;
  }
}
