import { describe, it, expect } from 'vitest';
import {
  TERMINAL_CONSULTATION_STATUSES,
  NOT_TERMINAL_FILTER,
  PHANTOM_CONSULTATION_STATUSES,
  LIVE_CONSULTATION_STATUSES,
} from '../apps/api/src/handlers/entity-resolve.js';

/**
 * Blinda a COBERTURA do estado vivo de uma consulta.
 *
 * Os vigilantes foram escritos por status, ad hoc, conforme cada incidente aparecia — e
 * nunca existiu o invariante "todo estado não-terminal tem prazo e dono". `quoting` e
 * `drafting` ficaram sem vigilante nenhum, e `quoting` é honrado por 20+ leitores como
 * estado vivo (inclusive o guard que bloqueia nova busca). A consulta do Ciro ficou 9 dias
 * presa lá, 4 deles sem uma palavra ao paciente.
 *
 * A defesa é definir o FIM (fechado e pequeno) e varrer o complemento. Este teste existe
 * pra que um status novo na migration quebre AQUI, em vez de virar buraco negro em produção.
 */

/** Valores exatos do CHECK em infra/supabase/migrations/0003_xarlote_v2_schema.sql:215-217. */
const CHECK_DA_MIGRATION = [
  'drafting', 'searching', 'quoting', 'quoted',
  'confirming', 'scheduled', 'completed', 'cancelled', 'failed',
] as const;

describe('cobertura de status de consulta', () => {
  it('🔴 todo status do CHECK é terminal OU vivo — nenhum fica de fora', () => {
    const terminal = new Set<string>(TERMINAL_CONSULTATION_STATUSES);
    const vivo = new Set<string>([...LIVE_CONSULTATION_STATUSES, ...PHANTOM_CONSULTATION_STATUSES]);
    const orfaos = CHECK_DA_MIGRATION.filter((s) => !terminal.has(s) && !vivo.has(s));
    // Se este teste falhar, alguém adicionou um status na migration e ele não tem dono.
    expect(orfaos).toEqual([]);
  });

  it('nenhum status é terminal E vivo ao mesmo tempo (exceto scheduled, que é terminal p/ o vigilante)', () => {
    // `scheduled` está em LIVE (uma tool pode cancelar uma consulta marcada) e em TERMINAL
    // (o vigilante de travamento não deve mexer nela — quem cuida é o worker de feedback).
    // É a única sobreposição legítima, e é intencional.
    const ambos = LIVE_CONSULTATION_STATUSES.filter((s) => (TERMINAL_CONSULTATION_STATUSES as readonly string[]).includes(s));
    expect(ambos).toEqual(['scheduled']);
  });

  it('o filtro do PostgREST lista exatamente os terminais', () => {
    expect(NOT_TERMINAL_FILTER).toBe('(scheduled,completed,cancelled,failed)');
    for (const s of TERMINAL_CONSULTATION_STATUSES) {
      expect(NOT_TERMINAL_FILTER).toContain(s);
    }
  });

  it('o complemento do terminal é o que o vigilante varre — e inclui os fantasmas', () => {
    const terminal = new Set<string>(TERMINAL_CONSULTATION_STATUSES);
    const varridos = CHECK_DA_MIGRATION.filter((s) => !terminal.has(s));
    expect(varridos).toEqual(['drafting', 'searching', 'quoting', 'quoted', 'confirming']);
    // Os dois fantasmas ESTÃO no que se varre — era exatamente isso que faltava.
    for (const p of PHANTOM_CONSULTATION_STATUSES) expect(varridos).toContain(p);
  });

  it('fantasma nunca é terminal (senão o vigilante não o alcançaria)', () => {
    for (const p of PHANTOM_CONSULTATION_STATUSES) {
      expect(TERMINAL_CONSULTATION_STATUSES as readonly string[]).not.toContain(p);
    }
  });
});
