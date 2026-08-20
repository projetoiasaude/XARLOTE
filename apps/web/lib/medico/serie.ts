/**
 * Série temporal de um marcador, e a geometria do gráfico — SVG puro, sem biblioteca.
 *
 * ## Por que gráfico, e por que sem biblioteca
 *
 * Um médico lê tendência de glicemia num traço, não em três linhas de texto. Mas ele abre
 * esta página na rede do consultório, às vezes no 4G do celular, e uma biblioteca de
 * gráficos custa de 40 a 200 KB de JavaScript para desenhar seis polilinhas. Então a
 * geometria é calculada aqui, em funções puras, e a tela imprime `<svg>` — zero KB de
 * dependência, e testável sem navegador.
 *
 * ## O gráfico é a SEGUNDA leitura
 *
 * Todo número plotado aparece também na tabela do exame. Isso não é redundância: é a regra
 * de acessibilidade que faz a página funcionar em leitor de tela, em impressão preto-e-branco
 * e para quem não distingue as cores. Nenhum dado existe só no gráfico.
 *
 * ## Só existe série com 2 pontos ou mais
 *
 * Um ponto não é tendência — é um valor, e a tabela já o mostra melhor. Exame sem data
 * também não entra: sem eixo x não há como posicionar, e chutar a ordem inverteria uma
 * tendência de piora em melhora. Fica na tabela, como veio.
 */
import { dataBr } from '../br-data';
import { lerReferencia, numeroBr, numeroTexto, normalizarTexto, situacao, type Referencia, type Situacao } from './numeros';
import type { Exame } from './resumo';

export interface PontoSerie {
  /** Instante do exame, para posicionar no eixo x. */
  ms: number;
  /** A data como veio (coluna DATE), para a tela formatar com `dataBr`. */
  data: string;
  valor: number;
  /** Comparação com a faixa DESTE laudo — não com a faixa do gráfico. */
  situacao: Situacao;
}

export interface Serie {
  /** Nome normalizado — a chave que junta "Hemoglobina" e "hemoglobina". */
  chave: string;
  /** Grafia a mostrar: a do exame mais recente. */
  marcador: string;
  unidade: string | null;
  /** Faixa comum a todos os pontos, ou `null` quando os laudos discordam. */
  referencia: Referencia | null;
  referenciaTexto: string | null;
  pontos: PontoSerie[];
  foraDaFaixa: number;
}

/** `YYYY-MM-DD` → ms em UTC. Sem fuso: coluna DATE não tem hora para converter. */
function msDaData(data: string): number | null {
  const puro = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (puro) return Date.UTC(Number(puro[1]), Number(puro[2]) - 1, Number(puro[3]));
  const ms = Date.parse(data);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A unidade reduzida a uma chave de comparação.
 *
 * Tolerante só nas variações **tipográficas** que não mudam a grandeza — `mm³`/`mm3`,
 * `µL`/`uL`, espaço e ponto sobrando. `mil/mm3` continua diferente de `mm3`, que é
 * justamente o caso que precisa ser detectado.
 */
function chaveUnidade(u: string): string {
  return normalizarTexto(u)
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/[µμ]/g, 'u')
    .replace(/[\s.]/g, '');
}

/** Duas referências são a mesma faixa? (para decidir se a banda pode ser desenhada) */
function mesmaReferencia(a: Referencia, b: Referencia): boolean {
  if (a.tipo !== b.tipo) return false;
  if (a.tipo === 'faixa' && b.tipo === 'faixa') return a.min === b.min && a.max === b.max;
  if (a.tipo === 'max' && b.tipo === 'max') return a.max === b.max;
  if (a.tipo === 'min' && b.tipo === 'min') return a.min === b.min;
  return false;
}

/** Quantos gráficos a tela desenha. Acima disso é parede, não informação. */
export const MAX_SERIES = 6;

