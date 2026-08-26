/**
 * care-links — criar, resgatar e revogar vínculos de cuidado.
 *
 * A parte de DECISÃO é pura e vive em `@iasaude/shared` (`care-access.ts`) e em
 * `care-invite.ts`. Aqui é só o I/O: ler os vínculos, gravar a prova do consentimento,
 * criar a linha, derrubá-la.
 *
 * Duas regras que o banco garante e este arquivo não pode contornar (migration 0030):
 *   • vínculo entre CONTAS exige `consent_event_id` — sem prova, o insert falha;
 *   • um vínculo ATIVO por par (índice único parcial) — reconectar depois de revogar é
 *     normal e continua permitido.
 */
import { randomUUID, randomBytes, randomInt } from 'crypto';
import { db, writeAudit, writeLog } from '@iasaude/db';
import { LGPD_POLICY_VERSION, type CareLinkView, type CareRelation } from '@iasaude/shared';
import {
  generateCareCode, hashCareCode, evaluateCareInvite, normalizarCodigo,
  CARE_INVITE_TTL_MS, CARE_INVITE_MAX_ATTEMPTS, CARE_INVITE_MAX_ABERTOS,
  type CareInviteVerdict,
} from './care-invite.js';

/** Versões de política — separadas porque as duas bases legais são diferentes. */
export const CARE_CONSENT_VERSION = `cuidador-${LGPD_POLICY_VERSION}`;
export const CARE_DECLARACAO_VERSION = `responsavel-${LGPD_POLICY_VERSION}`;

/** O pepper do OTP serve aqui: mesma classe de segredo, mesmo modelo de ameaça. */
function pepper(): string {
  return process.env['OTP_PEPPER'] ?? '';
}

/**
 * De quem esta pessoa cuida. É o caminho QUENTE — roda a cada turno do cuidador — e por
 * isso lê só o necessário, por índice parcial (`care_links_caregiver_idx`).
 */
export async function carregarVinculosDoCuidador(caregiverUserId: string): Promise<CareLinkView[]> {
  const { data, error } = await db
    .from('care_links')
    .select('user_id, relation, kind, status, users:user_id(preferred_name, full_name)')
    .eq('caregiver_user_id', caregiverUserId)
    .eq('status', 'ativo');
  if (error) {
    // Falha de leitura NÃO pode virar "não cuida de ninguém" em silêncio: seria um
    // cuidador perdendo acesso sem saber por quê. Loga alto e devolve vazio (fail-safe:
    // o pior caso é ele agir só sobre o próprio registro, nunca sobre o de outro).
    await writeLog('error', 'care', `leitura de vínculos falhou (${error.message.slice(0, 90)}) — tratando como SEM vínculo`, {
      userId: caregiverUserId,
    });
    return [];
  }
  return (data ?? []).map((r) => {
    const u = r.users as { preferred_name?: string | null; full_name?: string | null } | null;
    return {
      subjectUserId: r.user_id as string,
      subjectName: (u?.preferred_name || u?.full_name) ?? null,
      relation: r.relation as CareRelation,
      kind: r.kind as CareLinkView['kind'],
      status: r.status as CareLinkView['status'],
    };
  });
}

/** Quem cuida desta pessoa — pra tela de privacidade e pros avisos. */
export async function carregarQuemCuidaDeMim(subjectUserId: string): Promise<Array<{
  linkId: string; caregiverUserId: string; caregiverName: string | null; relation: string; desde: string;
}>> {
  const { data } = await db
    .from('care_links')
    .select('id, caregiver_user_id, relation, activated_at, users:caregiver_user_id(preferred_name, full_name)')
    .eq('user_id', subjectUserId)
    .eq('status', 'ativo');
  return (data ?? []).map((r) => {
    const u = r.users as { preferred_name?: string | null; full_name?: string | null } | null;
    return {
      linkId: r.id as string,
      caregiverUserId: r.caregiver_user_id as string,
      caregiverName: (u?.preferred_name || u?.full_name) ?? null,
      relation: r.relation as string,
      desde: r.activated_at as string,
    };
  });
}

export type CriarConviteResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; motivo: 'muitos_abertos' | 'falha' };

/**
 * O SUJEITO gera um código pra entregar a quem vai cuidar dele.
 *
 * Teto de convites abertos: sem ele, um aparelho sequestrado poderia gerar uma pilha de
 * códigos válidos e o dono nunca saberia quantas portas ficaram abertas.
 */
