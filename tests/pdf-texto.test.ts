import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  MAX_CARACTERES_PDF,
  extrairTextoDePdf,
  mensagemDePdfIlegivel,
} from '../packages/integrations/src/pdf-texto.js';

/**
 * A leitura do texto de um PDF de laudo.
 *
 * Todo PDF daqui é MONTADO no teste, byte por byte — nenhum laudo real, nenhum nome, nenhum
 * dado de paciente. O que os casos cobrem é o formato, não o conteúdo: stream em texto claro,
 * stream comprimido, texto posicionado por matriz, acento em escape octal, e as três formas
 * de um PDF ser ilegível (escaneado, cifrado, fonte sem mapa).
 *
 * O teste mais importante é o do PDF escaneado: se ele passar a "extrair" alguma coisa, o
 * caminho de imagem deixa de ser acionado e um laudo em foto entra no prontuário como se
 * tivesse sido lido.
 */

interface OpcoesPdf {
  comprimir?: boolean;
  encriptado?: boolean;
  /** Objetos crus a mais (imagem, fonte) pra provar que o parser os ignora. */
  extras?: string;
  /**
   * Objeto cru colado IMEDIATAMENTE antes do content stream.
   *
   * Existe porque a posição importa: o dicionário do stream é lido por fatia, e uma fatia
   * frouxa demais invade o objeto anterior. Gerador real põe fonte e logo exatamente aqui.
   */
  antes?: string;
  /** Conteúdo do `/Resources` da página — o gerador declara aqui os XObjects que ela usa. */
  recursos?: string;
}