/**
 * Os exames do resumo → as séries que valem um traço.
 *
 * `total` é o número de marcadores com histórico ANTES do corte, porque a tela precisa
 * dizer quantos ficaram fora. Corte silencioso ensina que a página não guarda o resto.
 *
 * A ordem prioriza o que pede atenção: primeiro os marcadores com algum ponto fora da
 * faixa do próprio laudo, depois os com mais pontos (mais história), depois alfabético.
 * Um médico com 90 segundos deve encontrar o gráfico que importa no primeiro.
 */
export function seriesDosExames(exames: Exame[], max: number = MAX_SERIES): { series: Serie[]; total: number } {
  const grupos = new Map<
    string,
    {
      marcador: string;
      unidade: string | null;
      /** Todas as unidades vistas, em chave de comparação — ver o corte lá embaixo. */
      unidades: Set<string>;
      refTexto: string | null;
      refs: Referencia[];
      pontos: PontoSerie[];
    }
  >();

  // Do mais ANTIGO para o mais recente, para que a última grafia/unidade vista seja a atual.
  const ordenados = [...exames]
    .map((e) => ({ e, ms: e.data ? msDaData(e.data) : null }))
    .filter((x): x is { e: Exame; ms: number } => x.ms !== null)
    .sort((a, b) => a.ms - b.ms);

  for (const { e, ms } of ordenados) {
    for (const v of e.valores) {
      const valor = numeroBr(v.valor);
      if (valor === null) continue; // texto, censurado ou composto: fica só na tabela
      const chave = normalizarTexto(v.marcador);
      if (!chave) continue;

      const ref = lerReferencia(v.referencia);
      const g =
        grupos.get(chave) ??
        { marcador: v.marcador, unidade: null, unidades: new Set<string>(), refTexto: null, refs: [], pontos: [] };
      g.marcador = v.marcador;
      if (v.unidade) {
        g.unidade = v.unidade;
        const u = chaveUnidade(v.unidade);
        if (u) g.unidades.add(u);
      }
      if (v.referencia) g.refTexto = v.referencia;
      if (ref) g.refs.push(ref);
      g.pontos.push({ ms, data: e.data!, valor, situacao: situacao(valor, ref) });
      grupos.set(chave, g);
    }
  }

  const series: Serie[] = [];
  // `Array.from` em vez de iterar o Map direto: o tsconfig deste app não fixa `target`,
  // então o tsc assume ES5 e recusa `for...of` sobre Map (TS2802). O Next transpila com
  // SWC para browsers reais, então isto é só para o typecheck passar sem ligar
  // `downlevelIteration` no projeto inteiro.
  for (const [chave, g] of Array.from(grupos.entries())) {
    if (g.pontos.length < 2) continue;
    // Unidades diferentes no mesmo marcador NÃO formam uma curva.
    //
    // Caso brasileiro corriqueiro: o laboratório A reporta leucócitos como `7.200` (/mm³) e
    // o B como `7,2` (mil/mm³). Os dois parseiam, e o traço desenha um despencar de 7200
    // para 7,2 com um `↓ 7.192,8` no cabeçalho. O médico lê inclinação — que é a única
    // razão de o gráfico existir — e a inclinação é da unidade, não do paciente.
    //
    // A banda de referência já tinha essa guarda (`mesmaReferencia`, logo abaixo); a
    // unidade não tinha. Os valores continuam na tabela do exame, cada um com a unidade do
    // SEU laudo, que é onde eles são verdadeiros. Regra do módulo, em `numeros.ts`: na
    // dúvida, nada — um número errado num gráfico lido em 90 segundos é pior que ausência.
    if (g.unidades.size > 1) continue;
    // Banda só quando TODOS os laudos que trouxeram faixa trouxeram a MESMA. Laboratórios
    // com faixas diferentes desenhariam uma banda que não vale para metade dos pontos.
    const refComum = g.refs.length > 0 && g.refs.every((r) => mesmaReferencia(r, g.refs[0]!)) ? g.refs[0]! : null;
    series.push({
      chave,
      marcador: g.marcador,
      unidade: g.unidade,
      referencia: refComum,
      referenciaTexto: g.refTexto,
      pontos: g.pontos,
      foraDaFaixa: g.pontos.filter((p) => p.situacao === 'acima' || p.situacao === 'abaixo').length,
    });
  }

  series.sort((a, b) => {
    const fora = (b.foraDaFaixa > 0 ? 1 : 0) - (a.foraDaFaixa > 0 ? 1 : 0);
    if (fora !== 0) return fora;
    if (b.pontos.length !== a.pontos.length) return b.pontos.length - a.pontos.length;
    return a.marcador.localeCompare(b.marcador, 'pt-BR');
  });

  return { series: series.slice(0, max), total: series.length };
}

