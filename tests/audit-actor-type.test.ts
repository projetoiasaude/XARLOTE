/**
 * A lista de atores de auditoria vive em DOIS lugares.
 *
 * O CHECK de `audit_log.actor_type` (SQL) e a união `AuditActorType` (TypeScript) são a
 * mesma lista, mantida à mão nos dois arquivos. Enquanto isso não tinha teste, nada
 * impedia alguém de acrescentar um valor só num lado.
 *
 * O sintoma seria invisível: `writeAudit` NUNCA lança (é o desenho — "se falharmos em
 * auditar, auditamos que falhamos"), então um valor aceito pelo TypeScript e recusado pelo
 * banco simplesmente não gravaria. A auditoria sumiria em silêncio justamente no evento
 * que mais precisava de prova.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTOR_TYPES } from '../packages/db/src/audit.js';

const DIR_MIGRATIONS = join(process.cwd(), 'infra/supabase/migrations');

/** Os valores do CHECK mais recente de `audit_log.actor_type` nas migrations. */
function atoresNoSql(): string[] {
  const arquivos = readdirSync(DIR_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let ultimo: string[] | null = null;
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR_MIGRATIONS, f), 'utf8');
    // Pega o CHECK de actor_type — na criação (0002) ou em qualquer ALTER posterior.
    const re = /actor_type[\s\S]{0,80}?check\s*\(\s*actor_type\s+in\s*\(([^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const valores = [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
      if (valores.length) ultimo = valores;
    }
  }
  return ultimo ?? [];
}

describe('actor_type: SQL e TypeScript não podem divergir', () => {
  it('a migration realmente declara a lista (o teste não pode passar por não achar nada)', () => {
    // Sem esta guarda, um regex que parasse de casar deixaria o teste verde para sempre.
    expect(atoresNoSql().length).toBeGreaterThanOrEqual(7);
  });

  it('as duas listas têm exatamente os mesmos valores', () => {
    expect([...atoresNoSql()].sort()).toEqual([...AUDIT_ACTOR_TYPES].sort());
  });

  it('`caregiver` existe nos dois lados', () => {
    // O ator que a Conta Cuidador introduziu: uma pessoa física que não é o titular.
    expect(AUDIT_ACTOR_TYPES).toContain('caregiver');
    expect(atoresNoSql()).toContain('caregiver');
  });

  it('nenhum valor repetido', () => {
    expect(new Set(AUDIT_ACTOR_TYPES).size).toBe(AUDIT_ACTOR_TYPES.length);
  });
});
