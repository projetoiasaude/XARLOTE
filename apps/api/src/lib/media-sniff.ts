/**
 * O que o arquivo REALMENTE é — lido dos primeiros bytes, nunca do que o cliente disse.
 *
 * ## Por que não confiar no `content-type` do upload
 *
 * Ele é escolhido por quem envia. Um `.exe` renomeado para `.jpg` chega anunciado como
 * `image/jpeg`, e a partir daí ele é tratado como imagem: guardado no bucket, servido por
 * URL assinada, e mandado pro modelo de visão. Aceitar a etiqueta é aceitar que o
 * remetente decida o que o sistema vai processar.
 *
 * A leitura dos bytes iniciais (a "assinatura mágica") é o oposto: o formato é uma
 * propriedade do conteúdo, e conteúdo o remetente não consegue falsificar sem virar
 * realmente aquele formato.
 *
 * ## Lista de PERMISSÃO, não de bloqueio
 *
 * O que não for reconhecido é recusado. Uma lista de bloqueio precisaria antecipar todo
 * formato perigoso que existe e todo que vai existir; a de permissão só precisa saber o
 * que o produto usa — foto de exame, receita em PDF, e áudio de voz.
 *
 * PURO: recebe bytes, devolve veredicto. Zero I/O.
 */

export type TipoMidia = 'image' | 'audio' | 'document';

export interface MidiaReconhecida {
  ok: true;
  tipo: TipoMidia;
  /** O mime REAL, derivado dos bytes — é este que vai pro banco e pro Storage. */
  mime: string;
  extensao: string;
}

export interface MidiaRecusada {
  ok: false;
  motivo: 'vazio' | 'muito_grande' | 'formato_nao_suportado';
}

export type VeredictoMidia = MidiaReconhecida | MidiaRecusada;

/**
 * 10 MB. Foto de celular moderna fica em 3-5 MB; PDF de laudo, menos.
 *
 * O limite existe por memória e por custo: o arquivo passa inteiro pela RAM do processo
 * antes de subir, e imagem grande vira token caro no modelo de visão.
 */
export const MAX_BYTES = 10 * 1024 * 1024;

