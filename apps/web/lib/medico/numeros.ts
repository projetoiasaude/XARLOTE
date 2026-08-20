/**
 * Números e faixas de referência de laudo — lidos, não adivinhados.
 *
 * ## De onde vem essa string
 *
 * O paciente fotografa o laudo, um modelo de visão lê, e o valor é gravado como TEXTO. O
 * que chega, de verdade: `"13,5"`, `"7.200"`, `"13.5 g/dL"`, `"<0,01"`, `"120/80"`,
 * `"Não reagente"`. A faixa de referência vem igualmente crua: `"12-16"`, `"até 100"`,
 * `"< 200"`, `"Homens: 13-17 Mulheres: 12-16"`.
 *
 * ## A regra que governa este arquivo
 *
 * **Na dúvida, `null`.** Um número errado num gráfico que um médico lê em 90 segundos é
 * pior que um gráfico que não existe: a ausência ele percebe, o erro ele não. Então toda
 * função aqui devolve `null` para o que não consegue ler com certeza, e a tela mostra o
 * texto original — que é o que o laudo dizia.
 *
 * ## E o que este arquivo NÃO faz
 *
 * Comparar um valor com a faixa **impressa no próprio laudo** é aritmética, e é isso que
 * `situacao()` faz. Não é interpretação clínica, não decide se está "alterado", e não
 * inventa faixa nossa quando o laudo não trouxe uma. A tela rotula o resultado como
 * "fora da faixa do laudo", nunca como "alterado".
 *
 * PURO e sem dependência: só imports relativos, para que o teste em /tests alcance.
 */

/** Acentos fora, minúsculas, espaço colapsado — a forma em que se compara texto. */
export function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Um número dentro da string, na notação em que os laudos brasileiros vêm. */
const TOKEN_NUM = /\d[\d.,]*/;

/**
 * `"13,5"` → 13.5 · `"7.200"` → 7200 · `"1.234,56"` → 1234.56 · `"13.5"` → 13.5
 *
 * ## A ambiguidade real, e como ela é resolvida
 *
 * `7.200` é sete mil e duzentos (leucócitos) ou sete vírgula dois? Depende de quem
 * escreveu, e quem escreveu foi um modelo lendo uma foto. A regra:
 *
 * 1. **Tem vírgula** → a vírgula é o decimal e todo ponto é milhar. `1.234,56` = 1234,56.
 * 2. **Sem vírgula, e os pontos formam agrupamento válido** (`\d{1,3}(.\d{3})+`, sem zero
 *    à frente) → milhar. `7.200` = 7200, `1.234.567` = 1234567. Agrupamento no Brasil tem
 *    exatamente 3 casas; valor de laudo com 3 casas DECIMAIS é raro o bastante para perder
 *    essa aposta. `0.850` está fora da regra (ninguém escreve 850 assim) e vira 0,85.
 * 3. **Qualquer outro ponto único** → decimal. `13.5`, `13.55`, `0.850`.
 * 4. **O que não fecha em `\d+(.\d+)?` depois de limpo** → `null`. `12.5.3` não é número.
 *
 * Devolve `null`, de propósito, para:
 * · **valor censurado** (`"<0,01"`, `"> 200"`) — é um limite de detecção, não uma medida;
 *   plotar como ponto finge precisão que o laudo recusou dar. A tabela mostra o texto.
 * · **valor composto** (`"120/80"`) — pressão arterial não é UM número. Cortar no primeiro
 *   daria 120 e jogaria fora a metade que muda a conduta.
 * · **texto** (`"Não reagente"`) — não há o que plotar.
 */
export function numeroBr(bruto: string | null | undefined): number | null {
  if (!bruto) return null;
  const s = bruto.trim();
  if (!s) return null;

  // Censurado: qualquer operador de comparação antes do número.
  if (/[<>≤≥]/.test(s)) return null;

  const m = TOKEN_NUM.exec(s);
  if (!m) return null;
  const token = m[0];

  // Composto (`120/80`, `1/2`): o que vem depois da barra é o resto do MESMO dado.
  const resto = s.slice(m.index + token.length);
  if (/^\s*[/x×]\s*\d/i.test(resto)) return null;

  /** Agrupamento de milhar brasileiro: 1 a 3 dígitos e depois blocos de exatamente 3. */
  const MILHAR = /^\d{1,3}(?:\.\d{3})+$/;

  let limpo: string;
  if (token.includes(',')) {
    const partes = token.split(',');
    // Duas vírgulas (`1,234,567` — notação americana) é ambíguo demais para ler.
    if (partes.length !== 2) return null;
    const inteiro = partes[0]!;
    if (inteiro.includes('.') && !MILHAR.test(inteiro)) return null;
    limpo = `${inteiro.replace(/\./g, '')}.${partes[1]}`;
  } else if (MILHAR.test(token) && !token.startsWith('0')) {
    limpo = token.replace(/\./g, '');
  } else {
    limpo = token;
  }

  // O veredicto final: se não fecha em número simples, não é número. `12.5.3` cai aqui.
  if (!/^\d+(?:\.\d+)?$/.test(limpo)) return null;

  const n = Number(limpo);
  if (!Number.isFinite(n)) return null;
  // Sinal negativo do texto original (`-1,5`), que o token não capturou.
  return /-\s*$/.test(s.slice(0, m.index)) ? -n : n;
}

