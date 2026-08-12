/**
 * `ehTextoCru(x)` — este nó precisa ser embrulhado num `<Text>`?
 *
 * ## O bug que criou este arquivo
 *
 * Os primitivos decidiam com `typeof children === 'string'`. Passar um NÚMERO — como a
 * contagem de lembretes atrasados, `{grupo.lembretes.length}` — caía no ramo "já é
 * elemento React" e o número ia cru pra dentro de um `<View>`:
 *
 *     Text strings must be rendered within a <Text> component
 *
 * No aparelho, em 12/08: a badge de "Passou da hora" apareceu como um círculo VAZIO e o
 * app soltou o erro em vermelho no rodapé. Em release isso não é um aviso — é uma tela
 * que não renderiza.
 *
 * `Stat` já fazia certo (`typeof value === 'string' || typeof value === 'number'`), o que
 * mostra que o padrão correto era conhecido e apenas não foi aplicado nos outros cinco.
 * Uma função só, usada por todos, é o que impede o sexto de nascer errado.
 *
 * `0` e `''` **contam como texto** de propósito: `if (children)` seria falso pros dois, e
 * uma contagem legítima de zero desapareceria da tela sem explicação.
 */
import type { ReactNode } from 'react';

export function ehTextoCru(no: ReactNode): no is string | number {
  return typeof no === 'string' || typeof no === 'number';
}
