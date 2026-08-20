/**
 * O resumo congelado, lido com desconfiança — e a triagem que decide o que salta primeiro.
 *
 * ## Por que um leitor tolerante, e não um `as Resumo`
 *
 * O resumo é gravado em `summary_cache` no instante em que o paciente cria o link, e nunca
 * reescrito. Isso significa que **links vivos hoje foram congelados por versões antigas do
 * formato**: sem `valores`, sem `versao`, e alguns com campos que o formato já não usa. Um
 * `corpo.resumo as Resumo` seguido de `.alergias.map()` não é uma conversão — é uma aposta
 * de que o campo existe, e ela é perdida na tela branca do navegador do consultório, com o
 * paciente ao lado. Campo que o formato não tem mais é simplesmente ignorado na leitura.
 *
 * Então aqui todo campo é checado, todo ausente tem um padrão, e nada lança. É a mesma
 * postura do parser de entrada do zpro: ler o que veio, ignorar o que não entende.
 *
 * ## A triagem
 *
 * O médico tem 90 segundos. `triagem()` responde "tem algo aqui que muda a conduta AGORA?"
 * antes de qualquer rolagem — e o que muda conduta, neste conjunto de dados, é alergia.
 *
 * A distinção que a tela precisa fazer, e que quase toda ficha eletrônica erra: **"nenhuma
 * alergia registrada" não é "o paciente nega alergias"**. A primeira é ausência de dado; a
 * segunda é anamnese. Confundi-las é como um resumo clínico causa dano — então `triagem()`
 * devolve um nível `neutro` com texto explícito, e nunca um "sem alergias" tranquilizador.
 *
 * PURO: `nowMs` é injetado, imports só relativos (o teste em /tests importa por caminho).
 */
import { normalizarTexto } from './numeros';

// ─── O formato, do jeito que a página usa ──────────────────────────────────────

export type Gravidade = 'grave' | 'moderada' | 'leve' | 'desconhecida';

export interface Alergia {
  substancia: string;
  reacao: string | null;
  /** O que o laudo/paciente escreveu, preservado — `"anafilaxia"` diz mais que `"grave"`. */
  gravidadeBruta: string | null;
  gravidade: Gravidade;
}

export interface ValorExame {
  marcador: string;
  valor: string;
  unidade: string | null;
  referencia: string | null;
}

export interface Exame {
  tipo: string;
  data: string | null;
  resumo: string | null;
  valores: ValorExame[];
  valoresOmitidos: number;
}

export interface ResumoMedico {
  versao: number;
  geradoEm: string;
  paciente: { nome: string | null; idade: number | null };
  alergias: Alergia[];
  medicamentos: Array<{ nome: string; dosagem: string | null; frequencia: string | null }>;
  condicoes: Array<{ nome: string; desde: string | null }>;
  exames: Exame[];
  adesao30d: number | null;
}

// ─── Leitura ───────────────────────────────────────────────────────────────────

function texto(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t || null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function lista(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !Array.isArray(i));
}

/**
 * `"grave"`, `"anafilaxia"`, `"severe"`, `"alta"` → `'grave'`.
 *
 * Anafilaxia entra como grave mesmo sem a palavra: é a reação que mata, e um resumo que a
 * classificasse como "sem gravidade informada" seria pior que não ter o campo. Casamento
 * por substring porque o texto é livre — vem do paciente conversando e do modelo.
 */
export function normalizarGravidade(bruto: string | null | undefined): Gravidade {
  if (!bruto) return 'desconhecida';
  const s = normalizarTexto(bruto);
  if (!s) return 'desconhecida';
  if (/anafila|choque|grave|sever|alta|high|serious|risco de vida/.test(s)) return 'grave';
  if (/moderad|medi[ao]|medium|intermediari/.test(s)) return 'moderada';
  if (/leve|mild|baixa|low|discret/.test(s)) return 'leve';
  return 'desconhecida';
}

