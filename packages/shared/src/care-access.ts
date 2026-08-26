/**
 * care-access — quem pode agir no registro de quem.
 *
 * ─── O QUE MUDA NO PRODUTO ────────────────────────────────────────────────────
 * Até aqui, "quem fala" e "de quem é o dado" eram a mesma pessoa, por construção:
 * `findUserByPhone(telefone)` devolvia UM usuário e todo write ia com
 * `.eq('user_id', ctx.userId)`. Um pai acompanhando o filho, ou um filho cuidando da mãe
 * idosa, não tinha onde existir.
 *
 * Este módulo separa os dois papéis:
 *   • ATOR    — quem está falando (telefone no WhatsApp, `sub` do JWT no app)
 *   • SUJEITO — de quem é o registro afetado
 *
 * ─── AS TRÊS INVARIANTES ──────────────────────────────────────────────────────
 * 1. **O padrão é sempre o próprio ator.** Silêncio nunca roteia pra terceiro. Uma ação
 *    sem alvo explícito é do próprio, e ponto.
 * 2. **O vínculo é verificado, nunca inferido.** `entity_relations` — o grafo em que a IA
 *    anota "takes", "has_condition" — NÃO autoriza nada. Uma Xarlote que deduz "ela é
 *    minha mãe" e abre o prontuário seria a pior falha que este produto pode ter.
 * 3. **Ambiguidade não vira chute.** Mesma escola de `resolveConsultationForUser`: quando
 *    não dá pra ter certeza de quem é o alvo, o chamador é obrigado a perguntar.
 *
 * PURO: sem I/O, sem relógio. Quem carrega os vínculos do banco é a camada de aplicação.
 */
import { resolveEntityRef, type EntityCandidate } from './entity-ref.js';

/** Relação do CUIDADOR em relação ao SUJEITO — "sou filho dela". */
export type CareRelation =
  | 'filho' | 'filha' | 'pai' | 'mae' | 'neto' | 'neta'
  | 'conjuge' | 'irmao' | 'irma' | 'responsavel' | 'cuidador' | 'outro';

/**
 * `vinculo`    — as duas pessoas têm conta própria; o sujeito consentiu e pode revogar.
 * `dependente` — o sujeito não tem WhatsApp próprio (criança); o cuidador declarou
 *                responsabilidade. Não há consentimento porque não há quem consinta.
 */
export type CareLinkKind = 'vinculo' | 'dependente';
export type CareLinkStatus = 'ativo' | 'revogado';

/**
 * O que se pode fazer no registro de outra pessoa.
 *
 * `falar` está separado de propósito e HOJE NENHUM VÍNCULO O CONCEDE: pedir remédio numa
 * farmácia ou marcar consulta em nome de alguém envolve dinheiro e um terceiro real, e é
 * uma decisão de produto que ainda não foi tomada. Deixar o degrau explícito (em vez de
 * simplesmente não checar) é o que impede alguém de ligá-lo sem perceber.
 */
export type CareCapability = 'ver' | 'agir' | 'falar';

export interface CareLinkView {
  subjectUserId: string;
  /** Nome pelo qual o cuidador se refere a ela — usado no prompt e na desambiguação. */
  subjectName: string | null;
  relation: CareRelation | string;
  kind: CareLinkKind;
  status: CareLinkStatus;
}

export type CareDenial =
  | 'sem_vinculo'
  | 'vinculo_revogado'
  | 'capacidade_nao_concedida';

export type CareVerdict =
  | { pode: true; via: 'proprio' }
  | { pode: true; via: 'vinculo'; link: CareLinkView }
  | { pode: false; motivo: CareDenial; explica: string };

/** Capacidades que um vínculo ATIVO concede hoje. Ver a nota em `CareCapability`. */
const CONCEDIDAS: ReadonlySet<CareCapability> = new Set<CareCapability>(['ver', 'agir']);

/**
 * A porta. Toda leitura e toda escrita sobre um sujeito passa por aqui.
 *
 * Ordem das regras: o próprio ator primeiro (o caso de 100% do tráfego de hoje, e o mais
 * barato), depois o vínculo, e a recusa por último — com motivo tipado, pra quem chamou
 * poder reagir em vez de só logar.
 */
export function podeAtuarSobre(
  atorUserId: string,
  sujeitoUserId: string,
  vinculos: readonly CareLinkView[],
  capacidade: CareCapability = 'ver',
): CareVerdict {
  if (atorUserId && sujeitoUserId && atorUserId === sujeitoUserId) {
    return { pode: true, via: 'proprio' };
  }

  const link = vinculos.find((v) => v.subjectUserId === sujeitoUserId);
  if (!link) {
    return { pode: false, motivo: 'sem_vinculo', explica: 'não existe vínculo de cuidado entre essas duas pessoas' };
  }
  if (link.status !== 'ativo') {
    return { pode: false, motivo: 'vinculo_revogado', explica: 'o vínculo existiu mas foi revogado' };
  }
  if (!CONCEDIDAS.has(capacidade)) {
    return {
      pode: false,
      motivo: 'capacidade_nao_concedida',
      explica: `cuidar não inclui "${capacidade}" — falar com farmácia ou consultório em nome de outra pessoa exige decisão que ainda não foi tomada`,
    };
  }
  return { pode: true, via: 'vinculo', link };
}

