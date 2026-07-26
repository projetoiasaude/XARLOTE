/**
 * agent-clinic — handler que negocia agendamento de consulta médica com
 * recepções de clínicas via WhatsApp. Espelho de `inbound-supplier.ts`, mas
 * pra clínica: usa `consultation_quotes` em vez de `quotes`, prompt
 * `buildAgentClinicSystemPrompt`, tools `agentClinicTools`.
 *
 * Idempotência: cada conversa de clínica fica linkada a UMA consultation_quote
 * via `conversation_id`. Mensagens da clínica fora desse contexto são logadas
 * e ignoradas.
 */
import { randomUUID } from 'crypto';
import { db, findOrCreateConversation, getConversationMessages, writeLog, writeAudit, writeEvent } from '@iasaude/db';
import {
  chat,
  buildAgentClinicSystemPrompt,
  agentClinicTools,
  messagesToHistory,
  trimHistory,
  type AgentClinicContext,
} from '@iasaude/llm';
import { AGENT_INSTANCE, whatsappJidVariants } from '@iasaude/shared';
import type { NormalizedInbound, Message } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { sendOutboundToClinic, sendTemplateOpeningToClinic } from './outbound-agent.js';
import { templatesEnabled } from '../config/template-registry.js';
import {
  consolidateConsultationQuotes,
  notifyUserConsultationQuoteArrived,
  notifyUserSingleTargetDeadEnd,
} from './consultation-consolidation.js';
import { relayClinicQuestionToUser } from './clarification.js';

export interface ClinicInboundCtx {
  conversationId: string;
  clinicPhone: string;
  text: string;
  traceId: string;
}

/**
 * Escolhe a mensagem de CORTESIA determinística pra clínica quando o LLM chamou uma
 * tool mas NÃO gerou texto (bug conhecido do gpt-4.1-mini). Puro/testável.
 * Prioridade: confirmação de agendamento > pergunta ao paciente > horário anotado.
 */
export function pickClinicFallbackMessage(flags: {
  appointmentConfirmed: boolean;
  clarificationRequested: boolean;
}): string {
  if (flags.appointmentConfirmed) return 'Perfeito, muito obrigada! Tá tudo certo então 🙂';
  if (flags.clarificationRequested) return 'Deixa eu confirmar isso aqui rapidinho e já te respondo, tá? Obrigada!';
  return 'Anotei o horário! Deixa eu confirmar aqui e já te retorno pra fechar, tá? 🙂';
}

