/**
 * red_flag_check handler — disparado pela Xarlote quando ela percebe sinal
 * crítico de saúde. Comportamento:
 *
 *   1. Grava em `symptoms_log` com red_flag_triggered=true
 *   2. Grava `audit_log` (severity critical)
 *   3. Cria `red_flag_pending` (expires_at = now + 60s)
 *   4. Envia mensagem com 3 BOTÕES WhatsApp pelo paciente:
 *        [📞 Ligar emergência]  [📞 Avisar meu contato]  [Foi engano]
 *   5. Agenda setTimeout 60s — se status ainda 'pending', escalona:
 *      envia WhatsApp pro emergency_contact + audita
 *
 * Quando o paciente clica em um botão, `inbound-user.ts` detecta o
 * button reply e chama `handleRedFlagButtonResponse()` (abaixo).
 *
 * NOTA: não há mais Telegram nesse fluxo. Tudo acontece no WhatsApp +
 * audit_log (visível em /audit do dashboard).
 */
import { db, writeAudit, writeLog } from '@iasaude/db';
import { sendMenu, providerFor } from '@iasaude/whatsapp';
import { SARA_INSTANCE, isWabaWindowOpen } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { dispatchOutbound, PRIORIDADE_EMERGENCIA } from '../queues/outbound.queue.js';
import { buildEmergencyContactTemplate } from '../config/template-registry.js';
import { getZproTicket } from '../middleware/zpro-ticket.js';

export interface RedFlagArgs {
  category:
    | 'self_harm' | 'suicide_ideation' | 'chest_pain' | 'stroke_signs'
    | 'overdose' | 'severe_bleeding' | 'breathing_difficulty'
    | 'allergic_reaction_severe' | 'child_emergency' | 'other_critical';
  severity: 'high' | 'critical';
  evidence: string;
  context?: string;
}

export interface RedFlagCtx {
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
}

// Botões: WhatsApp permite até 3 reply-buttons, e o WABA corta o TÍTULO em 20
// caracteres — '📞 Avisar meu contato' tinha 21 e era recusado pela Meta, deixando o
// menu inteiro cair pro fallback de texto justo no turno de emergência (auditoria
// 22/09). Sem emoji e curtos: cabem com folga e o matcher abaixo continua valendo.
export const BTN_CALL_EMERGENCY = 'Ligar 192';
export const BTN_NOTIFY_CONTACT = 'Avisar contato';
export const BTN_MISTAKE = 'Foi engano';

/** Teto de caracteres do título de reply-button no WABA. */
export const LIMITE_TITULO_BOTAO = 20;

const CATEGORY_INTRO: Record<RedFlagArgs['category'], string> = {
  self_harm:
    'Eu me importo muito com você 💙 O que você compartilhou comigo é sério. Pode escolher abaixo o que quer fazer agora — estou aqui:',
  suicide_ideation:
    'Eu me importo com você. Essa dor que está sentindo é real 💙 Pode escolher o que quer agora:',
  chest_pain:
    '⚠️ O que você tá sentindo pode ser sério. Senta, mantém a calma, e me diz como quer agir:',
  stroke_signs:
    '⚠️ Esses sinais podem ser AVC — cada minuto importa. Como quer agir agora?',
  overdose:
    '⚠️ Isso é grave. Não tome nada por conta. Como quer agir agora?',
  severe_bleeding:
    '⚠️ Comprime o local com pano limpo. Como quer agir agora?',
  breathing_difficulty:
    '⚠️ Isso precisa de atenção médica. Sente em posição confortável. Como quer agir?',
  allergic_reaction_severe:
    '⚠️ Reação alérgica grave precisa de socorro imediato. Como quer agir?',
  child_emergency:
    '⚠️ Com criança, qualquer dúvida em emergência: vamos agir. Como prefere?',
  other_critical:
    '⚠️ O que você descreveu pode ser sério. Como quer agir agora?',
};