/**
 * A gravidade final da alergia: o campo `gravidade` **ou** a reação, o que for pior.
 *
 * As duas vias de escrita deixam `severity` nulo com folga. O `tool-executor` extrai
 * `pick(['severity','reaction'])` — o modelo pode mandar só a reação — e o enricher grava
 * `severity: a.severity ?? null` sem nunca escrever reação nenhuma. Um paciente que disse
 * *"sou alérgico a dipirona, tive choque anafilático"* chega aqui como
 * `{substancia:'Dipirona', reacao:'choque anafilático', gravidade:null}`. Ler só o campo
 * `gravidade` classificaria isso como `desconhecida` e pintaria a faixa de ÂMBAR, com a
 * palavra que muda a conduta em cinza dentro de um chip.
 *
 * A reação só sabe **subir** para `grave`, nunca baixar. Rebaixar por reação ("coceira
 * leve") desmontaria a regra deliberada de `PESO_GRAVIDADE`, em que `desconhecida` pesa
 * mais que `leve`: um campo `gravidade` vazio com uma reação branda continua sendo
 * gravidade não confirmada, não uma alergia leve.
 */
export function gravidadeDe(gravidadeBruta: string | null, reacao: string | null): Gravidade {
  const doCampo = normalizarGravidade(gravidadeBruta);
  return normalizarGravidade(reacao) === 'grave' ? 'grave' : doCampo;
}

/** Grave primeiro; `desconhecida` ANTES de leve — ver `PESO_GRAVIDADE`. */
export const PESO_GRAVIDADE: Record<Gravidade, number> = {
  grave: 0,
  moderada: 1,
  /**
   * Gravidade não informada pesa mais que "leve", e isso é deliberado: uma alergia cuja
   * gravidade ninguém confirmou pode ser anafilática. Empurrá-la para o fim da lista, junto
   * do que se sabe ser leve, seria tratar ausência de informação como boa notícia.
   */
  desconhecida: 2,
  leve: 3,
};

export function ordenarAlergias(as: Alergia[]): Alergia[] {
  return [...as].sort((a, b) => {
    const d = PESO_GRAVIDADE[a.gravidade] - PESO_GRAVIDADE[b.gravidade];
    return d !== 0 ? d : a.substancia.localeCompare(b.substancia, 'pt-BR');
  });
}

/**
 * O corpo que a API devolveu → `ResumoMedico`, ou `null` se não é nem um objeto.
 *
 * `null` só para "isto não é um resumo". Resumo com campos faltando é lido e completado:
 * cada seção vazia é uma seção que a tela mostra como vazia, não uma tela que não abre.
 */
export function lerResumo(bruto: unknown): ResumoMedico | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const r = bruto as Record<string, unknown>;

  const pac = (r['paciente'] && typeof r['paciente'] === 'object' ? r['paciente'] : {}) as Record<string, unknown>;
  const idade = typeof pac['idade'] === 'number' && Number.isFinite(pac['idade']) ? Math.floor(pac['idade']) : null;

  const adesaoBruta = r['adesao_30d'];
  const adesao =
    typeof adesaoBruta === 'number' && Number.isFinite(adesaoBruta) && adesaoBruta >= 0 && adesaoBruta <= 1
      ? adesaoBruta
      : null;

  return {
    versao: typeof r['versao'] === 'number' ? r['versao'] : 1,
    geradoEm: texto(r['gerado_em']) ?? '',
    paciente: { nome: texto(pac['nome']), idade: idade !== null && idade >= 0 && idade < 130 ? idade : null },

    alergias: lista(r['alergias']).flatMap((a) => {
      const substancia = texto(a['substancia']);
      // Alergia sem substância não é dado: é uma linha que assusta e não informa.
      if (!substancia) return [];
      const gravidadeBruta = texto(a['gravidade']);
      const reacao = texto(a['reacao']);
      return [{ substancia, reacao, gravidadeBruta, gravidade: gravidadeDe(gravidadeBruta, reacao) }];
    }),

    medicamentos: lista(r['medicamentos']).flatMap((m) => {
      const nome = texto(m['nome']);
      return nome ? [{ nome, dosagem: texto(m['dosagem']), frequencia: texto(m['frequencia']) }] : [];
    }),

    condicoes: lista(r['condicoes']).flatMap((c) => {
      const nome = texto(c['nome']);
      return nome ? [{ nome, desde: texto(c['desde']) }] : [];
    }),

    exames: lista(r['exames']).flatMap((e) => {
      const tipo = texto(e['tipo']);
      if (!tipo) return [];
      const omitidos = typeof e['valores_omitidos'] === 'number' ? Math.max(0, Math.floor(e['valores_omitidos'])) : 0;
      const valores = lista(e['valores']).flatMap((v) => {
        const marcador = texto(v['marcador']);
        const valor = texto(v['valor']);
        // Marcador sem valor (ou valor sem marcador) não vira linha de tabela.
        if (!marcador || !valor) return [];
        return [{ marcador, valor, unidade: texto(v['unidade']), referencia: texto(v['referencia']) }];
      });
      return [{ tipo, data: texto(e['data']), resumo: texto(e['resumo']), valores, valoresOmitidos: omitidos }];
    }),

    adesao30d: adesao,
  };
}

