/**
 * O leitor de PDF de verdade (caso Ciro, 18/09/2026): laudo com fonte Type0/Identity-H e
 * `/ToUnicode` — a estrutura dos PDFs da Dasa e do IGR — tem que ser LIDO, não recusado.
 * O fixture é sintético (Arial embutida por subset, sem dado de paciente), mas reproduz
 * exatamente o veredito errado do leitor antigo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lerPdfCompleto } from '../packages/integrations/src/pdf-leitor';
import { extrairTextoDePdf } from '../packages/integrations/src/pdf-texto';

const FIXTURE = readFileSync(new URL('./fixtures/laudo-type0.pdf', import.meta.url));

describe('lerPdfCompleto — fontes compostas', () => {
  it('o leitor antigo reprova o laudo Type0 como "texto_ilegivel" (o bug de 18/09)', () => {
    const r = extrairTextoDePdf(FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('texto_ilegivel');
  });
  it('o leitor novo lê o laudo inteiro, com acento, unidade e as 2 páginas', async () => {
    const r = await lerPdfCompleto(FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paginas).toBe(2);
    expect(r.texto).toContain('Hemograma com Contagem de Plaquetas');
    expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
    expect(r.texto).toContain('Hematócrito');
    expect(r.texto).toContain('Creatinina 0,9 mg/dL');
    expect(r.truncado).toBe(false);
  });
  it('respeita o teto de caracteres e marca truncado', async () => {
    const r = await lerPdfCompleto(FIXTURE, { maxCaracteres: 60 });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.texto.length).toBe(60); expect(r.truncado).toBe(true); expect(r.caracteres).toBeGreaterThan(60); }
  });
});

describe('lerPdfCompleto — as recusas honestas continuam', () => {
  it('não-PDF → nao_e_pdf; vazio → nao_e_pdf', async () => {
    expect((await lerPdfCompleto(Buffer.from('isto não é um pdf'))).ok).toBe(false);
    expect(((await lerPdfCompleto(Buffer.from('oi'))) as { motivo: string }).motivo).toBe('nao_e_pdf');
    expect(((await lerPdfCompleto(null)) as { motivo: string }).motivo).toBe('nao_e_pdf');
  });
  it('folha escaneada (só imagem, sem operador de texto) → escaneado', async () => {
    // PDF mínimo válido com uma página sem texto
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 0>>stream\n\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1');
    const r = await lerPdfCompleto(pdf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('escaneado');
  });
});