const CATEGORY_LABELS: Record<RedFlagArgs['category'], string> = {
  self_harm: '🚨 AUTO-MUTILAÇÃO',
  suicide_ideation: '🚨 IDEAÇÃO SUICIDA',
  chest_pain: '🚨 DOR NO PEITO',
  stroke_signs: '🚨 SINAIS DE AVC',
  overdose: '🚨 OVERDOSE',
  severe_bleeding: '🚨 SANGRAMENTO INTENSO',
  breathing_difficulty: '🚨 FALTA DE AR GRAVE',
  allergic_reaction_severe: '🚨 REAÇÃO ALÉRGICA GRAVE',
  child_emergency: '🚨 EMERGÊNCIA INFANTIL',
  other_critical: '🚨 CRÍTICO',
};

const ESCALATE_DELAY_MS = 60 * 1000; // 1 min

/**
 * Handler chamado pela tool `red_flag_check` da Xarlote.
 * Retorna texto vazio porque a mensagem PRO USUÁRIO vai como botões.
 */
export async function handleRedFlagCheck(args: RedFlagArgs, ctx: RedFlagCtx): Promise<string> {
  const labelPretty = CATEGORY_LABELS[args.category] ?? '🚨 ALERTA';

  // 1. symptoms_log
  let symptomRowId: string | null = null;
  try {
    const { data: row } = await db.from('symptoms_log').insert({
      user_id: ctx.userId,
      conversation_id: ctx.conversationId,
      name: args.category,
      red_flag_triggered: true,
      red_flag_reason: args.evidence,
      context: args.context,
      source: 'inferred',
      confidence: args.severity === 'critical' ? 1.0 : 0.9,
    }).select('id').single();
    symptomRowId = row?.id ?? null;
  } catch (err) {
    await writeLog('error', 'red_flag', `falha ao gravar symptoms_log: ${String(err).slice(0, 200)}`, { traceId: ctx.traceId });
  }

  // 2. audit critical
  await writeAudit({
    actorType: 'xarlote',
    action: 'red_flag.detected',
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    targetTable: 'symptoms_log',
    targetId: symptomRowId,
    traceId: ctx.traceId,
    reason: args.evidence,
    metadata: {
      category: args.category,
      severity: args.severity,
      context: args.context,
    },
  });

  await writeLog(args.severity === 'critical' ? 'error' : 'warn', 'red_flag',
    `${labelPretty} detectado — paciente ${ctx.userId.slice(0, 8)}…: ${args.evidence.slice(0, 100)}`,
    { traceId: ctx.traceId, category: args.category, severity: args.severity },
  );

  // 3. red_flag_pending row (expires_at = now + 60s)
  const expiresAt = new Date(Date.now() + ESCALATE_DELAY_MS).toISOString();
  let pendingId: string | null = null;
  try {
    const { data: pending } = await db.from('red_flag_pending').insert({
      user_id: ctx.userId,
      conversation_id: ctx.conversationId,
      symptoms_log_id: symptomRowId,
      category: args.category,
      severity: args.severity,
      evidence: args.evidence,
      context: args.context,
      status: 'pending',
      expires_at: expiresAt,
      trace_id: ctx.traceId,
    }).select('id').single();
    pendingId = pending?.id ?? null;
  } catch (err) {
    // tabela pode não existir (migration pendente) — segue sem o row mas com botões
    if (!String(err).includes('does not exist')) {
      await writeLog('warn', 'red_flag', `red_flag_pending insert falhou: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
    }
  }

  // 4. Manda mensagem com 3 botões via uazapi
  const intro = CATEGORY_INTRO[args.category] ?? CATEGORY_INTRO.other_critical;
  const footer = '⏱️ Se você não escolher, em 1 minuto eu aviso seu contato de emergência automaticamente.';

  try {
    // Persistimos mensagem outbound antes pra aparecer no histórico
    await db.from('messages').insert({
      conversation_id: ctx.conversationId,
      direction: 'out',
      sender_role: 'assistant',
      content_type: 'text',
      content: `${intro}\n\n[Botões: ${BTN_CALL_EMERGENCY} · ${BTN_NOTIFY_CONTACT} · ${BTN_MISTAKE}]`,
      trace_id: ctx.traceId,
    });

    await sendMenu(SARA_INSTANCE, ctx.phoneE164, intro, [
      BTN_CALL_EMERGENCY,
      BTN_NOTIFY_CONTACT,
      BTN_MISTAKE,
    ], { type: 'button', footerText: footer, ticketId: await getZproTicket(ctx.phoneE164) });
  } catch (err) {
    // Fallback: se botões falharem (ex: simulador, instância offline), manda texto direto
    await writeLog('warn', 'red_flag', `sendMenu falhou, caindo pra texto: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `${intro}\n\nResponde com:\n• *1* pra ligar pra emergência (SAMU 192 ou CVV 188)\n• *2* pra avisar seu contato de emergência\n• *3* se foi engano\n\n${footer}`,
      ctx.traceId);
  }

  // 5. O escalonamento em 60s é feito pelo worker DURÁVEL `red-flag-escalator`,
  // que varre `red_flag_pending` vencidos (status='pending' AND expires_at<now).
  // Sobrevive a restart/crash do processo — ao contrário do setTimeout em
  // memória que existia aqui antes (perda silenciosa de escalonamento = risco
  // de vida num app de saúde). pendingId logado pra rastreio.
  if (!pendingId) {
    await writeLog('error', 'red_flag', '⚠️ red_flag sem pendingId — escalonamento automático NÃO garantido (verifique red_flag_pending)', { traceId: ctx.traceId, userId: ctx.userId });
  }

  // Retorna string vazia — a mensagem foi por botões, Xarlote não precisa de mais texto
  return '';
}

/**
 * Handler chamado em inbound-user quando paciente clica num botão e há
 * red_flag_pending ativo. Processa a escolha e responde.
 */
export async function handleRedFlagButtonResponse(opts: {
  userId: string;
  conversationId: string;
  phoneE164: string;
  buttonLabel: string;     // texto/id do botão clicado
  traceId: string;
}): Promise<boolean> {
  const { userId, conversationId, phoneE164, buttonLabel, traceId } = opts;

  // Busca pending ativo desse user (mais recente)
  let pending: { id: string; category: string; severity: string } | null = null;
  try {
    const { data } = await db
      .from('red_flag_pending')
      .select('id, category, severity')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    pending = data;
  } catch {
    return false;
  }
  if (!pending) return false;

  // Mapeia botão pra ação
  let action: 'call_emergency' | 'notify_contact' | 'mistake' | 'unknown' = 'unknown';
  if (buttonLabel.includes('Ligar') || buttonLabel.includes('emergência') || buttonLabel.includes('SAMU')) {
    action = 'call_emergency';
  } else if (buttonLabel.includes('Avisar') || buttonLabel.includes('contato')) {
    action = 'notify_contact';
  } else if (buttonLabel.toLowerCase().includes('engano') || buttonLabel.toLowerCase().includes('foi nada')) {
    action = 'mistake';
  } else if (buttonLabel.trim() === '1') action = 'call_emergency';
  else if (buttonLabel.trim() === '2') action = 'notify_contact';
  else if (buttonLabel.trim() === '3') action = 'mistake';

  if (action === 'unknown') return false;

  let replyText: string;
  let newStatus: 'responded_call_emergency' | 'responded_notify_contact' | 'responded_mistake';

  if (action === 'call_emergency') {
    newStatus = 'responded_call_emergency';
    replyText =
      '✅ Vai lá, eu fico aqui torcendo por você 💙\n\n' +
      '📞 *SAMU: 192*\n' +
      '📞 *CVV (escuta gratuita 24h): 188*\n\n' +
      'Quando puder, me conta como foi. Estou aqui.';
  } else if (action === 'notify_contact') {
    newStatus = 'responded_notify_contact';
    const aviso = await notificarContatoDeEmergencia(userId, pending.category, traceId);
    replyText = falaSobreOAviso(aviso);
    if (aviso.via === 'texto' || aviso.via === 'template') {
      const { error } = await db.from('red_flag_pending').update({ emergency_contact_notified: true }).eq('id', pending.id);
      if (error) {
        await writeLog('error', 'red_flag', `não consegui marcar emergency_contact_notified: ${error.message.slice(0, 120)}`, { traceId, userId });
      }
    }
  } else {
    newStatus = 'responded_mistake';
    replyText =
      '😅 Ufa! Fico aliviada. Tô aqui se precisar conversar sobre qualquer coisa, viu? 💙\n\n' +
      'Se foi falta de jeito ou clique sem querer, sem problema. Pode mandar mensagem normal.';
  }

  // ⚠️ ISTO É O QUE IMPEDE O ESCALONAMENTO DEPOIS DO "FOI ENGANO".
  //
  // O escalator varre `status='pending'` a cada 10s. Aqui havia um `try/catch {}` — e,
  // como supabase-js NÃO LANÇA (devolve `{error}`), o catch nunca disparava e um update
  // falho passava despercebido: a linha ficava `pending`, e 60s depois o contato de
  // emergência era avisado de uma emergência que a própria pessoa já tinha desmentido.
  {
    const { error } = await db.from('red_flag_pending').update({
      status: newStatus,
      user_response: buttonLabel,
      responded_at: new Date().toISOString(),
    }).eq('id', pending.id);
    if (error) {
      // Uma segunda tentativa curta: o custo de falhar aqui é avisar a família de alguém
      // que está bem — ou não avisar alguém que não está.
      const { error: erroDeNovo } = await db.from('red_flag_pending').update({
        status: newStatus,
        user_response: buttonLabel,
        responded_at: new Date().toISOString(),
      }).eq('id', pending.id);
      if (erroDeNovo) {
        await writeLog('error', 'red_flag', `red_flag_pending NÃO atualizado (${erroDeNovo.message.slice(0, 100)}) — o escalonamento pode disparar mesmo com resposta do paciente`, {
          traceId, userId, pendingId: pending.id,
        });
      }
    }
  }

  await writeAudit({
    actorType: 'user',
    actorId: userId,
    action: `red_flag.${action}`,
    userId,
    conversationId,
    targetTable: 'red_flag_pending',
    targetId: pending.id,
    traceId,
    metadata: { button_label: buttonLabel, category: pending.category },
  });

  await sendOutbound(conversationId, phoneE164, replyText, traceId);
  return true;
}

/**
 * Linha de red_flag_pending JÁ reivindicada pelo worker (status='escalated').
 * Worker faz o claim atômico (pending→escalated) antes de chamar isto, então
 * dois workers nunca escalam a mesma linha.
 */
export interface RedFlagPendingRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  category: string;
  severity?: string;
  evidence?: string;
  trace_id?: string | null;
}

