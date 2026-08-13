/**
 * Prova que o apagamento LGPD apaga — de verdade, contra o banco de verdade.
 *
 * ## Por que um script e não um teste de unidade
 *
 * O plano do apagamento (`lib/lgpd-plan.ts`) tem testes puros: eles garantem que a lista
 * cobre o schema e que a fronteira dos fios compartilhados é a certa. O que eles NÃO podem
 * garantir é o efeito: se o `delete` realmente saiu, se o cascade levou os filhos, se a
 * UPDATE de anonimização não estourou numa coluna NOT NULL. Isso só se prova executando.
 *
 * E não se prova na conta de um paciente real. Este script cria um paciente SINTÉTICO,
 * espalha dado dele por todas as tabelas do plano, apaga, e confere o que sobrou.
 *
 * ## O caso que mais importa: o fio compartilhado
 *
 * O script pendura uma cotação do pedido sintético numa conversa de farmácia que JÁ tem
 * mensagens de outros pacientes, e insere ali uma mensagem que menciona o nome e o telefone
 * do sintético. Depois do apagamento, exige as duas coisas ao mesmo tempo:
 *
 *   · os identificadores do sintético REDIGIDOS naquela mensagem;
 *   · as mensagens dos OUTROS pacientes no mesmo fio INTACTAS.
 *
 * É o requisito que fez o buraco ficar aberto tanto tempo, e é o único que um teste de
 * unidade não alcança.
 *
 * ## Como rodar
 *
 *   railway run --service ia-da-saude-api -- npx tsx apps/api/scripts/verify-forget-me.ts
 *
 * Sai com código 1 em qualquer falha, pra poder entrar num pipeline. E limpa o que criou
 * mesmo quando falha no meio (`finally`) — script de verificação que deixa lixo em produção
 * é pior que script nenhum.
 */
import { randomUUID } from 'node:crypto';
import { db } from '@iasaude/db';
import { executeForgetMe } from '../src/handlers/forget-me.js';
import { tabelasParaApagar } from '../src/lib/lgpd-plan.js';
import { MARCA_REDIGIDO } from '../src/lib/lgpd-plan.js';

/** Telefone reservado pra ficção. Não existe e não pode existir. */
const TELEFONE = '+5562900000099';
const NOME = 'Paciente Sintetico Verificacao';

