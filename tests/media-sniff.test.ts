import { describe, it, expect } from 'vitest';
import {
  MAX_BYTES,
  contentTypeDoPipeline,
  mensagemDeRecusa,
  sniffMidia,
} from '../apps/api/src/lib/media-sniff.js';

/**
 * A leitura dos bytes reais do arquivo.
 *
 * Este módulo é a fronteira entre "o paciente mandou alguma coisa" e "o sistema vai
 * processar isso". Cada teste corresponde a uma forma de a fronteira ser atravessada:
 * arquivo mentindo sobre o que é, formato que o pipeline não sabe tratar, ou um
 * container ambíguo indo pro caminho errado.
 */

/** Monta um buffer com uma assinatura no começo e lixo depois. */
function comAssinatura(bytes: number[], tamanho = 64): Buffer {
  const b = Buffer.alloc(tamanho, 0x00);
  Buffer.from(bytes).copy(b, 0);
  return b;
}

function ftyp(marca: string): Buffer {
  const b = Buffer.alloc(64, 0x00);
  b.write('\0\0\0\x20', 0, 'latin1'); // tamanho da box
  b.write('ftyp', 4, 'latin1');
  b.write(marca, 8, 'latin1');
  return b;
}

describe('imagens', () => {
  it('reconhece JPEG', () => {
    const r = sniffMidia(comAssinatura([0xff, 0xd8, 0xff, 0xe0]));
    expect(r).toMatchObject({ ok: true, tipo: 'image', mime: 'image/jpeg' });
  });

  it('reconhece PNG pelos 8 bytes completos', () => {
    const r = sniffMidia(comAssinatura([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(r).toMatchObject({ ok: true, tipo: 'image', mime: 'image/png' });
  });

  it('NÃO aceita PNG com assinatura truncada', () => {
    // Só "\x89PNG" casaria numa checagem preguiçosa de 4 bytes.
    const b = comAssinatura([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffMidia(b).ok).toBe(false);
  });

  it('reconhece WebP e não o confunde com WAV', () => {
    const webp = Buffer.alloc(64);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    expect(sniffMidia(webp)).toMatchObject({ tipo: 'image', mime: 'image/webp' });
  });
});

describe('o container ambíguo — HEIC e M4A dividem o mesmo cabeçalho', () => {
  it('marca de foto do iPhone vira IMAGEM', () => {
    expect(sniffMidia(ftyp('heic'))).toMatchObject({ tipo: 'image', mime: 'image/heic' });
    expect(sniffMidia(ftyp('mif1'))).toMatchObject({ tipo: 'image' });
  });

  it('marca de áudio vira ÁUDIO', () => {
    // Confundir os dois manda um áudio pro modelo de VISÃO, que responderia qualquer
    // coisa sobre uma imagem que não existe.
    expect(sniffMidia(ftyp('M4A '))).toMatchObject({ tipo: 'audio', mime: 'audio/mp4' });
    expect(sniffMidia(ftyp('mp42'))).toMatchObject({ tipo: 'audio' });
  });

  it('marca DESCONHECIDA no container conhecido é RECUSADA, não adivinhada', () => {
    // Vídeo, por exemplo. Adivinhar aqui é escolher um pipeline errado no escuro.
    expect(sniffMidia(ftyp('qt  '))).toEqual({ ok: false, motivo: 'formato_nao_suportado' });
  });
});

describe('áudio', () => {
  it('reconhece OGG, WAV e MP3', () => {
    const ogg = Buffer.alloc(32);
    ogg.write('OggS', 0, 'latin1');
    expect(sniffMidia(ogg)).toMatchObject({ tipo: 'audio', mime: 'audio/ogg' });

    const wav = Buffer.alloc(32);
    wav.write('RIFF', 0, 'latin1');
    wav.write('WAVE', 8, 'latin1');
    expect(sniffMidia(wav)).toMatchObject({ tipo: 'audio', mime: 'audio/wav' });

    const id3 = Buffer.alloc(32);
    id3.write('ID3', 0, 'latin1');
    expect(sniffMidia(id3)).toMatchObject({ tipo: 'audio', mime: 'audio/mpeg' });
  });

  it('reconhece MP3 cru, sem tag ID3', () => {
    expect(sniffMidia(comAssinatura([0xff, 0xfb, 0x90, 0x00]))).toMatchObject({ tipo: 'audio' });
  });
});

describe('documento', () => {
  it('reconhece PDF — laboratório manda laudo em PDF', () => {
    const pdf = Buffer.from('%PDF-1.7\nresto do arquivo');
    expect(sniffMidia(pdf)).toMatchObject({ ok: true, tipo: 'document', mime: 'application/pdf' });
  });
});

describe('o que é RECUSADO', () => {
  it('executável renomeado para .jpg não passa', () => {
    // O ataque que este módulo existe pra impedir: a etiqueta diz image/jpeg, os bytes
    // dizem outra coisa. Quem manda escolhe a etiqueta; os bytes, não.
    const exe = comAssinatura([0x4d, 0x5a, 0x90, 0x00]); // "MZ" — PE do Windows
    expect(sniffMidia(exe)).toEqual({ ok: false, motivo: 'formato_nao_suportado' });
  });

  it('ELF, ZIP e script de shell não passam', () => {
    expect(sniffMidia(comAssinatura([0x7f, 0x45, 0x4c, 0x46])).ok).toBe(false); // ELF
    expect(sniffMidia(comAssinatura([0x50, 0x4b, 0x03, 0x04])).ok).toBe(false); // ZIP
    expect(sniffMidia(Buffer.from('#!/bin/sh\nrm -rf /')).ok).toBe(false);
  });

  it('SVG não passa — é XML e pode carregar script', () => {
    expect(sniffMidia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')).ok).toBe(false);
  });

  it('arquivo vazio e nulo são recusados sem quebrar', () => {
    expect(sniffMidia(Buffer.alloc(0))).toEqual({ ok: false, motivo: 'vazio' });
    expect(sniffMidia(null as unknown as Buffer)).toEqual({ ok: false, motivo: 'vazio' });
  });

  it('arquivo grande demais é recusado ANTES de olhar o conteúdo', () => {
    const gigante = Buffer.alloc(MAX_BYTES + 1);
    Buffer.from([0xff, 0xd8, 0xff]).copy(gigante, 0); // JPEG válido, mas grande
    expect(sniffMidia(gigante)).toEqual({ ok: false, motivo: 'muito_grande' });
  });

  it('buffer curto demais pra ter assinatura não estoura', () => {
    // Um `buf[8]` num buffer de 2 bytes seria `undefined` — a checagem de tamanho
    // precisa vir antes de qualquer leitura.
    expect(sniffMidia(Buffer.from([0xff])).ok).toBe(false);
    expect(sniffMidia(Buffer.from('RI')).ok).toBe(false);
  });
});

describe('mensagemDeRecusa', () => {
  it('cada motivo tem uma orientação diferente e acionável', () => {
    const msgs = (['vazio', 'muito_grande', 'formato_nao_suportado'] as const).map(mensagemDeRecusa);
    expect(new Set(msgs).size).toBe(3);
    expect(mensagemDeRecusa('muito_grande')).toContain('10 MB');
    // Diz o que FAZER, não só o que deu errado.
    expect(mensagemDeRecusa('formato_nao_suportado')).toMatch(/foto|PDF|áudio/i);
  });
});

describe('contentTypeDoPipeline', () => {
  it('áudio vai pra transcrição, imagem e PDF vão pra visão', () => {
    expect(contentTypeDoPipeline('audio')).toBe('audio');
    expect(contentTypeDoPipeline('image')).toBe('image');
    // PDF de laudo entra pelo mesmo caminho da foto — não existe terceira via, e um
    // tipo separado aqui viraria um ramo sem implementação.
    expect(contentTypeDoPipeline('document')).toBe('image');
  });
});