// ─── Geometria ─────────────────────────────────────────────────────────────────

export interface Caixa {
  largura: number;
  altura: number;
  /** Folga para o rótulo do eixo y (esquerda) e para os pontos não serem cortados. */
  pad: { topo: number; base: number; esq: number; dir: number };
}

/**
 * Tamanho dos `<text>` do gráfico, em unidades do `viewBox`.
 *
 * Mora aqui, e não no componente, porque **não é escolha de estilo — é um piso medido**.
 * O `viewBox` de 320 é escalado pela largura do cartão: num Android de 360px o SVG desenha
 * com ~296px (360 − 32 do `px-4` da página − 32 do `p-4` da figure), fator 0,925. Um
 * `fontSize` de 10 no desenho vira **9,25px reais** na mão do médico — e o que está nesse
 * tamanho é valor de laudo e data de exame, que a régua trata como dado clínico. 13 no
 * desenho dá 12,0px nesse pior caso, 13,2 num iPhone de 390 e ~15,7 no desktop em duas
 * colunas. O teste de `share-medico` guarda esse número; mexer nele sem mexer no teste é
 * baixar a legibilidade de um médico de 45–60 anos lendo na luz do consultório.
 */
export const FONTE_EIXO = 13;

/**
 * A caixa é dimensionada pelo TEXTO, não pelo traço.
 *
 * `pad.esq` guarda o rótulo do eixo y (48px úteis, que seguram `1.234,5` em 13) e
 * `pad.base` guarda a linha das datas. Aumentar `FONTE_EIXO` sem abrir a caixa junto
 * empurra o texto por cima do traço.
 */
export const CAIXA_PADRAO: Caixa = { largura: 320, altura: 118, pad: { topo: 12, base: 28, esq: 54, dir: 10 } };

export interface Geometria {
  pontos: Array<{ x: number; y: number; p: PontoSerie }>;
  /** `points` da polilinha. */
  linha: string;
  /** `d` do preenchimento sob a linha — só estética, e some na impressão. */
  area: string;
  /** Banda da faixa de referência em coordenadas de tela, ou `null`. */
  faixa: { y: number; altura: number } | null;
  grade: Array<{ y: number; rotulo: string }>;
  dominio: { min: number; max: number };
}

/**
 * A série → coordenadas. O eixo x é o TEMPO, não a posição na lista.
 *
 * Espaçar por índice desenharia como regulares dois exames separados por seis meses e um
 * de ontem — e a inclinação da reta é justamente o que o médico lê. Quando todos os pontos
 * caem no mesmo dia (span zero), aí sim o índice é o único eixo possível.
 */