let falhas = 0;
function checa(ok: boolean, o_que: string, detalhe = ''): void {
  if (ok) {
    console.log(`  ✅ ${o_que}`);
  } else {
    falhas += 1;
    console.log(`  ❌ ${o_que}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n══ 1. Montando o paciente sintético ══');

  // Limpa resto de execução anterior interrompida.
  await db.from('users').delete().eq('phone_e164', TELEFONE);

  const { data: user, error: errUser } = await db
    .from('users')
    .insert({
      phone_e164: TELEFONE,
      full_name: NOME,
      preferred_name: 'Sintetico',
      document_cpf: '00000000191',
      birth_date: '1990-01-01',
      health_summary: 'RESUMO CLINICO SINTETICO que precisa desaparecer',
      emergency_contact_name: 'Contato Terceiro Sintetico',
      emergency_contact_phone_e164: '+5562900000098',
      emergency_contact_relation: 'irmao',
      home_city: 'Goiania',
      metadata: { origem: 'verify-forget-me', sujeira: true },
    })
    .select('id')
    .single();

  if (errUser || !user) throw new Error(`não consegui criar o sintético: ${errUser?.message}`);
  const uid = user.id as string;
  console.log(`  usuário sintético: ${uid}`);

  // ── Conversa própria + mensagens ──────────────────────────────────────────
  const { data: conv } = await db
    .from('conversations')
    .insert({
      party_type: 'user',
      user_id: uid,
      whatsapp_instance: 'sara',
      whatsapp_jid: `${TELEFONE.replace(/\D/g, '')}@s.whatsapp.net`,
      status: 'active',
      summary: 'RESUMO DA CONVERSA SINTETICA',
      memory_cards: [{ kind: 'fact', text: 'card sintetico' }],
    })
    .select('id')
    .single();
  const convId = conv!.id as string;

  await db.from('messages').insert([
    { conversation_id: convId, direction: 'in', sender_role: 'user', content_type: 'text', content: 'mensagem sintetica 1' },
    { conversation_id: convId, direction: 'out', sender_role: 'assistant', content_type: 'text', content: 'resposta sintetica' },
  ]);

  // ── Dado clínico e operacional espalhado ──────────────────────────────────
  await Promise.all([
    db.from('user_health_conditions').insert({ user_id: uid, name: 'condicao sintetica', active: true }),
    db.from('user_allergies').insert({ user_id: uid, substance: 'substancia sintetica', severity: 'grave' }),
    db.from('user_medications').insert({ user_id: uid, medication_name: 'remedio sintetico', dosage: '1mg', active: true }),
    db.from('user_exam_results').insert({ user_id: uid, exam_type: 'exame sintetico', findings: { valor: 1 } }),
    db.from('reminders').insert({ user_id: uid, type: 'medication', title: 'lembrete sintetico', status: 'pending', next_run_at: new Date(Date.now() + 86_400_000).toISOString() }),
    db.from('symptoms_log').insert({ user_id: uid, name: 'sintoma sintetico', intensity: 5 }),
    db.from('prescribers').insert({ user_id: uid, name: 'Dr Sintetico', crm: '00000' }),
    db.from('device_tokens').insert({ user_id: uid, token: `tok-sintetico-${randomUUID()}`, platform: 'ios' }),
    // Colunas conferidas contra o information_schema: é `refresh_hash` (não
    // `refresh_token_hash`), `platform` é NOT NULL, e não existe `expires_at`.
    db.from('app_sessions').insert({ user_id: uid, refresh_hash: `hash-sintetico-${randomUUID()}`, platform: 'ios' }),
    db.from('share_grants').insert({ user_id: uid, token_hash: `share-sintetico-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
    db.from('consent_events').insert({ user_id: uid, event_type: 'accept', policy_version: '1.0', channel: 'app' }),
  ]);

  // ── O caso crítico: o fio COMPARTILHADO ───────────────────────────────────
  // Pega uma conversa de fornecedor que já atende OUTROS pacientes.
  const { data: fios } = await db
    .from('quotes')
    .select('conversation_id, orders!inner(user_id)')
    .not('conversation_id', 'is', null)
    .limit(400);

  const porFio = new Map<string, Set<string>>();
  for (const q of fios ?? []) {
    const cid = q.conversation_id as string;
    const dono = (q as unknown as { orders: { user_id: string } }).orders?.user_id;
    if (!cid || !dono) continue;
    if (!porFio.has(cid)) porFio.set(cid, new Set());
    porFio.get(cid)!.add(dono);
  }
  const fioCompartilhado = [...porFio.entries()].find(([, donos]) => donos.size >= 2)?.[0];
  if (!fioCompartilhado) throw new Error('não achei fio de fornecedor compartilhado pra testar');

  const { count: antesNoFio } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', fioCompartilhado);

  // Pedido do sintético + cotação apontando pro fio compartilhado.
  const { data: pedido } = await db
    .from('orders')
    .insert({ user_id: uid, status: 'quoting', items: [{ name: 'remedio sintetico' }] })
    .select('id')
    .single();

  const { data: forn } = await db.from('suppliers').select('id').limit(1).single();
  await db.from('quotes').insert({
    order_id: pedido!.id as string,
    supplier_id: forn!.id as string,
    conversation_id: fioCompartilhado,
    status: 'quoted',
    total: 10,
  });

  // A mensagem no fio compartilhado que MENCIONA o sintético.
  const textoComPII = `Cliente ${NOME}, telefone ${TELEFONE}, quer remedio sintetico`;
  const { data: msgFio } = await db
    .from('messages')
    .insert({
      conversation_id: fioCompartilhado,
      direction: 'out',
      sender_role: 'assistant',
      content_type: 'text',
      content: textoComPII,
    })
    .select('id')
    .single();
  const msgFioId = msgFio!.id as string;

  console.log(`  fio compartilhado: ${fioCompartilhado} (${antesNoFio} mensagens de outros)`);

  console.log('\n══ 2. Executando o apagamento ══');
  const relatorio = await executeForgetMe(uid, { traceId: `verify-${randomUUID()}`, canal: 'app' });
  console.log(`  tabelas tocadas: ${Object.keys(relatorio.tabelas).length}`);
  console.log(`  mensagens apagadas: ${relatorio.mensagensApagadas}`);
  console.log(`  fios exclusivos limpos: ${relatorio.fiosExclusivosLimpos}`);
  console.log(`  fios compartilhados redigidos: ${relatorio.fiosCompartilhadosRedigidos}`);
  console.log(`  mensagens redigidas: ${relatorio.mensagensRedigidas}`);
  console.log(`  webhook_events apagados: ${relatorio.webhookEventsApagados}`);

  console.log('\n══ 3. Conferindo sobras ══');
  checa(relatorio.sobras.length === 0, 'o executor não reportou sobra', relatorio.sobras.join(', '));

  // Recontagem INDEPENDENTE — não confio no relatório do próprio executor.
  for (const tabela of tabelasParaApagar()) {
    const { count } = await db.from(tabela).select('*', { count: 'exact', head: true }).eq('user_id', uid);
    checa((count ?? 0) === 0, `${tabela} vazia`, `${count} linha(s)`);
  }

  const { count: msgsSobrando } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', convId);
  checa((msgsSobrando ?? 0) === 0, 'mensagens da conversa dele apagadas');

  console.log('\n══ 4. A linha de users foi ANONIMIZADA, não apagada ══');
  const { data: depois } = await db.from('users').select('*').eq('id', uid).maybeSingle();
  checa(depois !== null, 'a linha continua existindo (as FKs da prova dependem dela)');
  if (depois) {
    const u = depois as Record<string, unknown>;
    checa(u['deleted_at'] !== null, 'deleted_at marcado');
    checa(u['phone_e164'] === `deleted-${uid}`, 'telefone irrecuperável');
    checa(u['document_cpf'] === null, 'CPF apagado');
    checa(u['birth_date'] === null, 'data de nascimento apagada');
    checa(u['health_summary'] === null, 'resumo clínico apagado');
    checa(u['emergency_contact_phone_e164'] === null, 'telefone do contato de emergência (TERCEIRO) apagado');
    checa(u['home_city'] === null, 'cidade apagada');
    checa(JSON.stringify(u['metadata']) === '{}', 'metadata zerada sem violar NOT NULL');
    checa(u['full_name'] === null && u['preferred_name'] === null, 'nomes apagados');
  }

  console.log('\n══ 5. A PROVA sobreviveu ══');
  const { count: consents } = await db
    .from('consent_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', uid);
  checa((consents ?? 0) >= 2, 'consent_events preservado (aceite + revogação)', `${consents}`);

  const { count: audits } = await db
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', uid);
  checa((audits ?? 0) >= 2, 'audit_log preservado (tentativa + execução)', `${audits}`);

  console.log('\n══ 6. O FIO COMPARTILHADO — o teste que mais importa ══');
  const { data: msgDepois } = await db
    .from('messages')
    .select('content')
    .eq('id', msgFioId)
    .maybeSingle();

  checa(msgDepois !== null, 'a mensagem do fio compartilhado NÃO foi apagada');
  if (msgDepois) {
    const c = (msgDepois.content as string) ?? '';
    checa(!c.includes(NOME), 'o nome do sintético foi redigido');
    checa(!c.includes(TELEFONE), 'o telefone do sintético foi redigido');
    checa(c.includes(MARCA_REDIGIDO), 'a marca de redação está visível');
    checa(c.includes('remedio sintetico'), 'o resto do texto (não identificante) permaneceu');
  }

  const { count: depoisNoFio } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', fioCompartilhado);
  checa(
    (depoisNoFio ?? 0) === (antesNoFio ?? 0) + 1,
    'as mensagens dos OUTROS pacientes no fio estão intactas',
    `antes ${antesNoFio}+1, depois ${depoisNoFio}`,
  );

  // ── Limpeza do que este script criou ──────────────────────────────────────
  console.log('\n══ 7. Limpando o que o script criou ══');
  await db.from('messages').delete().eq('id', msgFioId);
  await db.from('consent_events').delete().eq('user_id', uid);
  await db.from('audit_log').delete().eq('user_id', uid);
  await db.from('users').delete().eq('id', uid);
  const { count: restou } = await db.from('users').select('*', { count: 'exact', head: true }).eq('id', uid);
  checa((restou ?? 0) === 0, 'sintético removido do banco');
}

main()
  .then(() => {
    console.log(falhas === 0 ? '\n✅ TUDO PASSOU\n' : `\n❌ ${falhas} FALHA(S)\n`);
    process.exit(falhas === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\n💥 erro:', err instanceof Error ? err.message : err);
    // Mesmo em erro, tenta não deixar lixo em produção.
    await db.from('users').delete().eq('phone_e164', TELEFONE).then(() => undefined, () => undefined);
    process.exit(1);
  });
