/**
 * care-tools — de quem é a ação que a Xarlote vai executar.
 *
 * ─── O RISCO QUE ESTE ARQUIVO EXISTE PRA CONTER ───────────────────────────────
 * Toda tool escreve com `.eq('user_id', ctx.userId)`. No momento em que `ctx.userId` pode
 * ser outra pessoa, um erro aqui não é um bug de UX: é um registro de dose, um exame ou um
 * lembrete de remédio caindo no prontuário errado.
 *
 * Três defesas, em camadas:
 *
 * 1. **A lista de tools que aceitam alvo é fechada e pequena.** Uma tool que não declara
 *    `para_quem` NÃO PODE ser redirecionada, aconteça o que acontecer com o argumento.
 *    Não é uma checagem que alguém precisa lembrar de fazer — é a ausência do caminho.
 *
 * 2. **Falar com terceiros nunca é redirecionável.** Pedir remédio na farmácia ou marcar
 *    consulta em nome de outra pessoa envolve dinheiro e um estabelecimento real. Essas
 *    tools ficam fora da lista por decisão, não por esquecimento.
 *
 * 3. **Silêncio é sempre o próprio.** Sem `para_quem`, a ação é do ator. Sempre.
 *
 * PURO: sem I/O, sem relógio.
 */
import { foldPt } from './br-datetime.js';
import { resolverSujeito, type CareLinkView } from './care-access.js';

/**
 * As tools que podem agir no registro de outra pessoa.
 *
 * Fechada de propósito, e espelhada nos schemas em `xarlote-tools.ts` — um teste compara
 * as duas listas, porque um `para_quem` declarado no schema e ausente daqui seria um alvo
 * aceito pelo modelo e ignorado pelo executor (a ação cairia calada no registro errado).
 *
 * Todas são de PRONTUÁRIO: registrar, lembrar, anotar. Nenhuma fala com terceiro.
 */
export const TOOLS_COM_SUJEITO: readonly string[] = [
  'create_reminder',
  'cancel_reminders',
  'list_reminders',
  'log_medication_taken',
  'log_symptom',
  'save_exam_result',
  'save_user_profile_fact',
  'red_flag_check',
];

const COM_SUJEITO = new Set(TOOLS_COM_SUJEITO);

export function aceitaSujeito(tool: string): boolean {
  return COM_SUJEITO.has(tool);
}

export type AlvoDaTool =
  | { ok: true; subjectUserId: string; via: 'proprio' }
  | { ok: true; subjectUserId: string; via: 'vinculo'; nome: string | null; relation: string }
  | { ok: false; mensagem: string };

export interface AtorDaTool {
  userId: string;
  nome: string | null;
  vinculos: readonly CareLinkView[];
}

/**
 * Traduz o `para_quem` de uma chamada de tool num sujeito.
 *
 * Nunca lança: devolve `ok:false` com a frase que o MODELO vai ler. As mensagens são
 * escritas pra ele — na escola do `ToolFailure` — e sempre dizem explicitamente que nada
 * foi feito, pra ele não anunciar uma ação que não aconteceu.
 */
export function resolverAlvoDaTool(
  tool: string,
  args: Record<string, unknown> | null | undefined,
  ator: AtorDaTool,
): AlvoDaTool {
  const bruto = (args ?? {})['para_quem'];
  const pedido = typeof bruto === 'string' ? bruto.trim() : '';

  // Sem alvo declarado: o próprio. É o caminho de 100% do tráfego de hoje e o mais barato.
  if (!pedido) return { ok: true, subjectUserId: ator.userId, via: 'proprio' };

  // Tool fora da lista com `para_quem` preenchido: o modelo tentou algo que não existe.
  // Recusar em voz alta é melhor que ignorar em silêncio — ignorar faria a ação cair no
  // registro do ator enquanto o modelo anuncia que foi pra outra pessoa.
  if (!aceitaSujeito(tool)) {
    return {
      ok: false,
      mensagem: `NADA FOI FEITO: \`${tool}\` não pode ser executada em nome de outra pessoa. `
        + `Pedir remédio, marcar ou cancelar consulta em nome de quem você cuida ainda não está disponível — `
        + `só registrar, lembrar e anotar. Diga isso ao paciente com suas palavras.`,
    };
  }

  // ⚠️ INCIDENTE GLAUBER (31/08/2026) — a ordem destas duas checagens importa.
  //
  // Antes, `vinculos.length === 0` recusava ANTES de `resolverSujeito` rodar. Só que
  // `resolverSujeito` é justamente quem sabe dizer "esse nome é o do próprio ator" — ele
  // já carrega `ator.nome` entre os candidatos. Resultado: numa conversa de quem não cuida
  // de ninguém, um `para_quem` com o PRÓPRIO nome levava a *"você não cuida de ninguém
  // chamado Glauber Andrade"* — dito ao Glauber, na conversa do Glauber. O
  // `save_exam_result` do exame de oncologia dele falhou e ninguém tentou de novo.
  //
  // Resolver PRIMEIRO e recusar DEPOIS: quem pede pra si mesmo passa, tenha vínculo ou não.
  // A causa raiz foi tratada em `ferramentasParaAtor` (sem vínculo o campo nem existe no
  // schema); isto aqui é a segunda camada, pro dia em que o campo chegar por outro caminho.
  const r = resolverSujeito(pedido, { userId: ator.userId, nome: ator.nome }, ator.vinculos);

  if (r.kind === 'proprio') return { ok: true, subjectUserId: ator.userId, via: 'proprio' };

  if (ator.vinculos.length === 0) {
    return {
      ok: false,
      mensagem: `NADA FOI FEITO: você não cuida de ninguém chamado "${pedido}". `
        + `Pra acompanhar a saúde de outra pessoa, ela precisa gerar um código na Xarlote dela e passar pra ele. `
        + `Explique isso — NÃO registre nada no lugar.`,
    };
  }
  if (r.kind === 'vinculo') {
    return { ok: true, subjectUserId: r.userId, via: 'vinculo', nome: r.link.subjectName, relation: r.link.relation };
  }
  if (r.kind === 'ambiguo') {
    return {
      ok: false,
      mensagem: `NADA FOI FEITO: "${pedido}" pode ser mais de uma pessoa (${r.nomes.join(', ')}). `
        + `PERGUNTE de quem se trata antes de registrar qualquer coisa.`,
    };
  }
  return {
    ok: false,
    mensagem: `NADA FOI FEITO: você não cuida de ninguém chamado "${pedido}". `
      + `As pessoas que você acompanha são: ${ator.vinculos.map((v) => v.subjectName ?? 'sem nome').join(', ')}. `
      + `Confirme com o paciente de quem se trata — NÃO registre no lugar.`,
  };
}