/** Monta um PDF válido o bastante: catálogo, páginas, e um content stream por página. */
function pdfCom(conteudos: string[], o: OpcoesPdf = {}): Buffer {
  const partes: Buffer[] = [];
  const add = (s: string | Buffer): void => {
    partes.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  };

  add('%PDF-1.4\n');
  const kids = conteudos.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  add('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  add(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${conteudos.length} >> endobj\n`);

  conteudos.forEach((c, i) => {
    const pagina = 3 + i * 2;
    const conteudo = pagina + 1;
    add(
      `${pagina} 0 obj << /Type /Page /Parent 2 0 R /Contents ${conteudo} 0 R ` +
        `${o.recursos ? `/Resources ${o.recursos} ` : ''}` +
        '/MediaBox [0 0 595 842] >> endobj\n',
    );
    if (o.antes) add(o.antes);
    const dados = o.comprimir ? deflateSync(Buffer.from(c, 'latin1')) : Buffer.from(c, 'latin1');
    add(
      `${conteudo} 0 obj << /Length ${dados.length}` +
        `${o.comprimir ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
    );
    add(dados);
    add('\nendstream endobj\n');
  });

  if (o.extras) add(o.extras);
  add(
    `trailer << /Root 1 0 R /Size ${2 + conteudos.length * 2}` +
      `${o.encriptado ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`,
  );

  return Buffer.concat(partes);
}

/** Um hemograma FICTÍCIO, escrito como um gerador real escreveria: uma linha por `Td`. */
const LAUDO_SINTETICO = [
  'BT /F1 12 Tf 72 780 Td (LABORATORIO EXEMPLO - RESULTADO DE EXAME) Tj ET',
  'BT /F1 10 Tf 72 758 Td (Paciente: TESTE SINTETICO) Tj',
  '0 -16 Td (Coleta: 12/08/2026) Tj',
  '0 -22 Td (HEMOGRAMA COMPLETO) Tj',
  '0 -16 Td (Hemoglobina 13,2 g/dL) Tj',
  '0 -16 Td (Leucocitos 7.400 /mm3) Tj',
  '0 -16 Td (Plaquetas 245.000 /mm3) Tj',
  '0 -22 Td (BIOQUIMICA) Tj',
  '0 -16 Td (Glicose de jejum 92 mg/dL) Tj',
  '0 -16 Td (Fun\\347\\343o renal: creatinina 0,9 mg/dL) Tj',
  'ET',
].join('\n');

/**
 * Um **Form XObject**: um pedaço de página desenhado à parte e chamado por `Do`.
 *
 * Não é exotismo — é o desenho padrão de gerador com template (o miolo do laudo vira um
 * formulário reutilizável) e o que sobra de qualquer junção ou carimbo de páginas. O
 * content stream da página fica com uma linha (`/Fm0 Do`) e o TEXTO INTEIRO mora aqui.
 */
function formXObject(numero: number, conteudo: string): string {
  const dados = deflateSync(Buffer.from(conteudo, 'latin1'));
  return (
    `${numero} 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 595 842] ` +
    `/Filter /FlateDecode /Length ${dados.length} >>\nstream\n` +
    `${dados.toString('latin1')}\nendstream endobj\n`
  );
}

/**
 * Uma PÁGINA INTEIRA escrita com índices de glifo — a fixture realista de fonte CID.
 *
 * O caso de 8 glifos que já existia aqui passava por acaso: ele cai numa faixa alta, onde
 * o classificador acerta. O laudo de UMA PÁGINA usa um subset de ~70-90 glifos distintos,
 * e nessa faixa (1..90) o resultado media `ok:true` com ~470 "letras" e zero minúscula —
 * lixo entregue ao modelo anunciado como "o texto que eu extraí do documento dele".
 *
 * Determinístico de propósito (LCG com semente fixa): fixture aleatória que só falha às
 * terças é pior que fixture nenhuma.
 */
function sopaDeGlifos(faixaMin: number, faixaMax: number): string {
  let semente = 11;
  const proximo = (): number => {
    semente = (semente * 1103515245 + 12345) & 0x7fffffff;
    return faixaMin + (semente % (faixaMax - faixaMin + 1));
  };
  const linhas: string[] = [];
  for (let l = 0; l < 26; l++) {
    const palavras: string[] = [];
    for (let p = 0; p < 5; p++) {
      let w = '';
      for (let i = 0; i < 4 + ((l + p) % 6); i++) w += proximo().toString(16).padStart(4, '0');
      palavras.push(`<${w}>`);
    }
    linhas.push(`0 -14 Td [${palavras.join(' -250 ')}] TJ`);
  }
  return `BT /F1 10 Tf 72 780 Td\n${linhas.join('\n')}\nET`;
}

/** Fonte CID declarada no arquivo — com e sem o mapa que torna o texto legível. */
const FONTE_CID_SEM_MAPA =
  '80 0 obj << /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Arial /Encoding /Identity-H ' +
  '/DescendantFonts [81 0 R] >> endobj\n';
const FONTE_CID_COM_MAPA =
  '80 0 obj << /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Arial /Encoding /Identity-H ' +
  '/DescendantFonts [81 0 R] /ToUnicode 82 0 R >> endobj\n';

describe('extrairTextoDePdf — o caminho que importa', () => {
  it('lê os valores de um laudo com stream em texto claro', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO]));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
    expect(r.texto).toContain('Glicose de jejum 92 mg/dL');
    expect(r.paginas).toBe(1);
    expect(r.truncado).toBe(false);
  });

  it('lê o mesmo laudo comprimido com FlateDecode — que é como laboratório de verdade sai', () => {
    const claro = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO]));
    const comprimido = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { comprimir: true }));

    expect(comprimido.ok).toBe(true);
    if (!comprimido.ok || !claro.ok) return;
    // O texto tem que ser IDÊNTICO: a compressão é do arquivo, não do conteúdo.
    expect(comprimido.texto).toBe(claro.texto);
  });

  it('separa uma linha por analito — valor não pode grudar no rótulo seguinte', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { comprimir: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const linhas = r.texto.split('\n');
    // Se a inferência de linha falhar, tudo vira uma linha só e o modelo lê
    // "Hemoglobina 13,2 g/dLLeucocitos 7.400" — número associado ao analito errado.
    expect(linhas).toContain('Hemoglobina 13,2 g/dL');
    expect(linhas).toContain('Leucocitos 7.400 /mm3');
    expect(r.texto).not.toContain('g/dLLeucocitos');
  });

  it('resolve acento escrito em escape octal', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Função renal: creatinina 0,9 mg/dL');
  });

  it('junta as palavras de um TJ com ajuste de espaçamento', () => {
    // Gerador de PDF escreve espaço como ajuste negativo, não como caractere.
    const conteudo =
      'BT /F1 10 Tf 72 700 Td [(Colesterol) -250 (total) -250 (190 mg/dL)] TJ ET';
    const r = extrairTextoDePdf(pdfCom([conteudo + '\n' + LAUDO_SINTETICO]));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Colesterol total 190 mg/dL');
  });

  it('quebra linha em T* e em mudança de Y da matriz de texto', () => {
    const conteudo = [
      'BT /F1 10 Tf 14 TL 1 0 0 1 72 700 Tm (TSH 2,10 uUI/mL) Tj T* (T4 livre 1,20 ng/dL) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 72 640 Tm (Vitamina D 32 ng/mL) Tj ET',
      LAUDO_SINTETICO,
    ].join('\n');
    const r = extrairTextoDePdf(pdfCom([conteudo]));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const linhas = r.texto.split('\n');
    expect(linhas).toContain('TSH 2,10 uUI/mL');
    expect(linhas).toContain('T4 livre 1,20 ng/dL');
    expect(linhas).toContain('Vitamina D 32 ng/mL');
  });

  it('conta as páginas', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO, LAUDO_SINTETICO], { comprimir: true }));
    expect(r.paginas).toBe(2);
  });

  it('colapsa a linha desenhada duas vezes seguidas (o negrito falso do gerador)', () => {
    // Gerador sem fonte bold escreve a MESMA linha duas vezes, deslocada de 0,3pt, pra
    // engrossar o traço. Sem colapsar, cada título do laudo chega dobrado ao modelo.
    const negritoFalso = [
      'BT /F1 12 Tf 72 780 Td (HEMOGRAMA COMPLETO) Tj ET',
      'BT /F1 12 Tf 72.3 780 Td (HEMOGRAMA COMPLETO) Tj ET',
      'BT /F1 10 Tf 72 758 Td (Hemoglobina 13,2 g/dL) Tj',
      '0 -16 Td (Leucocitos 7.400 /mm3) Tj ET',
    ].join('\n');
    const r = extrairTextoDePdf(pdfCom([negritoFalso]));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const linhas = r.texto.split('\n');
    expect(linhas.filter((l) => l === 'HEMOGRAMA COMPLETO')).toHaveLength(1);
  });

  it('mantém linha repetida NÃO consecutiva — cabeçalho de página 2 e valor que volta', () => {
    const pagina2 = [
      'BT /F1 12 Tf 72 780 Td (LABORATORIO EXEMPLO - RESULTADO DE EXAME) Tj ET',
      'BT /F1 10 Tf 72 758 Td (Ferritina 88 ng/mL) Tj',
      '0 -16 Td (Hemoglobina 13,2 g/dL) Tj ET',
    ].join('\n');
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO, pagina2]));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const linhas = r.texto.split('\n');
    // Decisão consciente: o colapso é só de linha VIZINHA. O cabeçalho da página 2 e a
    // hemoglobina que reaparece ficam os dois — apagar repetição distante custaria
    // apagar exame ("Resultado: 13,2" pode aparecer duas vezes de verdade), e o preço de
    // manter é algumas dezenas de caracteres do teto.
    expect(linhas.filter((l) => l.startsWith('LABORATORIO EXEMPLO'))).toHaveLength(2);
    expect(linhas.filter((l) => l === 'Hemoglobina 13,2 g/dL')).toHaveLength(2);
    expect(linhas).toContain('Ferritina 88 ng/mL');
  });

  it('lê o laudo com um objeto de FONTE colado antes do content stream', () => {
    // MEDIDO: com o dicionário lido por janela fixa de 1200 caracteres, esse `/Type /Font`
    // — que está no objeto ANTERIOR — casava `DICT_SEM_TEXTO` e o laudo inteiro voltava
    // como `escaneado`. O paciente ouvia "esse PDF é uma folha escaneada" sobre um arquivo
    // perfeitamente legível, e era mandado fotografar o que não precisava de foto.
    const fonte =
      '77 0 obj << /Type /Font /Subtype /TrueType /BaseFont /Helvetica /FirstChar 32 >> endobj\n';
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { antes: fonte }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
  });

  it('lê o laudo com o logo do laboratório (imagem PEQUENA) colado antes do content stream', () => {
    // Mesma causa, outro sintoma: o `/DCTDecode` do objeto anterior casava `FILTROS_OPACOS`.
    // O tamanho é o que provava a causa — com 4000 bytes o mesmo arquivo lia, porque a
    // janela fixa não alcançava o dicionário da imagem.
    const logo = (bytes: number): string =>
      `78 0 obj << /Type /XObject /Subtype /Image /Width 10 /Height 10 /Length ${bytes} ` +
      `/Filter /DCTDecode >>\nstream\n${'A'.repeat(bytes)}\nendstream endobj\n`;

    for (const tamanho of [300, 4000]) {
      const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { antes: logo(tamanho) }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
    }
  });

  it('lê o laudo cujo texto mora num Form XObject (gerador com template, PDF carimbado)', () => {
    // MEDIDO: com `XObject` na alternância de `DICT_SEM_TEXTO`, este arquivo voltava
    // `{ok:false, motivo:'escaneado', paginas:1}` — e o paciente ouvia "esse PDF é uma
    // folha escaneada, tira uma foto da folha" sobre um arquivo perfeitamente legível por
    // máquina. É a MESMA falha que a janela do dicionário já custou uma vez.
    //
    // A causa era uma alternância que se anulava: `/Subtype /Image` já pega TODA imagem
    // (todo XObject de imagem declara esse subtipo), então o termo `XObject` só excluía os
    // Form XObjects — justamente os que carregam texto.
    //
    // O que continua guardando o portão é `pareceStreamDeConteudo` (exige `BT` E um
    // operador que escreve) e `FILTROS_OPACOS` — os dois testes de imagem acima provam.
    const r = extrairTextoDePdf(
      pdfCom(['q 1 0 0 1 0 0 cm /Fm0 Do Q'], {
        recursos: '<< /XObject << /Fm0 5 0 R >> >>',
        extras: formXObject(5, LAUDO_SINTETICO),
      }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
    expect(r.texto).toContain('Glicose de jejum 92 mg/dL');
    expect(r.paginas).toBe(1);
  });

  it('fonte CID COM /ToUnicode não é recusada de saída — o portão é sobre a ausência do mapa', () => {
    // O portão estrutural não pode virar "PDF moderno não passa": quem embute Type0 e
    // entrega o mapa produz texto copiável, e esse texto é lido normalmente.
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { extras: FONTE_CID_COM_MAPA }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
  });

  it('ignora um XObject de imagem posto DEPOIS dos content streams', () => {
    // O nome antigo dizia "no meio do arquivo" e o `extras` cai no FIM, depois de todos os
    // content streams — o caso caro (objeto pequeno colado ANTES do stream) não era
    // exercido por ele. Quem exerce aquele caso são os dois testes de `antes:` acima; este
    // aqui guarda o outro lado: objeto solto no fim não pode virar texto de página.
    // Um XObject de imagem com bytes que casariam com qualquer heurística frouxa.
    const imagem =
      '90 0 obj << /Type /XObject /Subtype /Image /Width 8 /Height 8 /Length 12 /Filter /DCTDecode >>\n' +
      'stream\n\xff\xd8\xff\xe0BTTjTJ\xff\xd9\nendstream endobj\n';
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { extras: imagem }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
  });
});

describe('extrairTextoDePdf — quando NÃO dá pra ler, ele diz', () => {
  it('PDF escaneado (a folha é uma foto): motivo escaneado, nunca texto inventado', () => {
    // Página sem NENHUM operador de texto — só o desenho da imagem. É exatamente o que
    // sai de um scanner ou do "imprimir pra PDF" de uma foto.
    const soImagem = 'q 595 0 0 842 0 0 cm /Im1 Do Q';
    const r = extrairTextoDePdf(pdfCom([soImagem], { comprimir: true }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('escaneado');
    expect(r.paginas).toBe(1);
  });

  it('PDF com senha: motivo protegido, sem tentar adivinhar', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { encriptado: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('protegido');
  });

  it('fonte CID sem mapa de unicode: motivo em vez de palavra aleatória', () => {
    // Identity-H escreve índice de GLIFO em hex. Sem /ToUnicode, transformar índice em
    // caractere dá sequência sem sentido — e "sequência sem sentido" num laudo é pior
    // que "não consegui ler", porque ela seria mandada ao modelo como se fosse o exame.
    const cid =
      'BT /F1 10 Tf 72 700 Td <0003004500520051> Tj 0 -14 Td <0048005500560052> Tj ET';
    const r = extrairTextoDePdf(pdfCom([cid]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 'texto_ilegivel' e não 'escaneado': o PDF TEM texto, o que falta é o mapa da fonte.
    // Errar o motivo aqui manda o paciente consertar a coisa errada.
    expect(r.motivo).toBe('texto_ilegivel');
  });

  it('PÁGINA INTEIRA de fonte CID (subset de ~90 glifos): recusa em vez de entregar sopa', () => {
    // ESTA é a fixture que pega a regressão — a de 8 glifos passa mesmo com o detector
    // quebrado, porque cai numa faixa alta. Aqui o subset é do tamanho do de um laudo real
    // de uma página, e o resultado media `ok:true` com 474 "letras", 0% de minúsculas e o
    // texto `%QW9+WWAC)I!C1=)A?'#!3#S…`. Esse lixo descia pro prompt anunciado como "eu
    // extraí o TEXTO dele pra você", seguido de "chame save_exam_result com os marcadores
    // que você leu": exame fictício gravado no prontuário de alguém.
    const r = extrairTextoDePdf(pdfCom([sopaDeGlifos(1, 90)], { comprimir: true }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('texto_ilegivel');
  });

  it('subset CID só de MAIÚSCULAS (sem nenhum controle) também é recusado', () => {
    // A faixa 65..90 é a armadilha da armadilha: sopa sem um único caractere de controle,
    // que passa pela contagem de controle e pela de caracteres estranhos. O que a delata é
    // não ter minúscula nenhuma — texto em PT-BR mede de 50% a 90%.
    const r = extrairTextoDePdf(pdfCom([sopaDeGlifos(65, 90)]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('texto_ilegivel');
  });

  it('fonte Type0/Identity-H declarada SEM /ToUnicode: recusa pela estrutura, antes da estatística', () => {
    // Porta da frente: o arquivo DIZ que os bytes das strings são índices de glifo e não
    // entrega o mapa. Não depende de a sopa "parecer" sopa — se dependesse, um subset em
    // faixa imprimível passaria.
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO], { extras: FONTE_CID_SEM_MAPA }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('texto_ilegivel');
  });

  it('para de inflar ao estourar o orçamento TOTAL, não só o de cada stream', () => {
    // O teto de 8 MB era por stream, e `MAX_STREAMS` é 400 — 3,2 GB de inflate sequencial
    // na thread que atende todo mundo, porque a extração roda dentro do handler HTTP.
    //
    // O que o teste observa é a consequência determinística do orçamento de 32 MB: quatro
    // streams de 8 MB o esgotam, e o content stream que vem DEPOIS não chega a ser lido.
    // Perder o laudo atrás de 32 MB de lixo é o lado certo do erro — o veredicto é
    // honesto ("não li"), nunca texto inventado.
    const bomba = deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    const lixo = Array.from({ length: 4 }, (_, i) =>
      Buffer.concat([
        Buffer.from(`${50 + i} 0 obj << /Length ${bomba.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        bomba,
        Buffer.from('\nendstream endobj\n', 'latin1'),
      ]),
    );
    const pdf = pdfCom([LAUDO_SINTETICO], { antes: Buffer.concat(lixo).toString('latin1') });

    const r = extrairTextoDePdf(pdf);
    expect(r.ok).toBe(false);
  });

  it('arquivo que não é PDF: recusa pelos bytes, sem olhar extensão', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x41)]);
    expect(extrairTextoDePdf(jpeg)).toEqual({ ok: false, motivo: 'nao_e_pdf', paginas: 0 });
    expect(extrairTextoDePdf(Buffer.alloc(0))).toEqual({ ok: false, motivo: 'nao_e_pdf', paginas: 0 });
    expect(extrairTextoDePdf(null)).toEqual({ ok: false, motivo: 'nao_e_pdf', paginas: 0 });
  });

  it('PDF vazio de conteúdo não vira sucesso com texto vazio', () => {
    const r = extrairTextoDePdf(pdfCom(['q Q']));
    expect(r.ok).toBe(false);
  });

  it('aguenta stream corrompido sem derrubar a leitura das outras páginas', () => {
    const bom = pdfCom([LAUDO_SINTETICO], { comprimir: true });
    // Corrompe o PRIMEIRO stream trocando bytes do meio do bloco comprimido.
    const cru = bom.toString('latin1');
    const inicio = cru.indexOf('stream\n') + 7;
    const quebrado = Buffer.from(bom);
    quebrado.fill(0x41, inicio + 2, inicio + 8);

    const r = extrairTextoDePdf(quebrado);
    // O importante é NÃO lançar; sem stream legível, o veredicto é honesto.
    expect(r.ok).toBe(false);
  });

  it('não estoura a memória com stream que infla demais (zip bomb)', () => {
    const bomba = deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x20));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n3 0 obj << /Type /Page >> endobj\n', 'latin1'),
      Buffer.from(`4 0 obj << /Length ${bomba.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      bomba,
      Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);

    const r = extrairTextoDePdf(pdf);
    expect(r.ok).toBe(false);
  });
});

describe('extrairTextoDePdf — o corte', () => {
  it('corta no teto e DIZ quantos caracteres o laudo tinha', () => {
    // 400 linhas de analito: passa dos 3000 com folga.
    const linhas = Array.from(
      { length: 400 },
      (_, i) => `0 -14 Td (Analito ${i} valor ${i},5 mg/dL) Tj`,
    );
    const conteudo = `BT /F1 10 Tf 72 780 Td\n${linhas.join('\n')}\nET`;
    const r = extrairTextoDePdf(pdfCom([conteudo], { comprimir: true }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto.length).toBeLessThanOrEqual(MAX_CARACTERES_PDF);
    expect(r.truncado).toBe(true);
    // O contador é o que impede o corte de ser silencioso.
    expect(r.caracteres).toBeGreaterThan(MAX_CARACTERES_PDF);
    // Corta em fim de linha: valor partido no meio ("13," ) é pior que valor ausente.
    expect(r.texto.endsWith('mg/dL')).toBe(true);
  });

  it('respeita um teto menor passado por parâmetro', () => {
    const r = extrairTextoDePdf(pdfCom([LAUDO_SINTETICO]), { maxCaracteres: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto.length).toBeLessThanOrEqual(60);
    expect(r.truncado).toBe(true);
  });
});

describe('mensagemDePdfIlegivel', () => {
  it('cada motivo tem saída acionável pro paciente, e nenhuma culpa ele', () => {
    const todos = (['nao_e_pdf', 'protegido', 'escaneado', 'texto_ilegivel'] as const).map(
      mensagemDePdfIlegivel,
    );
    for (const m of todos) expect(m.length).toBeGreaterThan(20);
    // As três em que o arquivo JÁ está guardado precisam dizer isso — o paciente mandou
    // o exame dele e não pode ficar achando que sumiu.
    for (const motivo of ['protegido', 'escaneado', 'texto_ilegivel'] as const) {
      expect(mensagemDePdfIlegivel(motivo)).toMatch(/guardado/i);
    }
    expect(mensagemDePdfIlegivel('escaneado')).toMatch(/foto/i);
  });
});
