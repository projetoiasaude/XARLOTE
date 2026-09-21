/**
 * O LEITOR DE PDF DE VERDADE (caso Ciro, 18/09/2026).
 *
 * O paciente mandou o laudo da Dasa (12 páginas) e o da RM do IGR (1 página). Os dois são
 * PDFs de texto comuns — e os dois voltaram como "não consegui ler o texto". O leitor
 * escrito à mão em `pdf-texto.ts` cobre "fonte com codificação de 1 byte", e laudo de
 * laboratório moderno (Dasa, IGR, qualquer coisa gerada por Chrome/Java/.NET) usa fonte
 * Type0/Identity-H com mapa `/ToUnicode`: a extração devolvia índice de glifo em vez de
 * letra, a checagem estatística reprovava, e o paciente era mandado tirar foto de uma
 * folha que a máquina lia. Duas vezes na mesma noite, no primeiro uso real da frente.
 *
 * Aqui o texto sai do pdf.js (Mozilla) — que decodifica CMaps, fontes compostas e
 * cifragem de senha vazia como qualquer leitor de PDF faz. As RECUSAS honestas continuam
 * as mesmas, e continuam decididas pela mesma régua de `pdf-texto.ts`:
 *   · senha de verdade → `protegido`;
 *   · nenhum texto (folha escaneada) → `escaneado` — foto/visão resolve;
 *   · texto que não passa na estatística de "isto é português" → `texto_ilegivel`;
 *   · o pdf.js explodiu → cai no leitor antigo; se ele também não ler → `falha_ao_ler`.
 * Nunca lança. O que sai daqui é o mesmo `LeituraDePdf` que os chamadores já conheciam.
 */
import { extrairTextoDePdf, temTextoDeVerdade, compactar, MAX_CARACTERES_PDF, type LeituraDePdf } from './pdf-texto.js';

/** Páginas além disto não são lidas — um laudo tem 1–20; 60 é folga, não convite. */
const MAX_PAGINAS = 60;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
function carregarPdfJs(): Promise<PdfJs> {
  // Import dinâmico: o módulo é pesado (~1,5 MB) e só é necessário quando chega um PDF.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function lerPdfCompleto(
  buf: Buffer | null | undefined,
  opcoes: { maxCaracteres?: number } = {},
): Promise<LeituraDePdf> {
  const max = opcoes.maxCaracteres ?? MAX_CARACTERES_PDF;
  if (!buf || buf.length < 5 || buf.toString('latin1', 0, 5) !== '%PDF-') {
    return { ok: false, motivo: 'nao_e_pdf', paginas: 0 };
  }

  let pdfjs: PdfJs;
  try {
    pdfjs = await carregarPdfJs();
  } catch {
    return extrairTextoDePdf(buf, opcoes);
  }

  let doc: Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    const nome = (err as { name?: string } | null)?.name ?? '';
    if (nome === 'PasswordException') return { ok: false, motivo: 'protegido', paginas: 0 };
    // Arquivo que o pdf.js não abre: o leitor antigo dá o veredito (ele nunca lança).
    return extrairTextoDePdf(buf, opcoes);
  }

  const paginas = doc.numPages;
  const linhas: string[] = [];
  let itensDeTexto = 0;
  let bruto = 0;
  try {
    for (let i = 1; i <= Math.min(paginas, MAX_PAGINAS); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let linha = '';
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        itensDeTexto++;
        linha += it.str;
        if (it.hasEOL) { linhas.push(linha); linha = ''; } else linha += ' ';
      }
      if (linha.trim()) linhas.push(linha);
      linhas.push('');
      bruto += linha.length;
      // Teto de leitura: o chamador corta de qualquer jeito; ler 60 páginas pra jogar fora é custo.
      if (linhas.join('\n').length > max * 4) break;
    }
  } catch {
    return extrairTextoDePdf(buf, opcoes);
  } finally {
    try { await doc.destroy(); } catch { /* nada a fazer */ }
  }

  if (itensDeTexto === 0) return { ok: false, motivo: 'escaneado', paginas };

  const junto = linhas.join('\n');
  const texto = compactar(junto);
  if (!temTextoDeVerdade(junto, texto)) return { ok: false, motivo: 'texto_ilegivel', paginas };

  const caracteres = texto.length;
  void bruto;
  return {
    ok: true,
    texto: caracteres > max ? texto.slice(0, max) : texto,
    paginas,
    caracteres,
    truncado: caracteres > max,
  };
}
