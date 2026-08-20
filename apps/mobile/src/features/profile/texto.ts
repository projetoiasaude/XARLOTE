/**
 * Dobrar texto para BUSCAR e COMPARAR — sem `Intl` e sem `String.normalize`.
 *
 * ## Por que um mapa na mão em vez de `normalize('NFD')`
 *
 * O jeito canônico de tirar acento em JS é `s.normalize('NFD').replace(/\p{M}/gu,'')`.
 * Ele depende de duas coisas que este app não pode assumir de graça: a tabela de
 * normalização Unicode no Hermes e o suporte a `\p{...}` no regex do motor. O mesmo
 * raciocínio que manteve `Intl` fora de `br-format.ts` vale aqui — e a lição da casa é
 * que a receita padrão de uma ferramenta pode ser exatamente a errada na sua.
 *
 * O custo de escrever à mão é uma tabela de 30 linhas; o benefício é uma função pura,
 * determinística, testável no vitest e idêntica em todo aparelho. A busca da tela de
 * Perfil é sobre PT-BR: as letras abaixo cobrem o idioma inteiro.
 *
 * Comparar nome dobrado também é o que decide se a Xarlote confirmou o apelido pedido:
 * pedir "Márcia" e ela salvar "marcia" é a MESMA pessoa, e a tela não pode ficar
 * eternamente "esperando confirmação" por causa de um acento.
 */

const ACENTOS: Record<string, string> = {
  á: 'a', à: 'a', ã: 'a', â: 'a', ä: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', õ: 'o', ô: 'o', ö: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ç: 'c', ñ: 'n', ý: 'y',
};

/** Espaços múltiplos, quebras de linha e tabs viram UM espaço; sobra nas pontas cai. */
export function colapsarEspacos(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Minúsculas, sem acento, espaços colapsados. Serve pra comparar e pra buscar —
 * NUNCA pra exibir: o que o paciente escreveu é o que ele lê de volta.
 */
export function dobrar(s: string): string {
  let saida = '';
  for (const ch of colapsarEspacos(s).toLowerCase()) {
    saida += ACENTOS[ch] ?? ch;
  }
  return saida;
}

/**
 * Corta um texto num teto de caracteres sem partir palavra no meio, e **avisa** que
 * cortou (com "…"). Existe porque texto de anotação vai dentro de uma mensagem com
 * limite de 4000 no servidor — e um corte silencioso mudaria o sentido do que o
 * paciente está corrigindo.
 */
export function limitar(s: string, teto: number): string {
  const limpo = colapsarEspacos(s);
  if (limpo.length <= teto) return limpo;
  const bruto = limpo.slice(0, teto);
  const ultimoEspaco = bruto.lastIndexOf(' ');
  // Só respeita a fronteira de palavra se ela não jogar fora metade do texto.
  const base = ultimoEspaco > teto * 0.6 ? bruto.slice(0, ultimoEspaco) : bruto;
  return `${base.trimEnd()}…`;
}
