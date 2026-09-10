/**
 * O dia em que "cancela os da Nimesulida" apagou o prontuário inteiro (Glauber, 08–09/09/2026).
 *
 * ─── O QUE ACONTECEU ─────────────────────────────────────────────────────────────
 * 08/09 16:18 — o modelo chamou `cancel_reminders {all: true, title_query: "Nimesulida"}`.
 * 09/09 11:47 — de novo, com `{all: true, title_query: "Domperidona"}`.
 *
 * O filtro era `filter((r) => args.all || …includes(qn))`. O `||` faz curto-circuito: com
 * `all` verdadeiro TODO lembrete casa, e o título é jogado fora. Resultado medido no banco:
 * o paciente perdeu Esomeprazol 40mg, Domperidona (almoço e jantar) e Levofloxacino de uma
 * vez; no dia seguinte perdeu a Nimesulida, que tomava de 12 em 12 horas até 14/09. De
 * quatro medicações lembradas sobrou UMA — e ele ouviu "cancelei os lembretes antigos da
 * Nimesulida", porque nem a Xarlote sabia o que tinha destruído.
 *
 * Nas outras 13 chamadas da história do produto o modelo mandou só `title_query`.
 *
 * A REGRA: escopo explícito vence. `all` só significa "todos" quando não há título.
 */
import { describe, expect, it } from 'vitest';

/**
 * Espelha a decisão de escopo de `handleCancelReminders`. Pura de propósito: é a linha que
 * decide se um paciente perde um lembrete ou o prontuário inteiro.
 */
function escopo(args: { title_query?: string; all?: boolean }) {
  const q = (args.title_query ?? '').trim();
  const cancelarTudo = Boolean(args.all) && !q;
  return { cancelarTudo, q };
}
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function cancelados(args: { title_query?: string; all?: boolean }, titulos: string[]) {
  const { cancelarTudo, q } = escopo(args);
  const qn = fold(q);
  return titulos.filter((t) => cancelarTudo || fold(t).includes(qn));
}

/** Os lembretes que o Glauber tinha ativos em 08/09 16:18, antes da chamada. */
const GLAUBER = [
  'Esomeprazol magnésico 40mg',
  'Domperidona 10mg (almoço)',
  'Domperidona 10mg (jantar)',
  'Levofloxacino 500mg',
  'Nimesulida 100mg',
];

describe('a chamada real que apagou tudo', () => {
  it('{all:true, title_query:"Nimesulida"} cancela SÓ a Nimesulida', () => {
    expect(cancelados({ all: true, title_query: 'Nimesulida' }, GLAUBER)).toEqual(['Nimesulida 100mg']);
  });
  it('e NÃO encosta nas outras quatro medicações', () => {
    const sobrou = GLAUBER.filter((t) => !cancelados({ all: true, title_query: 'Nimesulida' }, GLAUBER).includes(t));
    expect(sobrou).toEqual([
      'Esomeprazol magnésico 40mg', 'Domperidona 10mg (almoço)', 'Domperidona 10mg (jantar)', 'Levofloxacino 500mg',
    ]);
  });
  it('a segunda chamada, {all:true, title_query:"Domperidona"}, leva só as duas Domperidonas', () => {
    expect(cancelados({ all: true, title_query: 'Domperidona' }, GLAUBER))
      .toEqual(['Domperidona 10mg (almoço)', 'Domperidona 10mg (jantar)']);
  });
});

describe('o comportamento legítimo de cada campo continua', () => {
  it('só title_query → cancela o grupo (as 13 chamadas históricas)', () => {
    expect(cancelados({ title_query: 'Domperidona' }, GLAUBER)).toHaveLength(2);
  });
  it('só all → cancela TUDO, que é o que o paciente pediu ("cancela todos")', () => {
    expect(cancelados({ all: true }, GLAUBER)).toEqual(GLAUBER);
  });
  it('all com título em branco/espaços ainda é "todos"', () => {
    expect(escopo({ all: true, title_query: '   ' }).cancelarTudo).toBe(true);
    expect(escopo({ all: true, title_query: '' }).cancelarTudo).toBe(true);
  });
  it('title_query sem acento casa título com acento (o ILIKE do Postgres não dobra)', () => {
    expect(cancelados({ title_query: 'esomeprazol magnesico' }, GLAUBER)).toEqual(['Esomeprazol magnésico 40mg']);
  });
  it('título que não casa nada não cancela nada — nunca "na dúvida, apaga tudo"', () => {
    expect(cancelados({ all: true, title_query: 'Losartana' }, GLAUBER)).toEqual([]);
  });
});
