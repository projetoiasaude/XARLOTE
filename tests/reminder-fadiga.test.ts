/**
 * 380 mensagens sem uma resposta.
 *
 * Uma paciente recebia 7 lembretes de água por dia desde 02/07/2026 — o último às 23:00 —
 * e nunca respondeu a nenhum. Outro recebia dois de exercício às 5:00 e 5:05, o segundo
 * cobrando o primeiro, desde 17/07, também sem responder.
 *
 * A regra tinha que separar isso do lembrete de remédio sem hesitar: calar uma dose pra
 * poupar incômodo trocaria desconforto por risco clínico.
 */
import { describe, it, expect } from 'vitest';
import {
  avaliarFadiga, ehCritico, ehMadrugada, perguntaDeContinuidade, LIMIAR_SEM_RESPOSTA,
} from '../packages/shared/src/reminder-fadiga.js';

describe('remédio e consulta passam sempre', () => {
  it.each(['medication', 'appointment'])('%s não é silenciado às 23h nem freado', (tipo) => {
    expect(avaliarFadiga({ tipo, horaBrt: 23, disparosSemResposta: 999 })).toEqual({ enviar: true });
  });

  it('nem às 5 da manhã, nem depois de meses sem resposta', () => {
    expect(avaliarFadiga({ tipo: 'medication', horaBrt: 5, disparosSemResposta: 400 }).enviar).toBe(true);
  });

  it('o teste de criticidade não se deixa enganar por caixa/espaço', () => {
    expect(ehCritico(' Medication ')).toBe(true);
    expect(ehCritico('hydration')).toBe(false);
    expect(ehCritico(null)).toBe(false);
  });
});

describe('hábito espera o dia', () => {
  it('a água das 23:00 não sai', () => {
    const v = avaliarFadiga({ tipo: 'hydration', horaBrt: 23, disparosSemResposta: 0 });
    expect(v).toEqual({ enviar: false, motivo: 'silencio_noturno' });
  });

  it('o exercício das 5:00 também não', () => {
    expect(avaliarFadiga({ tipo: 'exercise', horaBrt: 5, disparosSemResposta: 0 }).enviar).toBe(false);
  });

  it('mas às 8:00 sai normalmente', () => {
    expect(avaliarFadiga({ tipo: 'hydration', horaBrt: 8, disparosSemResposta: 0 })).toEqual({ enviar: true });
  });

  it('a fronteira do silêncio é 22h–7h', () => {
    expect(ehMadrugada(22)).toBe(true);
    expect(ehMadrugada(6)).toBe(true);
    expect(ehMadrugada(7)).toBe(false);
    expect(ehMadrugada(21)).toBe(false);
  });
});

describe('quem parou de ouvir', () => {
  it(`no ${LIMIAR_SEM_RESPOSTA}º disparo mudo, para e PERGUNTA`, () => {
    const v = avaliarFadiga({ tipo: 'hydration', horaBrt: 10, disparosSemResposta: LIMIAR_SEM_RESPOSTA });
    expect(v).toEqual({ enviar: false, motivo: 'sem_engajamento', perguntar: true });
  });

  it('não pergunta duas vezes', () => {
    const v = avaliarFadiga({ tipo: 'hydration', horaBrt: 10, disparosSemResposta: 99, jaPerguntou: true });
    expect(v).toMatchObject({ enviar: false, perguntar: false });
  });

  it('não faz a pergunta de madrugada — seria cometer o incômodo que ela encerra', () => {
    const v = avaliarFadiga({ tipo: 'hydration', horaBrt: 23, disparosSemResposta: 99 });
    expect(v).toMatchObject({ motivo: 'sem_engajamento', perguntar: false });
  });

  it('um fim de semana sem responder NÃO desliga nada', () => {
    expect(avaliarFadiga({ tipo: 'hydration', horaBrt: 10, disparosSemResposta: LIMIAR_SEM_RESPOSTA - 1 }).enviar).toBe(true);
  });

  it('a pergunta devolve a escolha, e oferece mudar de horário em vez de só parar', () => {
    const p = perguntaDeContinuidade('Beber 500ml de água', 'Antônia');
    expect(p).toContain('Antônia');
    expect(p).toContain('Beber 500ml de água');
    expect(p).toMatch(/horário/);
    expect(p).toMatch(/pare|parar/);
  });
});
