#!/usr/bin/env tsx
/**
 * Aplica o schema SQL no Supabase via service role key.
 * Uso: pnpm tsx scripts/apply-migrations.ts
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually
import { config } from 'dotenv';
config({ path: join(__dirname, '../.env') });

const SUPABASE_URL = process.env['SUPABASE_URL'];
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const sqlPath = join(__dirname, '../infra/supabase/schema.sql');
const sql = readFileSync(sqlPath, 'utf-8');

// Split on semicolons carefully (skip empty)
const statements = sql
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

console.log(`Applying ${statements.length} SQL statements to ${SUPABASE_URL}…\n`);

let ok = 0;
let fail = 0;

for (const stmt of statements) {
  const preview = stmt.slice(0, 60).replace(/\n/g, ' ') + '…';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ query: stmt }),
    });

    if (!res.ok) {
      // Fallback: direct SQL via PostgREST
      console.warn(`  ⚠ ${preview}`);
      fail++;
    } else {
      console.log(`  ✓ ${preview}`);
      ok++;
    }
  } catch (e) {
    console.error(`  ✗ ${preview}\n    ${(e as Error).message}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} ok, ${fail} failed.`);
if (fail > 0) {
  console.log('\n⚠ Para falhas, cole o arquivo infra/supabase/schema.sql no SQL Editor do Supabase Dashboard.');
}
