/**
 * O TEXTO de um PDF de laudo — lido dos bytes, sem OCR e sem modelo de visão.
 *
 * ## Por que não mandar o PDF pro modelo de visão
 *
 * Laudo de laboratório é TEXTO. Um PDF de hemograma tem os valores escritos em fonte
 * vetorial, com precisão de máquina — "Hemoglobina 13,2 g/dL" está lá, byte por byte.
 * Mandar esse arquivo pro modelo de visão é a mesma armadilha do HEIC que essa base já
 * pagou: o formato sobe, o provedor recusa (ou pior, aceita e CHUTA), e a Xarlote
 * responde "tive um probleminha" sem ninguém entender por quê.
 *
 * Ler o texto aqui resolve três coisas ao mesmo tempo:
 * · **Certeza** — 13,2 é 13,2, não "parece 13,2" de um OCR sobre JPEG de 0.8 de qualidade.
 * · **Preço** — algumas centenas de tokens de texto contra uma imagem de página inteira.
 * · **Honestidade** — quando NÃO dá pra ler (PDF escaneado), este módulo DIZ que não deu,
 *   e o chamador cai pra outro caminho de propósito. Falha nunca vira sucesso silencioso.
 *
 * ## Por que um parser à mão, e não uma biblioteca
 *
 * Não há biblioteca de PDF no repositório, e `packages/integrations` não pode ganhar
 * dependência nova nesta frente. O escopo real também é estreito: laudo de laboratório
 * brasileiro sai de gerador comum (Java/iText, wkhtmltopdf, Crystal), com o conteúdo em
 * `/FlateDecode` e fontes com codificação de 1 byte. Cobrir ESSE caso com ~300 linhas é
 * possível; cobrir "todo PDF do mundo" não é, e este arquivo não finge que cobre.
 *
 * ## O que ele NÃO faz (e por isso RECUSA em vez de inventar)
 *
 * · **Fonte CID/Identity-H sem `/ToUnicode`** — os bytes da string são índices de glifo,
 *   não caracteres. Mapear índice pra letra dá palavra aleatória. Aqui isso é detectado
 *   (`texto_ilegivel`) em vez de virar um laudo fictício no prontuário de alguém. São
 *   DOIS detectores, e por experiência: um estrutural (o arquivo declara a fonte e não
 *   entrega o mapa) e um estatístico sobre o que saiu. O estatístico sozinho já deixou
 *   passar uma página inteira de sopa de glifo, anunciada ao modelo como "o texto que eu
 *   extraí do documento dele".
 * · **PDF escaneado** (a folha é uma foto dentro do PDF): não existe operador de texto,
 *   então devolve `escaneado` — o chamador manda o arquivo pro caminho de imagem.
 * · **PDF com senha** (`/Encrypt`): devolve `protegido`.
 * · **OCR**: nunca. Isso é outro problema, com outro custo.
 *
 * PURO: recebe bytes, devolve texto ou motivo. Zero I/O, zero rede, zero relógio.
 * `inflateSync` é CPU determinística (o mesmo buffer sempre dá o mesmo resultado), então
 * a função continua testável sem mock nenhum.
 */
import { inflateSync } from 'node:zlib';
import { decifradorDeSenhaVazia, type Decifrador } from './pdf-cripto.js';

/**
 * `falha_ao_ler` não é produzido por esta função — ela não lança. Ele existe pro chamador
 * ter um rótulo HONESTO quando algo inesperado explodir no meio: dizer 'escaneado' pra um
 * erro de programação mandaria o paciente tirar foto de um PDF que era perfeitamente
 * legível, e a causa real nunca apareceria.
 */
export type MotivoIlegivel =
  | 'nao_e_pdf'
  | 'protegido'
  | 'escaneado'
  | 'texto_ilegivel'
  | 'falha_ao_ler';

export interface PdfLido {
  ok: true;
  /** Texto compactado e JÁ cortado no teto. */
  texto: string;
  paginas: number;
  /** Quantos caracteres o PDF tinha ANTES do corte — o contador que o corte exige. */
  caracteres: number;
  truncado: boolean;
}

export interface PdfIlegivel {
  ok: false;
  motivo: MotivoIlegivel;
  paginas: number;
}

export type LeituraDePdf = PdfLido | PdfIlegivel;

/**
 * Teto do texto que sai daqui: 3000 caracteres.
 *
 * Não é gosto — é o que cabe no caminho seguinte. `POST /app/messages` valida
 * `text` com `.max(4000)`, e a mensagem ainda carrega a legenda que o paciente
 * escreveu mais a linha que explica de onde o texto veio. 3000 deixa ~1000 de folga.
 * Estourar isso não daria "texto cortado": daria 400 e o exame não chegaria.
 */
export const MAX_CARACTERES_PDF = 3000;

