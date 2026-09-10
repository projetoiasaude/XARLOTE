/**
 * "Todo dia às 11h30 e às 20h" — e o motor entendeu 20h30 (Glauber, 09/09/2026).
 *
 * O modelo emitiu `FREQ=DAILY;BYHOUR=11,20;BYMINUTE=30,0` querendo dizer duas doses:
 * 11:30 e 20:00. Em RFC 5545 isso é PRODUTO CARTESIANO — 11:00, 11:30, 20:00 e 20:30 —
 * quatro disparos por dia para um remédio de duas doses. Honrar ao pé da letra DOBRARIA a
 * cobrança; parear por posição seria inventar semântica que o padrão não tem.
 *
 * A saída é recusar: lista de minutos torna o rrule inválido, `create_reminder` avisa o
 * modelo e ele cria DOIS lembretes — que é a forma correta de expressar dois horários.
 */
import { describe, expect, it } from 'vitest';
import { parseRrule, nextOccurrence } from '../packages/shared/src/rrule.js';

const brt = (iso: string) => new Date(`${iso}-03:00`);

describe('lista de minutos é ambígua → recusada', () => {
  it('o rrule REAL da Domperidona de 09/09 não é aceito', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=11,20;BYMINUTE=30,0')).toBeNull();
    expect(nextOccurrence('FREQ=DAILY;BYHOUR=11,20;BYMINUTE=30,0', brt('2026-09-10T09:00:00'))).toBeNull();
  });
  it('lista de minutos sozinha também é recusada', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8;BYMINUTE=0,30')).toBeNull();
  });
});

describe('o que continua valendo — o caso comum e não ambíguo', () => {
  it('vários horários com UM minuto: "8h e 20h" (a Nimesulida, que funcionou)', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0')).toMatchObject({ byHours: [8, 20], byMinute: 0 });
    expect(nextOccurrence('FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0', brt('2026-09-10T09:00:00'))?.toISOString())
      .toBe(brt('2026-09-10T20:00:00').toISOString());
  });
  it('horário único com minuto único segue intacto', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=13;BYMINUTE=30')).toMatchObject({ byHour: 13, byMinute: 30 });
  });
  it('sem BYMINUTE segue intacto', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8,20')).toMatchObject({ byHours: [8, 20] });
  });
});