/**
 * Executa o escalonamento de um red flag vencido: avisa o contato de emergência
 * e informa o paciente. Chamado pelo worker durável `red-flag-escalator`.
 * NÃO altera status (o worker já marcou 'escalated' no claim).
 */
export async function escalatePending(row: RedFlagPendingRow): Promise<void> {
  const traceId = row.trace_id ?? '';

  // Reconstrói o telefone do paciente a partir da conversa (pode não existir)
  let phoneE164: string | null = null;
  if (row.conversation_id) {
    try {
      const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', row.conversation_id).single();
      const jid = conv?.whatsapp_jid as string | undefined;
      if (jid) phoneE164 = `+${jid.replace('@s.whatsapp.net', '')}`;
    } catch { /* sem telefone — ainda assim avisamos o contato */ }
  }

  await writeLog('error', 'red_flag', `🚨 ESCALANDO red_flag ${row.id} — paciente não respondeu em 60s`, {
    traceId, userId: row.user_id, category: row.category,
  });

  // Mesmo caminho do clique no botão — inclusive quando não há caminho possível.
  const aviso = await notificarContatoDeEmergencia(row.user_id, row.category, traceId);
  const avisou = aviso.via === 'texto' || aviso.via === 'template';
  if (avisou) {
    const { error } = await db.from('red_flag_pending').update({ emergency_contact_notified: true }).eq('id', row.id);
    if (error) {
      await writeLog('error', 'red_flag', `não consegui marcar emergency_contact_notified no escalonamento: ${error.message.slice(0, 120)}`, { traceId, userId: row.user_id });
    }
  }
  if (phoneE164 && row.conversation_id) {
    // A primeira frase muda porque o motivo é outro (silêncio, não clique); o resto é a
    // MESMA fala honesta do clique — uma única fonte pro que a Xarlote pode afirmar.
    // A abertura muda por RAMO, não só por "avisou ou não": dizer "tentei avisar alguém"
    // pra quem nunca cadastrou contato é afirmar uma tentativa que não existiu.
    const abertura =
      avisou ? 'Como você não respondeu, pedi ajuda pra quem você cadastrou 💙\n\n'
      : aviso.via === 'sem_contato' ? 'Como você não respondeu, fui procurar seu contato de emergência — e você ainda não tem um cadastrado.\n\n'
      : 'Como você não respondeu, tentei avisar seu contato de emergência.\n\n';
    await sendOutbound(row.conversation_id, phoneE164, abertura + falaSobreOAviso(aviso), traceId);
  }

  await writeAudit({
    actorType: 'system',
    actorId: 'red-flag-escalator',
    action: 'red_flag.escalated',
    userId: row.user_id,
    conversationId: row.conversation_id ?? undefined,
    targetTable: 'red_flag_pending',
    targetId: row.id,
    traceId,
    metadata: {
      category: row.category,
      contact_notified: avisou,
      contact_via: aviso.via,
    },
  });
}

