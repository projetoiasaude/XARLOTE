/**
 * Prova o vínculo de cuidado contra o BANCO DE VERDADE.
 *
 * Escola do `verify-forget-me.ts`: teste unitário prova a decisão pura; só o banco prova
 * o CHECK, o índice único parcial e o cascade. Aqui as três coisas são exercidas com
 * usuários sintéticos, e tudo é limpo no fim — inclusive quando falha.
 *
 *   railway run --service ia-da-saude-api npx tsx apps/api/scripts/verify-care-link.ts
 */
import { randomUUID } from 'crypto';
import { db } from '@iasaude/db';
import {
  podeAtuarSobre, resolverSujeito, resolverAlvoDaTool, emergenciaSobreQuemCuido,
  type CareLinkView,
} from '@iasaude/shared';
import {
  criarConvite, resgatarConvite, criarDependente, revogarVinculo,
  carregarVinculosDoCuidador, carregarQuemCuidaDeMim,
} from '../src/lib/care-links.js';

const TRACE = `verify-care-${randomUUID().slice(0, 8)}`;
const criados: { users: string[]; links: string[] } = { users: [], links: [] };
let falhas = 0;

function ok(nome: string, condicao: boolean, detalhe = ''): void {
  if (condicao) { console.log(`  ✅ ${nome}`); return; }
  falhas += 1;
  console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function criarSintetico(nome: string): Promise<string> {
  const { data, error } = await db.from('users').insert({
    phone_e164: `+5562900${String(Math.floor(Math.random() * 900000) + 100000)}`,
    preferred_name: nome, full_name: `${nome} Sintetico`, onboarding_status: 'active',
  }).select('id').single();
  if (error || !data) throw new Error(`não criei ${nome}: ${error?.message}`);
  criados.users.push(data.id);
  return data.id;
}

async function limpar(): Promise<void> {
  for (const id of criados.users) {
    await db.from('care_links').delete().or(`user_id.eq.${id},caregiver_user_id.eq.${id}`);
    await db.from('care_invites').delete().eq('user_id', id);
    await db.from('consent_events').delete().eq('user_id', id);
    await db.from('audit_log').delete().eq('user_id', id);
    await db.from('users').delete().eq('id', id);
  }
}

async function main(): Promise<void> {
  console.log(`\n🤝 verificação do vínculo de cuidado (${TRACE})\n`);

  const mae = await criarSintetico('Maria');
  const filho = await criarSintetico('Hiago');
  const estranho = await criarSintetico('Estranho');

  // ── 1. Sem vínculo, não se enxerga nada ─────────────────────────────────────
  console.log('1. antes de qualquer vínculo');
  ok('o filho não cuida de ninguém', (await carregarVinculosDoCuidador(filho)).length === 0);
  ok('e a decisão pura recusa o acesso', podeAtuarSobre(filho, mae, [], 'ver').pode === false);

  // ── 2. A mãe gera o código e o filho resgata ────────────────────────────────
  console.log('\n2. conexão pelo código');
  const conv = await criarConvite(mae, TRACE);
  ok('a mãe gerou um código de 6 dígitos', conv.ok && /^\d{6}$/.test(conv.code));
  if (!conv.ok) { await limpar(); process.exit(1); }

  const errado = await resgatarConvite({ caregiverUserId: filho, codigoBruto: '000000', relation: 'mae', traceId: TRACE });
  ok('código errado NÃO cria vínculo', errado.ok === false);

  const proprio = await resgatarConvite({ caregiverUserId: mae, codigoBruto: conv.code, relation: 'mae', traceId: TRACE });
  ok('a própria mãe resgatando o próprio código é recusada com motivo claro',
    proprio.ok === false && proprio.verdict === 'proprio');

  const bom = await resgatarConvite({ caregiverUserId: filho, codigoBruto: conv.code, relation: 'mae', traceId: TRACE });
  ok('o filho resgatou e o vínculo nasceu', bom.ok === true);
  if (bom.ok) criados.links.push(bom.linkId);

  const reuso = await resgatarConvite({ caregiverUserId: estranho, codigoBruto: conv.code, relation: 'outro', traceId: TRACE });
  ok('o MESMO código não serve duas vezes', reuso.ok === false);

  // ── 3. A prova do consentimento existe ──────────────────────────────────────
  console.log('\n3. a prova');
  const { data: consents } = await db.from('consent_events')
    .select('id, policy_version, event_type').eq('user_id', mae).eq('event_type', 'accept');
  ok('o consentimento da MÃE foi gravado', (consents ?? []).some((c) => String(c.policy_version).startsWith('cuidador-')));

  const { data: link } = await db.from('care_links').select('consent_event_id, kind').eq('user_id', mae).eq('status', 'ativo').maybeSingle();
  ok('o vínculo aponta pra prova (o CHECK do banco exige)', Boolean(link?.consent_event_id));

  // ── 4. O acesso passa a valer, e só pra quem tem vínculo ────────────────────
  console.log('\n4. o acesso');
  const vinculos = await carregarVinculosDoCuidador(filho);
  ok('o filho agora cuida de 1 pessoa', vinculos.length === 1);
  ok('e o nome dela veio junto', vinculos[0]?.subjectName === 'Maria');
  ok('ele pode ver o registro dela', podeAtuarSobre(filho, mae, vinculos, 'ver').pode === true);
  ok('e agir nele', podeAtuarSobre(filho, mae, vinculos, 'agir').pode === true);
  ok('mas NÃO falar com farmácia/consultório por ela', podeAtuarSobre(filho, mae, vinculos, 'falar').pode === false);
  ok('o estranho continua sem acesso', podeAtuarSobre(estranho, mae, await carregarVinculosDoCuidador(estranho), 'ver').pode === false);
  ok('"minha mãe" resolve pra ela', resolverSujeito('minha mãe', { userId: filho, nome: 'Hiago' }, vinculos).kind === 'vinculo');
  ok('e um nome desconhecido NÃO cai nela', resolverSujeito('Joaquina', { userId: filho, nome: 'Hiago' }, vinculos).kind !== 'vinculo');

  // ── 5. A mãe vê quem cuida dela ─────────────────────────────────────────────
  console.log('\n5. o lado dela');
  const quem = await carregarQuemCuidaDeMim(mae);
  ok('a mãe vê que o filho a acompanha', quem.length === 1 && quem[0]?.caregiverName === 'Hiago');

  // ── 6. Um vínculo ativo por par ─────────────────────────────────────────────
  console.log('\n6. índice único parcial');
  const conv2 = await criarConvite(mae, TRACE);
  const dup = conv2.ok
    ? await resgatarConvite({ caregiverUserId: filho, codigoBruto: conv2.code, relation: 'mae', traceId: TRACE })
    : { ok: false as const, verdict: 'falha' as const };
  ok('não dá pra criar um segundo vínculo vivo entre os mesmos dois', dup.ok === false);

  // ── 7. Dependente ───────────────────────────────────────────────────────────
  console.log('\n7. perfil dependente');
  const dep = await criarDependente({ caregiverUserId: filho, nome: 'Pedro', relation: 'filho', traceId: TRACE });
  ok('o filho criou o perfil do filho pequeno', dep.ok === true);
  if (dep.ok) {
    criados.users.push(dep.subjectUserId);
    const { data: d } = await db.from('users').select('account_kind, phone_e164').eq('id', dep.subjectUserId).maybeSingle();
    ok('o dependente é marcado como tal', d?.account_kind === 'dependente');
    ok('e tem sentinela no lugar do telefone', String(d?.phone_e164 ?? '').startsWith('dep-'));
    ok('o filho agora cuida de 2 pessoas', (await carregarVinculosDoCuidador(filho)).length === 2);
  }

  // ── 8. Revogação ────────────────────────────────────────────────────────────
  console.log('\n8. revogação');
  const { data: linkAtivo } = await db.from('care_links').select('id').eq('user_id', mae).eq('status', 'ativo').maybeSingle();
  const rev = await revogarVinculo({ linkId: linkAtivo!.id, porUserId: mae, traceId: TRACE });
  ok('a mãe revogou sozinha, sem depender do filho', rev.ok === true);
  const depois = await carregarVinculosDoCuidador(filho);
  ok('o acesso à mãe morreu na hora', depois.every((v) => v.subjectUserId !== mae));
  ok('a decisão pura também recusa', podeAtuarSobre(filho, mae, depois, 'ver').pode === false);
  ok('revogar de novo é idempotente', (await revogarVinculo({ linkId: linkAtivo!.id, porUserId: mae, traceId: TRACE })).ok === true);

  const alheio = await revogarVinculo({ linkId: linkAtivo!.id, porUserId: estranho, traceId: TRACE });
  ok('um estranho NÃO revoga vínculo dos outros', alheio.ok === false);

  // ── 9. Reconexão ────────────────────────────────────────────────────────────
  console.log('\n9. reconectar depois de revogar');
  const conv3 = await criarConvite(mae, TRACE);
  const re = conv3.ok
    ? await resgatarConvite({ caregiverUserId: filho, codigoBruto: conv3.code, relation: 'mae', traceId: TRACE })
    : { ok: false as const };
  ok('dá pra reconectar (o unique é PARCIAL de propósito)', re.ok === true);

  // ── 10. Auditoria com o ator certo ──────────────────────────────────────────
  console.log('\n10. auditoria');
  const { data: aud } = await db.from('audit_log')
    .select('actor_type, actor_id, action').eq('user_id', mae).eq('action', 'care.link.created').limit(1).maybeSingle();
  ok('a criação do vínculo foi auditada como `caregiver`', aud?.actor_type === 'caregiver');
  ok('e o actor_id é o cuidador, não a titular', aud?.actor_id === filho);

  // ── 11. O roteamento de tool (F3) ───────────────────────────────────────────
  console.log('\n11. de quem é a ação');
  const vivos = await carregarVinculosDoCuidador(filho);
  const atorFilho = { userId: filho, nome: 'Hiago', vinculos: vivos };

  const semAlvo = resolverAlvoDaTool('create_reminder', {}, atorFilho);
  ok('sem `para_quem`, o lembrete é do PRÓPRIO cuidador',
    semAlvo.ok === true && semAlvo.subjectUserId === filho);

  const comAlvo = resolverAlvoDaTool('create_reminder', { para_quem: 'minha mãe' }, atorFilho);
  ok('com "minha mãe", a ação vai pro registro DELA',
    comAlvo.ok === true && comAlvo.subjectUserId === mae);

  const farmacia = resolverAlvoDaTool('start_pharmacy_order', { para_quem: 'minha mãe' }, atorFilho);
  ok('pedir remédio em nome dela é RECUSADO (capacidade não concedida)', farmacia.ok === false);

  const inexistente = resolverAlvoDaTool('create_reminder', { para_quem: 'Joaquina' }, atorFilho);
  ok('alvo desconhecido não cai em ninguém', inexistente.ok === false);

  const emergencia = emergenciaSobreQuemCuido('minha mãe está com dor no peito', { userId: filho, nome: 'Hiago' }, vivos);
  ok('"minha mãe está com dor no peito" agora identifica a emergência DELA', emergencia?.subjectUserId === mae);

  const passado = emergenciaSobreQuemCuido('semana passada minha mãe teve dor no peito', { userId: filho, nome: 'Hiago' }, vivos);
  ok('mas o PASSADO continua não acionando nada', passado === null);

  await limpar();
  console.log(falhas === 0 ? '\n✅ tudo certo — nada ficou no banco\n' : `\n❌ ${falhas} falha(s)\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 erro:', e);
  await limpar().catch(() => {});
  process.exit(1);
});