/**
 * ⚠️ FRONTEIRA POR `\p{L}`, NÃO POR `\b` — e isto CONSERTA um defeito antigo.
 *
 * O regex original usava `\b`, que em JavaScript só conhece `[A-Za-z0-9_]`. Um acento é
 * caractere NÃO-de-palavra, então `minha av[óo]\b` nunca casava com "minha avó": depois do
 * 'ó' vem um espaço, os dois são não-palavra, e não existe transição. Três das 23
 * alternativas estavam MORTAS em produção — `minha avó`, `meu avô` e `às vezes tenho`
 * jamais suprimiram nada, e a preempção de emergência disparava nesses casos.
 *
 * Achado por `tests/care-emergencia-regressao.test.ts`, escrito pra provar que a separação
 * dos dois regexes não mudara nada — e que descobriu que parte deles nunca funcionara.
 *
 * `(?<!\p{L})…(?!\p{L})` com a flag `u` é a fronteira que o autor original quis dizer.
 */

/**
 * PASSADO — motivo permanente pra não acionar o SAMU.
 *
 * "Semana passada minha mãe teve dor no peito, cota AAS" não é emergência, e continua não
 * sendo nem com vínculo. Separado da terceira pessoa de propósito: eram o mesmo regex, e
 * confundir os dois é o que impede a correção abaixo.
 */
export const PASSADO_RE =
  /(?<!\p{L})(semana passada|m[êe]s passado|ano passado|ontem|anteontem|passad[oa]|j[áa] tive|tinha tido|ele teve|ela teve|costumo ter|as vezes tenho|[àa]s vezes tenho)(?!\p{L})/iu;

/** TERCEIRA PESSOA — motivo que DEIXA de valer quando existe vínculo de cuidado. */
export const TERCEIRO_RE =
  /(?<!\p{L})(minha m[ãa]e|meu pai|minha av[óo]|meu av[ôo]|minha filha|meu filho|minha esposa|meu marido|um amigo|uma amiga)(?!\p{L})/iu;

/**
 * A emergência é sobre alguém de quem ele cuida?
 *
 * ─── O QUE ISTO CORRIGE ───────────────────────────────────────────────────────
 * Hoje `"minha mãe está com dor no peito"` NÃO aciona a orientação do SAMU: a guarda de
 * terceira pessoa suprime a preempção inteira. Está certo num mundo em que um telefone é
 * uma pessoa — a Xarlote não tem como saber de quem se fala nem o que fazer a respeito.
 *
 * Com vínculo, essa mesma linha vira silêncio sobre um infarto: quem escreveu está do
 * lado dela, e precisa ouvir 192 agora.
 *
 * Devolve o vínculo SÓ quando a resolução é inequívoca. Ambíguo não escala em nome de
 * ninguém — mas o chamador ainda deve orientar, porque a orientação de emergência é o
 * que salva, e ela não depende de saber em qual prontuário anotar.
 */
export function emergenciaSobreQuemCuido(
  texto: string,
  ator: { userId: string; nome: string | null },
  vinculos: readonly CareLinkView[],
): CareLinkView | null {
  const t = (texto ?? '').trim();
  if (!t || vinculos.length === 0) return null;
  if (PASSADO_RE.test(t)) return null;

  const m = TERCEIRO_RE.exec(foldPt(t)) ?? TERCEIRO_RE.exec(t);
  if (!m) return null;

  const r = resolverSujeito(m[0], ator, vinculos);
  return r.kind === 'vinculo' ? r.link : null;
}
