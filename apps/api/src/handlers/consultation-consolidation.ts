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
import { db, writeLog, writeAudit, writeEvent } from '@iasaude/db';
import { pickValidOffers, isOfferStillValid } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { hasPendingClinicClarification } from './clarification.js';

const CHECK_5MIN_MS = 5 * 60 * 1000;
const CHECK_10MIN_MS = 10 * 60 * 1000;
// LATÊNCIA DE CLÍNICA ≠ FARMÁCIA (incidente Vadivino/São Silvestre 21/07): farmácia responde em
// minutos, clínica em HORAS (recepção, secretária). O erro era o check de 10min tratar clínica
// CONTATADA (status 'offered') como se tivesse RESPONDIDO → consolidava sem horário → "nenhuma
// clínica respondeu" + failed, matando um caso que a clínica responderia em 1-2h.
//   RESCUE_WINDOW_MIN: só um NUDGE ("ainda aguardando, te aviso"), NÃO falha.
//   CLINIC_FAIL_MIN: horizonte LONGO — só aqui desiste, com honestidade e oferecendo alternativa.
// Rede de segurança: agent-clinic revive consulta 'failed'/'searching' quando a clínica responde
// tarde → mesmo após desistir, um retorno da clínica reabre e apresenta.
const RESCUE_WINDOW_MIN = Number(process.env['CLINIC_QUOTE_WINDOW_MIN'] ?? 45);
const CLINIC_FAIL_MIN = Number(process.env['CLINIC_FAIL_MIN'] ?? 360); // 6h antes de desistir
const scheduledTimeouts = new Set<string>();

/**
 * Resposta REAL da clínica = contatada (`offered`), retornou com HORÁRIO, **e o horário
 * ainda vale**. "offered" sozinho é só "mandei mensagem, aguardando".
 *
 * ⚠️ A validade temporal é a parte nova, e é o que destrava o rescue. Sem ela, uma oferta
 * vencida contava como resposta real → `countRealReplies >= 1` → o rescue dava `continue`
 * e NUNCA alcançava o teste de falha → a consulta com oferta podre era imortal (caso Ciro:
 * 9 dias com uma oferta de 27/07). Agora a oferta vencida não conta, o rescue chega ao
 * fim do horizonte e falha com honestidade.
 */