export async function processInboundClinic(ctx: ClinicInboundCtx): Promise<void> {
  const { conversationId, clinicPhone, text, traceId } = ctx;
  const t0 = Date.now();

  // 1. Persistir mensagem da clínica
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'in',
    sender_role: 'supplier', // schema usa 'supplier' como gênero pra B2B; semântica é clínica
    content_type: 'text',
    content: text,
    trace_id: traceId,
  });
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  // 2. Carrega a conversa (precisa de clinic_id)
  const { data: conv } = await db.from('conversations').select('*').eq('id', conversationId).single();
  if (!conv) {
    await writeLog('warn', 'clinic', 'Conversa de clínica não encontrada', { traceId, conversationId });
    return;
  }

  const clinicId = (conv as any).clinic_id as string | undefined;
  if (!clinicId) {
    await writeLog('warn', 'clinic', `Conv ${conversationId} sem clinic_id — não dá pra rotear pra clínica`, { traceId });
    return;
  }

  // 3. Acha a quote ativa da clínica nesta conversa
  let quote: any = null;
  let isAppointmentConfirmation = false;

  {
    // Todas as cotações abertas nesta conversa de clínica (conversa compartilhada
    // por telefone). Mais de uma consulta concorrente pra mesma clínica =
    // ambiguidade: atribuímos à mais recente e logamos pra auditoria.
    const { data: openQuotes, error: openErr } = await db
      .from('consultation_quotes')
      // ⚠️ Embed DESAMBIGUADO: existem DUAS FKs entre consultation_quotes e
      // consultations (consultation_id → consultations, e consultations.selected_quote_id
      // → consultation_quotes). Sem o hint, o PostgREST retorna PGRST201 (data=null) e a
      // cotação "some" → a clínica respondia e a Xarlote ficava muda. clinics(*) é
      // inequívoco (só a FK clinic_id).
      .select('*, consultations!consultation_quotes_consultation_id_fkey(*), clinics(*)')
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'offered'])
      .order('created_at', { ascending: false });
    // Torna VISÍVEL um erro de query (ex.: embed ambíguo) — antes era engolido em
    // silêncio e a cotação parecia "não existir", travando a resposta à clínica.
    if (openErr) {
      await writeLog('error', 'clinic', `Erro ao buscar cotação da clínica: ${openErr.message}`, { traceId, conversationId });
    }
    if (openQuotes && openQuotes.length > 1) {
      await writeLog(
        'warn',
        'clinic',
        `⚠️ ${openQuotes.length} cotações de consulta abertas na mesma conversa de clínica — resposta atribuída à mais recente (possível mistura; resolve 100% com código de referência)`,
        { traceId, conversationId, openQuoteIds: (openQuotes as Array<{ id: string }>).map((q) => q.id) },
      );
    }
    quote = openQuotes?.[0] ?? null;
  }

  // Se a consulta já foi escolhida e estamos esperando a clínica reconfirmar
  if (!quote) {
    const { data } = await db
      .from('consultation_quotes')
      // ⚠️ Embed DESAMBIGUADO: existem DUAS FKs entre consultation_quotes e
      // consultations (consultation_id → consultations, e consultations.selected_quote_id
      // → consultation_quotes). Sem o hint, o PostgREST retorna PGRST201 (data=null) e a
      // cotação "some" → a clínica respondia e a Xarlote ficava muda. clinics(*) é
      // inequívoco (só a FK clinic_id).
      .select('*, consultations!consultation_quotes_consultation_id_fkey(*), clinics(*)')
      .eq('conversation_id', conversationId)
      .eq('status', 'selected')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data && (data.consultations as any)?.status === 'confirming') {
      quote = data;
      isAppointmentConfirmation = true;
    }
  }

  // 🔁 REVIVE DE RESPOSTA TARDIA (paridade com a farmácia — inbound-supplier.ts):
  // a clínica respondeu DEPOIS do timeout. Antes a msg caía no warn abaixo e era
  // DESCARTADA (caso real: 4 ofertas de clínica perdidas às 08:14 de 02/07 — a
  // consulta tinha morrido em 'failed' e as ofertas nunca chegaram ao paciente).
  // Se há cotação 'timeout' desta conversa com consulta recente (<24h) e a consulta
  // ainda faz sentido (searching/failed/quoted), revivemos: quote volta pra 'pending'
  // (o passo 5 marca 'offered') e consulta 'failed' flipa atomicamente pra 'searching'
  // — a consolidação/rescue apresenta a boa notícia quando a oferta for registrada.
  if (!quote) {
    // SÓ 'timeout' (não 'unavailable'): revive a clínica LENTA que respondeu tarde. NÃO revive
    // 'unavailable' — um beco sem saída (alvo único encerrado, "não atende") reabriria em qualquer
    // "de nada/tchau" da clínica, ressuscitando uma consulta que o paciente já abandonou → duas
    // consultas ativas + trava a próxima busca (regressão que o review pegou).
    const { data: late } = await db
      .from('consultation_quotes')
      .select('*, consultations!consultation_quotes_consultation_id_fkey(*), clinics(*)')
      .eq('conversation_id', conversationId)
      .eq('status', 'timeout')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lateConsult = late?.consultations as { id?: string; status?: string; created_at?: string } | null;
    const ageOk = lateConsult?.created_at
      ? Date.now() - new Date(lateConsult.created_at).getTime() < 24 * 60 * 60 * 1000
      : false;
    if (late && lateConsult && ageOk && ['searching', 'failed', 'quoted'].includes(lateConsult.status ?? '')) {
      await db.from('consultation_quotes').update({ status: 'pending' }).eq('id', late.id);
      if (lateConsult.status === 'failed') {
        await db.from('consultations').update({ status: 'searching' }).eq('id', late.consultation_id).eq('status', 'failed');
      }
      quote = { ...late, status: 'pending' };
      await writeLog('info', 'clinic', `🔁 Resposta TARDIA da clínica — cotação revivida (consulta estava '${lateConsult.status}')`, {
        traceId, conversationId, quoteId: late.id, consultationId: late.consultation_id,
      });
    }
  }

  if (!quote) {
    await writeLog('warn', 'clinic', 'Nenhuma cotação ativa pra essa clínica', { traceId, conversationId });
    return;
  }

  // 4. Turn limit (12 turnos = 24 msgs) — CONTA SÓ ESTA NEGOCIAÇÃO. A conversa de
  // clínica é compartilhada por telefone e reusada entre consultas; contar a vida
  // inteira matava a 2ª negociação com a mesma clínica logo na 1ª resposta.
  const { count: msgCount } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .gte('created_at', (quote as { created_at: string }).created_at);

  if ((msgCount ?? 0) > 24) {
    await finalizeConsultationQuote(quote.id, quote.consultation_id, 'timeout', traceId);
    return;
  }

  // 5. Marca como offered (estado intermediário "negociando")
  if (quote.status === 'pending') {
    await db.from('consultation_quotes').update({ status: 'offered' }).eq('id', quote.id);
  }

  // 6. Monta contexto pro prompt
  const history = await getConversationMessages(conversationId, 24);
  const consultation = quote.consultations as {
    specialty: string;
    urgency: 'rotina' | '72h' | '24h' | 'urgente';
    modality: 'presencial' | 'telemedicina' | 'indiferente';
    city: string | null;
    preferences: Record<string, unknown> | null;
    user_id: string;
  } | null;

  if (!consultation) {
    await writeLog('error', 'clinic', 'Consultation não encontrada pra quote', { traceId, quoteId: quote.id });
    return;
  }

  // Primeiro nome (sem expor sobrenome à clínica) + dados que a recepção pode pedir
  // (convênio/carteirinha/CPF/nascimento/telefone) — a clínica-agent responde DIRETO, sem
  // re-perguntar (incidente Vadivino: re-pediu CPF/nascimento já dados; ecoou "Ipasgo").
  let patientFirstName: string | null = null;
  let patientFullName: string | null = null;
  let knownCpf: string | null = null;
  let knownBirth: string | null = null;
  let knownPhone: string | null = null;
  {
    const { data: u } = await db.from('users')
      .select('preferred_name, full_name, document_cpf, birth_date, phone_e164')
      .eq('id', consultation.user_id).single();
    const name = u?.preferred_name || u?.full_name;
    if (name) patientFirstName = String(name).split(/\s+/)[0] ?? null;
    patientFullName = (u?.full_name as string | null) ?? null;
    knownCpf = fmtCpfBR((u?.document_cpf as string | null) ?? null);
    knownBirth = fmtBirthBR((u?.birth_date as string | null) ?? null);
    knownPhone = (u?.phone_e164 as string | null) ?? null;
  }

  const prefs = consultation.preferences ?? {};
  const isSingleTarget = (prefs as any)['single_target'] === true;
  // Dados acumulados do paciente (convênio/carteirinha vindos das respostas de clarificação).
  const pdata = ((prefs as any)['patient_data'] ?? {}) as Record<string, string>;
  const planKnown = (pdata['health_plan'] ?? (prefs as any)['plan'] ?? null) as string | null;

  // O QUE O PACIENTE JÁ RESPONDEU nesta consulta — pares pergunta→resposta das cotações desta
  // consulta (espelha inbound-supplier): a clínica-agent aplica sozinha, não re-pergunta.
  const clientAnswers: string[] = [];
  {
    const { data: ans } = await db.from('consultation_quotes')
      .select('clarification_question, clarification_answer, clarification_answered_at')
      .eq('consultation_id', quote.consultation_id)
      .not('clarification_answer', 'is', null)
      .order('clarification_answered_at', { ascending: true });
    const seen = new Set<string>();
    for (const r of ans ?? []) {
      const a = (r.clarification_answer as string | null)?.trim();
      if (!a) continue;
      const qn = (r.clarification_question as string | null)?.trim();
      const line = qn ? `${qn} → ${a}` : a;
      if (!seen.has(line)) { seen.add(line); clientAnswers.push(line); }
    }
  }

  const ctxPrompt: AgentClinicContext = {
    specialty: consultation.specialty,
    urgency: consultation.urgency,
    modality: consultation.modality ?? 'indiferente',
    patientCity: consultation.city,
    plan: planKnown,
    patientName: patientFirstName,
    preferredTime: (prefs as any)['horario_pref'] ?? null,
    requestedProfessional: (prefs as any)['requested_doctor'] ?? null,
    singleTarget: isSingleTarget,
    knownData: {
      cpf: knownCpf,
      birthDate: knownBirth,
      phone: knownPhone,
      healthPlan: planKnown,
      planCardNumber: pdata['plan_card_number'] ?? null,
      fullName: patientFullName,
    },
    clientAnswers,
    isAppointmentConfirmation,
  };

  const cfg = loadPrompts();
  const systemPrompt = buildAgentClinicSystemPrompt(ctxPrompt);

  // 7. Chama LLM
  let llmResponse;
  try {
    llmResponse = await chat(text, {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: systemPrompt,
      history: trimHistory(messagesToHistory(history.slice(0, -1) as Message[]), 12),
      tools: agentClinicTools,
      temperature: 0.3,
      maxOutputTokens: 400,
      timeoutMs: 30_000,
    });
  } catch (err) {
    await writeLog('error', 'llm', `Agent-clinic LLM error: ${String(err)}`, { traceId });
    return;
  }

  const durationMs = Date.now() - t0;
  await writeEvent({
    eventName: 'agent_clinic.completion',
    durationMs,
    userId: consultation.user_id,
    conversationId,
    traceId,
    payload: {
      tools_called: llmResponse.toolCalls.map((t) => t.name),
      text_len: llmResponse.text.length,
    },
  });

  await writeLog('info', 'agent-clinic', `Agente clínica respondeu — tools: [${llmResponse.toolCalls.map((t) => t.name).join(', ') || 'nenhuma'}] texto: ${llmResponse.text.trim() ? `"${llmResponse.text.trim().slice(0, 80)}"` : '(vazio)'}`, {
    traceId, conversationId, durationMs,
  });

  // 8. Executa tool calls
  let shouldFinalize = false;
  let outcome = '';
  // Flags pro FALLBACK DETERMINÍSTICO (o gpt-4.1-mini às vezes chama tool SEM
  // gerar texto → a clínica ficava no vácuo). Espelha o inbound-supplier.
  let quoteRecorded = false;         // record_consultation_quote
  let appointmentConfirmed = false;  // record_appointment_confirmation
  let clarificationRequested = false; // request_clarification (levou pergunta ao paciente)
  let singleTargetDeadEnd = false;   // alvo único deu beco sem saída → paciente avisado, clínica recebe cortesia
  let repliedToClinic = false;       // já mandamos algo à clínica dentro do loop de tools (não duplicar no passo 9)

  for (const tc of llmResponse.toolCalls) {
    switch (tc.name) {
      case 'record_consultation_quote': {
        const a = tc.args as {
          proposed_datetime: string;
          alternative_datetimes?: string[];
          price_brl?: number;
          plan_accepted?: string;
          modality: 'presencial' | 'telemedicina';
          payment_methods?: string[];
          doctor_name?: string;
          crm?: string;
          address?: string;
          notes?: string;
        };

        const proposedISO = safeParseISO(a.proposed_datetime);
        if (!proposedISO) {
          // 🛟 NÃO DESCARTA MAIS EM SILÊNCIO (auditoria 26/07). O `break` mudo era grave: a
          // oferta REAL da clínica evaporava (sem quote gravada, `countRealReplies` nunca
          // contava), o paciente nunca via, a consulta caminhava pro fail de 6h — e a clínica
          // ficava sem resposta nenhuma, porque nem o fallback de texto era acionado
          // (`toolCalls.length !== 0`). Visto em prod: `proposed_datetime inválido: "undefined"`.
          // Agora: sobe pra error (acionável, com ids) e PERGUNTA o horário à recepção, que é
          // exatamente o que um humano faria ao receber preço sem data.
          await writeLog('error', 'consultation_quote', `proposed_datetime ausente/inválido: "${a.proposed_datetime}" — perguntando o horário à clínica em vez de descartar a oferta`, {
            traceId, quoteId: quote.id, consultationId: quote.consultation_id,
          });
          const askSlot = a.price_brl
            ? `Perfeito, obrigada! E qual seria o primeiro horário disponível?`
            : `Obrigada! E qual o primeiro horário disponível e o valor da consulta?`;
          await sendOutboundToClinic(conversationId, clinicPhone, askSlot, traceId);
          repliedToClinic = true; // já falamos com a clínica: não duplicar cortesia no passo 9
          break;
        }
        quoteRecorded = true;

        // Cria/atualiza prescriber se informado
        let prescriberId: string | null = quote.prescriber_id;
        if (a.doctor_name) {
          const { data: existing } = await db
            .from('prescribers')
            .select('id')
            .ilike('name', a.doctor_name)
            .eq('clinic_id', clinicId)
            .maybeSingle();
          if (existing?.id) {
            prescriberId = existing.id;
            if (a.crm) {
              await db.from('prescribers').update({ crm: a.crm }).eq('id', existing.id);
            }
          } else {
            const { data: newP } = await db.from('prescribers').insert({
              name: a.doctor_name,
              crm: a.crm ?? null,
              specialty: consultation.specialty,
              clinic_id: clinicId,
            }).select('id').single();
            prescriberId = newP?.id ?? null;
          }
        }

        const altIsos = (a.alternative_datetimes ?? [])
          .map(safeParseISO)
          .filter((x): x is string => !!x);

        await db.from('consultation_quotes').update({
          status: 'offered',
          prescriber_id: prescriberId,
          proposed_datetime: proposedISO,
          alternative_datetimes: altIsos.length > 0 ? altIsos : null,
          price_brl: typeof a.price_brl === 'number' ? a.price_brl : null,
          plan_accepted: a.plan_accepted ?? null,
          modality: a.modality,
          payment_methods: a.payment_methods ?? null,
          notes: a.notes ?? null,
          responded_at: new Date().toISOString(),
          // Guarda de idempotência: só grava enquanto pending/offered — um reprocesso/
          // retry NÃO reverte 'selected'/'scheduled' de volta pra 'offered'.
        }).eq('id', quote.id).in('status', ['pending', 'offered']);

        // Endereço — armazena na clinic se não tinha
        if (a.address) {
          await db.from('clinics').update({ address: a.address }).eq('id', clinicId);
        }

        await writeAudit({
          actorType: 'agent_clinic',
          actorId: 'agent-clinic',
          action: 'consultation_quote.offered',
          userId: consultation.user_id,
          targetTable: 'consultation_quotes',
          targetId: quote.id,
          conversationId,
          traceId,
          metadata: {
            clinic_id: clinicId,
            proposed_datetime: proposedISO,
            price_brl: a.price_brl,
            plan_accepted: a.plan_accepted,
            modality: a.modality,
            doctor_name: a.doctor_name,
          },
        });

        const clinic = quote.clinics as { name?: string } | null;
        // 🔀 GATE DE CLARIFICAÇÃO SEM CORRIDA (auditoria 26/07 — caso Ciro, 12:26 do dia 25/07).
        // Quando o modelo emite `record_consultation_quote` E `request_clarification` no MESMO
        // turno, cada case mandava a sua mensagem: o paciente recebia o CARD de horário e, no
        // mesmo minuto, o relay da pergunta — sobre o mesmo assunto. O gate existente
        // (hasPendingClinicClarification) perdia a corrida porque a quote é a PRIMEIRA da lista
        // de tools e a clarificação só é marcada depois. Pré-varremos o turno: se há pergunta
        // pendente, a oferta é gravada mas o aviso ESPERA — quando o paciente responder, a
        // consolidação apresenta o card já com o dado resolvido.
        const clarificationInSameTurn = llmResponse.toolCalls.some((t) => t.name === 'request_clarification');
        if (clarificationInSameTurn) {
          await writeLog('info', 'consultation', 'Oferta registrada, aviso ao paciente ADIADO — há pergunta da clínica no mesmo turno (evita mensagem dupla)', { traceId, quoteId: quote.id });
        } else {
          await notifyUserConsultationQuoteArrived(
            quote.consultation_id,
            clinic?.name ?? 'clínica',
            traceId,
          ).catch((e) =>
            writeLog('warn', 'consultation', `Falha ao notificar paciente: ${String(e)}`, { traceId }),
          );
        }

        shouldFinalize = true;
        outcome = 'offered';
        break;
      }

      case 'record_clinic_unavailable': {
        const a = tc.args as { reason?: string };
        await db.from('consultation_quotes').update({
          status: 'unavailable',
          notes: a.reason ?? null,
          responded_at: new Date().toISOString(),
        }).eq('id', quote.id).in('status', ['pending', 'offered']);

        await writeAudit({
          actorType: 'agent_clinic',
          actorId: 'agent-clinic',
          action: 'consultation_quote.unavailable',
          userId: consultation.user_id,
          targetTable: 'consultation_quotes',
          targetId: quote.id,
          conversationId,
          traceId,
          reason: a.reason,
        });

        // ALVO ÚNICO (incidente Vadivino 22/07): não há outra clínica pra procurar. Um "unavailable"
        // aqui só acontece num beco REAL sem saída (número errado / médico não atende ali) — a agenda
        // distante já foi roteada pra request_clarification (não cai aqui). NUNCA fica em silêncio nem
        // some: avisa o paciente com HONESTIDADE (sem sugerir outro médico) e encerra. A clínica recebe
        // uma cortesia (silentOutcome desligado abaixo), não o vácuo.
        if (isSingleTarget) {
          const clinicNm = (quote.clinics as { name?: string } | null)?.name ?? 'o consultório';
          const prof = (prefs as any)['requested_doctor'] as string | null;
          await notifyUserSingleTargetDeadEnd(quote.consultation_id, clinicNm, prof, a.reason ?? null, traceId)
            .catch((e) => writeLog('warn', 'consultation', `Falha ao avisar paciente (alvo único): ${String(e)}`, { traceId }));
          singleTargetDeadEnd = true;
          shouldFinalize = false; // pula o finalize genérico (que reverteria pra 'searching' em silêncio)
          outcome = 'unavailable';
          break;
        }

        shouldFinalize = true;
        outcome = 'unavailable';
        break;
      }

      case 'finalize_clinic_contact': {
        const a = tc.args as { outcome: string };
        outcome = a.outcome;
        shouldFinalize = true;
        await writeLog('info', 'consultation_quote', `Negociação clínica finalizada: ${a.outcome}`, { traceId, quoteId: quote.id });
        break;
      }

      case 'record_clinic_ack':
        await writeLog('info', 'agent-clinic', 'Clínica confirmou especialidade — esperando horário', { traceId });
        break;

      case 'request_clarification': {
        // Loop agêntico (Fase 4): a clínica precisa de um dado do paciente →
        // leva a pergunta ao CLIENTE (sara) e marca a cotação como aguardando
        // resposta (pausa a consolidação). O `llmResponse.text` segue como
        // mensagem de espera pra clínica (etapa 9, abaixo).
        const a = tc.args as { question?: string };
        const question = (a.question ?? '').trim();
        if (question) {
          // Marca ANTES do relay: mesmo que levar a pergunta ao paciente falhe, a
          // etapa 9 ainda manda a cortesia "vou confirmar" pra clínica (sem abortar).
          clarificationRequested = true;
          try {
            await relayClinicQuestionToUser(quote, question, traceId);
          } catch (err) {
            await writeLog('error', 'agent-clinic', `Falha ao levar pergunta da clínica ao paciente: ${String(err)}`, { traceId, conversationId });
          }
        }
        break;
      }

      case 'record_appointment_confirmation': {
        const a = tc.args as {
          confirmed_datetime: string;
          confirmation_code?: string;
          arrival_instructions?: string;
          notes?: string;
        };
        // Se a clínica confirmar sem data parseável, cai pro horário JÁ ofertado
        // (quote.proposed_datetime, ISO válido do record_consultation_quote) — senão
        // a consulta ficava presa em 'confirming', sem virar 'scheduled' nem gerar lembrete.
        const confISO = safeParseISO(a.confirmed_datetime) ?? (quote.proposed_datetime as string | null);
        const updates: Record<string, unknown> = {
          notes: [quote.notes, a.notes, a.arrival_instructions, a.confirmation_code ? `Código: ${a.confirmation_code}` : null]
            .filter(Boolean).join(' · '),
        };
        if (confISO) updates['proposed_datetime'] = confISO;
        await db.from('consultation_quotes').update(updates).eq('id', quote.id);

        // Marca consultation como 'scheduled' (handoff completo)
        if (confISO) {
          await db.from('consultations').update({
            status: 'scheduled',
            scheduled_at: confISO,
            scheduled_clinic_id: clinicId,
            scheduled_prescriber_id: quote.prescriber_id,
          }).eq('id', quote.consultation_id);
        }

        await writeAudit({
          actorType: 'agent_clinic',
          actorId: 'agent-clinic',
          action: 'consultation.scheduled',
          userId: consultation.user_id,
          targetTable: 'consultations',
          targetId: quote.consultation_id,
          conversationId,
          traceId,
          metadata: { confirmed_datetime: confISO, code: a.confirmation_code },
        });

        await writeLog('info', 'consultation', `✅ Consulta confirmada pela clínica — ${confISO}`, { traceId, quoteId: quote.id });
        appointmentConfirmed = true;
        break;
      }

      default:
        await writeLog('warn', 'agent-clinic', `Tool desconhecida chamada: ${tc.name}`, { traceId });
    }
  }

  // 9. Envia o texto pra clínica. Manda SEMPRE que houver texto, EXCETO nos outcomes
  // silenciosos (unavailable/timeout). Antes suprimia em qualquer finalize → a clínica
  // dava o horário e ouvia silêncio (a cortesia "anotei, vou confirmar" não saía).
  // ALVO ÚNICO num beco sem saída: a clínica ENGAJOU — não a deixa no vácuo. Manda cortesia
  // de encerramento (o paciente já foi avisado com honestidade em outro canal).
  const silentOutcome = (outcome === 'unavailable' || outcome === 'timeout') && !singleTargetDeadEnd;
  if (repliedToClinic) {
    // Já respondemos dentro do loop de tools (ex.: perguntamos o horário que faltava) —
    // mandar a cortesia genérica agora seria mensagem dupla pra recepção.
    await writeLog('info', 'agent-clinic', 'Resposta à clínica já enviada no loop de tools — pulando o passo 9', { traceId, conversationId });
  } else if (llmResponse.text.trim() && !silentOutcome) {
    await sendOutboundToClinic(conversationId, clinicPhone, llmResponse.text.trim(), traceId);
  } else if (!llmResponse.text.trim() && !silentOutcome && (quoteRecorded || appointmentConfirmed || clarificationRequested || singleTargetDeadEnd)) {
    // FALLBACK DETERMINÍSTICO (paridade c/ farmácia): o gpt-4.1-mini às vezes chama
    // a tool (registrou horário / confirmou / mandou pergunta ao paciente) SEM gerar
    // texto → a clínica ouvia silêncio. Aqui garantimos uma cortesia sem depender do LLM.
    const fallbackMsg = singleTargetDeadEnd
      ? 'Entendi, agradeço demais pela atenção! 🙏'
      : pickClinicFallbackMessage({ appointmentConfirmed, clarificationRequested });
    await sendOutboundToClinic(conversationId, clinicPhone, fallbackMsg, traceId);
    await writeLog('info', 'agent-clinic', 'Resposta determinística à clínica (LLM não gerou texto)', { traceId, conversationId, quoteRecorded, appointmentConfirmed, clarificationRequested, singleTargetDeadEnd });
  } else if (!llmResponse.text.trim() && !shouldFinalize && llmResponse.toolCalls.length === 0) {
    // 🛟 PARIDADE COM A FARMÁCIA (auditoria 26/07). Antes isto SÓ logava: o modelo voltava
    // vazio (sem texto e sem tool) e a recepção — que acabou de escrever — ficava no vácuo,
    // exatamente o comportamento que faz um humano concluir "é robô / desistiu". A farmácia
    // já tratava esse caso; a clínica não. Agora nunca deixamos a clínica sem resposta.
    await writeLog('warn', 'agent-clinic', 'Agente clínica retornou resposta vazia — enviando cortesia determinística', { traceId, conversationId });
    await sendOutboundToClinic(
      conversationId,
      clinicPhone,
      'Perfeito, obrigada! Deixa eu confirmar aqui rapidinho e já te retorno 🙂',
      traceId,
    );
  }

  // 10. Finaliza se necessário (após cotação ou indisponibilidade)
  if (shouldFinalize && !isAppointmentConfirmation) {
    await finalizeConsultationQuote(quote.id, quote.consultation_id, outcome, traceId);
  }
}