export async function criarConvite(subjectUserId: string, traceId: string): Promise<CriarConviteResult> {
  const agora = Date.now();
  const { count } = await db
    .from('care_invites')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', subjectUserId)
    .is('consumed_at', null)
    .gt('expires_at', new Date(agora).toISOString());
  if ((count ?? 0) >= CARE_INVITE_MAX_ABERTOS) return { ok: false, motivo: 'muitos_abertos' };

  const code = generateCareCode(randomInt);
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(agora + CARE_INVITE_TTL_MS).toISOString();

  const { error } = await db.from('care_invites').insert({
    user_id: subjectUserId,
    code_hash: hashCareCode(code, salt, pepper()),
    salt,
    max_attempts: CARE_INVITE_MAX_ATTEMPTS,
    expires_at: expiresAt,
  });
  if (error) {
    await writeLog('error', 'care', `convite não criado: ${error.message.slice(0, 120)}`, { traceId, userId: subjectUserId });
    return { ok: false, motivo: 'falha' };
  }

  // O código NÃO entra na auditoria — auditar o segredo é o mesmo que guardá-lo em claro.
  await writeAudit({
    actorType: 'user', action: 'care.invite.created', userId: subjectUserId,
    targetTable: 'care_invites', traceId, metadata: { expira_em: expiresAt },
  });
  return { ok: true, code, expiresAt };
}

export type ResgateResult =
  | { ok: true; linkId: string; subjectUserId: string; subjectName: string | null }
  | { ok: false; verdict: CareInviteVerdict | 'codigo_invalido' | 'ja_vinculado' | 'falha' };

/**
 * O CUIDADOR resgata o código e o vínculo nasce.
 *
 * A ordem aqui não é livre:
 *   1. incrementa `attempts` por CAS — ANTES de comparar, senão dois requests paralelos
 *      conseguem duas tentativas com o mesmo contador (mesma trava do OTP);
 *   2. avalia;
 *   3. grava a PROVA do consentimento em `consent_events`;
 *   4. cria o vínculo — que o banco recusa sem a prova do passo 3;
 *   5. consome o convite.
 */
export async function resgatarConvite(args: {
  caregiverUserId: string;
  codigoBruto: unknown;
  relation: string;
  traceId: string;
}): Promise<ResgateResult> {
  const code = normalizarCodigo(args.codigoBruto);
  if (!code) return { ok: false, verdict: 'codigo_invalido' };

  // Sem o salt não dá pra buscar pelo hash: varremos os convites ABERTOS e comparamos.
  // A lista é minúscula (teto de 3 por pessoa, TTL de 30min) e o índice parcial cobre.
  const { data: abertos } = await db
    .from('care_invites')
    .select('id, user_id, code_hash, salt, attempts, max_attempts, expires_at, consumed_at')
    .is('consumed_at', null)
    .gt('expires_at', new Date(Date.now() - CARE_INVITE_TTL_MS).toISOString())
    .limit(500);

  const agora = Date.now();
  for (const row of abertos ?? []) {
    // 1. CAS no contador — só avalia quem conseguiu incrementar.
    const { data: pegou } = await db
      .from('care_invites')
      .update({ attempts: (row.attempts as number) + 1 })
      .eq('id', row.id)
      .eq('attempts', row.attempts as number)
      .select('id');
    if (!pegou?.length) continue;

    const verdict = evaluateCareInvite(
      {
        user_id: row.user_id as string,
        code_hash: row.code_hash as string,
        salt: row.salt as string,
        attempts: (row.attempts as number) + 1,
        max_attempts: row.max_attempts as number,
        expires_at: row.expires_at as string,
        consumed_at: (row.consumed_at as string | null) ?? null,
      },
      { code, pepper: pepper(), nowMs: agora, resgatadorUserId: args.caregiverUserId },
    );
    if (verdict === 'proprio') return { ok: false, verdict };
    if (verdict !== 'ok') continue;

    const subjectUserId = row.user_id as string;

    const { data: jaTem } = await db.from('care_links')
      .select('id').eq('caregiver_user_id', args.caregiverUserId)
      .eq('user_id', subjectUserId).eq('status', 'ativo').limit(1);
    if (jaTem?.length) return { ok: false, verdict: 'ja_vinculado' };

    // 3. A PROVA. Escrita ANTES do vínculo porque o CHECK do banco a exige — e a ordem
    //    também é a certa: consentimento que só existe depois do acesso não é prova.
    const { data: consent } = await db.from('consent_events').insert({
      user_id: subjectUserId,
      event_type: 'accept',
      policy_version: CARE_CONSENT_VERSION,
      channel: 'app',
      evidence_text: `gerou um código de cuidado e ele foi resgatado por ${args.caregiverUserId}`,
    }).select('id').single();

    const { data: link, error: errLink } = await db.from('care_links').insert({
      user_id: subjectUserId,
      caregiver_user_id: args.caregiverUserId,
      relation: args.relation,
      kind: 'vinculo',
      status: 'ativo',
      consent_event_id: consent?.id ?? null,
      created_by_user_id: args.caregiverUserId,
    }).select('id').single();
    if (errLink || !link) {
      await writeLog('error', 'care', `vínculo não criado após resgate válido: ${errLink?.message.slice(0, 120)}`, { traceId: args.traceId });
      return { ok: false, verdict: 'falha' };
    }

    await db.from('care_invites')
      .update({ consumed_at: new Date().toISOString(), consumed_by_user_id: args.caregiverUserId })
      .eq('id', row.id).is('consumed_at', null);

    const { data: sujeito } = await db.from('users').select('preferred_name, full_name').eq('id', subjectUserId).maybeSingle();

    await writeAudit({
      actorType: 'caregiver', actorId: args.caregiverUserId, action: 'care.link.created',
      userId: subjectUserId, targetTable: 'care_links', targetId: link.id, traceId: args.traceId,
      reason: 'código de cuidado resgatado',
      metadata: { relation: args.relation, kind: 'vinculo' },
    });

    return {
      ok: true, linkId: link.id, subjectUserId,
      subjectName: (sujeito?.preferred_name || sujeito?.full_name) ?? null,
    };
  }

  return { ok: false, verdict: 'mismatch' };
}

