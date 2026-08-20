import { describe, it, expect } from 'vitest';
import {
  lerDocumentoDaResposta,
  milhar,
  resumoDoDocumento,
} from '../apps/mobile/src/features/media/pdf-documento.js';

/**
 * O que o app faz com o que o servidor leu do PDF.
 *
 * Duas guardas moram aqui, e as duas já custaram caro nesta base:
 *
 * 1. **Tipo declarado à mão sobre JSON de rede não valida nada.** `lerDocumentoDaResposta`
 *    CONFERE o formato em vez de afirmar — se o servidor mudar, a prévia fica calada, não
 *    mostra `undefined páginas` na cara do paciente.
 * 2. **PDF que não deu pra ler tem que DIZER isso.** Se essa frase sumir, a pessoa acha
 *    que mandou o exame e a Xarlote responde sobre um laudo que ninguém abriu.
 *
 * Nenhum laudo real aqui: os números são inventados e não há nome de gente.
 */

const LIDO = { texto: 'Hemoglobina 13,2 g/dL', paginas: 2, caracteres: 1842, truncado: false };
const ILEGIVEL = {
  texto: null,
  paginas: 3,
  motivo: 'escaneado',
  aviso: 'Esse PDF é uma folha escaneada (uma imagem), então não tem texto pra eu ler.',
};

describe('lerDocumentoDaResposta — confere, não declara', () => {
  it('lê a resposta de um PDF que deu certo', () => {
    expect(lerDocumentoDaResposta(LIDO)).toEqual(LIDO);
  });

  it('lê a resposta de um PDF ilegível preservando motivo e aviso', () => {
    expect(lerDocumentoDaResposta(ILEGIVEL)).toEqual(ILEGIVEL);
  });

  it('devolve undefined pro que não tem forma de documento', () => {
    // Sem o campo (foto e áudio), e as formas que um servidor mudado poderia mandar.
    expect(lerDocumentoDaResposta(undefined)).toBeUndefined();
    expect(lerDocumentoDaResposta(null)).toBeUndefined();
    expect(lerDocumentoDaResposta('lido')).toBeUndefined();
    expect(lerDocumentoDaResposta({ paginas: 2 })).toBeUndefined();
    expect(lerDocumentoDaResposta({ texto: 42 })).toBeUndefined();
  });

  it('número que não é número não vira NaN na tela', () => {
    const r = lerDocumentoDaResposta({ texto: 'abc', paginas: 'duas', caracteres: null });
    expect(r).toEqual({ texto: 'abc', paginas: 0, caracteres: 3, truncado: false });
  });

  it('ilegível SEM aviso do servidor ainda diz que não leu — nunca fica mudo', () => {
    const r = lerDocumentoDaResposta({ texto: null, paginas: 1 });
    expect(r?.texto).toBeNull();
    if (!r || r.texto !== null) return;
    expect(r.aviso.length).toBeGreaterThan(20);
    expect(r.aviso).toMatch(/não consegui ler/i);
    expect(r.motivo).toBe('falha_ao_ler');
  });
});

describe('resumoDoDocumento — a frase que o paciente lê', () => {
  it('PDF lido: diz quantas páginas e quanto texto entrou', () => {
    const r = resumoDoDocumento(LIDO);
    expect(r.tom).toBe('ok');
    expect(r.texto).toContain('2 páginas');
    expect(r.texto).toContain('1.842 caracteres');
  });

  it('uma página é "1 página", não "1 páginas"', () => {
    expect(resumoDoDocumento({ ...LIDO, paginas: 1 }).texto).toContain('1 página,');
  });

  it('sem contagem de páginas, a frase não inventa o número', () => {
    const t = resumoDoDocumento({ ...LIDO, paginas: 0 }).texto;
    expect(t).not.toContain('página');
    expect(t).toContain('1.842 caracteres');
  });

  it('PDF ilegível: repete o recado do servidor e muda de tom', () => {
    const r = resumoDoDocumento(ILEGIVEL);
    expect(r.tom).toBe('aviso');
    expect(r.texto).toBe(ILEGIVEL.aviso);
    // O que não pode acontecer é a frase falar de caracteres lidos num arquivo que não
    // foi lido — seria a prévia mentindo sobre o exame.
    expect(r.texto).not.toMatch(/caracteres de texto/);
  });
});

describe('milhar', () => {
  it('agrupa sem depender do locale do aparelho', () => {
    expect(milhar(0)).toBe('0');
    expect(milhar(999)).toBe('999');
    expect(milhar(1000)).toBe('1.000');
    expect(milhar(12345)).toBe('12.345');
    expect(milhar(1234567)).toBe('1.234.567');
    expect(milhar(-5)).toBe('0');
  });
});