/** Recebe webhook do uazapi quando a instância do agente é a de clínica. */
export async function processInboundClinicFromWebhook(inbound: NormalizedInbound): Promise<void> {
  // Casa por TODAS as variantes do 9º dígito BR (o WhatsApp entrega c/ ou sem o 9).
  const jids = [...new Set([inbound.from.jid, ...whatsappJidVariants(inbound.from.phoneE164)])];
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('whatsapp_instance', AGENT_INSTANCE)
    .in('whatsapp_jid', jids)
    .limit(1);
  const conv = convs?.[0];
  if (!conv) return;

  await processInboundClinic({
    conversationId: conv.id,
    clinicPhone: inbound.from.phoneE164,
    text: inbound.text ?? '',
    traceId: randomUUID(),
  });
}

/**
 * Inicia uma negociação com uma clínica (chamada após discovery).
 * Mirror de `initiatePharmacyNegotiation` mas pra clínica.
 */
export async function initiateClinicNegotiation(opts: {
  quoteId: string;
  consultationId: string;
  clinicId: string;
  clinicName: string;
  clinicWhatsApp: string;
  ctx: AgentClinicContext;
  userConversationId: string;
  userPhoneE164: string;
  traceId: string;
}): Promise<void> {
  const { quoteId, consultationId, clinicId, clinicName, clinicWhatsApp, ctx, userConversationId, userPhoneE164, traceId } = opts;

  // Kill-switch de disparo pra clínica (hot-reload via /prompts) — complementa o
  // CLINIC_OUTBOUND_MODE (env). Freio de emergência sem redeploy.
  if (!loadPrompts().clinic_outbound_enabled) {
    await writeLog('warn', 'clinic', 'Disparo pra clínica DESLIGADO (clinic_outbound_enabled=false) — negociação não iniciada', { traceId, quoteId });
    return;
  }

  const clinicJid = `${clinicWhatsApp.replace(/\D/g, '')}@s.whatsapp.net`;

  // Cria/recupera conversa com a clínica
  const conv = await findOrCreateConversation(AGENT_INSTANCE, clinicJid, 'clinic', null, null, clinicId);

  // Linka quote → conversation
  await db.from('consultation_quotes')
    .update({ conversation_id: conv.id, status: 'pending' })
    .eq('id', quoteId);

  // "Book" da conversa: acumula o contexto por consultation_id (NÃO sobrescreve)
  // — várias consultas concorrentes pra mesma clínica coexistem sem se apagar.
  // A notificação canônica deriva da consultation (consultations.conversation_id).
  {
    const { data: convRow } = await db.from('conversations').select('memory_cards').eq('id', conv.id).single();
    const prior = Array.isArray(convRow?.memory_cards) ? (convRow!.memory_cards as Array<Record<string, unknown>>) : [];
    const book = prior.filter((e) => e?.['consultation_id'] !== consultationId);
    book.push({ user_conversation_id: userConversationId, user_phone: userPhoneE164, consultation_id: consultationId });
    await db.from('conversations').update({ memory_cards: book }).eq('id', conv.id);
  }

  // Atualiza last_contacted_at da clínica
  await db.from('clinics').update({ last_contacted_at: new Date().toISOString() }).eq('id', clinicId);

  // Monta abertura via LLM (com fallback)
  const cfg = loadPrompts();
  const systemPrompt = buildAgentClinicSystemPrompt(ctx);

  const planClause = ctx.plan && ctx.plan.toLowerCase() !== 'particular'
    ? `Vocês atendem o plano ${ctx.plan}? `
    : ctx.plan?.toLowerCase() === 'particular'
      ? `O paciente vai pagar particular. `
      : `Vocês atendem por plano de saúde ou só particular? `;
  const urgencyClause = ctx.urgency === 'urgente' || ctx.urgency === '24h'
    ? `É um pouco urgente — quanto antes melhor. `
    : ctx.urgency === '72h'
      ? `Precisa ser nos próximos 3 dias se possível. `
      : ``;
  const modalityClause = ctx.modality === 'telemedicina'
    ? `Preferência é telemedicina. `
    : ctx.modality === 'presencial'
      ? ``
      : ``;
  // Alvo da consulta: se o paciente pediu um MÉDICO específico, a recepção precisa ouvir o NOME
  // dele (senão vira consulta genérica — incidente Vadivino/São Silvestre). Especialidade
  // genérica/vazia ("consulta"/"médico") NÃO pode gerar "consulta de consulta".
  const specOpen = (ctx.specialty ?? '').trim();
  const specOpenGeneric = !specOpen || /^consultas?$/i.test(specOpen) || /^m[eé]dic[ao]s?$/i.test(specOpen);
  const alvoConsulta = ctx.requestedProfessional
    ? `uma consulta com ${ctx.requestedProfessional}`
    : specOpenGeneric ? `uma consulta médica` : `uma consulta de ${specOpen}`;
  // Saudação pela HORA DE BRASÍLIA (auditoria 26/07): o literal "Boa tarde!" saía às 07:43
  // da manhã pra recepção — tell de robô logo na primeira frase (caso Ciro, 25/07).
  const openHour = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
  const openGreeting = openHour < 12 ? 'Bom dia' : openHour < 18 ? 'Boa tarde' : 'Boa noite';
  const fallbackOpening = `${openGreeting}! Aqui é a Xarlote, estou ajudando um paciente a marcar ${alvoConsulta}. ${planClause}${urgencyClause}${modalityClause}Qual o primeiro horário disponível? Obrigada!`;

  let opening: string;
  try {
    const res = await chat('INICIAR_COTACAO', {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction:
        systemPrompt +
        '\n\nEsta é a primeira mensagem. Escreva apenas a mensagem de abertura para a clínica — apresentando-se como Xarlote, dizendo que está ajudando um paciente a marcar ' + alvoConsulta + ', e perguntando plano + horário' + (ctx.requestedProfessional ? ' (pergunte pela agenda DELE(A) pelo nome)' : '') + '. Sem emojis. Sem mencionar IA/agente/sistema. Não use tools ainda.',
      history: [],
      tools: [],
      temperature: 0.4,
      maxOutputTokens: 200,
      timeoutMs: 20_000,
    });
    opening = res.text.trim() || fallbackOpening;
  } catch {
    opening = fallbackOpening;
  }

  await writeLog('info', 'consultation', `Iniciando negociação com clínica ${clinicName}`, {
    traceId, quoteId, clinicId,
  });

  await writeAudit({
    actorType: 'agent_clinic',
    actorId: 'agent-clinic',
    action: 'consultation_quote.initiated',
    targetTable: 'consultation_quotes',
    targetId: quoteId,
    traceId,
    metadata: { clinic_id: clinicId, clinic_name: clinicName, specialty: ctx.specialty },
  });

  // Fase 6: abertura fria oficial = template atendimento_clinica. {{1}} é a
  // NECESSIDADE INTEIRA ("uma consulta de cardiologia"), não só a especialidade —
  // é assim que o template foi aprovado na Meta. Ligado por WHATSAPP_TEMPLATES_ENABLED
  // =true; desligado (default), segue o texto livre de hoje.
  if (templatesEnabled()) {
    // Default defensivo: especialidade vazia/whitespace (input vago do paciente ou LLM
    // sem valor) não pode gerar "uma consulta de " e travar o template — cai pra genérico.
    const spec = (ctx.specialty ?? '').trim();
    const necessidade = spec ? `uma consulta de ${spec}` : 'uma consulta médica';
    await sendTemplateOpeningToClinic(conv.id, clinicWhatsApp, 'clinic_outreach', [necessidade], traceId);
  } else {
    await sendOutboundToClinic(conv.id, clinicWhatsApp, opening, traceId);
  }
}