export function geometria(s: Serie, caixa: Caixa = CAIXA_PADRAO): Geometria {
  const { largura, altura, pad } = caixa;
  const x0 = pad.esq;
  const x1 = largura - pad.dir;
  const y0 = pad.topo;
  const y1 = altura - pad.base;

  const valores = s.pontos.map((p) => p.valor);
  let vMin = Math.min(...valores);
  let vMax = Math.max(...valores);

  // A banda entra no domínio para caber na tela: uma faixa fora do enquadramento não
  // informa nada, e o ponto "acima da referência" perderia a régua contra a qual está alto.
  if (s.referencia) {
    if (s.referencia.tipo === 'faixa') {
      vMin = Math.min(vMin, s.referencia.min);
      vMax = Math.max(vMax, s.referencia.max);
    } else if (s.referencia.tipo === 'max') {
      vMax = Math.max(vMax, s.referencia.max);
    } else {
      vMin = Math.min(vMin, s.referencia.min);
    }
  }

  const span = vMax - vMin;
  // Todos iguais: abre uma janela artificial para a linha não colar na borda.
  const folga = span > 0 ? span * 0.12 : Math.max(Math.abs(vMax) * 0.1, 1);
  const dMin = vMin - folga;
  const dMax = vMax + folga;
  const dSpan = dMax - dMin || 1;

  const paraY = (v: number) => y1 - ((v - dMin) / dSpan) * (y1 - y0);

  const tMin = Math.min(...s.pontos.map((p) => p.ms));
  const tMax = Math.max(...s.pontos.map((p) => p.ms));
  const tSpan = tMax - tMin;
  const paraX = (ms: number, i: number) =>
    tSpan > 0
      ? x0 + ((ms - tMin) / tSpan) * (x1 - x0)
      : x0 + (s.pontos.length > 1 ? (i / (s.pontos.length - 1)) * (x1 - x0) : (x1 - x0) / 2);

  const pontos = s.pontos.map((p, i) => ({ x: paraX(p.ms, i), y: paraY(p.valor), p }));
  const linha = pontos.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area =
    pontos.length > 0
      ? `M${pontos[0]!.x.toFixed(1)},${y1} ${pontos.map((c) => `L${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')} L${pontos[pontos.length - 1]!.x.toFixed(1)},${y1} Z`
      : '';

  let faixa: Geometria['faixa'] = null;
  if (s.referencia) {
    const topo = s.referencia.tipo === 'min' ? dMax : s.referencia.tipo === 'max' ? s.referencia.max : s.referencia.max;
    const base = s.referencia.tipo === 'max' ? dMin : s.referencia.tipo === 'min' ? s.referencia.min : s.referencia.min;
    const yTopo = paraY(Math.min(topo, dMax));
    const yBase = paraY(Math.max(base, dMin));
    faixa = { y: yTopo, altura: Math.max(1, yBase - yTopo) };
  }

  const casas = dSpan >= 100 ? 0 : dSpan >= 10 ? 1 : 2;
  const grade = [dMax, (dMax + dMin) / 2, dMin].map((v) => ({ y: paraY(v), rotulo: numeroTexto(v, casas) }));

  return { pontos, linha, area, faixa, grade, dominio: { min: dMin, max: dMax } };
}

// ─── Leitura em palavras ───────────────────────────────────────────────────────

export interface Tendencia {
  direcao: 'subiu' | 'caiu' | 'estavel';
  delta: number;
  /** Variação percentual sobre o primeiro valor, ou `null` se o primeiro é zero. */
  percentual: number | null;
}

/** Do primeiro ao último ponto. Sem regressão: dois pontos não têm reta para ajustar. */
export function tendencia(s: Serie): Tendencia | null {
  if (s.pontos.length < 2) return null;
  const a = s.pontos[0]!.valor;
  const b = s.pontos[s.pontos.length - 1]!.valor;
  const delta = b - a;
  // 0,5% de diferença é ruído de leitura de foto, não movimento clínico.
  const direcao = Math.abs(delta) < Math.abs(a) * 0.005 ? 'estavel' : delta > 0 ? 'subiu' : 'caiu';
  return { direcao, delta, percentual: a === 0 ? null : (delta / Math.abs(a)) * 100 };
}

/**
 * A série em uma frase — o `aria-label` do `<svg>`.
 *
 * Sem isto o gráfico é um retângulo vazio para leitor de tela. Com isto, todo dado do
 * traço está disponível em texto, que é o requisito real de acessibilidade — o `role="img"`
 * sozinho apenas silencia o elemento.
 */
export function descricaoSerie(s: Serie): string {
  const partes = s.pontos.map((p) => `${numeroTexto(p.valor)} em ${dataBr(p.data)}`);
  const unidade = s.unidade ? ` (${s.unidade})` : '';
  const ref = s.referenciaTexto ? ` Faixa do laudo: ${s.referenciaTexto}.` : '';
  return `${s.marcador}${unidade}: ${partes.join('; ')}.${ref}`;
}