/**
 * O AVISO AO CONTATO DE EMERGÊNCIA — o caminho que mais precisa ser honesto.
 *
 * ## O que estava errado (auditoria 22/09, P0-4)
 *
 * `sendText` direto, fora da fila, sem noção de janela. O contato de emergência é, por
 * definição, alguém que nunca escreveu pra Xarlote: no WABA a janela de 24h está
 * FECHADA e texto livre é rejeitado pela Meta. O paciente lia "✅ Avisei o João" e o
 * João nunca recebia nada. Pior: o aceite do zpro era tratado como entrega.
 *
 * ## Como funciona agora
 *
 * 1. Janela ABERTA (o contato já conversou com a Xarlote) → texto livre, com a
 *    categoria clínica, que é o que ajuda a pessoa a decidir o que fazer.
 * 2. Janela FECHADA → template, na ordem: o DEDICADO (`ZPRO_TEMPLATE_EMERGENCIA`,
 *    quando a Meta aprovar) e, até lá, a PONTE — o HSM de reengajamento, que já está
 *    aprovado no próprio número da Xarlote e tem o formato certo (nome + motivo em uma
 *    frase). Nos dois, SEM categoria clínica: dado sensível não vai pra terceiro.
 * 3. Janela FECHADA e nenhum template ligado → **não manda nada e diz a verdade ao
 *    paciente**, com o 192 na frente. É a única opção honesta.
 *
 * Tudo pela FILA (`dispatchOutbound`), com `priority: 1`: a regra #5 do CLAUDE.md vale
 * aqui também, e a prioridade garante que a emergência passe na frente da rajada de
 * lembretes das 8h em vez de esperar 20 minutos por ela.
 */
