import { describe, it, expect } from 'vitest';
import { turnLimitAnchor, TURN_LIMIT_WINDOW_MS } from '../apps/api/src/handlers/agent-clinic.js';

/**
 * Blinda a âncora do freio de turnos com a clínica.
 *
 * INCIDENTE Rita/Ciro (03/08), observado ao vivo 3× seguidas: a âncora era
 * `quote.created_at` e o comentário afirmava contar "só esta negociação". Mas cotação
 * revivida não tem `created_at` resetado — a do Ciro era de 25/07 e já tinha sido revivida
 * 3×, então a contagem somou 9 DIAS: 31 mensagens contra o teto de 24. O freio pegou,
 * finalizou como `timeout` e retornou MUDO. E como `timeout` é revivível, cada mensagem
 * nova da secretária repetia o ciclo: ela respondeu três vezes e falou com uma parede,
 * enquanto o paciente não sabia de nada.
 */
const AGORA = Date.parse('2026-08-03T15:00:00Z');
const janela = new Date(AGORA - TURN_LIMIT_WINDOW_MS).toISOString();

describe('turnLimitAnchor', () => {
  it('🔴 cotação ANTIGA ancora na janela de 24h, não na criação (o caso Ciro)', () => {
    // Sem isto, a contagem varria de 25/07 até hoje e o freio ficava permanentemente batido.
    expect(turnLimitAnchor('2026-07-25T10:42:46+00:00', AGORA)).toBe(janela);
  });

  it('cotação RECENTE ancora na própria criação (negociação nova conta desde o início)', () => {
    const criada = '2026-08-03T13:00:00.000Z'; // 2h atrás, dentro da janela
    expect(turnLimitAnchor(criada, AGORA)).toBe(criada);
  });

  it('a âncora é sempre a MAIS RECENTE das duas', () => {
    for (const criada of ['2026-07-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-03T14:59:00.000Z']) {
      const a = turnLimitAnchor(criada, AGORA);
      expect(a >= janela).toBe(true);
      expect(a >= criada || criada < janela).toBe(true);
    }
  });

  it('mede VELOCIDADE, não longevidade: loop de bot cabe na janela, negociação de dias não', () => {
    // Um runaway real (bot ecoando bot) faz 24+ mensagens em minutos — dentro de qualquer
    // janela. Uma negociação saudável acumula 24+ ao longo de dias, e essa NÃO deve tripar.
    const criadaHaMinutos = new Date(AGORA - 10 * 60_000).toISOString();
    expect(turnLimitAnchor(criadaHaMinutos, AGORA)).toBe(criadaHaMinutos); // conta o loop todo
    const criadaHaDias = new Date(AGORA - 9 * 24 * 60 * 60_000).toISOString();
    expect(turnLimitAnchor(criadaHaDias, AGORA)).toBe(janela);             // ignora o histórico
  });

  it('created_at ilegível cai na janela — nunca varre a conversa inteira', () => {
    expect(turnLimitAnchor('', AGORA)).toBe(janela);
    expect(turnLimitAnchor('ontem', AGORA)).toBe(janela);
  });

  it('janela customizada é respeitada', () => {
    const w = 60 * 60_000; // 1h
    expect(turnLimitAnchor('2026-07-25T10:42:46+00:00', AGORA, w)).toBe(new Date(AGORA - w).toISOString());
  });
});
