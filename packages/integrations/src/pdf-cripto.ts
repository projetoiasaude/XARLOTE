/**
 * Decifra o PDF que "tem senha" mas abre sem pedir nenhuma.
 *
 * ## O caso real que trouxe este arquivo
 *
 * Um laudo enviado em 21/08 foi recusado com "esse PDF está protegido por senha", e o
 * paciente respondeu que ele abre normalmente. Os dois estavam certos:
 *
 *     /Encrypt 1 0 R   /Filter /Standard   /V 2   /R 3   /Length 128   /P 4
 *
 * O arquivo É cifrado — até o nome do gerador sai embaralhado. Mas a senha de USUÁRIO é
 * vazia: o laboratório pôs só a senha de DONO, que restringe cópia e edição. Qualquer
 * leitor abre sem perguntar nada, porque a chave sai da senha vazia. Isso não é exceção:
 * é o jeito padrão de marcar um laudo como "não copie", e portanto é o formato mais
 * provável de chegar aqui.
 *
 * Parar no `/Encrypt` mandava o paciente fotografar uma folha que a máquina já lia.
 *
 * ## O que este módulo faz, e o que não faz
 *
 * Implementa o *standard security handler* do PDF (ISO 32000-1, §7.6.3) para a senha de
 * usuário VAZIA — RC4 de 40/128 bits (V1/V2) e AES-128 (V4/AESV2). Ele **verifica** que a
 * senha vazia realmente abre antes de decifrar: se o arquivo pedir senha de verdade, a
 * verificação falha e o chamador continua devolvendo `protegido`, que é a verdade.
 *
 * NÃO tenta adivinhar senha, e não implementa AES-256 (V5/R6) — ali a derivação é outra
 * (SHA-256 endurecido), e chutar seria devolver lixo com cara de texto.
 *
 * PURO: bytes entram, bytes saem. Sem I/O, sem rede, sem relógio.
 */
import { createDecipheriv, createHash } from 'node:crypto';

/** O preenchimento fixo do padrão, §7.6.3.3. Toda senha é completada até 32 bytes com ele. */
export const ENCHIMENTO = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export interface ParametrosDeCripto {
  /** Algoritmo: 1 e 2 são RC4; 4 é RC4 ou AES-128 conforme o `/CFM`. */
  v: number;
  /** Revisão do handler: 2, 3 ou 4 aqui. */
  r: number;
  /** Tamanho da chave em BYTES (já convertido de `/Length`, que vem em bits). */
  bytesDeChave: number;
  o: Buffer;
  u: Buffer;
  /** `/P` é um inteiro COM SINAL de 32 bits — os bits altos das permissões o deixam negativo. */
  p: number;
  /** Primeiro elemento do `/ID` do trailer. Entra na derivação da chave. */
  id: Buffer;
  metadadosCifrados: boolean;
  aes: boolean;
}

/** RC4. Vinte linhas, e nenhuma dependência: o OpenSSL 3 tirou esta cifra do provedor padrão. */
export function rc4(chave: Buffer, dados: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + chave[i % chave.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }

  const saida = Buffer.allocUnsafe(dados.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < dados.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    saida[k] = dados[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return saida;
}

const md5 = (...partes: Buffer[]): Buffer => {
  const h = createHash('md5');
  for (const p of partes) h.update(p);
  return h.digest();
};

/**
 * Algoritmo 2: a chave do ARQUIVO, a partir de uma senha de usuário vazia.
 *
 * Senha vazia não significa "sem chave": ela vira os 32 bytes de enchimento, e é isso que
 * é batido junto do `/O`, das permissões e do `/ID`.
 */
export function chaveDeArquivo(p: ParametrosDeCripto): Buffer {
  const permissoes = Buffer.alloc(4);
  // Little-endian COM SINAL: `/P` costuma ser negativo (bits altos ligados), e escrever
  // como sem-sinal produziria outra chave — que decifra tudo em lixo silenciosamente.
  permissoes.writeInt32LE(p.p, 0);

  const partes = [ENCHIMENTO, p.o.subarray(0, 32), permissoes, p.id];
  if (p.r >= 4 && !p.metadadosCifrados) partes.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));

  let chave = md5(...partes);
  const n = p.r === 2 ? 5 : p.bytesDeChave;

  // As 50 rodadas não são superstição: elas encarecem a força bruta, e sem elas a chave
  // sai diferente da que o gerador usou.
  if (p.r >= 3) for (let i = 0; i < 50; i++) chave = md5(chave.subarray(0, n));

  return chave.subarray(0, n);
}

/**
 * Algoritmo 6: a senha vazia REALMENTE abre este arquivo?
 *
 * Sem esta verificação, um PDF com senha de verdade seria "decifrado" com a chave errada:
 * cada stream viraria ruído, o inflate falharia, e o resultado seria `escaneado` — ou
 * seja, o paciente ouviria "tira uma foto" sobre um arquivo que ninguém pode ler. Errar
 * o motivo é pior que recusar, porque manda a pessoa fazer algo que não vai funcionar.
 */
export function senhaVaziaAbre(p: ParametrosDeCripto, chave: Buffer): boolean {
  if (p.r === 2) return rc4(chave, ENCHIMENTO).equals(p.u.subarray(0, 32));

  let x = md5(ENCHIMENTO, p.id);
  x = rc4(chave, x);
  for (let i = 1; i <= 19; i++) {
    const variante = Buffer.from(chave.map((b) => b ^ i));
    x = rc4(variante, x);
  }
  // Só os 16 primeiros bytes: os 16 finais do `/U` são enchimento arbitrário do gerador.
  return x.subarray(0, 16).equals(p.u.subarray(0, 16));
}

