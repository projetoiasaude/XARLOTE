import { describe, it, expect } from 'vitest';
import {
  formatPhonePretty,
  isSubmittablePhone,
  looksLikeLandline,
  maskPhoneBR,
  phoneDigitsBR,
  phoneTail,
} from '../apps/mobile/src/lib/phone-input.js';
import { toE164BR } from '../packages/shared/src/phone.js';

/**
 * A máscara do campo de telefone do app.
 *
 * O caso que dá nome ao arquivo é o DDD 55 (Santa Maria/RS): uma máscara ingênua
 * "tira o 55 do começo" e come o DDD da pessoa, que então nunca recebe o código e
 * não faz ideia do porquê.
 */

describe('phoneDigitsBR', () => {
  it('mantém o DDD 55 quando ele é DDD, não DDI', () => {
    // 11 dígitos = celular de Santa Maria/RS. Tirar o "55" aqui seria comer o DDD.
    expect(phoneDigitsBR('55999912345')).toBe('55999912345');
    // 10 dígitos = fixo de Santa Maria. Mesmo raciocínio.
    expect(phoneDigitsBR('5532223333')).toBe('5532223333');
  });

  it('tira o 55 quando ele é DDI de verdade (12 ou 13 dígitos)', () => {
    expect(phoneDigitsBR('+5562983450244')).toBe('62983450244'); // 13 → celular
    expect(phoneDigitsBR('556232223333')).toBe('6232223333'); // 12 → fixo
  });

  it('ignora tudo que não é dígito', () => {
    expect(phoneDigitsBR('+55 (62) 98345-0244')).toBe('62983450244');
  });

  it('nunca passa de 11 dígitos, mesmo se o paciente continuar digitando', () => {
    expect(phoneDigitsBR('629834502449999')).toBe('62983450244');
  });

  it('vazio devolve vazio (não quebra no primeiro render)', () => {
    expect(phoneDigitsBR('')).toBe('');
    expect(phoneDigitsBR('abc')).toBe('');
  });
});

describe('maskPhoneBR — formatação progressiva', () => {
  it('acompanha o paciente dígito a dígito', () => {
    expect(maskPhoneBR('')).toBe('');
    expect(maskPhoneBR('6')).toBe('(6');
    expect(maskPhoneBR('62')).toBe('(62');
    expect(maskPhoneBR('629')).toBe('(62) 9');
    expect(maskPhoneBR('62983')).toBe('(62) 983');
    expect(maskPhoneBR('629834')).toBe('(62) 9834');
    expect(maskPhoneBR('6298345')).toBe('(62) 98345');
    expect(maskPhoneBR('62983450')).toBe('(62) 98345-0');
    expect(maskPhoneBR('62983450244')).toBe('(62) 98345-0244');
  });

  it('o traço NUNCA muda de lugar durante a digitação', () => {
    // Uma máscara que alterna 4-4 e 5-4 faz o número dançar a cada tecla. Aqui a
    // posição do traço, uma vez que aparece, é sempre a mesma.
    const posicoes = new Set<number>();
    for (const parcial of ['629834502', '6298345024', '62983450244']) {
      posicoes.add(maskPhoneBR(parcial).indexOf('-'));
    }
    expect([...posicoes]).toEqual([10]);
  });

  it('número colado com DDI sai limpo', () => {
    expect(maskPhoneBR('+55 62 98345-0244')).toBe('(62) 98345-0244');
  });
});

describe('isSubmittablePhone', () => {
  it('só libera com celular completo — 11 dígitos', () => {
    expect(isSubmittablePhone('62983450244')).toBe(true);
    expect(isSubmittablePhone('6298345024')).toBe(false);
  });

  it('BARRA telefone fixo: WhatsApp de fixo não recebe o código', () => {
    // 10 dígitos = fixo. Deixar passar gastaria uma das 3 tentativas do paciente
    // e o faria esperar 5 minutos por um código que nunca chega.
    expect(isSubmittablePhone('6232223333')).toBe(false);
  });
});

describe('looksLikeLandline — o botão apagado precisa ter voz', () => {
  it('reconhece fixo completo (10 dígitos sem o 9)', () => {
    expect(looksLikeLandline('6232223333')).toBe(true);
    expect(looksLikeLandline('(62) 3222-3333')).toBe(true);
  });

  it('NÃO acusa celular pela metade — ali a mensagem certa é silêncio', () => {
    // 10 dígitos começando com 9 é um celular a que falta um dígito. Dizer "isso é
    // um fixo" no meio da digitação seria mentir pro paciente.
    expect(looksLikeLandline('6298345024')).toBe(false);
  });

  it('não acusa nada com número incompleto nem com celular pronto', () => {
    expect(looksLikeLandline('62322')).toBe(false);
    expect(looksLikeLandline('62983450244')).toBe(false);
  });
});

describe('a máscara conversa com o toE164BR do backend', () => {
  it('o que a tela libera, o shared converte pro mesmo E.164 que a API procura', () => {
    const digitado = '(62) 98345-0244';
    expect(isSubmittablePhone(digitado)).toBe(true);
    expect(toE164BR(phoneDigitsBR(digitado))).toBe('+5562983450244');
  });

  it('celular de DDD 55 também chega inteiro no E.164', () => {
    expect(toE164BR(phoneDigitsBR('(55) 99991-2345'))).toBe('+5555999912345');
  });
});

describe('exibição', () => {
  it('formatPhonePretty devolve o E.164 cru quando não é BR', () => {
    expect(formatPhonePretty('+5562983450244')).toBe('+55 (62) 98345-0244');
    expect(formatPhonePretty('+14155552671')).toBe('+14155552671');
  });

  it('phoneTail dá os 4 últimos sem expor o número', () => {
    expect(phoneTail('+5562983450244')).toBe('0244');
    expect(phoneTail('62')).toBe('62');
  });
});
