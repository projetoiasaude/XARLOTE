import { describe, it, expect } from 'vitest';
import { anchorsMissing, ANCHOR_COVER_TOLERANCE_MS } from '../apps/api/src/handlers/appointment-commit.js';

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
const nenhum: number[] = [];

describe('anchorsMissing', () => {
  it('🔴 o caso Ciro: consulta em 22 dias sem NENHUM lembrete → cobra as duas', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(anchorsMissing(consulta, AGORA, nenhum)).toEqual(['1d_before', '2h_before']);
  });

  it('🔴 o caso Ciro real: o de 1d existe, o de 2h foi apagado → cobra só o de 2h', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(anchorsMissing(consulta, AGORA, [consulta - 24 * HORA])).toEqual(['2h_before']);
  });

  it('as duas presentes → não cobra nada (não fica reparando pra sempre)', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(anchorsMissing(consulta, AGORA, [consulta - 24 * HORA, consulta - 2 * HORA])).toEqual([]);
  });

  it('consulta em 5h: o lembrete de 1 DIA é impossível → só cobra o de 2h', () => {
    const consulta = AGORA + 5 * HORA;
    expect(anchorsMissing(consulta, AGORA, nenhum)).toEqual(['2h_before']);
  });

  it('consulta em 1h: nenhuma âncora cabe → não cobra nada', () => {
    const consulta = AGORA + 1 * HORA;
    expect(anchorsMissing(consulta, AGORA, nenhum)).toEqual([]);
  });

  it('exatamente na fronteira de 2h não cobra (a âncora seria agora)', () => {
    expect(anchorsMissing(AGORA + 2 * HORA, AGORA, nenhum)).toEqual([]);
    expect(anchorsMissing(AGORA + 2 * HORA + 60_000, AGORA, nenhum)).toEqual(['2h_before']);
  });

  it('exatamente na fronteira de 24h não cobra o de 1d', () => {
    expect(anchorsMissing(AGORA + 24 * HORA, AGORA, nenhum)).toEqual(['2h_before']);
    expect(anchorsMissing(AGORA + 24 * HORA + 60_000, AGORA, nenhum)).toEqual(['1d_before', '2h_before']);
  });

  it('lembrete muito distante da âncora NÃO conta como cobertura', () => {
    const consulta = Date.parse('2026-08-26T13:00:00Z');
    expect(anchorsMissing(consulta, AGORA, [consulta - 7 * 24 * HORA])).toEqual(['1d_before', '2h_before']);
  });
});

/**
 * 🔴 ACHADO NA VERIFICAÇÃO AO VIVO DO DEPLOY (04/08 12:54Z).
 *
 * O worker restaurou os dois lembretes do Ciro — mas criou uma DUPLICATA: os lembretes que
 * o modelo tinha criado em 03/08 via `create_reminder` têm `payload = {"event_at": "..."}`,
 * sem `consultation_id` e sem `kind`. A primeira versão da cobertura era por `payload.kind`,
 * então esses eram invisíveis e o "amanhã" foi recriado ao lado do que já existia: o Ciro
 * receberia DUAS mensagens iguais em 25/08, às 09h e às 10h.
 *
 * A pergunta certa não é "existe lembrete com a minha etiqueta?", é "o paciente já vai ser
 * avisado por volta desta hora?" — e essa não depende de quem criou o lembrete.
 */
describe('anchorsMissing — cobertura por PROXIMIDADE, não por etiqueta', () => {
  const consulta = Date.parse('2026-08-26T13:00:00Z'); // quarta 26/08 às 10h BRT

  it('🔴 o lembrete REAL que o modelo criou (25/08 12:00Z) cobre a âncora de 1 dia', () => {
    // A âncora de 1d é 25/08 13:00Z; o do modelo é 25/08 12:00Z — 1h de diferença.
    const doModelo = Date.parse('2026-08-25T12:00:00Z');
    expect(anchorsMissing(consulta, AGORA, [doModelo])).toEqual(['2h_before']);
  });

  it('os DOIS lembretes que o modelo criou cobrem só a de 1 dia (24/08 é longe demais)', () => {
    const semanaAntes = Date.parse('2026-08-24T12:00:00Z');
    const diaAntes = Date.parse('2026-08-25T12:00:00Z');
    expect(anchorsMissing(consulta, AGORA, [semanaAntes, diaAntes])).toEqual(['2h_before']);
  });

  it('na fronteira da tolerância cobre; um minuto além, não', () => {
    const ancora1d = consulta - 24 * HORA;
    expect(anchorsMissing(consulta, AGORA, [ancora1d - ANCHOR_COVER_TOLERANCE_MS])).toEqual(['2h_before']);
    expect(anchorsMissing(consulta, AGORA, [ancora1d - ANCHOR_COVER_TOLERANCE_MS - 60_000])).toEqual(['1d_before', '2h_before']);
  });

  it('horário inválido na lista não conta como cobertura nem explode', () => {
    expect(anchorsMissing(consulta, AGORA, [NaN])).toEqual(['1d_before', '2h_before']);
  });
});
