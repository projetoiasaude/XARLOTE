/**
 * Despachante de lembretes proativos — a Xarlote "acorda" e fala primeiro.
 *
 * A cada tick (30s, sob cron-lock) pega lembretes `pending` vencidos e:
 *   1. RECLAMA a row primeiro (avança next_run_at pelo rrule, ou marca `sent`
 *      se for one-shot) — claim-before-send garante no-máximo-um envio mesmo
 *      se o processo cair no meio (lembrete duplicado de remédio é pior que
 *      um raro lembrete perdido).
 *   2. Espelha a mensagem na conversa canônica (messages INSERT) → o app
 *      recebe via Supabase Realtime na hora, como qualquer fala da Xarlote.
 *   3. Envia pro WhatsApp REAL via fila outbound (rate-limit — CLAUDE.md §5).
 *
 * Recorrência: BYHOUR/BYMINUTE do rrule são SEMPRE horário de Brasília
 * (contrato com a LLM) — ver packages/shared/src/rrule.ts.
 */
import { db, writeEvent, writeLog, listDeviceTokens, deleteDeviceTokens } from '@iasaude/db';
import { isSimulatorMode, providerFor } from '@iasaude/whatsapp';
import { SARA_INSTANCE, nextOccurrence, isPlaceholderPhone, normalizeReminderBody, isWabaWindowOpen } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { sendPush } from '@iasaude/integrations';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { reengageTemplateEnabled, buildReengageTemplate, reengageReasonForReminder, REENGAGE_REASON_SILENT } from '../config/template-registry.js';

/** A perna do usuário (SARA) é WhatsApp oficial (zpro) → a janela de 24h se aplica? */
function saraNeedsWabaWindow(): boolean {
  return providerFor(SARA_INSTANCE) === 'zpro';
}

/**
 * Timestamp (ms) do último inbound REAL DO WHATSAPP do usuário, ou null. Exclui mensagens
 * sintéticas (app nativo /app/inbound e simulador — external_id 'sim-*'): elas NÃO abrem a
 * janela de 24h da Meta (nunca tocaram o WhatsApp). Contá-las reabriria falsamente a janela
 * → texto livre rejeitado marcado como entregue (a mentira que este fix elimina). Review 13/07.
 */
