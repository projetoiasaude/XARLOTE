/**
 * O "Tomei" repetido que virou dose do jantar às 7h40 da manhã (Glauber, 04/09/2026).
 * Estado do banco naquele instante, reconstruído das tabelas reais.
 */
import { describe, expect, it } from 'vitest';
import { decidirRegistroDeDose, textoMencionaRemedio, type LembreteParaDose } from '../packages/shared/src/adherence-guard.js';

const brt = (iso: string) => new Date(`${iso}-03:00`);
const iso = (s: string) => brt(s).toISOString();

// 04/09 07:40:45 — o Esomeprazol tocou às 07:00 e ainda não tinha sido confirmado;
// a Domperidona do jantar tocou ONTEM às 20:00 e foi confirmada ontem às 20:02.
const LEMBRETES: LembreteParaDose[] = [
  { id: 'eso', title: 'Esomeprazol magnésico 40mg', type: 'medication', last_run_at: iso('2026-09-04T07:00:18'), next_run_at: iso('2026-09-05T07:00:00'), last_confirmed_at: iso('2026-09-03T07:41:00'), medication_id: 'm-eso' },
  { id: 'dom-j', title: 'Domperidona 10mg (jantar)', type: 'medication', last_run_at: iso('2026-09-03T20:00:18'), next_run_at: iso('2026-09-04T20:00:00'), last_confirmed_at: iso('2026-09-03T20:02:00'), medication_id: 'm-dom' },
  { id: 'dom-a', title: 'Domperidona 10mg (almoço)', type: 'medication', last_run_at: iso('2026-09-03T11:30:17'), next_run_at: iso('2026-09-04T11:30:00'), last_confirmed_at: iso('2026-09-03T11:55:00'), medication_id: 'm-dom' },
  { id: 'barba', title: 'Loção da barba', type: 'medication', last_run_at: iso('2026-09-03T08:30:17'), next_run_at: iso('2026-09-04T08:30:00'), last_confirmed_at: null, medication_id: null },
];
const AGORA = brt('2026-09-04T07:40:45');

describe('o caso das 07:40', () => {
  it('"Tomei" → Esomeprazol registra, amarrado ao disparo das 07:00', () => {
    const d = decidirRegistroDeDose({ nomeInformado: 'Esomeprazol magnésico 40mg', status: 'taken', textoDoPaciente: 'Tomei', lembretes: LEMBRETES, registroRecente: null, agora: AGORA });
    expect(d.acao).toBe('registrar');
    if (d.acao === 'registrar') {
      expect(d.lembrete?.id).toBe('eso');
      expect(d.ocorrenciaIso).toBe(iso('2026-09-04T07:00:18'));
    }
  });
  it('"Tomei" → Domperidona (jantar) é RECUSADA: não tocou, e o Esomeprazol tocou', () => {
    const d = decidirRegistroDeDose({ nomeInformado: 'Domperidona 10mg (jantar)', status: 'taken', textoDoPaciente: 'Tomei', lembretes: LEMBRETES, registroRecente: null, agora: AGORA });
    expect(d.acao).toBe('recusar');
    if (d.acao === 'recusar') {
      expect(d.motivo).toContain('não tocou');
      expect(d.motivo).toContain('"Esomeprazol magnésico 40mg"');
      expect(d.motivo).toContain('20:00');
    }
  });
  it('o segundo "Tomei", 19 s depois, é a MESMA dose → não duplica', () => {
    const d = decidirRegistroDeDose({
      nomeInformado: 'Esomeprazol magnésico 40mg', status: 'taken', textoDoPaciente: 'Tomei', lembretes: LEMBRETES,
      registroRecente: { status: 'taken', created_at: iso('2026-09-04T07:40:28') }, agora: brt('2026-09-04T07:40:47'),
    });
    expect(d.acao).toBe('ja_registrado');
    if (d.acao === 'ja_registrado') expect(d.nota).toContain('07:40');
  });
});

describe('a palavra do paciente vence', () => {
  it('ele NOMEOU o remédio → registra mesmo fora de hora ("tomei a domperidona do jantar, vou sair")', () => {
    const d = decidirRegistroDeDose({ nomeInformado: 'Domperidona 10mg (jantar)', status: 'taken', textoDoPaciente: 'tomei a domperidona do jantar, vou sair', lembretes: LEMBRETES, registroRecente: null, agora: brt('2026-09-04T15:00:00') });
    expect(d.acao).toBe('registrar');
  });
  it('resposta nua sem NENHUM lembrete tocado por perto → registra (não há com o que confundir)', () => {
    const d = decidirRegistroDeDose({ nomeInformado: 'Domperidona 10mg (jantar)', status: 'taken', textoDoPaciente: 'tomei', lembretes: LEMBRETES, registroRecente: null, agora: brt('2026-09-04T15:00:00') });
    expect(d.acao).toBe('registrar');
    if (d.acao === 'registrar') expect(d.ocorrenciaIso).toBeNull(); // sem disparo recente pra amarrar
  });
  it('status diferente não é duplicata (taken há 10 min, agora skipped)', () => {
    const d = decidirRegistroDeDose({
      nomeInformado: 'Esomeprazol magnésico 40mg', status: 'skipped', textoDoPaciente: 'na verdade não tomei', lembretes: LEMBRETES,
      registroRecente: { status: 'taken', created_at: iso('2026-09-04T07:30:00') }, agora: AGORA,
    });
    expect(d.acao).toBe('registrar');
  });
  it('registro antigo (35 min) não conta como a mesma dose', () => {
    const d = decidirRegistroDeDose({
      nomeInformado: 'Esomeprazol magnésico 40mg', status: 'taken', textoDoPaciente: 'Tomei', lembretes: LEMBRETES,
      registroRecente: { status: 'taken', created_at: iso('2026-09-04T07:05:00') }, agora: AGORA,
    });
    expect(d.acao).toBe('registrar');
  });
});

describe('textoMencionaRemedio', () => {
  it('prefixo de 4+ letras basta', () => {
    expect(textoMencionaRemedio('tomei a dompe agora', 'Domperidona 10mg (jantar)')).toBe(true);
    expect(textoMencionaRemedio('tomei o esomeprazol', 'Esomeprazol magnésico 40mg')).toBe(true);
  });
  it('"Tomei", "Sim", "Os dois" não nomeiam nada', () => {
    expect(textoMencionaRemedio('Tomei', 'Domperidona 10mg (jantar)')).toBe(false);
    expect(textoMencionaRemedio('Os dois', 'Domperidona 10mg (jantar)')).toBe(false);
  });
  it('rótulo de horário entre parênteses e dosagem não contam como nome', () => {
    expect(textoMencionaRemedio('já jantei', 'Domperidona 10mg (jantar)')).toBe(false);
    expect(textoMencionaRemedio('tomei 10mg', 'Domperidona 10mg (jantar)')).toBe(false);
  });
});
