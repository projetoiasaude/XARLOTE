/**
 * O apagamento LGPD, executado — e VERIFICADO depois de executar.
 *
 * ## Três coisas que o apagamento antigo não fazia
 *
 * 1. **Fechar a porta primeiro.** `app_sessions` não estava na lista: o paciente apagava a
 *    conta e seguia logado no app, com JWT válido lendo um prontuário que já devia ter
 *    deixado de existir. Aqui sessão, aparelho e link de médico caem ANTES de qualquer
 *    limpeza — se algo falhar no meio, ao menos o acesso já morreu.
 *
 * 2. **Conferir depois.** A versão antiga logava `warn` numa falha de tabela e seguia; o
 *    paciente era avisado que estava tudo apagado. Aqui existe uma passada de verificação:
 *    recontar cada tabela e, se sobrou linha, **lançar** — pra que o BullMQ tente de novo
 *    em vez de o sistema afirmar que cumpriu. Apagamento é a operação em que "quase" é
 *    indistinguível de "não".
 *
 * 3. **Tratar a conversa do estabelecimento pelo que ela é.** Ver `destinoDaConversa` em
 *    `lib/lgpd-plan.ts`: fio exclusivo tem as mensagens apagadas, fio compartilhado é
 *    REDIGIDO — porque apagá-lo destruiria dado de até oito outros pacientes.
 *
 * ## O que sobrevive, e por quê
 *
 * `audit_log` e `consent_events` ficam: são a prova de que o apagamento foi pedido e
 * cumprido. Apagar o registro do apagamento destruiria a única evidência de conformidade.
 * A linha de `users` fica esvaziada, com `deleted_at` — é o que faz toda leitura recusar
 * (o 404 `user_gone` em `routes/app/overview.ts`).
 */
import { db, writeAudit, writeLog, deleteUserMemory } from '@iasaude/db';
import {
  aindaContemIdentificador,
  destinoDoFio,
  patchAnonimizacaoUser,
  redigirIdentificadores,
  tabelasParaApagar,
} from '../lib/lgpd-plan.js';
import { brPhoneVariants } from '@iasaude/shared';

/** Buckets que podem conter arquivo do paciente. */
const BUCKETS = ['xarlote-app-media', 'xarlote-media', 'xarlote-exports'] as const;

export interface RelatorioApagamento {
  userId: string;
  /** Linhas apagadas por tabela — só as que tinham algo. */
  tabelas: Record<string, number>;
  mensagensApagadas: number;
  conversasDoPaciente: number;
  fiosExclusivosLimpos: number;
  fiosCompartilhadosRedigidos: number;
  mensagensRedigidas: number;
  webhookEventsApagados: number;
  arquivosApagados: number;
  /** Tabelas que AINDA tinham linha na verificação. Vazio = apagamento completo. */
  sobras: string[];
}

/** Conta e apaga, devolvendo quantas linhas saíram (0 quando não havia nada). */
async function apagarPorUsuario(tabela: string, userId: string): Promise<number> {
  const { count } = await db
    .from(tabela)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (!count) return 0;

  const { error } = await db.from(tabela).delete().eq('user_id', userId);
  if (error) {
    // Erro aqui é ERRO, não warn: a consequência é dado clínico sobrevivendo a um pedido
    // de apagamento. Relançar leva o job pro retry do BullMQ.
    throw new Error(`forget-me: falha ao apagar ${tabela}: ${error.message}`);
  }
  return count;
}