export type AvisoAoContato =
  | { via: 'texto' | 'template'; contactName: string }
  | { via: 'sem_contato' }
  | { via: 'sem_template'; contactName: string }
  | { via: 'falhou'; contactName: string };

/** A janela de 24h com um número QUALQUER (o contato raramente tem conversa aqui). */
async function janelaComOContato(phoneE164: string): Promise<boolean> {
  // A janela é regra da Meta (zpro/WABA). Na uazapi não existe janela.
  if (providerFor(SARA_INSTANCE) !== 'zpro') return true;

  const jid = `${phoneE164.replace(/\D/g, '')}@s.whatsapp.net`;
  // ⚠️ (instância, jid) — é assim que `findOrCreateConversation` chaveia. Sem a
  // instância, o mesmo número com linha na perna do AGENTE fazia medir a janela da
  // conversa errada; e duas linhas faziam o `maybeSingle` ERRAR, caindo no ramo de erro.
  const { data: convs, error } = await db
    .from('conversations')
    .select('id')
    .eq('whatsapp_instance', SARA_INSTANCE)
    .eq('whatsapp_jid', jid)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1);
  /**
   * Erro de leitura cai pro lado FECHADO — o contrário do que vale em `establishmentWindow`.
   *
   * Lá, "assumir aberta" erra pro lado de tentar entregar. Aqui não: se eu assumo aberta
   * e mando texto livre que a Meta recusa, o paciente lê "✅ Estou avisando o João" e
   * NINGUÉM é avisado — a mentira exata que este P0 existe pra matar. Assumindo fechada,
   * no pior caso ele lê "não consegui falar com o João, liga pra ele ou pro 192", que é
   * verdade e é acionável.
   */
  if (error) return false;
  const conv = convs?.[0];
  if (!conv) return false; // nunca falou com a Xarlote → fechada, com certeza

  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id as string)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const iso = data?.created_at as string | undefined;
  return isWabaWindowOpen(iso ? new Date(iso).getTime() : null, Date.now());
}

