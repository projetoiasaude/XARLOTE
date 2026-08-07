/**
 * O portão do Hermes.
 *
 * O app reusa ~2.100 linhas de domínio de `@iasaude/shared` que rodam há meses em
 * produção — mas em Node. O Hermes NÃO é o V8: `Intl` com timeZone depende de o
 * engine ter sido compilado com ICU, `\p{...}` depende do suporte a unicode property
 * escapes, e `String.normalize` chegou tarde. Se qualquer um faltar, o estrago é
 * silencioso e clínico: um lembrete de remédio cai no dia errado, um "amanhã" vira
 * hoje, um nome com acento deixa de casar.
 *
 * Por isso os valores abaixo não são "razoáveis": são os valores EXATOS que o vitest
 * produz no Node (medidos, não estimados). Se o aparelho discordar de qualquer um,
 * a resposta certa é polyfill (@formatjs) — nunca "arredondar" o esperado.
 *
 * Roda no boot em desenvolvimento (ver src/app/_layout.tsx). Nunca em produção.
 */
import { nextOccurrence } from '@iasaude/shared';
import { toE164BR } from '@iasaude/shared';

export interface SmokeCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const FROM = new Date('2026-08-06T12:00:00Z');

function run(): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  const check = (name: string, expected: string, fn: () => unknown) => {
    let actual: string;
    try {
      actual = String(fn());
    } catch (err) {
      actual = `THREW: ${(err as Error).message}`;
    }
    checks.push({ name, expected, actual, ok: actual === expected });
  };

  // 1. Intl.DateTimeFormat com timeZone — usado por rrule.ts e reminder-deictics.ts.
  //    Sem ICU o Hermes ignora o timeZone e devolve UTC: 2026-08-06 em vez de 08-05.
  check('Intl timeZone America/Sao_Paulo', '2026-08-05', () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date('2026-08-06T02:00:00Z')),
  );

  // 2. A conta que decide QUANDO o remédio toca. É o cheque mais caro de errar.
  check('nextOccurrence diário 8h', '2026-08-07T11:00:00.000Z', () =>
    nextOccurrence('FREQ=DAILY;BYHOUR=8;BYMINUTE=0', FROM)?.toISOString(),
  );
  check('nextOccurrence semanal seg 9h30', '2026-08-10T12:30:00.000Z', () =>
    nextOccurrence('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30', FROM)?.toISOString(),
  );

  // 3. Unicode property escapes — intent-guard.ts e appointment-commit.ts normalizam
  //    texto com \p{L}\p{N}. Sem suporte, a regex lança e o turno inteiro cai.
  check('regex \\p{L}\\p{N}', 'Olá  José 42 ', () => 'Olá, José 42!'.replace(/[^\p{L}\p{N}\s]/gu, ' '));

  // 4. NFD + \p{M} — o `slug()` de pharmacy.ts. Sem isso "ação" ≠ "acao" e o
  //    casamento de nome de medicamento passa a falhar em silêncio.
  check('normalize NFD + \\p{M}', 'acao', () => 'ação'.normalize('NFD').replace(/\p{M}/gu, ''));

  // 5. Emoji properties — a limpeza de texto do WhatsApp em pharmacy.ts.
  check('\\p{Extended_Pictographic}', 'oi  tudo bem', () =>
    'oi 👍🏽 tudo bem'.replace(/\p{Extended_Pictographic}/gu, '').replace(/\p{Emoji_Modifier}/gu, ''),
  );

  // 6. O shared importa mesmo? (pega quebra do shim .js→.ts do metro.config.js)
  check('import de @iasaude/shared', '+5562983450244', () => toE164BR('(62) 98345-0244'));

  return checks;
}

/**
 * Roda o portão e grita no console se algo divergir. Devolve as falhas pra quem
 * quiser mostrar na tela — falha silenciosa aqui é exatamente o que estamos evitando.
 */
export function runSharedSmoke(): SmokeCheck[] {
  const checks = run();
  const failures = checks.filter((c) => !c.ok);
  if (failures.length === 0) {
    console.log(`[smoke] Hermes ok — ${checks.length}/${checks.length} conferem com o vitest`);
    return [];
  }
  console.error(
    `[smoke] ⚠️ ${failures.length} de ${checks.length} DIVERGIRAM do Node. ` +
      'O domínio compartilhado NÃO é confiável neste engine — ver src/lib/shared-smoke.ts.',
  );
  for (const f of failures) {
    console.error(`[smoke]   ✗ ${f.name}\n           esperado: ${JSON.stringify(f.expected)}\n           obtido:   ${JSON.stringify(f.actual)}`);
  }
  return failures;
}
