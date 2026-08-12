import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Testes ficam em /tests (fora dos pacotes) pra não entrar no build/typecheck
// dos pacotes. Importam os módulos-alvo por caminho relativo.
export default defineConfig({
  resolve: {
    alias: {
      // O app nativo importa por `@/…` (alias do tsconfig de apps/mobile, que o Metro
      // resolve em runtime). Sem esta linha, toda função pura do app que importa outra
      // pelo alias fica INTESTÁVEL aqui — e "intestável" na prática significa não
      // testada. O alias é o mesmo do tsconfig; se um dia divergirem, o teste quebra
      // alto em vez de testar outro arquivo em silêncio.
      '@': fileURLToPath(new URL('./apps/mobile/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
