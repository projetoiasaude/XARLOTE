/**
 * O PDF que "tem senha" mas abre sem pedir nenhuma.
 *
 * Um laudo real foi recusado em 21/08 com "esse PDF está protegido por senha", e o
 * paciente respondeu que ele abre normalmente. Os dois estavam certos: o arquivo é
 * cifrado (`/V 2 /R 3`, RC4 128), mas com senha de USUÁRIO vazia — o laboratório pôs só a
 * senha de DONO, que restringe cópia. Qualquer leitor abre; o conteúdo continua cifrado.
 *
 * A correção foi verificada contra aquele arquivo (7 páginas, 7.842 caracteres, 23
 * unidades de exame). Aqui o PDF é **sintético e montado no próprio teste**: laudo de
 * verdade não entra em fixture, e um arquivo construído aqui prova a ida e a volta sem
 * depender de nada externo.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ENCHIMENTO,
  chaveDeArquivo,
  chaveDoObjeto,
  lerParametros,
  rc4,
  senhaVaziaAbre,
  decifradorDeSenhaVazia,
  type ParametrosDeCripto,
} from '../packages/integrations/src/pdf-cripto.js';
import { extrairTextoDePdf } from '../packages/integrations/src/pdf-texto.js';

const md5 = (...p: Buffer[]) => {
  const h = createHash('md5');
  for (const x of p) h.update(x);
  return h.digest();
};

const ID = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const O = Buffer.alloc(32, 0x5a);
const P = -1340;

/** Algoritmo 5 do padrão: o `/U` que um gerador escreveria para esta chave. */
function montarU(chave: Buffer): Buffer {
  let x = md5(ENCHIMENTO, ID);
  x = rc4(chave, x);
  for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(chave.map((b) => b ^ i)), x);
  return Buffer.concat([x, Buffer.alloc(16, 0x11)]);
}

function parametros(bytesDeChave = 16): ParametrosDeCripto {
  return { v: 2, r: 3, bytesDeChave, o: O, u: Buffer.alloc(32), p: P, id: ID, metadadosCifrados: true, aes: false };
}

/** Um PDF de uma página, cifrado com RC4 e senha de usuário vazia. */
function pdfCifrado(texto: string): Buffer {
  const base = parametros();
  const chave = chaveDeArquivo(base);
  const u = montarU(chave);

  /*
    Várias linhas, e não uma frase curta: o extrator tem uma checagem ESTATÍSTICA que
    separa texto real de sopa de glifo (fonte CID sem mapa de unicode devolve índices que
    parecem letras). Com 20 caracteres ela reprova por falta de amostra — e reprovar ali
    seria o certo, não um defeito. A fixture precisa parecer um laudo pra exercitar o
    caminho de verdade. Conteúdo inventado: laudo real não entra em teste.
  */
  const linhas = [
    'Laboratorio Sintetico de Analises Clinicas',
    'Paciente: Fulano de Tal   Idade: 54 anos',
    'Material: sangue total   Metodo: automatizado',
    texto,
    'Hematocrito 39,8 %   valor de referencia 38 a 50',
    'Leucocitos 6.200 /mm3   valor de referencia 4000 a 11000',
    'Plaquetas 245 mil/mm3   valor de referencia 150 a 450',
    'Glicemia de jejum 96 mg/dL   valor de referencia menor que 100',
    'Observacao: resultados dentro da faixa esperada para a idade',
    'Responsavel tecnico: Dr. Sintetico   CRM 00000',
  ];
  const conteudo =
    'BT /F1 12 Tf 72 760 Td ' +
    linhas.map((l, i) => `${i === 0 ? '' : '0 -18 Td '}(${l}) Tj`).join(' ') +
    ' ET';
  const comprimido = deflateSync(Buffer.from(conteudo, 'latin1'));
  const cifrado = rc4(chaveDoObjeto(chave, 5, 0, false), comprimido);

  const cabeca =
    '%PDF-1.4\n' +
    `1 0 obj << /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} ` +
    `/O <${O.toString('hex')}> /U <${u.toString('hex')}> >> endobj\n` +
    '2 0 obj << /Type /Catalog /Pages 3 0 R >> endobj\n' +
    '3 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj\n' +
    '4 0 obj << /Type /Page /Parent 3 0 R /Contents 5 0 R >> endobj\n' +
    `5 0 obj << /Length ${cifrado.length} /Filter /FlateDecode >>\nstream\n`;

  const cauda =
    '\nendstream endobj\n' +
    `trailer << /Root 2 0 R /Encrypt 1 0 R /ID [<${ID.toString('hex')}> <${ID.toString('hex')}>] >>\n` +
    '%%EOF';

  return Buffer.concat([Buffer.from(cabeca, 'latin1'), cifrado, Buffer.from(cauda, 'latin1')]);
}

