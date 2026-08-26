/**
 * Rotas da Conta Cuidador.
 *
 * Quem gera o código é o SUJEITO; quem o resgata é o CUIDADOR. Cada rota diz, no nome,
 * de que lado está — porque confundir isso é confundir quem autorizou o quê.
 *
 * Desenho: docs/PLANO_CUIDADOR.md
 */
import type { FastifyInstance } from 'fastify';
import { requirePatient } from '../../middleware/patient-auth.js';
import { checkKeyedRateLimit } from '../../middleware/rate-limit.js';
import {
  criarConvite, resgatarConvite, criarDependente, revogarVinculo,
  carregarVinculosDoCuidador, carregarQuemCuidaDeMim,
} from '../../lib/care-links.js';
import { explicarVerdict } from '../../lib/care-invite.js';

/** Parentescos aceitos. Lista fechada: texto livre aqui viraria dado sujo e imprestável. */
const RELACOES = new Set([
  'filho', 'filha', 'pai', 'mae', 'neto', 'neta',
  'conjuge', 'irmao', 'irma', 'responsavel', 'cuidador', 'outro',
]);

export async function appCareRoutes(app: FastifyInstance): Promise<void> {
  /**
   * O SUJEITO gera um código pra entregar a quem vai cuidar dele.
   *
   * Teto de 5/hora: gerar código é barato e inofensivo, mas uma pilha deles é uma pilha
   * de portas abertas ao mesmo tempo.
   */
  app.post('/care/invites', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;
    const rl = await checkKeyedRateLimit(`care:inv:${userId}`, { max: 5, windowS: 3600 });
    // `count: -1` = não deu pra checar (Redis fora). Negar é o certo, e a mensagem
    // precisa dizer que é problema NOSSO — senão a pessoa acha que fez algo errado.
    if (rl.count === -1) return reply.code(503).send({ error: 'indisponivel', message: 'Não consegui gerar o código agora. Tenta de novo em um minuto?' });
    if (!rl.allowed) return reply.code(429).send({ error: 'muitos_codigos', message: 'Você já gerou vários códigos há pouco. Espera um pouquinho.' });

    const r = await criarConvite(userId, `care-inv-${userId.slice(0, 8)}`);
    if (!r.ok) {
      return r.motivo === 'muitos_abertos'
        ? reply.code(409).send({ error: 'muitos_abertos', message: 'Você já tem códigos válidos esperando. Use um deles ou espere vencer.' })
        : reply.code(500).send({ error: 'falha' });
    }
    // O código aparece UMA vez, aqui. Não é guardado em claro nem re-exibível.
    return reply.code(201).send({ codigo: r.code, expiraEm: r.expiresAt });
  });

  /**
   * O CUIDADOR resgata o código. É aqui que o vínculo nasce.
   *
   * Teto apertado (10/h): esta é a única rota com um segredo de 6 dígitos adivinhável.
   * O contador por convite (5 tentativas) protege UM código; este protege o espaço todo.
   */
  app.post<{ Body: { codigo?: string; relation?: string } }>('/care/links', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;
    const { codigo, relation } = req.body ?? {};
    if (!relation || !RELACOES.has(relation)) {
      return reply.code(400).send({ error: 'relacao_invalida', message: 'Diga o que você é dessa pessoa (filho, filha, neto, cônjuge…).' });
    }

    const rl = await checkKeyedRateLimit(`care:resg:${userId}`, { max: 10, windowS: 3600 });
    if (rl.count === -1) return reply.code(503).send({ error: 'indisponivel' });
    if (!rl.allowed) return reply.code(429).send({ error: 'muitas_tentativas', message: 'Muitas tentativas. Espera um pouco e tenta de novo.' });

    const r = await resgatarConvite({ caregiverUserId: userId, codigoBruto: codigo, relation, traceId: `care-resg-${userId.slice(0, 8)}` });
    if (r.ok) return reply.code(201).send({ vinculoId: r.linkId, pessoa: { id: r.subjectUserId, nome: r.subjectName } });

    if (r.verdict === 'ja_vinculado') {
      return reply.code(409).send({ error: 'ja_vinculado', message: 'Você já acompanha essa pessoa.' });
    }
    if (r.verdict === 'proprio') {
      return reply.code(409).send({ error: 'proprio', message: explicarVerdict('proprio') });
    }
    if (r.verdict === 'falha') return reply.code(500).send({ error: 'falha' });
    // Os demais desfechos colapsam num só: distinguir "venceu" de "não existe" faria
    // desta rota um oráculo de códigos válidos.
    return reply.code(404).send({ error: 'codigo_invalido', message: explicarVerdict('mismatch') });
  });

  /**
   * Perfil DEPENDENTE — a criança sem WhatsApp. Não há código porque não há quem o gere.
   * O que existe é a declaração de responsabilidade de quem cria (LGPD art. 14 §1º).
   */
  app.post<{ Body: { nome?: string; relation?: string; nascimento?: string } }>('/care/dependents', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;
    const { nome, relation, nascimento } = req.body ?? {};
    if (!relation || !RELACOES.has(relation)) return reply.code(400).send({ error: 'relacao_invalida' });
    if (!nome || nome.trim().length < 2) return reply.code(400).send({ error: 'nome_invalido', message: 'Como essa pessoa se chama?' });

    const rl = await checkKeyedRateLimit(`care:dep:${userId}`, { max: 5, windowS: 24 * 3600 });
    if (rl.count === -1) return reply.code(503).send({ error: 'indisponivel' });
    if (!rl.allowed) return reply.code(429).send({ error: 'muitos_perfis' });

    const r = await criarDependente({
      caregiverUserId: userId, nome, relation,
      birthDate: nascimento ?? null, traceId: `care-dep-${userId.slice(0, 8)}`,
    });
    return r.ok
      ? reply.code(201).send({ vinculoId: r.linkId, pessoa: { id: r.subjectUserId, nome: nome.trim() } })
      : reply.code(400).send({ error: 'falha', message: r.motivo });
  });

  /**
   * As duas direções na mesma resposta, de propósito: "de quem eu cuido" e "quem cuida de
   * mim" são a mesma pergunta vista dos dois lados, e a segunda é a que dá ao titular o
   * controle sobre quem enxerga o prontuário dele.
   */
  app.get('/care/links', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;
    const [cuido, cuidamDeMim] = await Promise.all([
      carregarVinculosDoCuidador(userId),
      carregarQuemCuidaDeMim(userId),
    ]);
    return reply.send({
      cuido: cuido.map((v) => ({ pessoa: { id: v.subjectUserId, nome: v.subjectName }, relation: v.relation, tipo: v.kind })),
      cuidamDeMim: cuidamDeMim.map((c) => ({ vinculoId: c.linkId, pessoa: { id: c.caregiverUserId, nome: c.caregiverName }, relation: c.relation, desde: c.desde })),
    });
  });

  /** Revogar. Qualquer uma das duas pontas, sozinha, sem depender da outra. */
  app.delete<{ Params: { id: string } }>('/care/links/:id', { preHandler: requirePatient }, async (req, reply) => {
    const r = await revogarVinculo({
      linkId: req.params.id,
      porUserId: req.patient!.userId,
      traceId: `care-rev-${req.params.id.slice(0, 8)}`,
    });
    return r.ok ? reply.send({ ok: true }) : reply.code(404).send({ error: 'nao_encontrado', message: r.motivo });
  });
}
