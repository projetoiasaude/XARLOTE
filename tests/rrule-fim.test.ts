/**
 * O motor de recorrência ignorava COUNT, UNTIL e BYHOUR múltiplo (auditoria 08/09/2026).
 *
 * Casos REAIS de produção, com as datas de verdade:
 *  • Levofloxacino 500mg (Glauber): "10 comprimidos, 1 por dia às 13h30", criado 03/09 18:58.
 *    O modelo mandou COUNT=10 e depois duration_days=10; o motor ignorou os dois — lembrete eterno.
 *  • Domperidona 10mg (jantar): COUNT=45, criado 03/09 12:22 — idem.
 *  • Bexxi 35mg: BYHOUR=8,20 e UNTIL=17/08 — a dose das 20h nunca existiu, e continuou
 *    tocando até 26/08, nove dias depois do fim.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRrule, parseUntil, nextOccurrence, fimDaRecorrencia, rruleComFim, fimDoDiaLocal, contarOcorrencias,
} from '../packages/shared/src/rrule.js';

// Brasília = UTC-3: 13h30 BRT = 16h30Z.
const brt = (iso: string) => new Date(`${iso}-03:00`);

describe('parseRrule — os campos que eram descartados', () => {
  it('BYHOUR=8,20 vira DOIS horários (antes: parseInt("8,20") = 8)', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0')).toMatchObject({ byHour: 8, byHours: [8, 20], byMinute: 0 });
  });
  it('BYHOUR único não ganha byHours (compat com quem lê byHour)', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')).toEqual({ freq: 'DAILY', interval: 1, byHour: 8, byMinute: 30 });
  });
  it('COUNT e UNTIL são lidos', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=13;BYMINUTE=30;COUNT=10')?.count).toBe(10);
    expect(parseRrule('FREQ=DAILY;BYHOUR=21;BYMINUTE=0;UNTIL=20260717T235959-03:00')?.until?.toISOString()).toBe('2026-07-18T02:59:59.000Z');
  });
  it('UNTIL em todas as grafias que o modelo já emitiu', () => {
    expect(parseUntil('20260717T235959-03:00')?.toISOString()).toBe('2026-07-18T02:59:59.000Z');
    expect(parseUntil('2026-08-17T20:59:59-03:00')?.toISOString()).toBe('2026-08-17T23:59:59.000Z');
    expect(parseUntil('20260717T235959Z')?.toISOString()).toBe('2026-07-17T23:59:59.000Z');
    // só data = o dia inteiro em Brasília (23:59 BRT = 02:59Z do dia seguinte)
    expect(parseUntil('20260717')?.toISOString()).toBe('2026-07-18T02:59:00.000Z');
    expect(parseUntil('2026-07-17')?.toISOString()).toBe('2026-07-18T02:59:00.000Z');
    expect(parseUntil('lixo')).toBeUndefined();
    expect(parseUntil('2026-13-40')).toBeUndefined();
  });
});

describe('BYHOUR múltiplo — caso Bexxi 35mg', () => {
  const rr = 'FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0;UNTIL=2026-08-17T20:59:59-03:00';
  it('disparou às 8h → a próxima é HOJE às 20h, não amanhã às 8h', () => {
    expect(nextOccurrence(rr, brt('2026-08-16T08:00:10'))?.toISOString()).toBe(brt('2026-08-16T20:00:00').toISOString());
  });
  it('disparou às 20h → amanhã às 8h', () => {
    expect(nextOccurrence(rr, brt('2026-08-16T20:00:10'))?.toISOString()).toBe(brt('2026-08-17T08:00:00').toISOString());
  });
  it('a dose das 20h do último dia ainda toca; depois dela, ACABOU (antes seguia até ser cancelado)', () => {
    expect(nextOccurrence(rr, brt('2026-08-17T08:00:10'))?.toISOString()).toBe(brt('2026-08-17T20:00:00').toISOString());
    expect(nextOccurrence(rr, brt('2026-08-17T20:00:10'))).toBeNull();
    expect(nextOccurrence(rr, brt('2026-08-26T08:00:25'))).toBeNull(); // o dia em que ainda estava tocando
  });
});

describe('COUNT — caso Levofloxacino (criado 03/09 18:58, 13h30 todo dia, 10 comprimidos)', () => {
  const rr = 'FREQ=DAILY;BYHOUR=13;BYMINUTE=30;COUNT=10';
  const criado = brt('2026-09-03T18:58:21');
  it('a série acaba na 10ª ocorrência: 13/09 às 13h30', () => {
    expect(fimDaRecorrencia(rr, criado)?.toISOString()).toBe(brt('2026-09-13T13:30:00').toISOString());
    expect(contarOcorrencias(rr, criado)).toBe(10);
  });
  it('o dispatcher, depois do 10º disparo, recebe null (vira `sent`)', () => {
    expect(nextOccurrence(rr, brt('2026-09-12T13:30:15'), undefined, { anchor: criado })?.toISOString()).toBe(brt('2026-09-13T13:30:00').toISOString());
    expect(nextOccurrence(rr, brt('2026-09-13T13:30:15'), undefined, { anchor: criado })).toBeNull();
  });
  it('sem âncora, COUNT continua sem efeito (não inventa fim de série)', () => {
    expect(fimDaRecorrencia(rr, null)).toBeNull();
    expect(nextOccurrence(rr, brt('2026-12-01T13:30:15'))).not.toBeNull();
  });
  it('Domperidona (jantar) COUNT=45 criada 03/09 12:22 → a 45ª dose é 17/10 às 20h', () => {
    const dom = 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0;COUNT=45';
    expect(fimDaRecorrencia(dom, brt('2026-09-03T12:22:50'))?.toISOString()).toBe(brt('2026-10-17T20:00:00').toISOString());
  });
});

describe('rruleComFim — COUNT vira UNTIL explícito, que qualquer leitor entende', () => {
  it('escreve UNTIL local com offset e remove COUNT', () => {
    const out = rruleComFim('FREQ=DAILY;BYHOUR=13;BYMINUTE=30;COUNT=10', brt('2026-09-13T13:30:00'));
    expect(out).toBe('FREQ=DAILY;BYHOUR=13;BYMINUTE=30;UNTIL=20260913T133059-03:00');
    // e o motor lê de volta: a ocorrência das 13h30 do dia 13 entra, a do dia 14 não
    expect(nextOccurrence(out, brt('2026-09-12T13:30:15'))?.toISOString()).toBe(brt('2026-09-13T13:30:00').toISOString());
    expect(nextOccurrence(out, brt('2026-09-13T13:30:15'))).toBeNull();
  });
  it('substitui um UNTIL antigo em vez de empilhar dois', () => {
    const out = rruleComFim('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260101', brt('2026-09-20T09:00:00'));
    expect(out.match(/UNTIL=/g)).toHaveLength(1);
    expect(out).toContain('UNTIL=20260920T090059-03:00');
  });
});

describe('fimDoDiaLocal — "por N dias" incluindo o dia do primeiro disparo', () => {
  it('primeiro disparo 04/09 13h30 + 9 dias → 13/09 às 23h59 BRT', () => {
    expect(fimDoDiaLocal(brt('2026-09-04T13:30:00'), 9).toISOString()).toBe(brt('2026-09-13T23:59:00').toISOString());
  });
  it('0 dias = o próprio dia', () => {
    expect(fimDoDiaLocal(brt('2026-09-04T13:30:00'), 0).toISOString()).toBe(brt('2026-09-04T23:59:00').toISOString());
  });
});
