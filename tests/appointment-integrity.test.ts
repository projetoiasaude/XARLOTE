import { describe, it, expect } from 'vitest';
import { faltandoAncoras } from '../apps/api/src/workers/appointment-integrity.worker.js';

/**
 * Blinda a INVARIANTE da consulta marcada: toda consulta `scheduled` com horário no
 * futuro tem lembrete de 1 dia e de 2 horas, e o paciente sabe dela.
 *
 * 🔴 O que motivou (auditoria 04/08): a única consulta agendada da história do produto
 * estava pela metade. O `scheduled` foi gravado à mão por um humano no terminal (o LLM
 * voltou vazio e não havia detector determinístico), e o lembrete "Consulta em 2 horas"
 * — o único aviso NO DIA — foi apagado por um curinga de `cancel_reminders` sem que nada
 * notasse. O paciente, que ia viajar, ficaria com avisos em 24/08 e 25/08 e NADA no dia 26.
 *
 * A lição: prevenir cada caminho é necessário, mas um estado terminal bom (`scheduled`)
 * é alcançável por vários caminhos e basta UM estar incompleto pra o paciente perder a
 * consulta em silêncio. Então a garantia é declarada sobre o ESTADO, e um worker conserta
 * quem violar — sem intervenção humana e sem depender de qual caminho causou.
 */

const HORA = 3_600_000;
const AGORA = Date.parse('2026-08-04T12:00:00Z');
const nenhum = () => new Set<string>();

describe('faltandoAncoras', () => {
  it('🔴 o caso Ciro: consulta em 22 dias sem NENHUM lembrete → cobra as duas', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(faltandoAncoras(consulta, AGORA, nenhum())).toEqual(['1d_before', '2h_before']);
  });

  it('🔴 o caso Ciro real: o de 1d existe, o de 2h foi apagado → cobra só o de 2h', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(faltandoAncoras(consulta, AGORA, new Set(['1d_before']))).toEqual(['2h_before']);
  });

  it('as duas presentes → não cobra nada (não fica reparando pra sempre)', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(faltandoAncoras(consulta, AGORA, new Set(['1d_before', '2h_before']))).toEqual([]);
  });

  it('consulta em 5h: o lembrete de 1 DIA é impossível → só cobra o de 2h', () => {
    const consulta = AGORA + 5 * HORA;
    expect(faltandoAncoras(consulta, AGORA, nenhum())).toEqual(['2h_before']);
  });

  it('consulta em 1h: nenhuma âncora cabe → não cobra nada', () => {
    const consulta = AGORA + 1 * HORA;
    expect(faltandoAncoras(consulta, AGORA, nenhum())).toEqual([]);
  });

  it('exatamente na fronteira de 2h não cobra (a âncora seria agora)', () => {
    expect(faltandoAncoras(AGORA + 2 * HORA, AGORA, nenhum())).toEqual([]);
    expect(faltandoAncoras(AGORA + 2 * HORA + 60_000, AGORA, nenhum())).toEqual(['2h_before']);
  });

  it('exatamente na fronteira de 24h não cobra o de 1d', () => {
    expect(faltandoAncoras(AGORA + 24 * HORA, AGORA, nenhum())).toEqual(['2h_before']);
    expect(faltandoAncoras(AGORA + 24 * HORA + 60_000, AGORA, nenhum())).toEqual(['1d_before', '2h_before']);
  });

  it('cobertura com chave desconhecida não conta como cobertura', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(faltandoAncoras(consulta, AGORA, new Set(['1_semana_antes']))).toEqual(['1d_before', '2h_before']);
  });
});