export type Referencia =
  | { tipo: 'faixa'; min: number; max: number }
  | { tipo: 'max'; max: number }
  | { tipo: 'min'; min: number };

/** Rótulos que os laudos põem antes da faixa e que não fazem parte dela. */
const PREFIXOS = [
  /^(?:valores?\s+de\s+referencia|valor\s+de\s+referencia|referencia|refer|ref|vr|v\.r|normal|desejavel|esperado)\s*[:=]?\s*/,
];

/**
 * `"12-16"` → faixa · `"até 100"` → max · `"maior que 40"` → min · resto → `null`.
 *
 * O casamento é **ancorado no início** da string (depois de tirar o rótulo). É o que
 * separa `"0-100 mL/min/1.73m²"`, que é legível, de `"Homens: 13-17 Mulheres: 12-16"`,
 * que não é: escolher um dos dois pares seria adivinhar o sexo do paciente a partir de um
 * dado que este link não carrega — então devolve `null`, e a tela mostra a faixa como
 * texto, do jeito que o laudo trouxe.
 *
 * Também devolve `null` para um número solto (`"16"`): sem operador, não se sabe se é
 * teto, piso ou alvo.
 */
export function lerReferencia(bruto: string | null | undefined): Referencia | null {
  if (!bruto) return null;
  let s = normalizarTexto(bruto).replace(/[–—]/g, '-');
  for (const p of PREFIXOS) s = s.replace(p, '');
  s = s.trim();
  if (!s) return null;

  // Faixa: `12-16`, `12 a 16`, `12,0 até 16,0`, `0 to 100`.
  const faixa = /^(\d[\d.,]*)\s*(?:-|\bate\b|\ba\b|\bto\b)\s*(\d[\d.,]*)/.exec(s);
  if (faixa) {
    const min = numeroBr(faixa[1]);
    const max = numeroBr(faixa[2]);
    if (min !== null && max !== null && min <= max) return { tipo: 'faixa', min, max };
    return null;
  }

  const teto = /^(?:<=?|≤|\bate\b|\bmenor\s+(?:que|de)\b|\binferior\s+a\b|\babaixo\s+de\b)\s*(\d[\d.,]*)/.exec(s);
  if (teto) {
    const max = numeroBr(teto[1]);
    return max === null ? null : { tipo: 'max', max };
  }

  const piso = /^(?:>=?|≥|\bmaior\s+(?:que|de)\b|\bsuperior\s+a\b|\bacima\s+de\b)\s*(\d[\d.,]*)/.exec(s);
  if (piso) {
    const min = numeroBr(piso[1]);
    return min === null ? null : { tipo: 'min', min };
  }

  return null;
}

export type Situacao = 'dentro' | 'acima' | 'abaixo' | 'indefinido';

/**
 * O valor cabe na faixa que o laudo imprimiu?
 *
 * Aritmética, não diagnóstico. `'indefinido'` quando falta o número ou falta a faixa — e
 * `'indefinido'` não desenha nada na tela: silêncio é melhor que um selo verde falso.
 */
export function situacao(valor: number | null, ref: Referencia | null): Situacao {
  if (valor === null || !ref) return 'indefinido';
  if (ref.tipo === 'faixa') {
    if (valor < ref.min) return 'abaixo';
    if (valor > ref.max) return 'acima';
    return 'dentro';
  }
  if (ref.tipo === 'max') return valor > ref.max ? 'acima' : 'dentro';
  return valor < ref.min ? 'abaixo' : 'dentro';
}

/**
 * Número → texto em pt-BR, com as casas decimais que o valor realmente tem.
 *
 * Sem `Intl`: o eixo do gráfico e a tabela precisam do mesmo resultado no servidor e no
 * navegador do médico, e `Intl` varia com o locale de quem abre. `7200` fica `7.200` e
 * `13.5` fica `13,5` — a forma que um laudo brasileiro usa.
 */
export function numeroTexto(n: number, casas?: number): string {
  // Até 3 casas, e não 2: `0,001` arredondado para `0,00` mostraria zero onde havia
  // medida — e num valor de laudo isso é informação errada, não formatação feia.
  const c = casas ?? (Number.isInteger(n) ? 0 : Math.min(3, (String(n).split('.')[1] ?? '').length));
  const fixo = Math.abs(n).toFixed(c);
  const [inteiro, dec] = fixo.split('.');
  const agrupado = inteiro!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${agrupado}${dec ? `,${dec}` : ''}`;
}