/** Teto por stream inflado (8 MB). Um PDF de 200 KB pode inflar pra gigabytes de propósito. */
const LIMITE_INFLADO = 8 * 1024 * 1024;
/**
 * Teto da SOMA do que foi inflado (32 MB).
 *
 * O teto por stream sozinho não era cinto nenhum: `MAX_STREAMS` é 400, então 400 streams
 * de 8 MB davam 3,2 GB de `inflateSync` sequencial — na thread que atende todo mundo, já
 * que a extração roda dentro do handler HTTP. O `break` do laço só olhava
 * `MAX_TEXTO_BRUTO`, que stream de lixo (sem `BT`) nunca alcança porque nem chega a virar
 * texto. Aqui a conta é sobre os BYTES inflados, que é o recurso que realmente acaba.
 */
const MAX_TOTAL_INFLADO = 32 * 1024 * 1024;
/** Teto de streams examinados. PDF hostil pode declarar milhares. */
const MAX_STREAMS = 400;
/** Teto do texto bruto acumulado antes de compactar. */
const MAX_TEXTO_BRUTO = 400_000;

/** Mínimo de letras pra chamar de "tem texto". Menos que isso é número de página de um scan. */
const MIN_LETRAS = 20;

/**
 * Densidade máxima de caractere de controle no texto BRUTO (10%).
 *
 * MEDIDO: uma página com índices de glifo na faixa 1..90 — o subset típico de um laudo de
 * uma página — cai ~29% em controle, porque quase um terço daquela faixa é C0. Texto de
 * verdade fica em zero: as únicas quebras que sobrevivem à extração são `\n`, `\r` e tab,
 * que não contam aqui.
 */
const MAX_CONTROLE_BRUTO = 0.1;

/**
 * Fração mínima de minúsculas latinas entre as letras (2%), e um piso absoluto de 4.
 *
 * MEDIDO: laudo sintético 50%, laudo real em PT-BR ~90%, sopa de glifo 0% — inclusive a
 * sopa que NÃO tem controle nenhum, a de um subset com os índices na faixa 65..90 (fonte
 * de título só-caixa-alta), que passa por todas as outras contagens.
 *
 * O piso é baixo de propósito, e o preço dele é assumido: um documento 100% em CAIXA ALTA,
 * sem uma única minúscula na folha inteira, é reprovado como `texto_ilegivel`. É o lado
 * seguro do erro — o paciente é mandado fotografar (recuperável), enquanto o erro oposto é
 * a Xarlote comentar e GRAVAR um exame que ninguém leu. Na prática 2% é satisfeito por um
 * punhado de "mg/dL"/"ng/mL" numa folha inteira, que é como unidade se escreve.
 *
 * Também MEDIDO e DESCARTADO: fração de vogais como sinal independente de caixa. O laudo
 * mediu 43% e a sopa só-maiúscula mediu 37% — separação estreita demais pra decidir sobre
 * o prontuário de alguém.
 */
const MIN_MINUSCULAS = 0.02;
/** ...e um piso absoluto, pra um laudo curto não passar por acidente de arredondamento. */
const MIN_MINUSCULAS_ABS = 4;

// ─────────────────────────────────────────────────────────────────────────────────
// Fronteira pública
// ─────────────────────────────────────────────────────────────────────────────────

