/**
 * Os três consertos do incidente Glauber (31/08/2026).
 *
 * O que aconteceu: ele mandou os dados de acesso aos resultados do Instituto Goiano de
 * Oncologia e pediu um lembrete "no dia 02". Duas coisas quebraram no mesmo minuto:
 *
 *   1. `save_exam_result` foi recusado com *"você não cuida de ninguém chamado Glauber
 *      Andrade"* — na conversa DO Glauber. O exame não foi salvo e ninguém tentou de novo.
 *   2. O lembrete foi agendado pra 02/10 em vez de 02/09 — 32 dias de atraso num
 *      resultado de exame oncológico.
 *
 * Os dois modos de falhar são silenciosos: nenhum alarme tocou, e só apareceram porque
 * alguém foi ler as conversas. Por isso valem teste.
 */
import { describe, it, expect } from 'vitest';
import { ferramentasParaAtor, xarloteTools } from '../packages/llm/src/tools/xarlote-tools.js';
import { resolverAlvoDaTool } from '../packages/shared/src/care-tools.js';
import { proximoDiaDoMes, horaDeIso } from '../packages/shared/src/rrule.js';

const props = (tools: typeof xarloteTools, nome: string) =>
  (tools.find((t) => t.function.name === nome)!.function.parameters as {
    properties: Record<string, unknown>;
  }).properties;

describe('1. `para_quem` não é oferecido a quem não cuida de ninguém', () => {
  it('sem vínculo, o campo SOME do schema — o modelo não tem como preenchê-lo', () => {
    const t = ferramentasParaAtor({ temVinculos: false });
    expect('para_quem' in props(t, 'save_exam_result')).toBe(false);
    expect('para_quem' in props(t, 'create_reminder')).toBe(false);
  });

  it('com vínculo, o campo continua lá — a Conta Cuidador precisa dele', () => {
    const t = ferramentasParaAtor({ temVinculos: true });
    expect('para_quem' in props(t, 'save_exam_result')).toBe(true);
  });

  it('remover pra um NÃO estraga o schema de quem tem vínculo', () => {
    // O array exportado é compartilhado entre turnos e usuários. Mutá-lo faria o primeiro
    // usuário sem vínculo apagar o campo pra todo mundo até o processo reiniciar — um bug
    // que só apareceria em produção, sob concorrência, e nunca num teste de um caso só.
    ferramentasParaAtor({ temVinculos: false });
    expect('para_quem' in props(xarloteTools, 'save_exam_result')).toBe(true);
    expect('para_quem' in props(ferramentasParaAtor({ temVinculos: true }), 'create_reminder')).toBe(true);
  });

  it('as 8 ferramentas que tinham o campo perdem todas', () => {
    const antes = xarloteTools.filter((t) => 'para_quem' in (t.function.parameters as { properties: Record<string, unknown> }).properties).length;
    const depois = ferramentasParaAtor({ temVinculos: false })
      .filter((t) => 'para_quem' in (t.function.parameters as { properties: Record<string, unknown> }).properties).length;
    expect(antes).toBeGreaterThan(0);
    expect(depois).toBe(0);
  });
});

describe('2. o próprio nome resolve pra si mesmo, mesmo sem nenhum vínculo', () => {
  const glauber = { userId: 'u-glauber', nome: 'Glauber Andrade', vinculos: [] };

  it('o caso exato do incidente: para_quem com o próprio nome, zero vínculos', () => {
    const r = resolverAlvoDaTool('save_exam_result', { para_quem: 'Glauber Andrade' }, glauber);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subjectUserId).toBe('u-glauber');
      expect(r.via).toBe('proprio');
    }
  });

  it('"eu" e "pra mim" também', () => {
    for (const p of ['eu', 'pra mim', 'mim']) {
      expect(resolverAlvoDaTool('create_reminder', { para_quem: p }, glauber).ok).toBe(true);
    }
  });

  it('sem para_quem segue sendo o próprio — o caminho de quase todo turno', () => {
    const r = resolverAlvoDaTool('create_reminder', {}, glauber);
    expect(r.ok && r.via).toBe('proprio');
  });

  it('nome de OUTRA pessoa continua recusado — a trava não foi afrouxada', () => {
    const r = resolverAlvoDaTool('create_reminder', { para_quem: 'dona Maria' }, glauber);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem).toContain('NADA FOI FEITO');
  });

  it('falar com farmácia em nome de outro segue proibido, com ou sem vínculo', () => {
    const r = resolverAlvoDaTool('start_pharmacy_order', { para_quem: 'minha mãe' }, glauber);
    expect(r.ok).toBe(false);
  });
});

describe('3. "dia N" é conta do servidor', () => {
  // 31/08/2026 às 16:25 em Brasília — o instante exato do pedido do Glauber.
  const quandoElePediu = new Date('2026-08-31T19:25:00.000Z');

  it('o caso do incidente: em 31/08, "dia 2" é 02/09 — não 02/10', () => {
    const iso = proximoDiaDoMes(2, { h: 8, m: 0 }, quandoElePediu, 'America/Sao_Paulo');
    expect(iso).not.toBeNull();
    expect(iso!.slice(0, 10)).toBe('2026-09-02');
  });

  it('dia que ainda não passou neste mês fica NESTE mês', () => {
    const iso = proximoDiaDoMes(15, { h: 9, m: 0 }, new Date('2026-09-10T12:00:00.000Z'), 'America/Sao_Paulo');
    expect(iso!.slice(0, 10)).toBe('2026-09-15');
  });

  it('vira o ano corretamente em dezembro', () => {
    const iso = proximoDiaDoMes(3, { h: 8, m: 0 }, new Date('2026-12-28T12:00:00.000Z'), 'America/Sao_Paulo');
    expect(iso!.slice(0, 7)).toBe('2027-01');
  });

  it('dia inválido devolve null em vez de inventar data', () => {
    for (const d of [0, 32, -1, 2.5, NaN]) {
      expect(proximoDiaDoMes(d, { h: 8, m: 0 }, quandoElePediu)).toBeNull();
    }
  });

  it('hora inválida devolve null — não silencia pra meia-noite', () => {
    expect(proximoDiaDoMes(2, { h: 24, m: 0 }, quandoElePediu)).toBeNull();
    expect(proximoDiaDoMes(2, { h: 8, m: 60 }, quandoElePediu)).toBeNull();
  });

  it('horaDeIso pega só a hora do palpite do modelo — a parte que ele acerta', () => {
    expect(horaDeIso('2026-10-02T08:00:00-03:00')).toEqual({ h: 8, m: 0 });
    expect(horaDeIso('2026-10-02T19:30:00-03:00')).toEqual({ h: 19, m: 30 });
  });

  it('horaDeIso não aceita lixo — cai no default do chamador', () => {
    for (const v of [null, undefined, '', 'amanhã', '2026-10-02']) {
      expect(horaDeIso(v)).toBeNull();
    }
  });
});