/** Compara bytes crus numa posição. */
function casa(buf: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Compara ASCII numa posição — mais legível que a lista de bytes pra 'RIFF', 'ftyp'. */
function casaAscii(buf: Buffer, offset: number, texto: string): boolean {
  if (buf.length < offset + texto.length) return false;
  return buf.toString('latin1', offset, offset + texto.length) === texto;
}

/**
 * Marcas de container ISO-BMFF (`ftyp` no offset 4).
 *
 * HEIC (foto do iPhone) e M4A (áudio do gravador) compartilham o MESMO container — a
 * diferença está só na marca em 8..11. Confundir os dois manda um áudio pro modelo de
 * visão, que responde qualquer coisa sobre uma imagem que não existe.
 */
const MARCAS_IMAGEM = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'] as const;
const MARCAS_AUDIO = ['M4A ', 'M4B ', 'mp42', 'isom', 'iso2', 'dash'] as const;

export function sniffMidia(buf: Buffer): VeredictoMidia {
  if (!buf || buf.length === 0) return { ok: false, motivo: 'vazio' };
  if (buf.length > MAX_BYTES) return { ok: false, motivo: 'muito_grande' };

  // ── Imagens ────────────────────────────────────────────────────────────────
  // JPEG: FF D8 FF
  if (casa(buf, 0, [0xff, 0xd8, 0xff])) {
    return { ok: true, tipo: 'image', mime: 'image/jpeg', extensao: 'jpg' };
  }
  // PNG: 89 "PNG" CR LF SUB LF — os 8 bytes completos, porque os 4 primeiros sozinhos
  // casariam com arquivos que só começam parecido.
  if (casa(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, tipo: 'image', mime: 'image/png', extensao: 'png' };
  }
  // WebP: "RIFF" ... "WEBP" (o RIFF sozinho também é WAV — a marca em 8 desempata).
  if (casaAscii(buf, 0, 'RIFF') && casaAscii(buf, 8, 'WEBP')) {
    return { ok: true, tipo: 'image', mime: 'image/webp', extensao: 'webp' };
  }
  // GIF: aceito por completude (alguém manda print de GIF), nunca é exame.
  if (casaAscii(buf, 0, 'GIF87a') || casaAscii(buf, 0, 'GIF89a')) {
    return { ok: true, tipo: 'image', mime: 'image/gif', extensao: 'gif' };
  }

  // ── Container ISO-BMFF: HEIC ou M4A, decidido pela MARCA ────────────────────
  if (casaAscii(buf, 4, 'ftyp')) {
    const marca = buf.toString('latin1', 8, 12);
    if (MARCAS_IMAGEM.includes(marca as (typeof MARCAS_IMAGEM)[number])) {
      return { ok: true, tipo: 'image', mime: 'image/heic', extensao: 'heic' };
    }
    if (MARCAS_AUDIO.includes(marca as (typeof MARCAS_AUDIO)[number])) {
      return { ok: true, tipo: 'audio', mime: 'audio/mp4', extensao: 'm4a' };
    }
    // Container conhecido, marca desconhecida: RECUSA. Adivinhar aqui é justamente
    // arriscar mandar vídeo ou outra coisa pro pipeline errado.
    return { ok: false, motivo: 'formato_nao_suportado' };
  }

  // ── Áudio ──────────────────────────────────────────────────────────────────
  if (casaAscii(buf, 0, 'OggS')) {
    return { ok: true, tipo: 'audio', mime: 'audio/ogg', extensao: 'ogg' };
  }
  if (casaAscii(buf, 0, 'RIFF') && casaAscii(buf, 8, 'WAVE')) {
    return { ok: true, tipo: 'audio', mime: 'audio/wav', extensao: 'wav' };
  }
  // MP3: com tag ID3, ou frame sync cru (FF Ex/Fx).
  if (casaAscii(buf, 0, 'ID3')) {
    return { ok: true, tipo: 'audio', mime: 'audio/mpeg', extensao: 'mp3' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && ((buf[1]! & 0xe0) === 0xe0)) {
    return { ok: true, tipo: 'audio', mime: 'audio/mpeg', extensao: 'mp3' };
  }

  // ── Documento ──────────────────────────────────────────────────────────────
  // PDF de laudo é caso REAL: laboratório manda o resultado em PDF.
  if (casaAscii(buf, 0, '%PDF-')) {
    return { ok: true, tipo: 'document', mime: 'application/pdf', extensao: 'pdf' };
  }

  return { ok: false, motivo: 'formato_nao_suportado' };
}

/** A mensagem que o paciente lê quando o arquivo é recusado. */
export function mensagemDeRecusa(motivo: MidiaRecusada['motivo']): string {
  switch (motivo) {
    case 'vazio':
      return 'O arquivo chegou vazio. Tenta enviar de novo?';
    case 'muito_grande':
      return 'Esse arquivo é grande demais (o limite é 10 MB). Se for foto, tenta tirar de novo com menos zoom.';
    case 'formato_nao_suportado':
      return 'Não consigo ler esse tipo de arquivo. Manda uma foto (JPG, PNG ou HEIC), um PDF, ou um áudio.';
  }
}

/**
 * O `contentType` de `NormalizedInbound` — o que decide o PIPELINE.
 *
 * `document` entra como `image` de propósito: o extrator de exames trata PDF de laudo
 * pelo mesmo caminho da foto, e não existe uma terceira via. Manter um tipo separado
 * aqui criaria um ramo sem implementação, que é como uma foto de laudo em PDF sumiria
 * sem ninguém notar.
 */
export function contentTypeDoPipeline(tipo: TipoMidia): 'image' | 'audio' {
  return tipo === 'audio' ? 'audio' : 'image';
}
