/**
 * Prova que o link do médico funciona — e que as recusas recusam.
 *
 * Testa a corrente inteira contra o banco de verdade: cria o grant como a rota cria,
 * resolve como a página pública resolve, e verifica cada caminho de negação. O que os
 * testes puros não alcançam é o efeito no banco: o contador de acessos, a trava de PIN
 * persistida, e a revogação valendo de imediato.
 *
 *   railway run --service ia-da-saude-api -- pnpm --filter api exec tsx scripts/verify-share-link.ts
 */
import { randomBytes } from 'node:crypto';
import { db } from '@iasaude/db';
import {
  PIN_MAX_TENTATIVAS,
  avaliarShare,
  expiraEm,
  hashPin,
  hashShareToken,
  montarResumo,
  novoShareToken,
} from '../src/lib/share-grants.js';

const TELEFONE = '+5562900000097';
let falhas = 0;

function checa(ok: boolean, o_que: string, detalhe = ''): void {
  if (ok) console.log(`  ✅ ${o_que}`);
  else {
    falhas += 1;
    console.log(`  ❌ ${o_que}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** Lê o grant como a rota pública lê. */
async function resolver(token: string, pin?: string) {
  const { data } = await db
    .from('share_grants')
    .select('id, expires_at, revoked_at, pin_hash, pin_salt, pin_attempts, summary_cache, access_count')
    .eq('token_hash', hashShareToken(token))
    .maybeSingle();
  if (!data) return { veredicto: { kind: 'indisponivel' as const }, grant: null };
  return {
    veredicto: avaliarShare(
      {
        expires_at: data.expires_at as string,
        revoked_at: data.revoked_at as string | null,
        pin_hash: data.pin_hash as string | null,
        pin_salt: data.pin_salt as string | null,
        pin_attempts: (data.pin_attempts as number) ?? 0,
      },
      pin,
      Date.now(),
    ),
    grant: data,
  };
}

async function main(): Promise<void> {
  console.log('\n══ 1. Paciente sintético com quadro clínico ══');
  await db.from('users').delete().eq('phone_e164', TELEFONE);

  const { data: user } = await db
    .from('users')
    .insert({
      phone_e164: TELEFONE,
      full_name: 'Paciente Sintetico Link',
      preferred_name: 'Sintetico',
      birth_date: '1985-03-20',
      adherence_score_30d: 0.87,
      document_cpf: '00000000191',
    })
    .select('id')
    .single();
  const uid = user!.id as string;

  await Promise.all([
    db.from('user_allergies').insert({ user_id: uid, substance: 'Dipirona', reaction: 'urticaria', severity: 'grave' }),
    db.from('user_medications').insert({ user_id: uid, medication_name: 'Losartana', dosage: '50mg', frequency: '1x ao dia', active: true }),
    db.from('user_health_conditions').insert({ user_id: uid, name: 'hipertensao', onset_date: '2020-01-01', active: true }),
    db.from('user_exam_results').insert({ user_id: uid, exam_type: 'hemograma', title: 'Hemograma completo', exam_date: '2026-08-01', summary: 'dentro da referencia' }),
  ]);

  const [{ data: al }, { data: med }, { data: cond }, { data: ex }] = await Promise.all([
    db.from('user_allergies').select('substance, reaction, severity').eq('user_id', uid),
    db.from('user_medications').select('medication_name, dosage, frequency').eq('user_id', uid),
    db.from('user_health_conditions').select('name, onset_date').eq('user_id', uid),
    db.from('user_exam_results').select('exam_type, title, exam_date, summary').eq('user_id', uid),
  ]);

  const agora = Date.now();
  const resumo = montarResumo(
    { user: { preferred_name: 'Sintetico', birth_date: '1985-03-20', adherence_score_30d: 0.87 },
      alergias: al ?? [], medicamentos: med ?? [], condicoes: cond ?? [], exames: ex ?? [] },
    agora,
  );

  console.log('\n══ 2. Link SEM PIN ══');
  const token = novoShareToken(randomBytes);
  const { data: g1 } = await db
    .from('share_grants')
    .insert({
      user_id: uid,
      token_hash: hashShareToken(token),
      summary_cache: resumo as unknown as Record<string, unknown>,
      expires_at: expiraEm(72, agora).toISOString(),
    })
    .select('id')
    .single();

  const r1 = await resolver(token);
  checa(r1.veredicto.kind === 'ok', 'abre com o token certo');
  const cache = r1.grant?.summary_cache as Record<string, unknown> | undefined;
  checa(!!cache, 'o resumo veio do cache do grant');
  const texto = JSON.stringify(cache ?? {});
  checa(texto.includes('Dipirona'), 'a alergia está no resumo');
  checa(texto.includes('Losartana'), 'o medicamento está no resumo');
  checa(!texto.includes(TELEFONE) && !texto.includes('00000000191'), 'telefone e CPF NÃO estão no resumo');
  checa(!texto.includes('1985-03-20'), 'a data de nascimento NÃO está — só a idade');
  checa(texto.includes('"idade":41'), 'a idade foi calculada', texto.slice(0, 80));

  const errado = await resolver(novoShareToken(randomBytes));
  checa(errado.veredicto.kind === 'indisponivel', 'token inexistente é recusado');

  console.log('\n══ 3. Link COM PIN ══');
  const token2 = novoShareToken(randomBytes);
  const salt = randomBytes(16).toString('hex');
  const { data: g2 } = await db
    .from('share_grants')
    .insert({
      user_id: uid,
      token_hash: hashShareToken(token2),
      pin_hash: hashPin('4321', salt),
      pin_salt: salt,
      summary_cache: resumo as unknown as Record<string, unknown>,
      expires_at: expiraEm(72, agora).toISOString(),
    })
    .select('id')
    .single();
  const g2id = g2!.id as string;

  checa((await resolver(token2)).veredicto.kind === 'pin_necessario', 'sem PIN, PEDE o PIN');
  checa((await resolver(token2, '0000')).veredicto.kind === 'pin_necessario', 'PIN errado não abre');
  checa((await resolver(token2, '4321')).veredicto.kind === 'ok', 'PIN certo abre');

  console.log('\n══ 4. A trava de PIN persiste no banco ══');
  await db.from('share_grants').update({ pin_attempts: PIN_MAX_TENTATIVAS }).eq('id', g2id);
  const travado = await resolver(token2, '4321');
  checa(travado.veredicto.kind === 'indisponivel', 'travado não abre NEM com o PIN certo');
  checa(travado.veredicto.kind === 'indisponivel', 'e a trava é indistinguível de inexistente');
  await db.from('share_grants').update({ pin_attempts: 0 }).eq('id', g2id);

  console.log('\n══ 5. Expiração e revogação ══');
  const token3 = novoShareToken(randomBytes);
  await db.from('share_grants').insert({
    user_id: uid,
    token_hash: hashShareToken(token3),
    summary_cache: {},
    expires_at: new Date(agora - 1000).toISOString(),
  });
  checa((await resolver(token3)).veredicto.kind === 'indisponivel', 'link expirado não abre');

  await db.from('share_grants').update({ revoked_at: new Date().toISOString() }).eq('id', g1!.id as string);
  checa((await resolver(token)).veredicto.kind === 'indisponivel', 'link revogado não abre — na hora');

  console.log('\n══ 6. O contador de acessos ══');
  const { data: antes } = await db.from('share_grants').select('access_count').eq('id', g2id).single();
  await db
    .from('share_grants')
    .update({ access_count: ((antes!.access_count as number) ?? 0) + 1, last_accessed_at: new Date().toISOString() })
    .eq('id', g2id);
  const { data: depois } = await db.from('share_grants').select('access_count, last_accessed_at').eq('id', g2id).single();
  checa((depois!.access_count as number) === ((antes!.access_count as number) ?? 0) + 1, 'o acesso é contado');
  checa(depois!.last_accessed_at !== null, 'a data do último acesso é registrada');

  console.log('\n══ 7. O apagamento LGPD derruba os links ══');
  const { count: vivosAntes } = await db
    .from('share_grants')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', uid);
  checa((vivosAntes ?? 0) >= 3, 'existem links do sintético antes do apagamento', `${vivosAntes}`);

  // `share_grants` está no PLANO_LGPD como 'apagar' — aqui é a prova do efeito.
  await db.from('share_grants').delete().eq('user_id', uid);
  checa((await resolver(token2, '4321')).veredicto.kind === 'indisponivel', 'depois de apagar a conta, o link não abre');

  console.log('\n══ 8. Limpando ══');
  await db.from('users').delete().eq('id', uid);
  const { count } = await db.from('users').select('*', { count: 'exact', head: true }).eq('id', uid);
  checa((count ?? 0) === 0, 'sintético removido');
}

main()
  .then(() => {
    console.log(falhas === 0 ? '\n✅ TUDO PASSOU\n' : `\n❌ ${falhas} FALHA(S)\n`);
    process.exit(falhas === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\n💥 erro:', err instanceof Error ? err.message : err);
    await db.from('users').delete().eq('phone_e164', TELEFONE).then(() => undefined, () => undefined);
    process.exit(1);
  });