describe('rc4 — a cifra que o OpenSSL 3 não fornece mais', () => {
  it('bate com o vetor clássico do RFC 6229', () => {
    // Chave "Key", texto "Plaintext" → BBF316E8D940AF0AD3
    const saida = rc4(Buffer.from('Key', 'latin1'), Buffer.from('Plaintext', 'latin1'));
    expect(saida.toString('hex').toUpperCase()).toBe('BBF316E8D940AF0AD3');
  });

  it('é sua própria inversa: cifrar duas vezes devolve o original', () => {
    const chave = Buffer.from('uma chave qualquer', 'latin1');
    const claro = Buffer.from('Hemoglobina 13,2 g/dL', 'latin1');
    expect(rc4(chave, rc4(chave, claro)).equals(claro)).toBe(true);
  });
});

describe('senha vazia — abre ou não abre', () => {
  it('reconhece o arquivo que a senha vazia ABRE', () => {
    const base = parametros();
    const chave = chaveDeArquivo(base);
    expect(senhaVaziaAbre({ ...base, u: montarU(chave) }, chave)).toBe(true);
  });

  it('RECUSA quando o /U é de outra senha — e recusar aqui é o que evita mentir', () => {
    // Sem esta checagem, a chave errada decifraria tudo em ruído, o inflate falharia, e o
    // paciente ouviria "tira uma foto" sobre um arquivo que ninguém pode ler.
    const base = parametros();
    expect(senhaVaziaAbre({ ...base, u: Buffer.alloc(32, 0x99) }, chaveDeArquivo(base))).toBe(false);
  });

  it('a chave muda quando as permissões mudam', () => {
    // `/P` entra na derivação. Se ele fosse lido sem sinal, a chave sairia diferente da
    // que o gerador usou — e tudo decifraria em lixo, em silêncio.
    const a = chaveDeArquivo(parametros());
    const b = chaveDeArquivo({ ...parametros(), p: -1341 });
    expect(a.equals(b)).toBe(false);
  });

  it('40 bits e 128 bits dão chaves de tamanhos diferentes', () => {
    expect(chaveDeArquivo(parametros(5))).toHaveLength(5);
    expect(chaveDeArquivo(parametros(16))).toHaveLength(16);
  });
});

describe('chave por objeto', () => {
  it('cada objeto tem a sua', () => {
    const chave = chaveDeArquivo(parametros());
    expect(chaveDoObjeto(chave, 5, 0, false).equals(chaveDoObjeto(chave, 6, 0, false))).toBe(false);
  });

  it('a geração também conta', () => {
    const chave = chaveDeArquivo(parametros());
    expect(chaveDoObjeto(chave, 5, 0, false).equals(chaveDoObjeto(chave, 5, 1, false))).toBe(false);
  });

  it('AES leva o sal, e por isso dá chave diferente do RC4', () => {
    const chave = chaveDeArquivo(parametros());
    expect(chaveDoObjeto(chave, 5, 0, true).equals(chaveDoObjeto(chave, 5, 0, false))).toBe(false);
  });
});

describe('lerParametros — o que dá pra abrir e o que não dá', () => {
  it('lê o dicionário de um arquivo RC4', () => {
    const p = lerParametros(pdfCifrado('teste').toString('latin1'));
    expect(p).not.toBeNull();
    expect(p!.v).toBe(2);
    expect(p!.r).toBe(3);
    expect(p!.bytesDeChave).toBe(16);
    expect(p!.p).toBe(P);
  });

  it('devolve null pra AES-256, que este módulo NÃO sabe abrir', () => {
    // Assumir aqui produziria lixo com cara de texto — pior que recusar.
    const cru = '/Encrypt 1 0 R 1 0 obj << /Filter /Standard /V 5 /R 6 /Length 256 ' +
      `/O <${O.toString('hex')}> /U <${O.toString('hex')}> /P -1 >> endobj`;
    expect(lerParametros(cru)).toBeNull();
  });

  it('devolve null quando o manipulador não é o padrão', () => {
    const cru = '/Encrypt 1 0 R 1 0 obj << /Filter /MinhaEmpresa /V 2 /R 3 >> endobj';
    expect(lerParametros(cru)).toBeNull();
  });
});

describe('o caminho inteiro: PDF cifrado entra, texto sai', () => {
  it('lê o laudo cifrado com senha de usuário vazia', () => {
    const r = extrairTextoDePdf(pdfCifrado('Hemoglobina 13,2 g/dL'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.texto).toContain('Hemoglobina 13,2 g/dL');
  });

  it('continua dizendo `protegido` quando a senha é DE VERDADE', () => {
    // Estraga o /U: agora a senha vazia não abre, e a resposta honesta volta a ser recusa.
    const cru = pdfCifrado('nao devia sair').toString('latin1');
    const quebrado = cru.replace(/\/U <[0-9a-f]+>/, `/U <${Buffer.alloc(32, 0x77).toString('hex')}>`);
    const r = extrairTextoDePdf(Buffer.from(quebrado, 'latin1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('protegido');
  });

  it('o decifrador de senha vazia recusa o arquivo com senha real', () => {
    const cru = pdfCifrado('x').toString('latin1');
    const quebrado = cru.replace(/\/U <[0-9a-f]+>/, `/U <${Buffer.alloc(32, 0x77).toString('hex')}>`);
    expect(decifradorDeSenhaVazia(quebrado)).toBeNull();
  });
});