export function extrairTextoDePdf(
  buf: Buffer | null | undefined,
  opcoes: { maxCaracteres?: number } = {},
): LeituraDePdf {
  const max = opcoes.maxCaracteres ?? MAX_CARACTERES_PDF;

  if (!buf || buf.length < 5 || buf.toString('latin1', 0, 5) !== '%PDF-') {
    return { ok: false, motivo: 'nao_e_pdf', paginas: 0 };
  }

  // latin1 é 1 byte = 1 caractere, então os índices desta string valem como offsets no
  // buffer. É o que permite achar `stream` por texto e cortar os bytes por subarray.
  const cru = buf.toString('latin1');

  /**
   * Senha: o dicionário do trailer fica em texto claro mesmo em PDF cifrado, então a
   * chave aparece aqui. Exigir o caractere seguinte evita casar com a palavra "/Encrypt"
   * escrita dentro do conteúdo de um PDF legível.
   *
   * Achar `/Encrypt` NÃO é motivo suficiente pra desistir, e isso custou um laudo real em
   * 21/08. Laboratório costuma cifrar com senha de DONO — a que impede copiar e editar —
   * deixando a senha de USUÁRIO vazia. O arquivo abre em qualquer leitor sem perguntar
   * nada, mas o conteúdo está cifrado de verdade. Parar aqui mandava o paciente
   * fotografar uma folha que a máquina já lia.
   *
   * `decifradorDeSenhaVazia` devolve `null` quando o arquivo pede senha DE VERDADE, e aí
   * `protegido` volta a ser a resposta honesta.
   */
  let decifrador: Decifrador | null = null;
  if (/\/Encrypt[\s<[\d]/.test(cru)) {
    decifrador = decifradorDeSenhaVazia(cru);
    if (!decifrador) return { ok: false, motivo: 'protegido', paginas: contarPaginas(cru) };
  }

  /**
   * PORTA DA FRENTE: fonte CID sem mapa de unicode.
   *
   * Numa fonte Type0/Identity-H os bytes da string NÃO são caracteres — são índices de
   * glifo dentro do subset que o gerador embutiu. O `/ToUnicode` é o mapa que desfaz
   * isso; sem ele, "ler" o PDF é reinterpretar índice como letra, e o que sai é palavra
   * aleatória com cara de texto. A checagem estatística lá embaixo pega a maioria dos
   * casos, mas ela é probabilística: um subset cujos índices caiam todos em ASCII
   * imprimível produz sopa que passa por qualquer contagem. Aqui a evidência é
   * ESTRUTURAL — o arquivo diz que usa a codificação e não entrega o mapa.
   *
   * A condição é conservadora de propósito: exige o marcador da fonte E a ausência de
   * QUALQUER `/ToUnicode` no arquivo. E os dois se enxergam pelo mesmo buraco — o
   * `/ToUnicode` é uma CHAVE do próprio dicionário da fonte (o CMap é que fica no stream).
   * Ou seja: se o `/Subtype /Type0` está visível aqui, o dicionário dele está visível, e o
   * `/ToUnicode` estaria também se existisse. Quando a fonte mora dentro de um object
   * stream comprimido, nenhum dos dois aparece e o portão simplesmente não dispara — o que
   * deixa a decisão pro detector estatístico, que é o desenho certo.
   */
  if (/\/Subtype\s*\/Type0|\/Encoding\s*\/Identity-H/.test(cru) && !/\/ToUnicode/.test(cru)) {
    return { ok: false, motivo: 'texto_ilegivel', paginas: contarPaginas(cru) };
  }

  let paginas = contarPaginas(cru);
  // Páginas também podem viver dentro de object streams (PDF 1.5+), onde o `/Type /Page`
  // não aparece no texto cru. Sem isto, um laudo moderno reporta 0 páginas. A decisão é
  // tomada ANTES do laço: contar "só enquanto estiver zero" pararia no primeiro object
  // stream e um laudo com as páginas divididas em dois viria pela metade.
  const contarNosStreams = paginas === 0;
  const pedacos: string[] = [];
  let viuOperadorDeTexto = false;
  let tamanho = 0;
  let inflado = 0;

  for (const stream of streamsDe(cru, buf)) {
    // Orçamento de descompressão, não de texto: é ele que impede 400 streams muito
    // compressíveis de virarem gigabytes na thread que atende todo mundo.
    const orcamento = Math.min(LIMITE_INFLADO, MAX_TOTAL_INFLADO - inflado);
    if (orcamento <= 0) break;

    const conteudo = decodificarStream(stream, orcamento, decifrador);
    if (conteudo === null) continue;
    inflado += conteudo.length;

    if (contarNosStreams) paginas += contarPaginas(conteudo);

    if (!pareceStreamDeConteudo(conteudo)) continue;
    viuOperadorDeTexto = true;

    const antes = tamanho;
    tamanho += extrairDoConteudo(conteudo, pedacos, MAX_TEXTO_BRUTO - antes);
    if (tamanho >= MAX_TEXTO_BRUTO) break;
  }

  const bruto = pedacos.join('');
  const texto = compactar(bruto);

  if (!temTextoDeVerdade(bruto, texto)) {
    // Dois "não deu" diferentes, porque o conserto é diferente: sem operador de texto o
    // PDF é uma folha escaneada (foto resolve); COM operador e saída ilegível, a fonte é
    // CID sem mapa (foto também resolve, mas a causa é outra e vale saber qual foi).
    //
    // A conta é sobre o texto BRUTO, não o compactado: glifo mal mapeado vira caractere
    // de controle, e `compactar` justamente apaga controle — medir depois dele diria
    // "escaneado" pra um PDF que tem texto sim, só ilegível. Motivo errado manda o
    // paciente consertar a coisa errada.
    return {
      ok: false,
      motivo: viuOperadorDeTexto && bruto.length > 0 ? 'texto_ilegivel' : 'escaneado',
      paginas,
    };
  }

  const caracteres = texto.length;
  const cortado = cortar(texto, max);

  return {
    ok: true,
    texto: cortado,
    // Um PDF de onde saiu texto tem ao menos uma página; reportar 0 seria pior que
    // inferir 1, porque a tela do paciente mostra esse número.
    paginas: paginas > 0 ? paginas : 1,
    caracteres,
    truncado: cortado.length < caracteres,
  };
}

/** O que o paciente lê quando o PDF subiu mas o texto não saiu. */
export function mensagemDePdfIlegivel(motivo: MotivoIlegivel): string {
  switch (motivo) {
    case 'nao_e_pdf':
      return 'Esse arquivo não é um PDF que eu consiga abrir. Tenta mandar de novo, ou tira uma foto da folha.';
    case 'protegido':
      return 'Esse PDF está protegido por senha, então não consigo ler o que tem dentro. Ele fica guardado aqui; se quiser que eu leia, tira uma foto da folha.';
    case 'escaneado':
      return 'Esse PDF é uma folha escaneada (uma imagem), então não tem texto pra eu ler. Ele fica guardado aqui. Se quiser que eu leia os valores, tira uma foto da folha.';
    case 'texto_ilegivel':
      // "Consegui" no começo: esta frase entra dentro do bloco que a Xarlote lê, e
      // `resolvedElsewhere` (packages/shared/src/pharmacy.ts) conta "consegui" como verbo de
      // COMPRA CONCLUÍDA — a regex não enxerga negação nem sujeito. Prosa de sistema não pode
      // se passar por fala de paciente; "Abri" diz o mesmo sem o homônimo.
      return 'Abri o PDF, mas não decifrei o texto dele (a fonte do arquivo não diz quais letras são). Ele fica guardado aqui; uma foto da folha funciona melhor.';
    case 'falha_ao_ler':
      return 'Tive um problema pra ler esse PDF aqui do meu lado. Ele fica guardado do mesmo jeito. Se quiser que eu leia agora, manda uma foto da folha.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// Estrutura do arquivo
// ─────────────────────────────────────────────────────────────────────────────────

/** Conta objetos de página. `(?!s)` separa `/Type /Page` de `/Type /Pages`, que é o nó-pai. */
function contarPaginas(s: string): number {
  return (s.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

interface StreamBruto {
  /** Janela de texto antes do `stream` — onde mora o `/Filter` e o `/Subtype`. */
  dicionario: string;
  dados: Buffer;
  /** Número e geração do objeto: em PDF cifrado, cada objeto tem a SUA chave. */
  numero: number;
  geracao: number;
}

/**
 * Varre `stream ... endstream`.
 *
 * O dicionário NÃO é achado por `lastIndexOf('<<')`: dicionário de stream costuma ter
 * dicionário aninhado (`/DecodeParms << … >>`), e o `lastIndexOf` acharia o filho —
 * perdendo justamente o `/Filter` que decide se dá pra inflar. Então a leitura é por
 * fatia até o `stream`.
 *
 * O que a fatia NÃO pode fazer é invadir o objeto anterior. MEDIDO: com uma janela fixa
 * de 1200 caracteres, um laudo legível voltava `escaneado` sempre que houvesse um objeto
 * PEQUENO antes do content stream — `5 0 obj << /Type /Font … >>` casava `DICT_SEM_TEXTO`
 * e um XObject de imagem de 300 bytes casava `FILTROS_OPACOS`. O mesmo arquivo com a
 * imagem em 4000 bytes voltava a ler, o que provou que a causa era a janela e não o
 * conteúdo. Fonte embutida ou logo do laboratório imediatamente antes da página é
 * ordenação comum de gerador real — e o preço do erro era o paciente ouvir "esse PDF é
 * uma folha escaneada" sobre um arquivo perfeitamente legível por máquina.
 *
 * Por isso a fatia começa na FRONTEIRA do objeto corrente (`obj`, ou o `endobj`/
 * `endstream` do anterior), com os 1200 caracteres valendo só como piso quando nenhuma
 * dessas âncoras existe — PDF linearizado sem `endobj`, por exemplo.
 */
function* streamsDe(cru: string, buf: Buffer): Generator<StreamBruto> {
  let pos = 0;
  let vistos = 0;

  while (vistos < MAX_STREAMS) {
    const idx = cru.indexOf('stream', pos);
    if (idx < 0) return;

    // A palavra `stream` também está dentro de `endstream`.
    if (cru.slice(idx - 3, idx) === 'end') {
      pos = idx + 6;
      continue;
    }

    let inicio = idx + 6;
    if (cru[inicio] === '\r') inicio++;
    if (cru[inicio] === '\n') inicio++;

    const fim = cru.indexOf('endstream', inicio);
    if (fim < 0) return;

    vistos++;
    const fronteira = Math.max(
      cru.lastIndexOf(' obj', idx),
      cru.lastIndexOf('endobj', idx),
      cru.lastIndexOf('endstream', idx),
      idx - 1200,
      0,
    );
    // `N G obj` imediatamente antes do stream. Em arquivo cifrado é isto que dá a chave
    // do objeto; num arquivo claro é só metadado ignorado.
    const cabeca = cru.slice(Math.max(0, fronteira - 24), idx);
    const ref = /(\d+)\s+(\d+)\s+obj\b(?![\s\S]*\bobj\b)/.exec(cabeca);

    yield {
      dicionario: cru.slice(fronteira, idx),
      dados: buf.subarray(inicio, fim),
      numero: ref ? Number(ref[1]) : 0,
      geracao: ref ? Number(ref[2]) : 0,
    };

    pos = fim + 9;
  }
}

/** Filtros que este módulo não desembrulha — devolver `null` é melhor que devolver lixo. */
const FILTROS_OPACOS =
  /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode|Crypt)/;

/**
 * Streams que nunca contêm texto de página — pular economiza inflate e evita falso positivo.
 *
 * **`XObject` NÃO entra nesta lista, e o motivo é medido.** Havia aqui um
 * `/Type\s*\/(XObject|…)`, e ele se anulava com o próprio termo vizinho: `/Subtype /Image`
 * já pega TODA imagem, porque todo XObject de imagem declara esse subtipo. O que sobrava
 * pro termo `XObject` excluir eram só os **Form XObjects** — que são exatamente os que
 * carregam texto. Um laudo cujo content stream de página só chama `/Fm0 Do`, com o texto
 * inteiro dentro do objeto `/Subtype /Form`, voltava `{ok:false, motivo:'escaneado'}`: o
 * paciente ouvia "esse PDF é uma folha escaneada, tira uma foto da folha" sobre um arquivo
 * perfeitamente legível por máquina. Form XObject é o desenho padrão de gerador com
 * template, e o que sobra de qualquer junção ou carimbo de páginas.
 *
 * É a MESMA falha que este arquivo já pagou uma vez com a janela do dicionário (ver
 * `streamsDe`), e o preço do erro é o mesmo: mandar fotografar o que não precisa de foto.
 *
 * O que continua guardando o portão sem excluir texto: `pareceStreamDeConteudo` exige `BT`
 * E um operador que escreve (`Tj`/`TJ`/`T*`), então stream sem texto segue sendo pulado, e
 * `FILTROS_OPACOS` segue barrando `/DCTDecode` e companhia.
 */
const DICT_SEM_TEXTO = /\/Subtype\s*\/Image|\/Type\s*\/(Font|Metadata|XRef|EmbeddedFile)|\/FontFile/;

function decodificarStream(
  s: StreamBruto,
  orcamento: number,
  decifrador: Decifrador | null,
): string | null {
  if (DICT_SEM_TEXTO.test(s.dicionario)) return null;
  if (FILTROS_OPACOS.test(s.dicionario)) return null;
  if (s.dados.length === 0) return null;

  // Decifrar vem ANTES de inflar: no arquivo cifrado é o texto comprimido que está
  // embaralhado, então inflar primeiro só produz erro de zlib.
  const dados = decifrador ? decifrador.streamDe(s.dados, s.numero, s.geracao) : s.dados;
  if (!dados || dados.length === 0) return null;

  if (/\/FlateDecode/.test(s.dicionario)) {
    try {
      // `maxOutputLength` é o cinto contra zip bomb: sem ele, um PDF de 200 KB pode
      // pedir gigabytes de RAM e derrubar o processo da API inteira. O orçamento vem do
      // chamador porque o teto que importa é o da SOMA — 400 streams dentro do limite
      // individual ainda somam gigabytes.
      return inflateSync(dados, { maxOutputLength: orcamento }).toString('latin1');
    } catch {
      // Stream corrompido ou cifrado. Seguir pro próximo é melhor que abortar o PDF:
      // laudo com um stream ruim ainda pode ter o hemograma no stream seguinte.
      return null;
    }
  }

  // Sem `/Filter`: o conteúdo já está em texto claro (gerador simples faz isso).
  if (/\/Filter/.test(s.dicionario)) return null;
  return dados.toString('latin1');
}

/** Um stream de página tem bloco de texto (`BT`) e ao menos um operador que escreve. */
function pareceStreamDeConteudo(s: string): boolean {
  return s.includes('BT') && (/\bTj\b/.test(s) || /\bTJ\b/.test(s) || /\bT\*/.test(s));
}

// ─────────────────────────────────────────────────────────────────────────────────
// O stream de conteúdo: operadores de texto
// ─────────────────────────────────────────────────────────────────────────────────

type Operando =
  | { tipo: 'num'; valor: number }
  | { tipo: 'str'; bytes: number[] }
  | { tipo: 'arr'; itens: Operando[] };

const DELIMITADORES = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const BRANCOS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);

/**
 * Percorre o stream e empurra o texto em `saida`.
 *
 * Devolve quantos caracteres escreveu, pro chamador respeitar o teto global.
 *
 * A quebra de linha é inferida da POSIÇÃO, não do conteúdo: `T*`, `Td`/`TD` com
 * deslocamento vertical, `Tm` com Y diferente e `'`/`"` começam linha nova. Sem isso, um
 * laudo em tabela vira uma única linha gigante onde "Hemoglobina" e "13,2" ficam
 * colados no rótulo do analito seguinte — e aí o modelo lê o valor errado.
 */
function extrairDoConteudo(s: string, saida: string[], teto: number): number {
  let i = 0;
  let escritos = 0;
  let pilha: Operando[] = [];
  let ultimoY: number | null = null;
  let precisaLinha = false;

  const escrever = (bytes: number[]): void => {
    if (escritos >= teto) return;
    const t = decodificarString(bytes);
    if (!t) return;
    if (precisaLinha) {
      saida.push('\n');
      precisaLinha = false;
    }
    saida.push(t);
    escritos += t.length;
  };

  while (i < s.length && escritos < teto) {
    const c = s[i]!;

    if (BRANCOS.has(c)) {
      i++;
      continue;
    }
    if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (c === '(') {
      const r = lerLiteral(s, i);
      pilha.push({ tipo: 'str', bytes: r.bytes });
      i = r.fim;
      continue;
    }
    if (c === '<') {
      if (s[i + 1] === '<') {
        i = pularDicionario(s, i);
        continue;
      }
      const r = lerHex(s, i);
      pilha.push({ tipo: 'str', bytes: r.bytes });
      i = r.fim;
      continue;
    }
    if (c === '[') {
      const r = lerArray(s, i);
      pilha.push({ tipo: 'arr', itens: r.itens });
      i = r.fim;
      continue;
    }
    if (c === '/') {
      i++;
      while (i < s.length && !BRANCOS.has(s[i]!) && !DELIMITADORES.has(s[i]!)) i++;
      continue;
    }
    if (c === ']' || c === '>' || c === '}' || c === '{' || c === ')') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.') {
      const r = lerNumero(s, i);
      pilha.push({ tipo: 'num', valor: r.valor });
      i = r.fim;
      continue;
    }

    // Operador.
    let j = i;
    while (j < s.length && !BRANCOS.has(s[j]!) && !DELIMITADORES.has(s[j]!)) j++;
    const op = s.slice(i, j);
    i = j;

    // Imagem embutida: entre `ID` e `EI` vêm bytes crus que quebrariam o tokenizador.
    if (op === 'BI') {
      const ei = acharFimDeImagemEmbutida(s, i);
      i = ei;
      pilha = [];
      continue;
    }

    switch (op) {
      case 'Tj':
      case 'Tj*': {
        const ultimo = pilha[pilha.length - 1];
        if (ultimo?.tipo === 'str') escrever(ultimo.bytes);
        break;
      }
      case "'": {
        precisaLinha = true;
        const ultimo = pilha[pilha.length - 1];
        if (ultimo?.tipo === 'str') escrever(ultimo.bytes);
        break;
      }
      case '"': {
        precisaLinha = true;
        const ultimo = pilha[pilha.length - 1];
        if (ultimo?.tipo === 'str') escrever(ultimo.bytes);
        break;
      }
      case 'TJ': {
        const ultimo = pilha[pilha.length - 1];
        if (ultimo?.tipo === 'arr') {
          for (const item of ultimo.itens) {
            if (item.tipo === 'str') escrever(item.bytes);
            // Ajuste de espaçamento em milésimos de unidade de texto. Valor bem negativo
            // é como o gerador escreve um espaço entre palavras sem mandar o caractere.
            else if (item.tipo === 'num' && item.valor <= -120) escrever([0x20]);
          }
        }
        break;
      }
      case 'T*':
      case 'ET':
        precisaLinha = true;
        break;
      case 'BT':
        ultimoY = null;
        precisaLinha = true;
        break;
      case 'Td':
      case 'TD': {
        const ty = pilha[pilha.length - 1];
        if (ty?.tipo === 'num' && Math.abs(ty.valor) > 0.5) precisaLinha = true;
        break;
      }
      case 'Tm': {
        const f = pilha[pilha.length - 1];
        if (f?.tipo === 'num') {
          if (ultimoY !== null && Math.abs(f.valor - ultimoY) > 0.5) precisaLinha = true;
          ultimoY = f.valor;
        }
        break;
      }
      default:
        break;
    }

    pilha = [];
  }

  return escritos;
}

/** String literal `( … )`: parênteses aninham, e `\` escapa. */
function lerLiteral(s: string, inicio: number): { bytes: number[]; fim: number } {
  const bytes: number[] = [];
  let i = inicio + 1;
  let nivel = 1;

  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      const p = s[i + 1];
      i += 2;
      if (p === undefined) break;
      if (p === 'n') bytes.push(0x0a);
      else if (p === 'r') bytes.push(0x0d);
      else if (p === 't') bytes.push(0x09);
      else if (p === 'b') bytes.push(0x08);
      else if (p === 'f') bytes.push(0x0c);
      else if (p === '\n') continue; // continuação de linha: não gera byte
      else if (p === '\r') {
        if (s[i] === '\n') i++;
        continue;
      } else if (p >= '0' && p <= '7') {
        // Escape octal de até 3 dígitos — é assim que caractere acentuado aparece.
        let oct = p;
        while (oct.length < 3 && s[i] !== undefined && s[i]! >= '0' && s[i]! <= '7') {
          oct += s[i];
          i++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
      } else bytes.push(p.charCodeAt(0) & 0xff);
      continue;
    }
    if (c === '(') nivel++;
    if (c === ')') {
      nivel--;
      if (nivel === 0) return { bytes, fim: i + 1 };
    }
    bytes.push(c.charCodeAt(0) & 0xff);
    i++;
  }

  return { bytes, fim: i };
}

/** String hexadecimal `< … >`. Dígito ímpar no fim vira `0` (regra do formato). */
function lerHex(s: string, inicio: number): { bytes: number[]; fim: number } {
  const bytes: number[] = [];
  let i = inicio + 1;
  let atual = '';

  while (i < s.length && s[i] !== '>') {
    const c = s[i]!;
    if (/[0-9a-fA-F]/.test(c)) {
      atual += c;
      if (atual.length === 2) {
        bytes.push(parseInt(atual, 16));
        atual = '';
      }
    }
    i++;
  }
  if (atual.length === 1) bytes.push(parseInt(atual + '0', 16));

  return { bytes, fim: i + 1 };
}

function lerNumero(s: string, inicio: number): { valor: number; fim: number } {
  let i = inicio;
  if (s[i] === '-' || s[i] === '+') i++;
  while (i < s.length && ((s[i]! >= '0' && s[i]! <= '9') || s[i] === '.')) i++;
  const v = Number.parseFloat(s.slice(inicio, i));
  return { valor: Number.isFinite(v) ? v : 0, fim: i };
}

function lerArray(s: string, inicio: number): { itens: Operando[]; fim: number } {
  const itens: Operando[] = [];
  let i = inicio + 1;

  while (i < s.length && s[i] !== ']') {
    const c = s[i]!;
    if (BRANCOS.has(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      const r = lerLiteral(s, i);
      itens.push({ tipo: 'str', bytes: r.bytes });
      i = r.fim;
      continue;
    }
    if (c === '<') {
      const r = lerHex(s, i);
      itens.push({ tipo: 'str', bytes: r.bytes });
      i = r.fim;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.') {
      const r = lerNumero(s, i);
      itens.push({ tipo: 'num', valor: r.valor });
      i = r.fim;
      continue;
    }
    i++;
  }

  return { itens, fim: i + 1 };
}

/** Salta um dicionário inline (`/BDC` carrega um), contando os `<<` aninhados. */
function pularDicionario(s: string, inicio: number): number {
  let i = inicio + 2;
  let nivel = 1;
  while (i < s.length && nivel > 0) {
    if (s[i] === '<' && s[i + 1] === '<') {
      nivel++;
      i += 2;
      continue;
    }
    if (s[i] === '>' && s[i + 1] === '>') {
      nivel--;
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

/** `EI` delimitado por brancos — dentro dos bytes da imagem, "EI" solto é comum. */
function acharFimDeImagemEmbutida(s: string, inicio: number): number {
  let i = inicio;
  while (i < s.length - 1) {
    if (
      s[i] === 'E' &&
      s[i + 1] === 'I' &&
      (i === 0 || BRANCOS.has(s[i - 1]!)) &&
      (i + 2 >= s.length || BRANCOS.has(s[i + 2]!))
    ) {
      return i + 2;
    }
    i++;
  }
  return s.length;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Bytes → caracteres, e a checagem de que o resultado é texto mesmo
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Decodifica a string do PDF.
 *
 * Duas codificações cobrem o caso real: 1 byte por caractere (PDFDocEncoding, que nos
 * caracteres que importam coincide com latin1) e UTF-16BE, que se anuncia pelo BOM
 * `FE FF` ou se delata pelos bytes altos zerados.
 */
function decodificarString(bytes: number[]): string {
  if (bytes.length === 0) return '';

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return utf16be(bytes.slice(2));
  }

  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    let zerosAltos = 0;
    for (let i = 0; i < bytes.length; i += 2) if (bytes[i] === 0) zerosAltos++;
    if (zerosAltos / (bytes.length / 2) > 0.6) return utf16be(bytes);
  }

  return Buffer.from(bytes).toString('latin1');
}

function utf16be(bytes: number[]): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return out;
}

/**
 * Colapsa o texto sem perder a estrutura de linha.
 *
 * Cabeçalho e rodapé de laboratório repetem por página; linha idêntica CONSECUTIVA sai.
 * Repetição não-consecutiva fica: "Resultado: 13,2" pode aparecer legitimamente duas
 * vezes, e apagar o segundo seria apagar exame.
 */
function compactar(bruto: string): string {
  const linhas = bruto
    .split('\n')
    .map((l) =>
      l
        // Controle solto vira nada: o PDF usa alguns como separador interno, e byte de
        // controle dentro do prontuario nao e texto que o modelo deva ler.
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter((l) => l.length > 0);

  const saida: string[] = [];
  for (const l of linhas) {
    if (saida[saida.length - 1] === l) continue;
    saida.push(l);
  }
  return saida.join('\n');
}

/** Controle que texto de verdade NUNCA tem. `\t`, `\n`, `\v`, `\f` e `\r` ficam de fora. */
const CONTROLE_SUSPEITO = /[\u0000-\u0008\u000e-\u001f\u007f]/;

/**
 * O texto extraído é texto de verdade, ou é glifo mal mapeado?
 *
 * Fonte CID sem `/ToUnicode` produz sequência de caracteres plausíveis-mas-aleatórios.
 * São TRÊS medidas, e as duas primeiras existem porque a terceira sozinha foi enganada:
 *
 * 1. **Controle no BRUTO.** MEDIDO: um subset com índices de glifo na faixa 1..90 (o
 *    tamanho típico de um laudo de uma página) devolvia `ok:true` com 474 "letras" e o
 *    texto `%QW9+WWAC)I!C1=)A?'#!3#S…`. A causa era de ordem: `compactar` APAGA os
 *    caracteres de controle — a evidência mais forte de glifo mal mapeado — antes de a
 *    conta ser feita, e o que sobrevivia daquela faixa é tudo maiúscula, dígito e
 *    pontuação, que o classificador conta como legítimo. Então a medida de controle é
 *    sobre o bruto, ANTES da limpeza.
 * 2. **Minúsculas.** Sinal barato e independente da faixa de glifo: texto em PT-BR é
 *    majoritariamente minúsculo, sopa em faixa só-maiúscula dá zero.
 * 3. **Proporção de caracteres estranhos e uma palavra formada** — a medida original,
 *    que continua pegando as faixas altas de glifo (200, 400).
 *
 * O desfecho que isso impede é preciso: o bloco que a Xarlote lê anuncia "eu extraí o
 * TEXTO dele pra você" e pede pra ela chamar `save_exam_result` com o que leu. Lixo
 * aprovado aqui vira exame gravado no prontuário de alguém.
 */
function temTextoDeVerdade(bruto: string, t: string): boolean {
  if (t.length === 0) return false;

  if (bruto.length > 0) {
    let controle = 0;
    for (const ch of bruto) if (CONTROLE_SUSPEITO.test(ch)) controle++;
    if (controle / bruto.length > MAX_CONTROLE_BRUTO) return false;
  }

  let letras = 0;
  let minusculas = 0;
  let estranhos = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    if (/[\p{L}]/u.test(ch)) {
      letras++;
      if (/[\p{Ll}]/u.test(ch) && /[\p{Script=Latin}]/u.test(ch)) minusculas++;
      // Letra fora do latim num laudo brasileiro é sinal de mapeamento errado.
      if (!/[\p{Script=Latin}]/u.test(ch)) estranhos++;
    } else if (/[\p{N}]/u.test(ch)) {
      // dígito: conta como legítimo
    } else if (/[ \n.,;:()/\-+%<>=*'"°ºª#$&@[\]|_?!]/.test(ch)) {
      // pontuação e símbolo que aparecem em laudo
    } else if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff)) {
      estranhos++;
    } else {
      estranhos++;
    }
  }

  if (letras < MIN_LETRAS) return false;
  if (minusculas < MIN_MINUSCULAS_ABS || minusculas / letras < MIN_MINUSCULAS) return false;
  if (estranhos / t.length > 0.2) return false;
  // Pelo menos uma palavra de 3 letras. Glifo mal mapeado quase nunca forma sequência.
  return /[\p{Script=Latin}]{3}/u.test(t);
}

/** Corta no fim de linha quando possível — cortar no meio de "Hemoglobina 13," é pior. */
function cortar(t: string, max: number): string {
  if (t.length <= max) return t;
  const bruto = t.slice(0, max);
  const ultimaLinha = bruto.lastIndexOf('\n');
  return ultimaLinha > max * 0.6 ? bruto.slice(0, ultimaLinha) : bruto;
}