export function countRealReplies(quotes: Array<{ status: string; proposed_datetime: string | null }> | null): number {
  return pickValidOffers(quotes, Date.now()).length;
}

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
      .select('id, conversation_id, created_at, specialty, preferences')
      .eq('status', 'searching')
      .lt('created_at', cutoff)
      .limit(50);
    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'consultation', `rescue query falhou: ${error.message}`, {});
      return;
    }
    const now = Date.now();
    // 🌙 QUIET HOURS (incidente Vadivino 22/07: "não consegui fechar" às 02:25): de madrugada não
    // FALHA consulta nem manda nudge (re-engajamento não-urgente) — só apresenta boa-nova (oferta
    // real). O consult fica vivo e o próximo scan diurno resolve. Base de usuários BR (Brasília).
    const hourBrt = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date(now)));
    const isNightBrt = hourBrt >= 22 || hourBrt < 7;
    for (const c of rows ?? []) {
      try {
        if (!c.conversation_id) continue;
        const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', c.conversation_id).single();
        const phone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
        if (!phone) continue;
        const phoneE164 = `+${phone}`;
        const traceId = `rescue-consult-${c.id}`;

        // 1) Já tem resposta REAL (horário) esperando? Apresenta AGORA.
        const { data: qs } = await db.from('consultation_quotes').select('status, proposed_datetime').eq('consultation_id', c.id);
        if (countRealReplies(qs) >= 1) {
          await writeLog('info', 'consultation', `Rescue: clínica respondeu com horário — consolidando`, { traceId, consultationId: c.id });
          await consolidateConsultationQuotes(c.id, c.conversation_id, phoneE164, traceId);
          continue;
        }

        // 2) Sem horário ainda. Horizonte LONGO estourou → desiste com honestidade (allowFail).
        const ageMin = (now - new Date(c.created_at as string).getTime()) / 60_000;
        if (ageMin >= CLINIC_FAIL_MIN) {
          if (isNightBrt) continue; // não desiste de madrugada — espera o dia (evita fail às 2h)
          // R5 (incidente Vadivino 22/07): NÃO desiste se a CLÍNICA ainda está CONVERSANDO. Ela
          // ofertou "amanhã, mas particular" às 18:45 e o rescue matou a consulta às 19:39 (54min
          // depois) — perdendo uma negociação VIVA. Só falha se a clínica está de fato muda há horas.
          const { data: cq } = await db.from('consultation_quotes')
            .select('conversation_id').eq('consultation_id', c.id)
            .not('conversation_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (cq?.conversation_id) {
            const { data: lastIn } = await db.from('messages')
              .select('created_at').eq('conversation_id', cq.conversation_id).eq('direction', 'in')
              .order('created_at', { ascending: false }).limit(1).maybeSingle();
            const clinicActive = !!lastIn?.created_at && (now - new Date(lastIn.created_at as string).getTime()) < 2 * 60 * 60 * 1000;
            if (clinicActive) {
              await writeLog('info', 'consultation', `Rescue: ${Math.round(ageMin)}min mas a CLÍNICA respondeu há pouco — negociação viva, NÃO desiste`, { traceId, consultationId: c.id });
              continue; // dá mais tempo; o próximo scan reavalia (quando a clínica calar de vez, falha)
            }
          }
          await writeLog('warn', 'consultation', `Rescue: ${Math.round(ageMin)}min sem retorno de clínica — desistindo (honesto)`, { traceId, consultationId: c.id });
          await consolidateConsultationQuotes(c.id, c.conversation_id, phoneE164, traceId, true);
          continue;
        }

        // 3) Entre o nudge e o fail: tranquiliza UMA vez (não repete o do check de 10min). Não de madrugada.
        const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
        if (!prefs['waiting_nudged'] && !isNightBrt) {
          await db.from('consultations').update({ preferences: { ...prefs, waiting_nudged: true } }).eq('id', c.id);
          await sendOutbound(c.conversation_id, phoneE164,
            `Ainda tô aguardando o retorno da clínica sobre sua consulta de ${c.specialty} 🙏 Elas às vezes demoram um pouco pra responder. Assim que tiver horário, te aviso na hora!`,
            traceId);
          await writeLog('info', 'consultation', `Rescue: paciente tranquilizado (aguardando clínica, ${Math.round(ageMin)}min)`, { traceId, consultationId: c.id });
        }
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

  const { data: quotes } = await db.from('consultation_quotes').select('status, proposed_datetime').eq('consultation_id', consultationId);
  const replies = countRealReplies(quotes);

  if (replies >= 2) {
    await writeLog('info', 'consultation', `5min: ${replies} clínica(s) responderam com horário — consolidando`, { traceId, consultationId });
    await consolidateConsultationQuotesEarly(consultationId, userConversationId, userPhoneE164, traceId);
  } else {
    await writeLog('info', 'consultation', `5min: ${replies} resposta(s) com horário — aguardando`, { traceId, consultationId });
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

  const { data: quotes } = await db.from('consultation_quotes').select('status, proposed_datetime').eq('consultation_id', consultationId);
  const replies = countRealReplies(quotes);
  const contacted = (quotes ?? []).filter((q) => q.status === 'offered').length;

  if (replies >= 1) {
    await writeLog('info', 'consultation', `10min: ${replies} resposta(s) com horário — consolidando`, { traceId, consultationId });
    await consolidateConsultationQuotesEarly(consultationId, userConversationId, userPhoneE164, traceId);
    return;
  }

  // Nenhuma clínica RESPONDEU com horário ainda (clínica demora horas). NÃO falha: ativa modo eager
  // (a próxima resposta consolida) e TRANQUILIZA o paciente UMA vez, em vez de dizer "ninguém
  // respondeu" (o erro do caso Vadivino). MERGE nas preferences (preserva plan/horario_pref).
  const { data: cur } = await db.from('consultations').select('preferences').eq('id', consultationId).single();
  const prefs = (cur?.preferences as Record<string, unknown> | null) ?? {};
  const willNudge = contacted >= 1 && !prefs['waiting_nudged'];
  await db.from('consultations').update({
    preferences: { ...prefs, eager_consolidate: true, ...(willNudge ? { waiting_nudged: true } : {}) },
  }).eq('id', consultationId);
  if (willNudge) {
    await sendOutbound(userConversationId, userPhoneE164,
      `Já falei com ${contacted === 1 ? 'a clínica' : 'as clínicas'} e tô aguardando o retorno com horário 💙 Clínica às vezes demora um pouquinho (recepção, secretária), mas assim que responderem eu te aviso na hora, tá?`,
      traceId);
  }
  await writeLog('info', 'consultation', `10min: 0 respostas com horário (${contacted} contatada(s)) — eager${willNudge ? ' + paciente tranquilizado' : ''}`, { traceId, consultationId });
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

  // Modo eager OU ALVO ÚNICO: uma clínica só — não há "mais umas" pra esperar, então consolida/
  // apresenta a oferta na hora (nunca diz "vou aguardar mais umas", que pressupõe várias clínicas).
  const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
  if (prefs['eager_consolidate'] || prefs['single_target'] === true) {
    await writeLog('info', 'consultation', `${prefs['single_target'] === true ? 'Alvo único' : 'Modo eager'} — consolidando após resposta de ${clinicName}`, { traceId, consultationId });
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

/**
 * INVARIANTE DE CICLO DE VIDA (incidente Vadivino 22/07): quando uma consulta vira terminal
 * (failed/cancelled), suas cotações ainda 'pending'/'offered' precisam ser FECHADAS — senão ficam
 * abertas na conversa COMPARTILHADA da clínica (mesma por telefone) e o agent-clinic vê "N cotações
 * abertas na mesma conversa" (19× no caso Vadivino) e atribui a resposta à errada. Fecha pra
 * 'unavailable' (NÃO 'timeout' — timeout é revivível pela resposta-tardia; um alvo morto não deve
 * ressuscitar). Idempotente, escopo por consultation_id (não toca cotações de OUTRAS consultas). */
export async function closeConsultationQuotes(consultationId: string, reason: string): Promise<void> {
  await db.from('consultation_quotes')
    .update({ status: 'unavailable', notes: `[encerrada] ${reason}`.slice(0, 200), responded_at: new Date().toISOString() })
    .eq('consultation_id', consultationId).in('status', ['pending', 'offered']);
}

/**
 * ⏰ EXPIRA oferta de horário que já passou. Espelha `expireAbandonedQuotes` do
 * order-followup — o análogo de farmácia que a consulta nunca teve.
 *
 * Por que existe: em 03/08 as 5 cotações "confirmáveis" do banco tinham data no passado (a
 * mais antiga de 06/07). Os filtros de validade que acabei de espalhar impedem que elas
 * sejam apresentadas ou confirmadas, mas elas continuariam PARADAS no estado `offered` pra
 * sempre, poluindo a conversa compartilhada da clínica e a contagem de cotações abertas.
 *
 * Status escolhido: **`withdrawn`**. Está no CHECK da migration e não tem NENHUM outro
 * escritor — é o único slot semanticamente livre. `unavailable` significa "a clínica
 * recusou" (não foi o caso: ela ofereceu, o tempo passou) e `timeout` é revivível pela
 * resposta tardia da clínica, o que ressuscitaria justamente a oferta morta.
 */
export async function expireStaleConsultationOffers(): Promise<void> {
  try {
    const cutoffIso = new Date(Date.now() - 30 * 60_000).toISOString(); // mesma tolerância do predicado
    const { data: stale } = await db
      .from('consultation_quotes')
      .select('id, consultation_id, proposed_datetime')
      .in('status', ['pending', 'offered'])
      .not('proposed_datetime', 'is', null)
      .lt('proposed_datetime', cutoffIso)
      .limit(50);
    if (!stale?.length) return;

    for (const q of stale) {
      const { data: done } = await db.from('consultation_quotes')
        .update({
          status: 'withdrawn',
          notes: `[oferta vencida] o horário ${String(q.proposed_datetime).slice(0, 16)} passou sem confirmação`.slice(0, 200),
          responded_at: new Date().toISOString(),
        })
        .eq('id', q.id as string).in('status', ['pending', 'offered']).select('id');
      if (!done?.length) continue; // outro tick pegou primeiro
      await writeEvent({
        eventName: 'consultation.offer_expired',
        payload: { quote_id: q.id, consultation_id: q.consultation_id, proposed_datetime: q.proposed_datetime },
      }).catch(() => { /* evento é best-effort */ });
    }
    await writeLog('info', 'consultation', `⏰ ${stale.length} oferta(s) de horário vencida(s) marcada(s) como withdrawn`, {});
  } catch (err) {
    await writeLog('warn', 'consultation', `expireStaleConsultationOffers falhou: ${String(err).slice(0, 160)}`, {});
  }
}

/**
 * ALVO ÚNICO — beco sem saída HONESTO (incidente Vadivino 22/07): a ÚNICA clínica que o paciente
 * escolheu não pode atender de jeito nenhum (número errado, médico não atende ali). Não há outra
 * clínica pra procurar e **NÃO se sugere outro médico**. Avisa o paciente com honestidade, deixa a
 * porta aberta (outro contato / insistir) e encerra a consulta (failed) — nunca fica em silêncio.
 * Idempotente: só encerra/avisa se a consulta ainda estava em andamento.
 */
export async function notifyUserSingleTargetDeadEnd(
  consultationId: string,
  clinicName: string,
  professional: string | null,
  reason: string | null,
  traceId: string,
): Promise<void> {
  // NÃO sobrescreve 'quoted' (uma opção JÁ foi apresentada ao paciente — ele pode escolhê-la):
  // só encerra se ainda estava buscando. Evita o "Consegui um horário 🎉" seguido de "não consegui 😕"
  // caso o LLM emita record_consultation_quote E record_clinic_unavailable no mesmo turno.
  const { data: flipped } = await db.from('consultations')
    .update({ status: 'failed', cancelled_reason: `alvo único indisponível: ${reason ?? 'sem vaga'}`.slice(0, 200) })
    .eq('id', consultationId).in('status', ['searching', 'quoting']).select('conversation_id, specialty');
  const row = flipped?.[0];
  if (!row?.conversation_id) return; // já resolvida/encerrada/apresentada por outro caminho — não duplica aviso
  await closeConsultationQuotes(consultationId, 'alvo único indisponível'); // fecha órfãs (anti-ambiguidade)
  const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', row.conversation_id).single();
  const phone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!phone) return;
  const alvo = professional ? `com ${professional}` : 'nesse consultório';
  const motivo = reason ? ` (me disseram: ${reason})` : '';
  await sendOutbound(row.conversation_id, `+${phone}`,
    `Falei com *${clinicName}* pra marcar sua consulta ${alvo}, mas não consegui encaixar dessa vez${motivo} 😕 Se você tiver outro contato dele(a) — ou quiser que eu insista com eles — é só me falar que eu sigo na hora 💙`,
    traceId);
  await writeLog('info', 'consultation', 'Alvo único encerrado com honestidade (paciente avisado, sem sugerir outro médico)', { traceId, consultationId });
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
  allowFail = false,
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

  // Só oferta com horário que AINDA VALE é apresentável. Apresentar uma opção vencida
  // (numerada, com "quer que eu confirme?") é convidar o paciente a fechar um horário que
  // já passou — e o "sim" dele viraria mensagem à clínica pedindo uma data da semana anterior.
  const successful = pickValidOffers(quotes as QuoteRow[] | null, Date.now()) as QuoteRow[];

  if (successful.length === 0) {
    if (!allowFail) {
      // Timers/eager: NENHUM horário ainda ≠ falha (clínica demora horas). Desfaz a transição
      // pra 'quoted' e volta pra 'searching' — a próxima resposta da clínica (eager/rescue)
      // consolida. Só o rescue de horizonte longo (allowFail) desiste de verdade. Era AQUI que o
      // "nas próximas 10 min" matava a consulta do Vadivino antes do São Silvestre responder.
      await db.from('consultations').update({ status: 'searching' }).eq('id', consultationId).eq('status', 'quoted');
      await writeLog('info', 'consultation', 'Sem horário de clínica ainda — mantém aguardando (não falha)', { traceId, consultationId });
      return;
    }
    // ALVO ÚNICO: uma clínica só, escolhida pelo paciente — NÃO sugere outra região/telemedicina/
    // outro médico (proibido). Honesto + porta aberta (insistir / outro contato do mesmo médico).
    const singleTarget = ((c as { preferences?: Record<string, unknown> | null }).preferences?.['single_target']) === true;
    if (singleTarget) {
      await sendOutbound(
        userConversationId,
        userPhoneE164,
        // Neutro de propósito: às vezes a espera é no consultório, às vezes é no paciente (ficou
        // uma pergunta/oferta pendente). "não consegui FECHAR" é verdade nos dois casos.
        `Sobre sua consulta de ${c.specialty}: ainda não consegui fechar com o consultório 😕 Não vou te deixar no vácuo — quer que eu insista com eles, ou você tem outro contato/jeito de falar com o médico? Me diz que eu sigo.`,
        traceId,
      );
      await db.from('consultations').update({ status: 'failed' }).eq('id', consultationId);
      await closeConsultationQuotes(consultationId, 'sem retorno da clínica (horizonte longo)');
      await writeLog('warn', 'consultation', 'Alvo único sem retorno (horizonte longo) — paciente avisado, sem sugerir alternativa', { traceId, consultationId });
      return;
    }
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      `Sobre sua consulta de ${c.specialty}: as clínicas ainda não me retornaram com horário 😕 Não quero te deixar no vácuo. Quer que eu tente em outra região, procure por telemedicina, ou prefere aguardar mais um pouco? Me diz que eu sigo daqui.`,
      traceId,
    );
    await db.from('consultations').update({ status: 'failed' }).eq('id', consultationId);
    await closeConsultationQuotes(consultationId, 'nenhuma clínica retornou (horizonte longo)');
    await writeLog('warn', 'consultation', 'Nenhuma cotação obtida pra consulta (horizonte longo)', { traceId, consultationId });
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
    // ⚠️ SEM `Math.max(0, …)` aqui: ele colapsava data PASSADA em 0, e `hoursAway < 1`
    // premiava a oferta vencida com o mesmo score de "dentro de 1h". O filtro de validade
    // acima já as remove; deixar a máscara era guardar a armadilha pro próximo refactor.
    const hoursAway = (propTime - now) / (1000 * 60 * 60);
    // Quanto mais próximo (mas no futuro), maior score (max 100 pra <=24h, decai).
    // Passado (negativo) vai a zero de propósito — nunca deve ganhar de um horário real.
    const timeScore = hoursAway < 0 ? 0 : hoursAway < 1 ? 50 : Math.max(0, 100 - hoursAway * 0.5);
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
  const singleOpt = ranked.length === 1;
  const lines: string[] = [singleOpt
    ? `Consegui um horário pra sua consulta de ${c.specialty} 🎉\n`
    : `Achei algumas opções pra sua consulta de ${c.specialty} 🎉\n`];

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

  lines.push(singleOpt
    ? '\nQuer que eu confirme esse horário? É só me dizer "pode ser" 💙'
    : '\nQual te atende melhor? Pode me dizer o número ou o nome da clínica 💙');

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