async function lastUserInboundMs(conversationId: string): Promise<number | null> {
  const { data } = await db
    .from('messages')
    .select('created_at, external_id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(10);
  const real = (data ?? []).find((m) => {
    const ext = (m.external_id as string | null) ?? '';
    return !ext.startsWith('sim-'); // sintético (app/simulador) não abre a janela WhatsApp
  });
  return real?.created_at ? new Date(real.created_at as string).getTime() : null;
}

interface DueReminder {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  rrule: string | null;
  next_run_at: string;
  last_run_at: string | null;
  last_confirmed_at: string | null;
  created_at: string;
  payload: Record<string, unknown> | null;
  users: {
    phone_e164: string | null;
    preferred_name: string | null;
    reminder_max_per_day: number | null;
    metadata: Record<string, unknown> | null;
  } | null;
}

export async function dispatchReminders(): Promise<void> {
  // Kill-switch por fluxo (hot-reload via /prompts) — freio de emergência sem
  // desligar a Xarlote inteira nem redeploy.
  if (!loadPrompts().reminders_enabled) return;

  const now = new Date();

  const { data: due, error } = await db
    .from('reminders')
    .select('id, user_id, type, title, body, rrule, next_run_at, last_run_at, last_confirmed_at, created_at, payload, users(phone_e164, preferred_name, timezone, reminder_max_per_day, metadata)')
    .eq('status', 'pending')
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true }) // backlog processa em ordem, sem starvation
    .limit(50);

  if (error) {
    await writeLog('error', 'reminder', `Busca de lembretes vencidos falhou: ${error.message}`);
    return;
  }
  if (!due?.length) return;

  const STALE_MS = 45 * 60_000; // recorrente atrasado > 45min = pula (espera a próxima)
  const reengagedThisTick = new Set<string>(); // no máx 1 check-in de re-engajamento por usuário por tick

  for (const reminder of due as unknown as DueReminder[]) {
    const user = reminder.users;
    if (!user?.phone_e164) continue;

    // Número de TESTE/placeholder (ex: usuária Marina do simulador): auto-cancela
    // o lembrete-zumbi na 1ª passada — senão claim+mirror+envio-bloqueado se
    // repetem TODO dia pra sempre, poluindo o alerta de "possível ban".
    if (isPlaceholderPhone(user.phone_e164)) {
      await db.from('reminders').update({ status: 'cancelled' }).eq('id', reminder.id);
      await writeLog('warn', 'reminder', `lembrete cancelado — telefone placeholder/teste (${user.phone_e164})`, {});
      continue;
    }

    // 1. Claim: recorrente avança pro próximo disparo e CONTINUA pending;
    //    one-shot vira `sent`. Filtro por next_run_at = claim otimista
    //    (se outra réplica já avançou a row, 0 linhas mudam e pulamos).
    // Recorrência calculada no FUSO DO USUÁRIO (default Brasília) — "8h30" tem
    // que ser 8h30 onde a pessoa mora, não onde o servidor roda.
    const userTz = (user as { timezone?: string | null }).timezone || undefined;
    const next = reminder.rrule ? nextOccurrence(reminder.rrule, now, userTz) : null;
    const claim = next
      ? { next_run_at: next.toISOString(), last_run_at: now.toISOString() }
      : { status: 'sent', last_run_at: now.toISOString() };

    const { data: claimed } = await db
      .from('reminders')
      .update(claim)
      .eq('id', reminder.id)
      .eq('status', 'pending')
      .eq('next_run_at', reminder.next_run_at)
      .select('id');
    if (!claimed?.length) continue;

    // STALENESS: após downtime longo, um recorrente MUITO atrasado ("remédio das
    // 8h" chegando 14h) é pior que não chegar (dose fora de hora). Claim já avançou
    // pro próximo disparo; aqui só pulamos o ENVIO desta ocorrência velha. One-shot
    // atrasado ainda envia (é a única chance dele).
    const lateMs = now.getTime() - new Date(reminder.next_run_at).getTime();
    if (reminder.rrule && lateMs > STALE_MS) {
      await writeLog('warn', 'reminder', `lembrete recorrente pulado — atrasado ${Math.round(lateMs / 60000)}min (aguarda próxima ocorrência)`, {});
      continue;
    }

    // GATE CONDICIONAL (0020 — incidente Glauber): lembrete-backup "só se não confirmar".
    // Fica DEPOIS do claim (next_run_at já avançou — pular antes causaria re-disparo a cada
    // 30s). Timezone-agnóstico: compara dois instantes (o primário foi confirmado DESDE o
    // último disparo dele?). Fail-safe: qualquer null/erro/indeterminado ⇒ DISPARA (melhor
    // lembrar do remédio do que calar por engano).
    const cond = reminder.payload as { condition?: string; depends_on_reminder_id?: string; depends_on_title?: string } | null;
    if (cond?.condition === 'if_not_confirmed') {
      const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
      type PrimaryRow = { last_run_at: string | null; last_confirmed_at: string | null };
      // Só um primário VIVO suprime. 'cancelled' fora → primário cancelado cai no fail-safe
      // (dispara); 'acknowledged' dentro → one-shot confirmado (app botão done) é visível.
      const ACTIVE = ['pending', 'sent', 'acknowledged'];
      let primary: PrimaryRow | null = null;
      if (cond.depends_on_reminder_id) {
        const { data } = await db.from('reminders')
          .select('last_run_at, last_confirmed_at')
          .eq('id', cond.depends_on_reminder_id)
          .in('status', ACTIVE)
          .maybeSingle();
        primary = data as PrimaryRow | null;
      }
      if (!primary && cond.depends_on_title) {
        const dep = escLike(cond.depends_on_title);
        // Exato primeiro; se o título do primário foi "decorado" (emoji/verbo no fim),
        // cai pro prefixo. `neq id` = nunca se resolve a si mesmo (título idêntico ao backup).
        for (const pat of [dep, `${dep}%`]) {
          const { data } = await db.from('reminders')
            .select('last_run_at, last_confirmed_at')
            .eq('user_id', reminder.user_id)
            .in('status', ACTIVE)
            .ilike('title', pat)
            .neq('id', reminder.id)
            .order('created_at', { ascending: false })
            .limit(1).maybeSingle();
          if (data) { primary = data as PrimaryRow; break; }
        }
      }
      // Suprime SÓ se o primário foi confirmado HOJE (fuso do user) E depois do último disparo
      // dele. "Hoje" (não só ">= last_run") evita que uma confirmação de um dia com agenda
      // DIVERGENTE (primário seg/qua/sex, backup diário) cale o backup num dia sem primário.
      // Fail-safe: qualquer null/indeterminado ⇒ NÃO suprime → DISPARA (melhor lembrar).
      const tzDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: userTz || 'America/Sao_Paulo' }).format(new Date(iso));
      const confirmedToday = !!primary?.last_confirmed_at && tzDay(primary.last_confirmed_at) === tzDay(now.toISOString());
      const afterLastRun = !primary?.last_run_at
        || (!!primary?.last_confirmed_at && new Date(primary.last_confirmed_at).getTime() >= new Date(primary.last_run_at).getTime());
      if (confirmedToday && afterLastRun) {
        await writeLog('info', 'reminder', `backup condicional pulado — primário confirmado hoje ("${reminder.title}")`, {});
        continue; // claim JÁ avançou next_run_at → recorrência intacta, sem loop
      }
      // não confirmado (ou indeterminado) → segue o fluxo normal e DISPARA
    }

    // 🧯 CAP DIÁRIO (incidente Antônia Flávia 09/07): a coluna users.reminder_max_per_day
    // existia SÓ no banco — o código nunca a leu, e ela recebia 10 lembretes/dia há 6 dias
    // SEM responder um único (fadiga real + risco de block/ban do WhatsApp). Janela ROLLING
    // de 24h (sem matemática de fuso; espaçamento até mais suave que "dia civil").
    // Fica DEPOIS do claim (ocorrência consumida, recorrência intacta — mesma semântica do
    // staleness) e NUNCA corta one-shot (aviso único de consulta/quimio passa SEMPRE — cap
    // é anti-flood de recorrente, não anti-cuidado).
    // Backup CONDICIONAL (if_not_confirmed) é ISENTO do cap: ele só chega aqui quando o
    // primário NÃO foi confirmado — é rede de segurança de dose, volume baixo e alto valor
    // (capar o backup da insulina não-confirmada inverteria o fail-safe do 0020).
    const isConditionalBackup = (reminder.payload as { condition?: string } | null)?.condition === 'if_not_confirmed';
    if (reminder.rrule && !isConditionalBackup) {
      const cap = user.reminder_max_per_day ?? 6;
      // Conta ENVIOS reais (event_log reminder.dispatched) — last_run_at não serve de proxy
      // porque o claim carimba também ocorrências PULADAS (staleness/condicional/cap).
      // ⚠️ Coluna é occurred_at (migration 0002), NÃO created_at — o review pegou a query
      // com coluna errada que fazia o PostgREST devolver {error, count:null} e o cap virar
      // no-op silencioso. Erro de query agora é logado e decide fail-open EXPLICITAMENTE.
      const { count: sent24h, error: capErr } = await db
        .from('event_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_name', 'reminder.dispatched')
        .eq('user_id', reminder.user_id)
        .gte('occurred_at', new Date(now.getTime() - 24 * 60 * 60_000).toISOString());
      if (capErr) {
        // fail-open deliberado (melhor lembrar demais que calar remédio) — mas NUNCA mudo.
        await writeLog('warn', 'reminder', `cap: query do event_log falhou (${capErr.message.slice(0, 80)}) — fail-open, enviando`, {});
      } else if ((sent24h ?? 0) >= cap) {
        await writeLog('warn', 'reminder', `cap diário atingido (${sent24h}/${cap} em 24h) — "${reminder.title}" pulado (ocorrência consumida)`, {});
        void writeEvent({
          eventName: 'reminder.capped',
          userId: reminder.user_id,
          payload: { reminder_id: reminder.id, cap, sent_24h: sent24h ?? 0 },
        });
        continue;
      }
    }

    const name = user.preferred_name ?? 'você';
    // body:"" (string vazia que a LLM às vezes manda) NÃO é null → `?? fallback`
    // não pega e o WhatsApp recebia mensagem VAZIA (rejeitada). Trata vazio.
    const rawMsg = reminder.body?.trim() ? reminder.body : `Ei ${name}, lembrete: ${reminder.title} 💊`;

    // 🕐 RE-ANCORAGEM DE DÊITICO NO DISPARO (incidente Elizabeth 09/07): rows ONE-SHOT
    // criadas antes do fix (ou por um LLM desobediente) podem ter "amanhã" congelado da
    // criação — entregue no dia do evento vira mentira ("Amanhã é dia da quimioterapia"
    // NO dia da quimio). Re-ancora da perspectiva de AGORA. RECORRENTE nunca é re-ancorado
    // (o "hoje"/"amanhã" genérico de um body diário é atemporal por escolha do autor —
    // "separar os remédios de amanhã" todo dia às 21h deve continuar "de amanhã" sempre).
    // Log SEM conteúdo do body (regra 3 do CLAUDE.md: dado clínico não vai a log ≥ info).
    let msg = rawMsg;
    if (!reminder.rrule) {
      const norm = normalizeReminderBody(rawMsg, {
        authoredAtIso: reminder.created_at,
        fireAtIso: now.toISOString(),
        eventAtIso: (reminder.payload as { event_at?: string } | null)?.event_at ?? null,
        timeZone: userTz ?? null,
      });
      if (norm.changed) {
        await writeLog('info', 'reminder', `body re-ancorado no disparo (dêitico corrigido) — reminder ${reminder.id}`, {});
      }
      msg = norm.body;
    }

    // 2. Espelha na conversa canônica (mesma do WhatsApp) → app vê via realtime.
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('party_type', 'user')
      .eq('user_id', reminder.user_id)
      .eq('whatsapp_instance', SARA_INSTANCE)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    // O espelho é gravado ANTES de sabermos se o canal aceita (a janela é testada abaixo).
    // Guardamos o id pra carimbar o RESULTADO REAL no fim — sem isso, 30 lembretes não
    // entregues em 17–19/07 (incl. o anti-hipertensivo do Arthur) apareciam no dashboard
    // como se tivessem sido enviados, e ninguém tinha como ver.
    let mirroredMessageId: string | null = null;
    if (conv) {
      const { data: mirrored } = await db.from('messages').insert({
        conversation_id: conv.id,
        direction: 'out',
        sender_role: 'assistant',
        content_type: 'text',
        content: msg,
      }).select('id').single();
      mirroredMessageId = (mirrored?.id as string | undefined) ?? null;
      await db.from('conversations').update({ last_message_at: now.toISOString() }).eq('id', conv.id);
    }

    // 🚪 JANELA WABA (incidente Elizabet 13/07): na perna oficial (zpro), texto livre fora
    // de 24h da última msg do usuário é REJEITADO pela Meta. Antes o dispatcher mandava
    // assim mesmo → a Meta descartava e o lembrete era marcado 'sent' sem chegar. Agora:
    // dentro da janela → texto livre; fora → template de re-engajamento (se aprovado) OU
    // nada por WhatsApp (o push + espelho no app cobrem quem tem app), e o não-entregue é
    // registrado com HONESTIDADE (evento + warn) pra ser visível/acionável.
    const needsWindow = !isSimulatorMode() && saraNeedsWabaWindow();
    let windowOpen = !needsWindow; // uazapi/simulador: canal sem restrição de janela
    if (needsWindow) {
      if (!conv) {
        // Sem conversa WhatsApp localizada → o usuário nunca falou por lá → janela FECHADA
        // (fail-safe: melhor template/suppress do que texto livre que a Meta rejeita).
        windowOpen = false;
      } else {
        const lastIn = await lastUserInboundMs(conv.id);
        windowOpen = isWabaWindowOpen(lastIn, now.getTime());
      }
    }

    // 3. WhatsApp real, SEMPRE pela fila (rate-limit anti-ban).
    let whatsappDelivered = false;
    let deliveryStatus: 'delivered' | 'window_blocked' | 'suppressed' = 'suppressed';
    if (!isSimulatorMode()) {
      if (windowOpen) {
        await dispatchOutbound({ kind: 'text', instance: SARA_INSTANCE, phoneE164: user.phone_e164, text: msg });
        whatsappDelivered = true;
        deliveryStatus = 'delivered';
      } else if (reengageTemplateEnabled()) {
        // Fora da janela + template de re-engajamento aprovado: abre a conversa com um HSM
        // (Meta aceita template fora de 24h). O corpo do lembrete continua no espelho/app;
        // quando o usuário responder, a janela reabre.
        // {{2}} = o MOTIVO real deste lembrete ("Passei só pra te lembrar de tomar o seu
        // Neblock 5mg hoje às 7h…") — o template é o mesmo pra todos os casos, só muda a frase.
        const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: userTz || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(now);
        const [hh, mm] = hhmm.split(':');
        const whenLabel = `hoje às ${mm === '00' ? `${Number(hh)}h` : `${Number(hh)}h${mm}`}`;
        const tpl = buildReengageTemplate(name.split(' ')[0] ?? name, reengageReasonForReminder(reminder, whenLabel));
        await dispatchOutbound({ kind: 'template', instance: SARA_INSTANCE, phoneE164: user.phone_e164, templateName: tpl.name, templateLanguage: tpl.language, templateVariables: tpl.variables, text: tpl.text });
        whatsappDelivered = true;
        deliveryStatus = 'delivered';
        // O paciente recebe o TEMPLATE, não o corpo do lembrete → o espelho tem que mostrar
        // o template (senão o dashboard exibe um texto e a pessoa leu outro — mesmo bug já
        // corrigido no check-in mais abaixo).
        if (mirroredMessageId) await db.from('messages').update({ content: tpl.text }).eq('id', mirroredMessageId);
        await writeLog('info', 'reminder', `fora da janela 24h → template de re-engajamento enviado ("${reminder.title}")`, {});
      } else {
        // Fora da janela e sem template aprovado: NÃO queima texto livre (a Meta rejeitaria).
        // Honestidade: registra o não-entregue por WhatsApp — visível pro fundador agir.
        deliveryStatus = 'window_blocked';
        await writeLog('warn', 'reminder', `lembrete "${reminder.title}" NÃO entregue por WhatsApp — janela de 24h fechada (usuário mudo) e sem template de re-engajamento aprovado`, {});
        void writeEvent({
          eventName: 'reminder.wa_window_closed',
          userId: reminder.user_id,
          conversationId: conv?.id,
          payload: { reminder_id: reminder.id, type: reminder.type },
        });
      }
    }

    // Carimba no espelho o que REALMENTE aconteceu no canal. `delivered_at` null +
    // delivery_status='window_blocked' = a linha existe no dashboard mas o paciente NUNCA
    // recebeu — a diferença que faltava pra enxergar o Arthur sem o remédio de pressão.
    if (mirroredMessageId) {
      await db.from('messages').update({
        delivered_at: whatsappDelivered ? new Date().toISOString() : null,
        delivery_status: isSimulatorMode() ? 'suppressed' : deliveryStatus,
      }).eq('id', mirroredMessageId);
    }

    // 4. Push pro app nativo (acorda mesmo com o app fechado). No-op se FCM
    //    não configurado; tokens mortos são limpos. Abre direto no chat.
    try {
      const tokens = await listDeviceTokens(reminder.user_id);
      if (tokens.length) {
        const title = reminder.type === 'medication' ? '💊 Hora do remédio' : 'Xarlote';
        const result = await sendPush(tokens, {
          title,
          body: msg,
          data: { kind: 'reminder', reminder_id: reminder.id, route: '/app' },
        });
        if (result.invalidTokens.length) await deleteDeviceTokens(result.invalidTokens);
      }
    } catch (err) {
      await writeLog('warn', 'reminder', `push falhou: ${String(err).slice(0, 120)}`, { traceId: undefined });
    }

    // AWAIT (não fire-and-forget): o cap do PRÓXIMO lembrete deste tick conta este evento —
    // sem await, 8 lembretes às 8h do mesmo usuário passariam todos antes do 1º ser contado.
    await writeEvent({
      eventName: 'reminder.dispatched',
      userId: reminder.user_id,
      conversationId: conv?.id,
      payload: {
        reminder_id: reminder.id,
        type: reminder.type,
        recurring: Boolean(reminder.rrule),
        next_run_at: next?.toISOString() ?? null,
        mirrored_to_app: Boolean(conv),
        whatsapp_delivered: whatsappDelivered,
        window_open: windowOpen,
      },
    });

    // 🤝 RE-ENGAJAMENTO (incidente Antônia Flávia 09/07: 69 mensagens de lembrete e NEM UMA
    // resposta em 6 dias): usuário recebendo lembretes recorrentes e mudo há 5+ dias ganha
    // UM check-in perguntando se estão ajudando (cooldown de 7 dias via
    // users.metadata.reminder_reengage_at). NÃO pausa nada sozinho — remédio de paciente
    // silencioso é exatamente o que NÃO se pausa por conta própria (fail-safe pró-cuidado);
    // só abre a porta pro usuário ajustar/parar. Best-effort: falha aqui nunca derruba o tick.
    if (reminder.rrule && conv && !reengagedThisTick.has(reminder.user_id)) {
      try {
        // RE-LÊ o metadata fresco (o snapshot do join é do início do tick — com 2+ lembretes
        // do MESMO usuário vencidos no mesmo tick, o snapshot stale mandaria 2 check-ins) e
        // grava o carimbo ANTES de enviar com guard condicional: só envia quem GANHOU o
        // update (elimina corrida entre rows e minimiza a janela contra outros RMW de
        // metadata — audio_intro/update_profile).
        const { data: freshUser } = await db.from('users').select('metadata').eq('id', reminder.user_id).maybeSingle();
        const meta = (freshUser?.metadata ?? {}) as Record<string, unknown> & { reminder_reengage_at?: string };
        const askedAgo = meta.reminder_reengage_at ? now.getTime() - new Date(meta.reminder_reengage_at).getTime() : Infinity;
        if (askedAgo > 7 * 24 * 60 * 60_000) {
          const { data: lastIn } = await db
            .from('messages')
            .select('created_at')
            .eq('conversation_id', conv.id)
            .eq('direction', 'in')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          const silentMs = lastIn?.created_at ? now.getTime() - new Date(lastIn.created_at as string).getTime() : Infinity;
          if (silentMs > 5 * 24 * 60 * 60_000) {
            reengagedThisTick.add(reminder.user_id);
            await db.from('users').update({ metadata: { ...meta, reminder_reengage_at: now.toISOString() } }).eq('id', reminder.user_id);
            // Vocativo só com nome REAL — "você, tô te mandando..." não existe em PT-BR.
            const firstName = user.preferred_name?.trim() ? user.preferred_name.trim().split(' ')[0] : null;
            const checkin = firstName
              ? `${firstName}, tô te mandando esses lembretes todo dia e queria saber: tão te ajudando de verdade? Se quiser mudar horário, diminuir ou parar algum, é só me falar aqui 💙`
              : `Oi! Tô te mandando esses lembretes todo dia e queria saber: tão te ajudando de verdade? Se quiser mudar horário, diminuir ou parar algum, é só me falar aqui 💙`;
            // IRONIA da janela (incidente Elizabet): o check-in é EXATAMENTE pra quem está
            // mudo 5+ dias → SEMPRE fora da janela de 24h. Texto livre não chega. Fora da
            // janela usa o template de re-engajamento (se aprovado); senão só espelha no app.
            // {{2}} aqui é a reativação PURA ("faz uns dias que a gente não conversa…").
            const useTemplate = !isSimulatorMode() && needsWindow && !windowOpen && reengageTemplateEnabled();
            const tpl = useTemplate ? buildReengageTemplate(firstName ?? '', REENGAGE_REASON_SILENT) : null;
            // Espelha o que o paciente REALMENTE recebe (antes gravava o check-in e mandava o
            // template — dashboard mostrava um texto e a pessoa lia outro).
            await db.from('messages').insert({
              conversation_id: conv.id, direction: 'out', sender_role: 'assistant', content_type: 'text',
              content: tpl ? tpl.text : checkin,
            });
            if (!isSimulatorMode()) {
              if (!needsWindow || windowOpen) {
                await dispatchOutbound({ kind: 'text', instance: SARA_INSTANCE, phoneE164: user.phone_e164, text: checkin });
              } else if (tpl) {
                await dispatchOutbound({ kind: 'template', instance: SARA_INSTANCE, phoneE164: user.phone_e164, templateName: tpl.name, templateLanguage: tpl.language, templateVariables: tpl.variables, text: tpl.text });
              }
            }
            await writeLog('info', 'reminder', `check-in de re-engajamento (mudo há ${Math.round(silentMs / 86_400_000)}d) — ${(!needsWindow || windowOpen) ? 'texto livre' : reengageTemplateEnabled() ? 'template' : 'só app (janela fechada, sem template)'}`, {});
            void writeEvent({ eventName: 'reminder.reengage_checkin', userId: reminder.user_id, conversationId: conv.id, payload: { silent_days: Math.round(silentMs / 86_400_000) } });
          }
        }
      } catch (err) {
        await writeLog('warn', 'reminder', `re-engajamento falhou (ignorado): ${String(err).slice(0, 100)}`, {});
      }
    }
  }
}