/**
 * Perfil DEPENDENTE — a criança que não tem WhatsApp.
 *
 * Não há consentimento porque não há quem consinta: uma criança de 6 anos não pode
 * autorizar tratamento dos próprios dados de saúde. O que existe é a DECLARAÇÃO DE
 * RESPONSABILIDADE de quem a representa (LGPD art. 14 §1º), gravada em `consent_events`
 * com política própria — auditável e distinguível de um consentimento de verdade.
 */
export async function criarDependente(args: {
  caregiverUserId: string;
  nome: string;
  relation: string;
  birthDate?: string | null;
  traceId: string;
}): Promise<{ ok: true; subjectUserId: string; linkId: string } | { ok: false; motivo: string }> {
  const nome = (args.nome ?? '').trim();
  if (nome.length < 2) return { ok: false, motivo: 'nome muito curto' };

  // Sentinela no lugar do telefone — `phone_e164` é NOT NULL UNIQUE e este perfil nunca
  // conversa. Mesmo padrão que o forget-me usa pra anonimizar (`deleted-<uuid>`).
  const { data: dep, error: errDep } = await db.from('users').insert({
    phone_e164: `dep-${randomUUID()}`,
    preferred_name: nome,
    full_name: nome,
    account_kind: 'dependente',
    onboarding_status: 'active',
    ...(args.birthDate ? { birth_date: args.birthDate } : {}),
  }).select('id').single();
  if (errDep || !dep) return { ok: false, motivo: `não consegui criar o perfil: ${errDep?.message.slice(0, 80)}` };

  const { data: consent } = await db.from('consent_events').insert({
    user_id: dep.id,
    event_type: 'accept',
    policy_version: CARE_DECLARACAO_VERSION,
    channel: 'app',
    evidence_text: `declaração de responsabilidade por ${args.caregiverUserId} (relação: ${args.relation})`,
  }).select('id').single();

  const { data: link, error: errLink } = await db.from('care_links').insert({
    user_id: dep.id,
    caregiver_user_id: args.caregiverUserId,
    relation: args.relation,
    kind: 'dependente',
    status: 'ativo',
    consent_event_id: consent?.id ?? null,
    created_by_user_id: args.caregiverUserId,
  }).select('id').single();
  if (errLink || !link) return { ok: false, motivo: 'não consegui criar o vínculo' };

  await writeAudit({
    actorType: 'caregiver', actorId: args.caregiverUserId, action: 'care.dependent.created',
    userId: dep.id, targetTable: 'care_links', targetId: link.id, traceId: args.traceId,
    reason: 'perfil dependente criado sob declaração de responsabilidade',
    metadata: { relation: args.relation },
  });
  return { ok: true, subjectUserId: dep.id, linkId: link.id };
}

/**
 * Revogar. Qualquer uma das duas pontas pode, sozinha.
 *
 * O sujeito não precisa da concordância do cuidador — seria absurdo depender de quem
 * está perdendo o acesso. E o cuidador pode se desligar de quem não quer mais acompanhar.
 */
export async function revogarVinculo(args: {
  linkId: string; porUserId: string; traceId: string;
}): Promise<{ ok: boolean; motivo?: string }> {
  const { data: link } = await db.from('care_links')
    .select('id, user_id, caregiver_user_id, status').eq('id', args.linkId).maybeSingle();
  if (!link) return { ok: false, motivo: 'vínculo não encontrado' };
  if (link.user_id !== args.porUserId && link.caregiver_user_id !== args.porUserId) {
    return { ok: false, motivo: 'esse vínculo não é seu' };
  }
  if (link.status !== 'ativo') return { ok: true }; // idempotente

  const { data: mudou } = await db.from('care_links')
    .update({ status: 'revogado', revoked_at: new Date().toISOString(), revoked_by_user_id: args.porUserId })
    .eq('id', args.linkId).eq('status', 'ativo').select('id');
  if (!mudou?.length) return { ok: true };

  await db.from('consent_events').insert({
    user_id: link.user_id,
    event_type: 'revoke',
    policy_version: CARE_CONSENT_VERSION,
    channel: 'app',
    evidence_text: `vínculo de cuidado revogado por ${args.porUserId}`,
  });

  await writeAudit({
    actorType: link.caregiver_user_id === args.porUserId ? 'caregiver' : 'user',
    actorId: args.porUserId, action: 'care.link.revoked',
    userId: link.user_id, targetTable: 'care_links', targetId: args.linkId, traceId: args.traceId,
    reason: link.user_id === args.porUserId ? 'o titular revogou' : 'o cuidador se desligou',
  });
  return { ok: true };
}
