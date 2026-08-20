/**
 * A regra de abertura da `CollapsibleSection` — separada do componente porque ela é uma
 * REGRA, e regra tem que poder ser executada num teste.
 *
 * ## O defeito que ela existe pra impedir
 *
 * A primeira versão lia `defaultOpen` uma vez só, no inicializador do `useState`. Isso
 * é invisível no simulador (onde o dado já está em cache) e fatal na rua: a tela Saúde
 * monta "Alergias" com `count` 0 porque a consulta ainda não voltou. Congelada fechada,
 * ela ficava fechada PARA SEMPRE — inclusive depois de a própria paciente registrar a
 * primeira alergia pelo botão "+ Contar" da mesma tela, um toque acima. E o `emptyHint`
 * sumia junto, porque ele só existe enquanto `vazia`: sobrava a linha "Alergias · 1" e
 * nada embaixo dela.
 *
 * ## A regra, em uma frase
 *
 * **Enquanto ninguém tocou, a abertura é derivada do dado de AGORA; a partir do primeiro
 * toque, quem manda é a pessoa.** Dado que chega depois não tem direito de desfazer uma
 * escolha feita com o dedo.
 */

export interface EstadoDaSecao {
  /** A pessoa já tocou no cabeçalho desta seção nesta montagem? */
  tocou: boolean;
  /** O que ela escolheu no último toque. Só tem significado quando `tocou`. */
  manual: boolean;
  /** O que a TELA pediu ao montar a seção. */
  defaultOpen: boolean;
  /**
   * Zero CONTADO (`count === 0`).
   *
   * `count === null` significa "não deu pra contar" e NÃO é vazio: a seção passa a se
   * comportar como cheia, porque afirmar que o banco está vazio sem ter contado é a
   * mesma mentira que a seção que some.
   */
  vazia: boolean;
}

export function secaoAberta({ tocou, manual, defaultOpen, vazia }: EstadoDaSecao): boolean {
  // A escolha da pessoa vence qualquer dado que chegue depois. Sempre.
  if (tocou) return manual;
  // Vazia nasce fechada mesmo com `defaultOpen`: o `emptyHint` é uma linha só, e abrir
  // espaço pra uma linha empurra pra baixo o que a tela veio responder.
  return defaultOpen && !vazia;
}