const CATEGORIA_HUMANA: Record<string, string> = {
  self_harm: 'sinais de auto-mutilação',
  suicide_ideation: 'pensamentos suicidas',
  chest_pain: 'dor forte no peito',
  stroke_signs: 'possíveis sinais de AVC',
  overdose: 'possível overdose',
  severe_bleeding: 'sangramento intenso',
  breathing_difficulty: 'falta de ar grave',
  allergic_reaction_severe: 'reação alérgica grave',
  child_emergency: 'emergência com criança',
  other_critical: 'sinais críticos de emergência',
};

export async function notificarContatoDeEmergencia(
  userId: string,
  category: string,
  traceId: string,
): Promise<AvisoAoContato> {
  const { data: u } = await db
    .from('users')
    .select('full_name, preferred_name, emergency_contact_name, emergency_contact_phone_e164, emergency_contact_relation')
    .eq('id', userId)
    .single();

  const telefone = u?.emergency_contact_phone_e164 as string | undefined;
  if (!telefone) return { via: 'sem_contato' };

  const patientName = (u?.preferred_name as string) || (u?.full_name as string) || 'o paciente';
  const contactName = (u?.emergency_contact_name as string) || 'amigo(a)';
  const relation = u?.emergency_contact_relation ? ` (${u.emergency_contact_relation})` : '';
  const catText = CATEGORIA_HUMANA[category] ?? 'sinais críticos';

  const janelaAberta = await janelaComOContato(telefone);

  try {
    if (janelaAberta) {
      const msg =
        `Olá, ${contactName}${relation}! Aqui é a *Xarlote*, assistente de saúde 💙\n\n` +
        `${patientName} reportou ${catText} agora pelo WhatsApp e listou você como contato de emergência.\n\n` +
        `Por favor, *entre em contato com ele(a) o quanto antes* pra verificar como está. Se houver risco imediato, ligue *192 (SAMU)*.\n\n` +
        `_Essa é uma mensagem automática enviada porque ${patientName} pediu, ou porque parou de responder ao meu chat agora há pouco._`;
      await dispatchOutbound({
        kind: 'text',
        instance: SARA_INSTANCE,
        phoneE164: telefone,
        text: msg,
        traceId,
        priority: PRIORIDADE_EMERGENCIA,
      });
      await writeLog('warn', 'red_flag', '✉️ Contato de emergência avisado (texto, janela aberta)', { traceId, userId });
      return { via: 'texto', contactName };
    }

    const tpl = buildEmergencyContactTemplate(contactName, patientName);
    if (!tpl) {
      // Sem template aprovado NÃO EXISTE caminho: a Meta recusa texto livre fora da
      // janela. Registrar como erro é o que faz isso aparecer pro fundador em vez de
      // morrer num "ok" — é literalmente o aviso de emergência que não saiu.
      await writeLog('error', 'red_flag', 'aviso ao contato de emergência IMPOSSÍVEL: janela fechada e template `ZPRO_TEMPLATE_EMERGENCIA` não configurado', { traceId, userId });
      return { via: 'sem_template', contactName };
    }

    await dispatchOutbound({
      kind: 'template',
      instance: SARA_INSTANCE,
      phoneE164: telefone,
      text: tpl.text,
      templateName: tpl.name,
      templateLanguage: tpl.language,
      templateVariables: tpl.variables,
      traceId,
      priority: PRIORIDADE_EMERGENCIA,
    });
    // Registra QUAL caminho saiu: enquanto o dedicado não existe, isto é o que prova que
    // a ponte (o HSM de reengajamento) está de fato entregando os avisos.
    await writeLog('warn', 'red_flag', `✉️ Contato de emergência avisado (template ${tpl.via}: ${tpl.name}, janela fechada)`, { traceId, userId });
    return { via: 'template', contactName };
  } catch (err) {
    await writeLog('error', 'red_flag', `Falha pra avisar contato de emergência: ${String(err).slice(0, 200)}`, { traceId, userId });
    return { via: 'falhou', contactName };
  }
}

