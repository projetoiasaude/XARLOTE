#!/usr/bin/env tsx
/**
 * Aplica um arquivo de migration específico no Supabase via service role key.
 * Uso: pnpm tsx scripts/apply-migration-file.ts infra/supabase/migrations/0001_memory_pgvector.sql
 */
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mini dotenv loader (sem dependência) — lê apenas KEY=value, ignora aspas mal-fechadas
function loadEnv(path: string) {
  try {
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv(join(__dirname, '../.env'));
loadEnv(join(__dirname, '../apps/api/.env'));

const SUPABASE_URL = process.env['SUPABASE_URL'];
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: pnpm tsx scripts/apply-migration-file.ts <path/para/migration.sql>');
  process.exit(1);
}

const sqlPath = resolve(arg);
const sql = readFileSync(sqlPath, 'utf-8');

// Splitter cuidadoso: não quebra dentro de blocos $$ ... $$ (functions/DO)
function splitSql(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next2 = text.slice(i, i + 2);
    if (next2 === '$$') {
      inDollar = !inDollar;
      buf += '$$';
      i += 2;
      continue;
    }
    if (ch === ';' && !inDollar) {
      const trimmed = buf.trim();
      if (trimmed.length && !trimmed.startsWith('--')) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length && !tail.startsWith('--')) out.push(tail);
  return out;
}

const statements = splitSql(sql);
console.log(`Aplicando ${statements.length} statements de ${arg}\n`);

async function run() {
let ok = 0;
let fail = 0;
const failures: { stmt: string; error: string }[] = [];

for (const stmt of statements) {
  const preview = stmt.slice(0, 80).replace(/\n/g, ' ') + (stmt.length > 80 ? '…' : '');
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
      const body = await res.text();
      failures.push({ stmt: preview, error: `HTTP ${res.status}: ${body.slice(0, 200)}` });
      fail++;
      console.warn(`  ⚠ ${preview}`);
    } else {
      ok++;
      console.log(`  ✓ ${preview}`);
    }
  } catch (e) {
    failures.push({ stmt: preview, error: (e as Error).message });
    fail++;
  }
}

console.log(`\n${ok} ok, ${fail} failed.`);
if (failures.length) {
  console.log('\nFalhas:');
  failures.forEach((f) => console.log(`  ✗ ${f.stmt}\n    ${f.error}`));
  console.log('\nCopie o SQL pro SQL Editor do Supabase manualmente se persistir.');
  process.exit(1);
}
}

run().catch((e) => { console.error(e); process.exit(1); });