/** Marca quote como terminal e dispara consolidação se thresholds batem. */
async function finalizeConsultationQuote(
  quoteId: string,
  consultationId: string,
  outcome: string,
  traceId: string,
): Promise<void> {
  const finalStatus =
    outcome === 'offered' ? 'offered'
    : outcome === 'unavailable' ? 'unavailable'
    : 'timeout';

  await db.from('consultation_quotes')
    .update({ status: finalStatus, responded_at: new Date().toISOString() })
    .eq('id', quoteId)
    .in('status', ['pending', 'offered']);

  await writeLog('info', 'consultation_quote', `Quote finalizada: ${finalStatus}`, { traceId, quoteId });

  // Verifica se já podemos consolidar
  const { data: quotes } = await db.from('consultation_quotes').select('status').eq('consultation_id', consultationId);
  if (!quotes) return;

  const offered = quotes.filter((q) => q.status === 'offered').length;
  const terminal = quotes.filter((q) => ['offered', 'unavailable', 'timeout'].includes(q.status)).length;
  const total = quotes.length;

  // Consolida se: 3+ offered, OR 2+ offered e todas done, OR todas terminal
  if (offered >= 3 || (offered >= 2 && terminal === total) || terminal === total) {
    const { data: c } = await db.from('consultations').select('conversation_id, user_id').eq('id', consultationId).single();
    if (!c?.conversation_id) return;

    const { data: uconv } = await db.from('conversations').select('whatsapp_jid').eq('id', c.conversation_id).single();
    const userPhone = uconv?.whatsapp_jid?.replace('@s.whatsapp.net', '') ?? '';

    await consolidateConsultationQuotes(consultationId, c.conversation_id, `+${userPhone}`, traceId);
  }
}

/** Formata CPF pra exibição no prompt (NÃO loga — PII). "12345678901" → "123.456.789-01". */
function fmtCpfBR(cpf: string | null): string | null {
  if (!cpf) return null;
  const d = cpf.replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : null;
}

/** Formata nascimento ISO/date → "DD/MM/AAAA" (BR). */
function fmtBirthBR(b: string | null): string | null {
  if (!b) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(b.trim());
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return b.trim() || null;
}

/** Parse defensivo de ISO 8601. Aceita "2026-06-02 14:30" também. */
function safeParseISO(input: string): string | null {
  if (!input) return null;
  try {
    // Normaliza: troca " " entre data e hora por "T"
    let normalized = input.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
    if (!/[T]/.test(normalized) && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      normalized += 'T08:00:00-03:00';
    }
    // Sem offset/Z explícito = horário de Brasília. new Date() interpretaria
    // como hora LOCAL do servidor (UTC no Railway) → consulta 3h adiantada.
    if (/T\d{2}:\d{2}/.test(normalized) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
      normalized += '-03:00';
    }
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}
