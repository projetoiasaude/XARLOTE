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
import { hasPendingClinicClarification } from './clarification.js';

const CHECK_5MIN_MS = 5 * 60 * 1000;
const CHECK_10MIN_MS = 10 * 60 * 1000;
// JANELA REAL de resposta da clínica (recalibrada c/ dados do 1º dia real: recepção
// demora — o muro de 12min matava a consulta antes da 1ª resposta). O check de 10min
// só ativa modo eager (não falha); quem encerra de verdade é o rescue nesta janela.
const RESCUE_WINDOW_MIN = Number(process.env['CLINIC_QUOTE_WINDOW_MIN'] ?? 45);
const scheduledTimeouts = new Set<string>();

/**
 * RESGATE DURÁVEL de consultas (espelho de rescueOrphanedPharmacyQuotes).
 *
 * Os timers 5/10min e o modo eager vivem em memória — se o processo reinicia, OU
 * se a consolidação foi adiada pelo gate de clarificação (loop agêntico) e nada
 * mais re-dispara, a consulta fica presa em 'searching' PARA SEMPRE e o paciente
 * nunca recebe as opções que já chegaram. Este scan roda no worker (a cada 30s) e
 * consolida qualquer consulta presa além de RESCUE_WINDOW_MIN. Seguro junto com os
 * timers: consolidateConsultationQuotes faz transição atômica searching→quoted
 * (quem chegar segundo vira no-op) e re-checa o gate de clarificação (vira no-op
 * enquanto pendente, prossegue após a janela de 8min).
 */
export async function rescueStalledConsultations(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RESCUE_WINDOW_MIN * 60_000).toISOString();
    const { data: rows, error } = await db
      .from('consultations')
      .select('id, conversation_id, created_at')
      .eq('status', 'searching')
      .lt('created_at', cutoff)
      .limit(50);
    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'consultation', `rescue query falhou: ${error.message}`, {});
      return;
    }
    for (const c of rows ?? []) {
      try {
        if (!c.conversation_id) continue;
        const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', c.conversation_id).single();
        const phone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
        if (!phone) continue;
        const traceId = `rescue-consult-${c.id}`;
        await writeLog('warn', 'consultation', `Resgatando consulta presa em 'searching' (>${RESCUE_WINDOW_MIN}min)`, { traceId, consultationId: c.id });
        await consolidateConsultationQuotes(c.id, c.conversation_id, `+${phone}`, traceId);
      } catch (err) {
        await writeLog('error', 'consultation', `rescue de consulta falhou: ${String(err).slice(0, 160)}`, { consultationId: c.id });
      }
    }

    await rescueStuckConfirming();
  } catch (err) {
    await writeLog('error', 'consultation', `rescueStalledConsultations falhou: ${String(err).slice(0, 160)}`, {});
  }
}

/**
 * Destrava consultas presas em 'confirming' (paciente escolheu, clínica nunca
 * reconfirmou). Sem isto, a consulta fica 'confirming' PARA SEMPRE: a guarda de
 * idempotência de start_consultation_search bloqueia qualquer nova busca do
 * paciente ("você já tem uma busca em andamento"). Dois estágios:
 *   > 3h sem atividade → avisa o paciente UMA vez (honesto, dedup por flag).
 *   > 12h → volta pra 'quoted' (destrava + reapresenta opções) e cancela os
 *           lembretes pré-criados (que apontavam pra um horário NÃO confirmado).
 */