// ─── Triagem: o que o médico lê antes de rolar ─────────────────────────────────

export interface Triagem {
  nivel: 'critico' | 'atencao' | 'neutro';
  titulo: string;
  detalhe: string;
  /** As alergias graves, para a faixa do topo repetir só o nome — não a ficha toda. */
  criticas: Alergia[];
}

export function triagem(r: ResumoMedico): Triagem {
  const graves = r.alergias.filter((a) => a.gravidade === 'grave');
  if (graves.length > 0) {
    return {
      nivel: 'critico',
      titulo: graves.length === 1 ? 'Alergia grave registrada' : `${graves.length} alergias graves registradas`,
      detalhe: 'Confirme com o paciente antes de prescrever.',
      criticas: ordenarAlergias(graves),
    };
  }
  if (r.alergias.length > 0) {
    const semGravidade = r.alergias.filter((a) => a.gravidade === 'desconhecida').length;
    return {
      nivel: 'atencao',
      titulo: `${r.alergias.length} ${r.alergias.length === 1 ? 'alergia registrada' : 'alergias registradas'}`,
      detalhe:
        semGravidade > 0
          ? `${semGravidade === r.alergias.length ? 'Gravidade' : `Gravidade de ${semGravidade}`} não confirmada — vale checar na consulta.`
          : 'Nenhuma classificada como grave.',
      criticas: ordenarAlergias(r.alergias),
    };
  }
  return {
    nivel: 'neutro',
    titulo: 'Nenhuma alergia registrada',
    // A frase que evita o pior mal-entendido possível desta página. Ver o cabeçalho.
    detalhe: 'Ausência de registro não é negativa de alergia — pode nunca ter sido perguntado.',
    criticas: [],
  };
}

// ─── Frescor: quando este retrato foi tirado ───────────────────────────────────

export interface Frescor {
  /**
   * Dias desde o congelamento, ou **`null` quando a data não é legível**.
   *
   * `null` e não `0`: `0` é uma afirmação ("montado hoje") que a tela imprimia como
   * *"Este retrato tem 0 dias"* — exatamente o "fingir que é de hoje" que este aviso
   * existe para impedir, e ainda contradizendo o cabeçalho ao lado, que já dizia "data de
   * geração não registrada". Desconhecido tem que ser um valor que o consumidor não
   * consegue confundir com uma medida.
   */
  dias: number | null;
  texto: string;
  /** Acima de 2 dias a tela avisa: o congelado pode não ser o quadro de hoje. */
  avisar: boolean;
}

/**
 * Quantos dias entre o congelamento e agora.
 *
 * Existe porque o resumo **não é ao vivo**: ele foi montado no instante em que o paciente
 * criou o link, e o link vive até 7 dias. Um médico que leia "medicamentos em uso" sem
 * saber que a foto tem 6 dias pode prescrever contra um dado que já mudou. O aviso é a
 * diferença entre um documento e um documento datado.
 */
export function frescor(geradoEm: string, nowMs: number): Frescor {
  const ms = Date.parse(geradoEm);
  if (!Number.isFinite(ms)) return { dias: null, texto: 'data de geração não registrada', avisar: true };
  const dias = Math.floor(Math.max(0, nowMs - ms) / 86_400_000);
  if (dias === 0) return { dias, texto: 'montado hoje', avisar: false };
  if (dias === 1) return { dias, texto: 'montado ontem', avisar: false };
  return { dias, texto: `montado há ${dias} dias`, avisar: dias > 2 };
}

/**
 * Adesão em percentual inteiro, ou `null`.
 *
 * Arredondamento para baixo em vez de `Math.round`: 0,995 virando "100%" diria ao médico
 * que nenhuma dose falhou num mês em que alguma falhou. Numa métrica de tratamento, o
 * arredondamento otimista é o único que causa dano.
 */
export function adesaoPercentual(v: number | null): number | null {
  return v === null ? null : Math.floor(v * 100);
}