/** Só os vínculos vivos — o que vai pro prompt e pra lista de candidatos. */
export function vinculosAtivos(vinculos: readonly CareLinkView[]): CareLinkView[] {
  return vinculos.filter((v) => v.status === 'ativo');
}

/** Como o parentesco é lido em voz alta: "mãe dele", "filho dele". */
export function descreverParentesco(relation: string): string {
  const r = (relation ?? '').trim().toLowerCase();
  const mapa: Record<string, string> = {
    filho: 'pai/mãe dele', filha: 'pai/mãe dela',
    pai: 'filho dele', mae: 'filho dela',
    neto: 'avô/avó dele', neta: 'avô/avó dela',
    conjuge: 'cônjuge dele', irmao: 'irmão dele', irma: 'irmã dele',
    responsavel: 'sob responsabilidade dele', cuidador: 'sob cuidado dele',
  };
  return mapa[r] ?? 'sob cuidado dele';
}

/** Linha de apresentação de uma pessoa cuidada, pro bloco do system prompt. */
export function descreverVinculo(v: CareLinkView): string {
  const nome = (v.subjectName ?? '').trim() || 'pessoa sem nome registrado';
  const canal = v.kind === 'dependente'
    ? 'perfil sem WhatsApp próprio'
    : 'ela também fala com você pelo WhatsApp dela';
  return `${nome} (${descreverParentesco(v.relation)}) — ${canal}`;
}

export type SujeitoResolvido =
  | { kind: 'proprio'; userId: string }
  | { kind: 'vinculo'; userId: string; link: CareLinkView }
  | { kind: 'ambiguo'; nomes: string[] }
  | { kind: 'desconhecido'; pedido: string };

/**
 * Traduz o `para_quem` que o modelo escreveu num sujeito de verdade.
 *
 * ⚠️ O PRÓPRIO ATOR ENTRA NA LISTA DE CANDIDATOS, e isso não é detalhe.
 * `resolveEntityRef` tem um resgate `only-one`: com um único candidato, ele devolve esse
 * candidato mesmo quando o texto não bateu com nada. Se a lista fosse só das pessoas
 * cuidadas, um cuidador com UMA pessoa veria qualquer `para_quem` irreconhecível cair
 * silenciosamente no prontuário dela. Incluindo o ator, sempre há ≥2 candidatos, e o
 * resgate perigoso deixa de existir.
 *
 * `paraQuem` vazio nem chega aqui: ausência de alvo é o próprio, sempre.
 */
export function resolverSujeito(
  paraQuem: string | null | undefined,
  ator: { userId: string; nome: string | null },
  vinculos: readonly CareLinkView[],
): SujeitoResolvido {
  const pedido = (paraQuem ?? '').trim();
  if (!pedido) return { kind: 'proprio', userId: ator.userId };

  const ativos = vinculosAtivos(vinculos);

  const candidatos: EntityCandidate[] = [
    // Só auto-referências INEQUÍVOCAS. Possessivos ('meu', 'minha') ficam de fora: o
    // token de "minha mãe" casaria com o próprio ator e a ação voltaria calada pra ele.
    { id: ator.userId, labels: [ator.nome, 'eu', 'mim', 'pra mim', 'comigo'] },
    ...ativos.map((v) => ({
      id: v.subjectUserId,
      labels: [v.subjectName, v.relation, descreverParentesco(v.relation)],
    })),
  ];

  const decisao = resolveEntityRef(pedido, candidatos);

  // 🔴 `only-one` NÃO vale pra escolher pessoa. Esse resgate existe pra casos em que
  // sobra uma opção óbvia ("cancela minha consulta", com uma consulta só) — ali, errar
  // custa um pedido de desculpas. Aqui custaria escrever no prontuário errado. Quando o
  // texto não casou com nada, a resposta certa é dizer que não casou.
  const casouDeVerdade = decisao.kind === 'exact'
    || (decisao.kind === 'rescued' && decisao.why === 'label');

  if (casouDeVerdade) {
    if (decisao.id === ator.userId) return { kind: 'proprio', userId: ator.userId };
    const link = ativos.find((v) => v.subjectUserId === decisao.id);
    return link
      ? { kind: 'vinculo', userId: link.subjectUserId, link }
      : { kind: 'desconhecido', pedido };
  }

  if (decisao.kind === 'ambiguous') {
    const nomes = decisao.ids.map((id) =>
      id === ator.userId
        ? (ator.nome ?? 'você')
        : (ativos.find((v) => v.subjectUserId === id)?.subjectName ?? 'sem nome'),
    );
    return { kind: 'ambiguo', nomes };
  }

  return { kind: 'desconhecido', pedido };
}
