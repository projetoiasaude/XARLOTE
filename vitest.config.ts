import { defineConfig } from 'vitest/config';

// Testes ficam em /tests (fora dos pacotes) pra não entrar no build/typecheck
// dos pacotes. Importam os módulos-alvo por caminho relativo.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
