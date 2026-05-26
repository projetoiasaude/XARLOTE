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
import { sendMenu, sendText } from '@iasaude/whatsapp';
import { SARA_INSTANCE } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';

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

// Botões: WhatsApp permite até 3 reply-buttons. ID curto e estável.
const BTN_CALL_EMERGENCY = '🚨 Ligar emergência';
const BTN_NOTIFY_CONTACT = '📞 Avisar meu contato';
const BTN_MISTAKE = 'Foi engano';

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
    ], { type: 'button', footerText: footer });
  } catch (err) {
    // Fallback: se botões falharem (ex: simulador, instância offline), manda texto direto
    await writeLog('warn', 'red_flag', `sendMenu falhou, caindo pra texto: ${String(err).slice(0, 120)}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `${intro}\n\nResponde com:\n• *1* pra ligar pra emergência (SAMU 192 ou CVV 188)\n• *2* pra avisar seu contato de emergência\n• *3* se foi engano\n\n${footer}`,
      ctx.traceId);
  }

  // 5. Agenda escalonamento em 60s
  if (pendingId) {
    setTimeout(() => {
      escalateIfStillPending(pendingId!, ctx).catch((err) =>
        writeLog('error', 'red_flag', `escalate falhou: ${String(err).slice(0, 200)}`, { traceId: ctx.traceId }),
      );
    }, ESCALATE_DELAY_MS);
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
    // Tenta notificar contato de emergência
    const notified = await notifyEmergencyContact(userId, pending.category, traceId);
    if (notified.ok) {
      replyText = `✅ Avisei ${notified.contactName ?? 'seu contato'} agora pelo WhatsApp 💙 Pediu pra entrar em contato com você o quanto antes.\n\nSe a situação piorar, liga *192* sem esperar.`;
      await db.from('red_flag_pending').update({ emergency_contact_notified: true }).eq('id', pending.id);
    } else {
      replyText =
        '😔 Não consegui avisar — você ainda não me passou um contato de emergência, ou o número que tenho não tá funcionando.\n\n' +
        'Por favor, me passa agora o nome e o telefone de alguém que possa te ajudar: pai, mãe, cônjuge, amigo. Ex: *"Maria, +5511999998888"*.\n\n' +
        'Se for urgente AGORA: *SAMU 192*.';
    }
  } else {
    newStatus = 'responded_mistake';
    replyText =
      '😅 Ufa! Fico aliviada. Tô aqui se precisar conversar sobre qualquer coisa, viu? 💙\n\n' +
      'Se foi falta de jeito ou clique sem querer, sem problema. Pode mandar mensagem normal.';
  }

  // Atualiza pending row
  try {
    await db.from('red_flag_pending').update({
      status: newStatus,
      user_response: buttonLabel,
      responded_at: new Date().toISOString(),
    }).eq('id', pending.id);
  } catch {}

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

/** Escalona se o paciente não respondeu em 60s. */
async function escalateIfStillPending(pendingId: string, ctx: RedFlagCtx): Promise<void> {
  let pending: { id: string; status: string; category: string; severity: string; evidence: string } | null = null;
  try {
    const { data } = await db
      .from('red_flag_pending')
      .select('id, status, category, severity, evidence')
      .eq('id', pendingId)
      .single();
    pending = data;
  } catch {
    return;
  }
  if (!pending || pending.status !== 'pending') return; // já respondeu

  await writeLog('error', 'red_flag', `🚨 ESCALANDO red_flag_pending ${pendingId} — paciente não respondeu em 60s`, {
    traceId: ctx.traceId,
    userId: ctx.userId,
    category: pending.category,
  });

  // Marca como escalated
  await db.from('red_flag_pending').update({
    status: 'escalated',
    escalated_at: new Date().toISOString(),
  }).eq('id', pendingId);

  // Tenta avisar contato de emergência
  const notified = await notifyEmergencyContact(ctx.userId, pending.category, ctx.traceId);

  if (notified.ok) {
    await db.from('red_flag_pending').update({ emergency_contact_notified: true }).eq('id', pendingId);

    // Avisa o paciente que avisamos o contato
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Como você não respondeu, avisei ${notified.contactName ?? 'seu contato de emergência'} agora pelo WhatsApp 💙\n\nSe for emergência médica AGORA: *SAMU 192*.`,
      ctx.traceId);
  } else {
    // Sem contato cadastrado — avisa paciente e o fundador via Telegram
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      'Como você não respondeu e eu não tenho contato de emergência cadastrado, não consegui avisar ninguém 😔\n\nSe precisar AGORA: *SAMU 192* ou *CVV 188*. Estou aqui também.',
      ctx.traceId);
  }

  await writeAudit({
    actorType: 'system',
    actorId: 'red-flag-escalator',
    action: 'red_flag.escalated',
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    targetTable: 'red_flag_pending',
    targetId: pendingId,
    traceId: ctx.traceId,
    metadata: {
      category: pending.category,
      contact_notified: notified.ok,
      contact_name: notified.contactName,
    },
  });
}

/**
 * Envia mensagem WhatsApp pro emergency_contact do paciente.
 * Retorna ok=true se conseguiu, com o nome do contato.
 */
async function notifyEmergencyContact(
  userId: string,
  category: string,
  traceId: string,
): Promise<{ ok: boolean; contactName?: string }> {
  const { data: u } = await db
    .from('users')
    .select('full_name, preferred_name, emergency_contact_name, emergency_contact_phone_e164, emergency_contact_relation')
    .eq('id', userId)
    .single();

  if (!u?.emergency_contact_phone_e164) {
    return { ok: false };
  }

  const patientName = u.preferred_name || u.full_name || 'o paciente';
  const contactName = u.emergency_contact_name || 'amigo(a)';
  const relation = u.emergency_contact_relation ? ` (${u.emergency_contact_relation})` : '';

  const friendlyCategory: Record<string, string> = {
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
  const catText = friendlyCategory[category] ?? 'sinais críticos';

  const msg =
    `Olá, ${contactName}${relation}! Aqui é a *Xarlote*, assistente de saúde da IA da Saúde 💙\n\n` +
    `${patientName} reportou ${catText} agora pelo WhatsApp e listou você como contato de emergência.\n\n` +
    `Por favor, *entre em contato com ele(a) o quanto antes* pra verificar como está. Se houver risco imediato, ligue *192 (SAMU)*.\n\n` +
    `_Essa é uma mensagem automática enviada porque ${patientName} pediu, ou porque parou de responder ao meu chat agora há pouco._`;

  try {
    await sendText(SARA_INSTANCE, u.emergency_contact_phone_e164, msg);
    await writeLog('warn', 'red_flag', `✉️ Contato de emergência ${contactName} avisado (${u.emergency_contact_phone_e164.slice(0, 8)}***)`, {
      traceId, userId,
    });
    return { ok: true, contactName };
  } catch (err) {
    await writeLog('error', 'red_flag', `Falha pra avisar contato de emergência: ${String(err).slice(0, 200)}`, { traceId, userId });
    return { ok: false, contactName };
  }
}