/**
 * O que a Xarlote diz ao PACIENTE sobre o aviso. Pura de propósito (testada em
 * `tests/emergencia-contato.test.ts`): é a frase que não pode afirmar o que não houve.
 *
 * "Estou avisando" e não "Avisei": o que temos é o envio ENFILEIRADO com prioridade
 * máxima — a entrega quem confirma é o eco do WhatsApp, que chega depois.
 */
export function falaSobreOAviso(aviso: AvisoAoContato): string {
  switch (aviso.via) {
    case 'texto':
    case 'template':
      return (
        `✅ Estou avisando ${aviso.contactName} agora pelo WhatsApp 💙 Pedi pra entrar em contato com você o quanto antes.\n\n` +
        `Se a situação piorar, liga *192* sem esperar.`
      );
    case 'sem_contato':
      return (
        '😔 Não consegui avisar ninguém — você ainda não me passou um contato de emergência.\n\n' +
        'Me passa agora o nome e o telefone de alguém que possa te ajudar: pai, mãe, cônjuge, amigo. Ex: *"Maria, +5511999998888"*.\n\n' +
        'Se for urgente AGORA: *SAMU 192*.'
      );
    case 'sem_template':
      return (
        `😔 Não consegui falar com ${aviso.contactName} pelo WhatsApp agora — o WhatsApp só me deixa iniciar conversa com quem já falou comigo antes.\n\n` +
        `*Liga pra ${aviso.contactName} agora*, ou pro *192 (SAMU)* se for urgente. Eu fico aqui com você.`
      );
    case 'falhou':
      return (
        `😔 Tentei avisar ${aviso.contactName} e não consegui agora.\n\n` +
        `*Liga pra ele(a)*, ou pro *192 (SAMU)* se for urgente. Estou aqui.`
      );
  }
}
