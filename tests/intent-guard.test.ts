import { describe, it, expect } from 'vitest';
import { isExplicitAbandon, isAmbiguousNegation, verdictForLiveIntent } from '../packages/shared/src/intent-guard.js';
import { pickClinicAck, isGenericClinicAck, CLINIC_ACK_VARIANTS, CLINIC_ACK_ESCALATION } from '../apps/api/src/handlers/agent-clinic.js';

/**
 * Blinda a regra "ambiguidade NUNCA encerra".
 *
 * 🔴 CASO GLAUBER (auditoria 04/08). Transcrição real de produção:
 *   01/08  Glauber: "quero marcar uma consulta"
 *   01/08  Xarlote: "É pra qual especialidade?"
 *   01/08  Glauber: "Cardiologista"
 *   01/08  Xarlote: "É em Goiânia mesmo? E você vai usar algum plano de saúde ou é particular?"
 *   02/08  Glauber: "Não precisa"
 *   02/08  Xarlote: "Tá certo, então deixo pra lá? Sem problema nenhum, Glauber!"
 *
 * "Não precisa" respondia à pergunta do PLANO. A Xarlote leu como "não precisa da
 * consulta" e encerrou. Nunca existiu linha em `consultations` — a intenção morreu na
 * conversa, invisível pra todos os vigilantes do sistema.
 *
 * Assimetria de custo: encerrar por engano custa a consulta (o evento mais escasso do
 * produto); perguntar de novo custa uma frase.
 */

describe('🔴 "Não precisa" — a frase que matou a consulta do Glauber', () => {
  it('é ambígua, NÃO é desistência', () => {
    expect(isAmbiguousNegation('Não precisa')).toBe(true);
    expect(isExplicitAbandon('Não precisa')).toBe(false);
  });

  it('o veredito é PERGUNTAR, não encerrar nem seguir em frente', () => {
    expect(verdictForLiveIntent('Não precisa')).toBe('ask-first');
  });

  it('mas "não precisa MAIS" / "não precisa da consulta" É desistência', () => {
    expect(isExplicitAbandon('não precisa mais')).toBe(true);
    expect(isExplicitAbandon('não precisa da consulta')).toBe(true);
    expect(isExplicitAbandon('não precisa marcar')).toBe(true);
    expect(verdictForLiveIntent('não precisa mais')).toBe('abandon');
  });
});

describe('isAmbiguousNegation — negações curtas que dependem da pergunta', () => {
  it.each(['Não', 'não', 'Sem', 'Nenhum', 'nenhuma', 'Não tenho', 'não uso', 'Deixa', 'tanto faz', 'Indiferente', 'negativo'])(
    '"%s" é ambígua',
    (t) => expect(isAmbiguousNegation(t)).toBe(true),
  );

  it('frase longa NÃO é tratada como negação curta (tem contexto próprio)', () => {
    expect(isAmbiguousNegation('não uso plano de saúde nenhum, é particular mesmo')).toBe(false);
  });

  it('texto vazio não é nada', () => {
    expect(isAmbiguousNegation('')).toBe(false);
    expect(isExplicitAbandon('')).toBe(false);
    expect(verdictForLiveIntent('')).toBe('continue');
  });
});

describe('isExplicitAbandon — só o inequívoco encerra', () => {
  it.each([
    'não quero mais',
    'desisti',
    'desistir',
    'cancela',
    'pode cancelar',
    'deixa pra depois',
    'deixa pra outro dia',
    'mudei de ideia',
    'já marquei',
    'já resolvi',
    'não vou marcar',
    'esquece',
  ])('"%s" encerra', (t) => expect(isExplicitAbandon(t)).toBe(true));

  it.each([
    'Cardiologista',
    'Tudo bem',
    'Sim',
    'quero marcar uma consulta',
    'pode ser de manhã',
    'particular',
  ])('"%s" NÃO encerra', (t) => expect(isExplicitAbandon(t)).toBe(false));

  it('a resposta que ele DEVERIA ter sido lido como dando segue o fluxo', () => {
    expect(verdictForLiveIntent('particular')).toBe('continue');
    expect(verdictForLiveIntent('Cardiologista')).toBe('continue');
  });
});

/**
 * 🔴 A CORTESIA REPETIDA (auditoria 04/08). Em 03/08 a MESMA frase — "Perfeito,
 * obrigada! Deixa eu confirmar aqui rapidinho e já te retorno" — saiu 3× pra Rita, duas
 * delas com 2 minutos de diferença (18:20 e 18:22), porque o modelo voltou vazio três
 * vezes e o fallback era uma string fixa. Do lado dela é um robô travado; e prometer
 * "já te retorno" sem nunca retornar é pior que silêncio.
 */
describe('pickClinicAck — cortesia que não se repete e sabe escalar', () => {
  it('não repete a cortesia que já saiu na janela (caso Ciro, 25/08)', () => {
    // A Rita recebeu a MESMA frase 3× em 4 minutos porque mensagens reais entravam
    // entre elas e zeravam a comparação com "a última".
    const primeira = CLINIC_ACK_VARIANTS[0]!;
    const janelaComRuidoNoMeio = ['Oi Rita! Meu nome é Ciro Costa.', primeira, 'Não, obrigado.'];
    expect(pickClinicAck(janelaComRuidoNoMeio)).not.toBe(primeira);
  });

  it('sem histórico, usa a primeira variante', () => {
    expect(pickClinicAck([])).toBe(CLINIC_ACK_VARIANTS[0]);
    expect(pickClinicAck([null, undefined, ''])).toBe(CLINIC_ACK_VARIANTS[0]);
  });

  it('duas cortesias na janela ⇒ escala pra pergunta concreta', () => {
    const janela = [CLINIC_ACK_VARIANTS[0]!, 'qualquer coisa', CLINIC_ACK_VARIANTS[1]!];
    expect(pickClinicAck(janela)).toBe(CLINIC_ACK_ESCALATION);
  });

  it('esgotadas as variantes, escala em vez de repetir', () => {
    expect(pickClinicAck([...CLINIC_ACK_VARIANTS])).toBe(CLINIC_ACK_ESCALATION);
  });

  it('isGenericClinicAck reconhece a cortesia e ignora fala real', () => {
    expect(isGenericClinicAck(CLINIC_ACK_VARIANTS[0])).toBe(true);
    expect(isGenericClinicAck('Consegui quarta às 18h')).toBe(false);
  });
});