async function rescueStuckConfirming(): Promise<void> {
  const cutoff3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db
    .from('consultations')
    .select('id, conversation_id, specialty, preferences, updated_at')
    .eq('status', 'confirming')
    .lt('updated_at', cutoff3h)
    .limit(30);
  if (error || !rows?.length) return;

  const now = Date.now();
  for (const c of rows) {
    try {
      if (!c.conversation_id) continue;
      const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', c.conversation_id).single();
      const phone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
      if (!phone) continue;
      const phoneE164 = `+${phone}`;
      const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
      const ageMs = now - new Date(c.updated_at as string).getTime();
      const traceId = `rescue-confirming-${c.id}`;

      if (ageMs > 12 * 60 * 60 * 1000) {
        // Destrava: volta pra 'quoted' (opções ainda no _consolidated_summary) e
        // cancela os lembretes que apontavam pro horário não confirmado.
        const { data: flipped } = await db.from('consultations')
          .update({ status: 'quoted' }).eq('id', c.id).eq('status', 'confirming').select('id');
        if (!flipped?.length) continue; // outro processo já mexeu
        await db.from('reminders').update({ status: 'cancelled' })
          .eq('status', 'pending').filter('payload->>consultation_id', 'eq', c.id);
        await sendOutbound(c.conversation_id, phoneE164,
          `Sobre sua consulta de ${c.specialty}: a clínica ainda não confirmou a reserva 😕 Liberei de novo as opções — quer tentar outra clínica ou horário? (Se preferir, ligue direto na clínica pra confirmar.)`,
          traceId);
        await writeLog('warn', 'consultation', `Consulta 'confirming' >12h sem reconfirmação → revertida pra 'quoted'`, { traceId, consultationId: c.id });
      } else if (!prefs['confirming_nudged']) {
        // 3-12h: avisa UMA vez (honesto) sem mexer no estado.
        await db.from('consultations').update({
          preferences: { ...prefs, confirming_nudged: true },
        }).eq('id', c.id);
        await sendOutbound(c.conversation_id, phoneE164,
          `Oi! Ainda estou aguardando a clínica confirmar sua consulta de ${c.specialty} 🙏 Assim que tiver retorno eu te aviso. Se quiser, posso buscar outra opção em paralelo — é só falar!`,
          traceId);
        await writeLog('info', 'consultation', `Consulta 'confirming' >3h — paciente avisado (aguardando clínica)`, { traceId, consultationId: c.id });
      }
    } catch (err) {
      await writeLog('error', 'consultation', `rescueStuckConfirming falhou p/ ${c.id}: ${String(err).slice(0, 140)}`, {});
    }
  }
}

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
    // Sem ofertas — entra em modo eager via preferences. MERGE (não sobrescreve):
    // preserva plan/horario_pref que a negociação com a clínica usa. Antes o objeto
    // inteiro era substituído por { eager_consolidate:true }, apagando o contexto.
    const { data: cur } = await db.from('consultations').select('preferences').eq('id', consultationId).single();
    await db.from('consultations').update({
      preferences: { ...((cur?.preferences as Record<string, unknown> | null) ?? {}), eager_consolidate: true },
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
  // Loop agêntico (Fase 4): se uma clínica fez uma pergunta que ainda aguarda
  // o paciente, NÃO consolida agora — espera a resposta (a janela libera sozinha
  // após CLARIFICATION_WAIT_MIN, então nunca trava pra sempre).
  if (await hasPendingClinicClarification(consultationId)) {
    await writeLog('info', 'consultation', 'Consolidação adiada — clarificação de clínica pendente', { traceId, consultationId });
    return;
  }

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
  // Loop agêntico (Fase 4): gate de clarificação — não apresenta opções enquanto
  // uma clínica aguarda um dado do paciente (mesma proteção da consolidação de farmácia).
  if (await hasPendingClinicClarification(consultationId)) {
    await writeLog('info', 'consultation', 'Consolidação adiada — clarificação de clínica pendente', { traceId, consultationId });
    return;
  }

  // Idempotência (fast-path)
  const { data: c } = await db.from('consultations').select('status, specialty, preferences').eq('id', consultationId).single();
  if (!c || ['quoted', 'confirming', 'scheduled', 'cancelled', 'completed'].includes(c.status)) return;

  // Transição ATÔMICA searching→quoted: quem chegar em segundo casa 0 linhas e vira
  // no-op. Sem isso, timer+eager+rescue disparando juntos apresentavam as opções
  // ao paciente DUAS vezes (o .eq('status','searching') filtrava, mas o código
  // seguia mesmo com 0 linhas afetadas). O .select('id') deixa o count visível.
  const { data: transitioned } = await db.from('consultations')
    .update({ status: 'quoted' }).eq('id', consultationId).eq('status', 'searching').select('id');
  if (!transitioned || transitioned.length === 0) {
    await writeLog('info', 'consultation', 'Consolidação já em curso/feita por outro processo — no-op', { traceId, consultationId });
    return;
  }

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
    // Local = endereço da clínica (é pra lá que o paciente vai); cai pra cidade se não tiver.
    const localText = clinic?.address || clinic?.city;
    const addressPart = localText ? `\n   📍 ${localText}` : '';

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
