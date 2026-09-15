/**
 * Mensagem que o paciente nunca recebeu não é conversa (Glauber, Ciro e Vossa, 14–15/09/2026).
 * Horários reais, em UTC (Goiânia = UTC-3).
 */
import { describe, it, expect } from 'vitest';
import { lembreteFoiEntregue, lembretesEntregues, lembretesQueTocaramJuntos } from '../packages/shared/src/adesao-ack';
import { messagesToHistory, NAO_ENTREGUE } from '../packages/llm/src/utils/history';
import { decidirRegistroDeDose } from '../packages/shared/src/adherence-guard';

const msg = (direction: 'in' | 'out', content: string, created_at: string, delivery_status: string | null = 'delivered') =>
  ({ id: created_at, conversation_id: 'c', external_id: null, direction, sender_role: direction === 'in' ? 'user' : 'assistant', content_type: 'text', content, transcript: null, media_storage_path: null, media_mime: null, media_duration_ms: null, location_lat: null, location_lng: null, raw_payload: null, llm_model: null, llm_tokens_in: null, llm_tokens_out: null, llm_latency_ms: null, trace_id: null, delivery_status, created_at }) as any;

describe('histórico do modelo — Glauber 15/09', () => {
  const rows = [
    msg('out', 'Oii, Glauber! Aqui é a Xarlote, Passei pra te lembrar do seu remédio hoje às 7h: Esomeprazol magnésico 40mg.', '2026-09-14T10:00:12Z'),
    msg('out', 'Oi Glauber! Hora da Nimesulida 100mg 💊 Já tomou?', '2026-09-14T11:00:14Z', 'window_blocked'),
    msg('out', 'Oi Glauber! Hora de tomar a Domperidona 10mg antes do almoço 💊 Já tomou?', '2026-09-14T14:30:30Z', 'window_blocked'),
    msg('out', 'Oi Glauber! Hora de tomar a Domperidona 10mg antes do jantar 💊 Já tomou?', '2026-09-14T23:00:30Z', 'window_blocked'),
    msg('in', 'Sim', '2026-09-15T09:49:18Z', null),
  ];
  it('o que ficou window_blocked/suppressed não entra; o entregue e o dele entram', () => {
    const h = messagesToHistory(rows);
    expect(h.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(h[0]!.content).toContain('Esomeprazol');
    expect(h.some((m) => m.content.includes('Domperidona'))).toBe(false);
  });
  it('queued/null/delivered continuam no histórico', () => {
    const h = messagesToHistory([msg('out', 'a', '2026-09-15T09:00:00Z', 'queued'), msg('out', 'b', '2026-09-15T09:01:00Z', null), msg('out', 'c', '2026-09-15T09:02:00Z', 'delivered')]);
    expect(h.length).toBe(3);
    expect([...NAO_ENTREGUE]).toEqual(['window_blocked', 'suppressed', 'failed']);
  });
});

describe('backstop de dose — só o que foi entregue tocou', () => {
  const saidas = [
    { created_at: '2026-09-14T10:00:12Z', delivery_status: 'delivered' },
    { created_at: '2026-09-14T23:00:30Z', delivery_status: 'window_blocked' },
    { created_at: '2026-09-15T10:00:01Z', delivery_status: 'delivered' },
  ];
  const domperidonaJantar = { id: 'ff2c4a6e', title: 'Domperidona 10mg (jantar)', last_run_at: '2026-09-14T23:00:29Z' };
  const esomeprazol = { id: 'b83da0e7', title: 'Esomeprazol magnésico 40mg', last_run_at: '2026-09-15T10:00:00Z' };
  it('o espelho window_blocked apaga o disparo; o entregue fica; sem espelho conta como entregue', () => {
    expect(lembreteFoiEntregue(domperidonaJantar, saidas)).toBe(false);
    expect(lembreteFoiEntregue(esomeprazol, saidas)).toBe(true);
    expect(lembreteFoiEntregue({ id: 'x', last_run_at: '2026-09-13T10:00:00Z' }, saidas)).toBe(true);
    expect(lembretesEntregues([domperidonaJantar, esomeprazol], saidas).map((l) => l.id)).toEqual(['b83da0e7']);
  });
  it('Ciro 14/09: creatina e whey suprimidos não tocaram — nem com o template entregue no mesmo segundo', () => {
    const saidasCiro = [
      { created_at: '2026-09-14T10:20:12Z', delivery_status: 'suppressed', content: 'Oi Ciro! Hora da creatina 💪 Já tomou? Responde "tomei" que eu marco!' },
      { created_at: '2026-09-14T10:20:15Z', delivery_status: 'delivered', content: 'Oii, Ciro! Aqui é a Xarlote, Faz uns dias que a gente não conversa e você ficou na minha cabeça. Está tudo bem por aí?' },
      { created_at: '2026-09-14T10:20:16Z', delivery_status: 'suppressed', content: 'Oi Ciro! Hora do whey junto com a creatina 💪 Já tomou? Responde "tomei" que eu marco!' },
    ];
    const creatina = { id: 'c', title: 'Creatina', last_run_at: '2026-09-14T10:20:12Z' };
    const whey = { id: 'w', title: 'Whey', last_run_at: '2026-09-14T10:20:15Z' };
    expect(lembreteFoiEntregue(creatina, saidasCiro)).toBe(false);
    expect(lembreteFoiEntregue(whey, saidasCiro)).toBe(false);
    expect(lembretesQueTocaramJuntos(lembretesEntregues([creatina, whey], saidasCiro))).toEqual([]);
    // no dia seguinte, entregues de verdade
    const entregues = [{ created_at: '2026-09-15T10:20:01Z', delivery_status: 'delivered', content: 'Oi Ciro! Hora da creatina 💪' }, { created_at: '2026-09-15T10:20:04Z', delivery_status: 'delivered', content: 'Oi Ciro! Hora do whey junto com a creatina 💪' }];
    expect(lembretesEntregues([{ ...creatina, last_run_at: '2026-09-15T10:20:00Z' }, { ...whey, last_run_at: '2026-09-15T10:20:03Z' }], entregues).length).toBe(2);
  });
});

describe('a dose confirma o disparo entregue — Vossa 14/09 06:12', () => {
  const lembretes = [
    { id: 'ef4430bc', title: 'Venlafaxina', type: 'medication', last_run_at: '2026-09-14T00:00:28Z', next_run_at: '2026-09-15T00:00:00Z', last_confirmed_at: null, medication_id: '0e6f78e1' },
    { id: 'c3d5cff9', title: 'Venlafaxina (reforço 21h30)', type: 'medication', last_run_at: null, next_run_at: null, last_confirmed_at: null, medication_id: '0e6f78e1' },
    { id: '3abd4769', title: 'Venlafaxina (reforço 22h30)', type: 'medication', last_run_at: null, next_run_at: null, last_confirmed_at: null, medication_id: '0e6f78e1' },
  ];
  it('"Tomei" às 06:12 amarra na Venlafaxina das 21h (entregue), não no reforço bloqueado', () => {
    const d = decidirRegistroDeDose({ nomeInformado: 'Venlafaxina', status: 'taken', textoDoPaciente: 'Tomei', lembretes, registroRecente: null, agora: new Date('2026-09-14T09:12:17Z') });
    expect(d.acao).toBe('registrar');
    if (d.acao === 'registrar') {
      expect(d.lembrete?.id).toBe('ef4430bc');
      expect(d.ocorrenciaIso).toBe('2026-09-14T00:00:28.000Z');
    }
  });
});

describe('o tempo entra no histórico', () => {
  it('conversa de 4 dias atrás começa com a data; mensagem depois de um vazio de 6h+ também', () => {
    const rows = [
      msg('in', 'Oi xarlote', '2026-09-10T15:12:00Z'),
      msg('out', 'Oi Lud!', '2026-09-10T15:12:30Z'),
      msg('in', 'Setor Oeste', '2026-09-10T15:52:00Z'),
      msg('in', 'Oi Xarlote, tudo bem?', '2026-09-14T17:54:37Z'),
    ];
    const h = messagesToHistory(rows, new Date('2026-09-14T17:55:00Z'));
    expect(h[0]!.content).toBe('[10/09 12:12 — há 4 dias] Oi xarlote');
    expect(h[1]!.content).toBe('Oi Lud!');
    expect(h[3]!.content).toBe('[14/09 14:54 — agora há pouco] Oi Xarlote, tudo bem?');
    // janela toda antiga, sem a mensagem atual: a primeira ganha a marca
    const h2 = messagesToHistory(rows.slice(0, 3), new Date('2026-09-14T17:55:00Z'));
    expect(h2[0]!.content.startsWith('[10/09 12:12 — há 4 dias]')).toBe(true);
    // conversa corrente: nada marcado
    const h3 = messagesToHistory(rows.slice(0, 3), new Date('2026-09-10T16:00:00Z'));
    expect(h3.every((m) => !m.content.startsWith('['))).toBe(true);
  });
});