export async function executeForgetMe(
  userId: string,
  ctx: {
    traceId: string;
    canal: 'whatsapp' | 'app';
    conversationId?: string;
    /**
     * Telefone lido ANTES de qualquer escrita, carregado pelo job.
     *
     * O passo 8 anonimiza `users.phone_e164` para `deleted-<id>`. Se a verificação do
     * passo 9 lançar (é o desenho: sobra ⇒ retry), a tentativa seguinte lê a linha já
     * anonimizada e perde as variantes do número — e a purga de `webhook_events`, que
     * SÓ se alcança pelo número, nunca mais acontece. O job carrega o original.
     */
    telefoneOriginal?: string;
  },
): Promise<RelatorioApagamento> {
  const nowIso = new Date().toISOString();
  /**
   * Sobras que a verificação por `user_id` não alcança.
   *
   * `webhook_events` não tem `user_id` — então a passada final do passo 9 é cega pra ela.
   * Uma falha lá precisa chegar ao mesmo lugar das outras sobras, senão o apagamento se
   * declararia completo tendo deixado payload cru com telefone para trás.
   */
  const sobrasExtra: string[] = [];

  // ── 0. Audit ANTES ─────────────────────────────────────────────────────────
  // Se o processo morrer no meio, tem que existir registro de que foi TENTADO.
  await writeAudit({
    actorType: 'user',
    action: 'user.forget_me.executing',
    userId,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    traceId: ctx.traceId,
    reason: 'lgpd_article_18',
    metadata: { channel: ctx.canal },
  });

  // ── 1. COLETAR antes de apagar ─────────────────────────────────────────────
  // Tudo que depende de uma linha que vai ser destruída precisa ser lido AGORA.
  // Foi o erro mais fácil de cometer aqui: apagar `orders` e só depois procurar as
  // conversas de fornecedor, que se alcançam justamente por `orders → quotes`.
  const { data: userRow } = await db
    .from('users')
    .select('phone_e164, full_name, preferred_name')
    .eq('id', userId)
    .maybeSingle();

  /**
   * O que conta como identificador na redação dos fios compartilhados.
   *
   * O nome PREFERIDO fica de fora de propósito: ele costuma ser uma palavra só, e
   * `identificadorRedigivel` recusaria mesmo se entrasse. A razão está lá — "Rosa"
   * apagaria "rosa mosqueta"; "Vera" apagaria "verapamil". Num fio compartilhado isso
   * corrompe o registro de OUTROS pacientes. Telefone (forte) e nome completo (2+
   * palavras) bastam.
   */
  // `deleted-<uuid>` é o carimbo de `patchAnonimizacaoUser`: se ele já está aí, esta é uma
  // RETENTATIVA e o número real só existe no job.
  const telefoneDaLinha = userRow?.phone_e164 as string | undefined;
  const telefone =
    telefoneDaLinha && !telefoneDaLinha.startsWith('deleted-') ? telefoneDaLinha : ctx.telefoneOriginal;

  const identificadores = [
    ...(telefone ? brPhoneVariants(telefone) : []),
    ...(telefone ? [telefone.replace(/\D/g, '')] : []),
    userRow?.full_name ?? '',
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

  const { data: convsDoPaciente } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId);
  const idsConvPaciente = (convsDoPaciente ?? []).map((c) => c.id as string);

  // Conversas de fornecedor/clínica que falaram DESTE paciente.
  const { data: pedidos } = await db.from('orders').select('id').eq('user_id', userId);
  const { data: consultas } = await db.from('consultations').select('id').eq('user_id', userId);

  const idsFio = new Set<string>();
  if (pedidos?.length) {
    const { data } = await db
      .from('quotes')
      .select('conversation_id')
      .in('order_id', pedidos.map((o) => o.id as string));
    for (const q of data ?? []) if (q.conversation_id) idsFio.add(q.conversation_id as string);
  }
  if (consultas?.length) {
    const { data } = await db
      .from('consultation_quotes')
      .select('conversation_id')
      .in('consultation_id', consultas.map((c) => c.id as string));
    for (const q of data ?? []) if (q.conversation_id) idsFio.add(q.conversation_id as string);
  }

  // Arquivos: caminhos lidos antes de as linhas sumirem.
  const caminhos: string[] = [];
  if (idsConvPaciente.length) {
    const { data } = await db
      .from('messages')
      .select('media_storage_path')
      .in('conversation_id', idsConvPaciente)
      .not('media_storage_path', 'is', null);
    for (const m of data ?? []) if (m.media_storage_path) caminhos.push(m.media_storage_path as string);
  }
  for (const tabela of ['app_media', 'app_exports']) {
    const { data } = await db.from(tabela).select('storage_path').eq('user_id', userId);
    for (const r of data ?? []) if (r.storage_path) caminhos.push(r.storage_path as string);
  }

  // ── 1b. ARQUIVOS, antes de qualquer linha sumir ────────────────────────────
  //
  // Isto ficava no passo 7, depois de `messages`, `app_media` e `app_exports` já terem
  // sido apagadas — e `caminhos` só se descobre a partir DELAS. Funcionava na primeira
  // passada; numa RETENTATIVA (o passo 9 lança de propósito quando sobra linha) a lista
  // vinha vazia, o bloco era pulado e o apagamento se declarava COMPLETO com o laudo do
  // paciente ainda no bucket. Apagar o arquivo enquanto a linha que o aponta existe é o
  // que torna esta etapa idempotente: se morrer antes, a próxima tentativa reencontra
  // tudo; se morrer depois, não há mais o que apagar.
  let arquivosApagados = 0;
  if (caminhos.length) {
    let algumBucketRespondeu = false;
    for (const bucket of BUCKETS) {
      const { data, error } = await db.storage.from(bucket).remove(caminhos);
      // Caminho que não existe naquele bucket devolve erro/vazio — normal, já que a
      // mesma lista é tentada nos três. O que importa é o total removido.
      if (!error) {
        algumBucketRespondeu = true;
        arquivosApagados += data?.length ?? 0;
      }
    }
    // Os três recusarem não é "nenhum arquivo lá": é o Storage fora. Vira sobra, e a
    // retentativa ainda vai encontrar as linhas (elas só somem depois daqui).
    if (!algumBucketRespondeu) sobrasExtra.push(`storage(${caminhos.length}_arquivos)`);
  }

  // ── 2. FECHAR A PORTA ──────────────────────────────────────────────────────
  // `tabelasParaApagar()` já devolve sessão/aparelho/link do médico primeiro.
  const tabelas: Record<string, number> = {};
  for (const t of tabelasParaApagar()) {
    // `conversations` sai por último (passo 5): apagá-la agora levaria as mensagens
    // por cascade antes de a redação dos fios compartilhados acontecer.
    if (t === 'conversations') continue;
    const n = await apagarPorUsuario(t, userId);
    if (n > 0) tabelas[t] = n;
  }

  // 🤝 O OUTRO LADO DO VÍNCULO DE CUIDADO.
  //
  // A varredura acima apaga por `user_id`, e em `care_links` `user_id` é o SUJEITO — ou
  // seja, ela cobre "apagaram a pessoa cuidada". O caso inverso não é alcançável por ali:
  // quando quem pede o apagamento é o CUIDADOR, a linha aponta pra ele em
  // `caregiver_user_id`.
  //
  // E o `on delete cascade` da FK NÃO salva: este fluxo ANONIMIZA a linha de `users` (o
  // `id` é preservado de propósito, pras FKs da prova), nunca a deleta. O cascade jamais
  // dispara. Sem este bloco, uma pessoa que pediu pra ser esquecida continuaria com acesso
  // ativo ao prontuário de quem ficou.
  {
    const { data: comoCuidador } = await db
      .from('care_links')
      .delete()
      .eq('caregiver_user_id', userId)
      .select('id');
    if ((comoCuidador ?? []).length > 0) tabelas['care_links_como_cuidador'] = comoCuidador!.length;
  }
  {
    // Convite que ELE resgataria depois de sumir — porta entreaberta com o nome de um
    // fantasma. `consumed_by_user_id` é o vestígio dele em convite de outra pessoa.
    const { data: convites } = await db
      .from('care_invites')
      .update({ consumed_by_user_id: null })
      .eq('consumed_by_user_id', userId)
      .select('id');
    if ((convites ?? []).length > 0) tabelas['care_invites_resgatados_por_ele'] = convites!.length;
  }

  // ── 3. Mensagens das conversas DELE ────────────────────────────────────────
  //
  // ⚠️ SOLTAR A PROVA ANTES DE APAGAR A MENSAGEM.
  //
  // `consent_events.evidence_message_id` aponta pra mensagem em que a pessoa autorizou
  // algo (o consentimento da busca de exame, por exemplo) e a FK é `ON DELETE NO ACTION`.
  // Como `consent_events` é PRESERVADO de propósito (é a prova de conformidade), o DELETE
  // abaixo violava a FK e derrubava o apagamento no meio: passos 4 a 8 nunca rodavam e o
  // paciente ficava meio-apagado, com telefone e mensagens intactos. Acontecia com
  // QUALQUER paciente que já tivesse usado a frente de exames.
  //
  // A prova não se perde: `evidence_text` e `policy_version` continuam na linha. A
  // migration 0034 troca a FK por `on delete set null` — isto aqui não depende dela.
  {
    const { error } = await db
      .from('consent_events')
      .update({ evidence_message_id: null })
      .eq('user_id', userId)
      .not('evidence_message_id', 'is', null);
    if (error) throw new Error(`forget-me: falha ao soltar evidence_message_id: ${error.message}`);
  }

  let mensagensApagadas = 0;
  if (idsConvPaciente.length) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .in('conversation_id', idsConvPaciente);
    const { error } = await db.from('messages').delete().in('conversation_id', idsConvPaciente);
    if (error) throw new Error(`forget-me: falha ao apagar mensagens: ${error.message}`);
    mensagensApagadas = count ?? 0;
  }

  // ── 4. Os fios do estabelecimento ──────────────────────────────────────────
  let fiosExclusivosLimpos = 0;
  let fiosCompartilhadosRedigidos = 0;
  let mensagensRedigidas = 0;

  for (const fio of idsFio) {
    if (idsConvPaciente.includes(fio)) continue; // já caiu no passo 3

    // Quantos pacientes DIFERENTES este fio atende? A pergunta que decide o destino.
    // As cotações deste paciente já foram apagadas no passo 2, então o que sobrar aqui
    // é exatamente "os outros" — e é isso que a gente não pode destruir.
    const donosRestantes = new Set<string>();

    const { data: restantes } = await db
      .from('quotes')
      .select('order_id')
      .eq('conversation_id', fio);
    const outrosPedidos = (restantes ?? []).map((q) => q.order_id as string).filter(Boolean);
    if (outrosPedidos.length) {
      const { data: donos } = await db.from('orders').select('user_id').in('id', outrosPedidos);
      for (const o of donos ?? []) if (o.user_id) donosRestantes.add(o.user_id as string);
    }

    // ⚠️ FIO DE CLÍNICA SE ALCANÇA POR `consultation_quotes`, NÃO POR `quotes`.
    //
    // A contagem olhava só as cotações de FARMÁCIA. Num fio de clínica — que chega aqui
    // justamente por `consultation_quotes` — ela dava 0, o destino virava "apagar
    // mensagens", e o histórico da clínica com OUTROS pacientes ia junto. Bastava uma
    // clínica ter atendido duas pessoas pelo mesmo número.
    const { data: consRestantes } = await db
      .from('consultation_quotes')
      .select('consultation_id')
      .eq('conversation_id', fio);
    const outrasConsultas = (consRestantes ?? []).map((q) => q.consultation_id as string).filter(Boolean);
    if (outrasConsultas.length) {
      const { data: donos } = await db.from('consultations').select('user_id').in('id', outrasConsultas);
      for (const c of donos ?? []) if (c.user_id) donosRestantes.add(c.user_id as string);
    }

    // O próprio titular não conta: as linhas dele já caíram no passo 2. Descontar é
    // barato e protege contra cascade que não tenha rodado ainda.
    donosRestantes.delete(userId);
    const outrosPacientes = donosRestantes.size;

    // `outrosPacientes` conta quem NÃO é este paciente: as cotações dele já caíram por
    // cascade quando `orders` foi apagada no passo 2. Só zero autoriza a exclusão.
    if (destinoDoFio(outrosPacientes) === 'apagar_mensagens') {
      const { error } = await db.from('messages').delete().eq('conversation_id', fio);
      if (error) throw new Error(`forget-me: falha ao limpar fio ${fio}: ${error.message}`);
      fiosExclusivosLimpos += 1;
      continue;
    }

    // Fio compartilhado: redige só o que identifica ESTE paciente.
    fiosCompartilhadosRedigidos += 1;
    const { data: msgs } = await db
      .from('messages')
      .select('id, content, transcript')
      .eq('conversation_id', fio);

    for (const m of msgs ?? []) {
      const conteudo = (m.content as string | null) ?? '';
      const transcricao = (m.transcript as string | null) ?? '';
      if (!aindaContemIdentificador(conteudo + ' ' + transcricao, identificadores)) continue;

      const patch: Record<string, unknown> = {};
      if (conteudo) patch['content'] = redigirIdentificadores(conteudo, identificadores);
      if (transcricao) patch['transcript'] = redigirIdentificadores(transcricao, identificadores);
      // `raw_payload` é o payload cru do WhatsApp e leva o número no remetente. Não dá
      // pra redigir com confiança um JSON de forma arbitrária — então ele SAI.
      patch['raw_payload'] = null;

      const { error } = await db.from('messages').update(patch).eq('id', m.id as string);
      if (error) throw new Error(`forget-me: falha ao redigir mensagem: ${error.message}`);
      mensagensRedigidas += 1;
    }
  }

  // ── 5. Memória e conversas do paciente ─────────────────────────────────────
  await deleteUserMemory(userId);
  const nConvs = await apagarPorUsuario('conversations', userId);
  if (nConvs > 0) tabelas['conversations'] = nConvs;

  // ── 6. webhook_events ──────────────────────────────────────────────────────
  // Payload cru de entrada, com telefone e conteúdo da mensagem dentro do JSON. A tabela
  // não tem `user_id`: a única linkagem possível é o número no texto do `raw`, e busca de
  // texto em `jsonb` não se expressa por PostgREST. Era exatamente por isso que este
  // buraco ficou aberto — faltava uma função SQL, não vontade.
  //
  // `purge_webhook_events_for_phone` (migration 0028) recebe TODAS as variantes de uma
  // vez: cada ida ao banco é uma janela em que a exclusão pode falhar pela metade.
  let webhookEventsApagados = 0;
  const digitosDoTelefone = (telefone ? brPhoneVariants(telefone) : [])
    .map((v) => v.replace(/\D/g, ''))
    .filter((d) => d.length >= 10);

  if (digitosDoTelefone.length > 0) {
    const { data, error } = await db.rpc('purge_webhook_events_for_phone', {
      p_digits: digitosDoTelefone,
    });
    if (error) {
      // Não derruba o apagamento inteiro (o resto já saiu), mas é ERRO e não warn: a
      // consequência é PII de um titular que pediu exclusão continuar no banco. Vai
      // pro anomaly-detector e a sobra fica registrada no relatório.
      await writeLog('error', 'lgpd', `forget-me: webhook_events NÃO purgado: ${error.message}`, {
        traceId: ctx.traceId,
        userId,
      });
      sobrasExtra.push('webhook_events(rpc_falhou)');
    } else {
      webhookEventsApagados = typeof data === 'number' ? data : 0;
    }
  }

  // (os arquivos saíram no passo 1b, antes das linhas que guardam o caminho deles)

  // ── 8. Anonimizar a linha do usuário ───────────────────────────────────────
  const { error: errUser } = await db
    .from('users')
    .update(patchAnonimizacaoUser(userId, nowIso))
    .eq('id', userId);
  if (errUser) throw new Error(`forget-me: falha ao anonimizar users: ${errUser.message}`);

  await db.from('consent_events').insert({
    user_id: userId,
    event_type: 'revoke',
    policy_version: process.env['APP_CONSENT_VERSION'] ?? '1.0',
    channel: ctx.canal,
  });

  // ── 9. VERIFICAR ───────────────────────────────────────────────────────────
  // A parte que não existia. Sem ela, "apagado" é uma afirmação sobre a intenção do
  // código, não sobre o estado do banco.
  const sobras: string[] = [...sobrasExtra];
  for (const t of tabelasParaApagar()) {
    const { count } = await db
      .from(t)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    if ((count ?? 0) > 0) sobras.push(`${t}(${count})`);
  }

  const relatorio: RelatorioApagamento = {
    userId,
    tabelas,
    mensagensApagadas,
    conversasDoPaciente: idsConvPaciente.length,
    fiosExclusivosLimpos,
    fiosCompartilhadosRedigidos,
    mensagensRedigidas,
    webhookEventsApagados,
    arquivosApagados,
    sobras,
  };

  await writeAudit({
    actorType: 'user',
    action: sobras.length === 0 ? 'user.forget_me.executed' : 'user.forget_me.incomplete',
    userId,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    traceId: ctx.traceId,
    reason: 'lgpd_article_18',
    // Sem PII: contagens e nomes de tabela. O relatório é a prova do que foi feito, e
    // prova de apagamento não pode conter o que foi apagado.
    metadata: relatorio as unknown as Record<string, unknown>,
  });

  if (sobras.length > 0) {
    // Relança pra o retry: melhor tentar de novo do que registrar sucesso com sobra.
    throw new Error(`forget-me INCOMPLETO — sobrou: ${sobras.join(', ')}`);
  }

  return relatorio;
}