/** Algoritmo 1: a chave DESTE objeto. Cada objeto tem a sua, derivada do número dele. */
export function chaveDoObjeto(chaveArquivo: Buffer, numero: number, geracao: number, aes: boolean): Buffer {
  const extra = Buffer.from([
    numero & 0xff,
    (numero >> 8) & 0xff,
    (numero >> 16) & 0xff,
    geracao & 0xff,
    (geracao >> 8) & 0xff,
  ]);
  const partes = aes ? [chaveArquivo, extra, Buffer.from([0x73, 0x41, 0x6c, 0x54])] : [chaveArquivo, extra];
  return md5(...partes).subarray(0, Math.min(chaveArquivo.length + 5, 16));
}

/** Decifra um stream com a chave do objeto dele. `null` quando os bytes não fazem sentido. */
export function decifrar(dados: Buffer, chaveObj: Buffer, aes: boolean): Buffer | null {
  if (!aes) return rc4(chaveObj, dados);

  // AES-128-CBC: os 16 primeiros bytes são o vetor de inicialização.
  if (dados.length <= 16) return null;
  try {
    const d = createDecipheriv('aes-128-cbc', chaveObj, dados.subarray(0, 16));
    d.setAutoPadding(false);
    const claro = Buffer.concat([d.update(dados.subarray(16)), d.final()]);
    // PKCS#7 removido à mão: `setAutoPadding(true)` lança quando o último bloco está
    // truncado, e stream truncado é comum em PDF remendado — melhor devolver o que deu.
    const n = claro[claro.length - 1] ?? 0;
    return n >= 1 && n <= 16 && n <= claro.length ? claro.subarray(0, claro.length - n) : claro;
  } catch {
    return null;
  }
}

/** Lê `<abc…>` (hex) ou `(…)` (literal) num dicionário. */
function lerCadeia(dict: string, chave: string): Buffer | null {
  const hex = new RegExp(`/${chave}\\s*<([0-9A-Fa-f\\s]+)>`).exec(dict);
  if (hex) return Buffer.from(hex[1]!.replace(/\s+/g, ''), 'hex');

  const lit = new RegExp(`/${chave}\\s*\\(`).exec(dict);
  if (!lit) return null;
  // Varredura à mão por causa do escape: `\)` dentro da cadeia não a encerra.
  let i = lit.index + lit[0].length;
  const bytes: number[] = [];
  while (i < dict.length) {
    const c = dict[i]!;
    if (c === '\\') {
      const s = dict[i + 1];
      if (s === undefined) break;
      const especiais: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      bytes.push(especiais[s] ?? s.charCodeAt(0));
      i += 2;
      continue;
    }
    if (c === ')') break;
    bytes.push(c.charCodeAt(0));
    i++;
  }
  return Buffer.from(bytes);
}

const inteiro = (dict: string, chave: string, padrao: number): number => {
  const m = new RegExp(`/${chave}\\s+(-?\\d+)`).exec(dict);
  return m ? Number(m[1]) : padrao;
};

/**
 * Lê os parâmetros de criptografia do PDF. `null` quando não há, ou quando o esquema está
 * fora do que este módulo sabe fazer — e aí o chamador continua dizendo `protegido`.
 */
export function lerParametros(cru: string): ParametrosDeCripto | null {
  const ref = /\/Encrypt\s+(\d+)\s+(\d+)\s*R/.exec(cru);
  if (!ref) return null;

  const alvo = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\b`, 'g');
  const m = alvo.exec(cru);
  if (!m) return null;

  const inicio = m.index + m[0].length;
  const dict = cru.slice(inicio, inicio + 2000);
  if (!/\/Filter\s*\/Standard/.test(dict)) return null;

  const v = inteiro(dict, 'V', 0);
  const r = inteiro(dict, 'R', 0);
  if (v < 1 || v > 4 || r < 2 || r > 4) return null; // AES-256 (V5/R6) fica de fora, e assumido

  const o = lerCadeia(dict, 'O');
  const u = lerCadeia(dict, 'U');
  if (!o || !u || o.length < 32 || u.length < 16) return null;

  const idM = /\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>/.exec(cru);
  const id = idM ? Buffer.from(idM[1]!.replace(/\s+/g, ''), 'hex') : Buffer.alloc(0);

  // `/V 4` pode ser RC4 ou AES — quem decide é o método do filtro padrão.
  const aes = v === 4 && /\/CFM\s*\/AESV2/.test(dict);
  if (v === 4 && !aes && !/\/CFM\s*\/V2/.test(dict)) return null; // filtro desconhecido

  return {
    v,
    r,
    bytesDeChave: v === 1 ? 5 : Math.max(5, Math.min(16, Math.floor(inteiro(dict, 'Length', 128) / 8))),
    o,
    u,
    p: inteiro(dict, 'P', -1),
    id,
    metadadosCifrados: !/\/EncryptMetadata\s+false/.test(dict),
    aes,
  };
}

export interface Decifrador {
  aes: boolean;
  /** Decifra os dados de um objeto. */
  streamDe: (dados: Buffer, numero: number, geracao: number) => Buffer | null;
}

/**
 * Monta o decifrador quando — e SÓ quando — a senha de usuário vazia realmente abre.
 * `null` significa "isto pede senha de verdade", que é uma resposta honesta.
 */
export function decifradorDeSenhaVazia(cru: string): Decifrador | null {
  const p = lerParametros(cru);
  if (!p) return null;

  const chave = chaveDeArquivo(p);
  if (!senhaVaziaAbre(p, chave)) return null;

  return {
    aes: p.aes,
    streamDe: (dados, numero, geracao) => decifrar(dados, chaveDoObjeto(chave, numero, geracao, p.aes), p.aes),
  };
}
