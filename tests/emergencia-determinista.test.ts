/**
 * A emergência que o servidor reconhece SOZINHO (auditoria 22/09, P0-4).
 *
 * Ideação suicida, automutilação e overdose dependiam do modelo chamar `red_flag_check`
 * — e o modelo de fallback perde chamada de ferramenta. Aqui a régua é conservadora nos
 * dois sentidos: os botões do SAMU não podem aparecer pra quem disse "morrendo de rir",
 * e não podem FALTAR pra quem disse "tomei a cartela inteira".
 */
import { describe, it, expect } from 'vitest';
import { categoriaDeEmergenciaNaFala } from '../packages/shared/src/emergencia-determinista.js';

describe('ideação suicida', () => {
  for (const f of [
    'quero me matar',
    'não aguento mais viver',
    'tô pensando em me matar',
    'queria morrer',
    'acho melhor eu morrer',
    'tenho pensamentos suicidas',
    'vou acabar com a minha vida',
    'pensei em tirar a minha própria vida',
  ]) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBe('suicide_ideation'));
  }
});

describe('overdose', () => {
  for (const f of [
    'tomei a cartela inteira',
    'tomei a caixa toda de remédio',
    'tomei um monte de comprimido',
    'acho que tomei remédio demais',
    'tomei 20 comprimidos',
  ]) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBe('overdose'));
  }
});

describe('automutilação', () => {
  for (const f of ['me cortei ontem de novo', 'tô me machucando', 'pensei em cortar os pulsos']) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBe('self_harm'));
  }
});

describe('sinais físicos continuam valendo (a régua antiga, intacta)', () => {
  for (const f of [
    'tô com dor no peito',
    'falta de ar desde ontem',
    'minha mãe está com o rosto torto e a fala arrastada',
    'dor de cabeça muito forte',
  ]) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBe('other_critical'));
  }
});

describe('figura de linguagem NÃO é emergência (o custo de errar pra mais)', () => {
  for (const f of [
    'tô morrendo de rir com isso',
    'tô morrendo de fome, o que posso comer?',
    'quero morrer de vergonha do que eu falei',
    'esse remédio tá me matando de sono',
    'tô me matando de trabalhar essa semana',
    'só pra matar o tempo até a consulta',
    'morrendo de saudade da minha neta',
  ]) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBeNull());
  }
});

describe('conversa comum de saúde não vira SAMU', () => {
  for (const f of [
    'tomei o remédio certinho hoje',
    'tomei o comprimido das 8h',
    'a dor melhorou bastante',
    'preciso comprar dipirona',
    'esqueci de tomar ontem',
    'meu pai fez exame do coração semana passada',
    'quero cortar o açúcar da dieta',
  ]) {
    it(`"${f}"`, () => expect(categoriaDeEmergenciaNaFala(f)).toBeNull());
  }

  it('texto vazio/nulo', () => {
    expect(categoriaDeEmergenciaNaFala('')).toBeNull();
    expect(categoriaDeEmergenciaNaFala(null)).toBeNull();
    expect(categoriaDeEmergenciaNaFala(undefined)).toBeNull();
  });
});

describe('idiomática NÃO pode desligar a detecção do resto da mensagem (achado da revisão)', () => {
  // A 1ª versão testava "é figura de linguagem?" na mensagem INTEIRA: uma frase com
  // "morrendo de vergonha" no fim apagava a ideação do começo. São co-ocorrências banais.
  for (const [f, esperado] of [
    ['tenho vontade de sumir de vez, tô morrendo de vergonha do que fiz', 'suicide_ideation'],
    ['tava morrendo de rir mais cedo... mas tomei a cartela inteira agora', 'overdose'],
    ['não aguento mais viver, morrendo de sono e de cansaço', 'suicide_ideation'],
    ['quero me matar, e ainda por cima me matando de trabalhar', 'suicide_ideation'],
  ] as Array<[string, string]>) {
    it(`"${f.slice(0, 45)}…" → ${esperado}`, () => {
      expect(categoriaDeEmergenciaNaFala(f)).toBe(esperado);
    });
  }

  it('"quero morrer de preguiça hoje" continua NÃO sendo emergência (typo pego na revisão)', () => {
    expect(categoriaDeEmergenciaNaFala('quero morrer de preguiça hoje')).toBeNull();
    expect(categoriaDeEmergenciaNaFala('tô morrendo de preguiça de ir')).toBeNull();
  });
});

describe('a CAUSA manda sobre o sintoma', () => {
  it('overdose + falta de ar → overdose', () => {
    expect(categoriaDeEmergenciaNaFala('tomei a cartela inteira e agora não consigo respirar')).toBe('overdose');
  });
});
