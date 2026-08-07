/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Metro em MONOREPO pnpm + a ponte pro @iasaude/shared.
 *
 * Duas coisas fora do default, e por quê:
 *
 * 1. watchFolders/nodeModulesPaths na RAIZ: o app importa `@iasaude/shared` via
 *    workspace (source TypeScript direto, sem build). Sem isso o Metro não enxerga
 *    pacotes fora de apps/mobile.
 *
 * 2. SHIM `.js` → `.ts`: o shared usa imports NodeNext (`./types.js`) apontando pra
 *    fontes `.ts` — o Node resolve isso, o Metro NÃO. Quando um import termina em .js
 *    e o arquivo de origem está dentro de packages/, tentamos o mesmo caminho com .ts
 *    antes de desistir. É a única costura necessária pra reusar as ~2.100 linhas de
 *    domínio testado em produção sem fork nem build step.
 *
 * E uma que NÃO fazemos, de propósito: `disableHierarchicalLookup`. Ela é a receita
 * padrão de monorepo npm/yarn (impede que um pacote resolva algo que só existe
 * hoisted por acidente) e é EXATAMENTE errada no pnpm — aqui as dependências de cada
 * pacote moram no `node_modules` irmão dele dentro da store, e desligar o walk-up é
 * o que faz `expo` não achar `expo-modules-core`. Se alguém reintroduzir a linha, o
 * bundle quebra numa cascata de "Unable to resolve module" que parece dependência
 * faltando e não é.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.endsWith('.js')
    && (moduleName.startsWith('./') || moduleName.startsWith('../'))
    && context.originModulePath.includes(`${path.sep}packages${path.sep}`)
  ) {
    try {
      return context.resolveRequest(context, moduleName.replace(/\.js$/, '.ts'), platform);
    } catch {
      // cai no resolver normal — o .js pode existir de verdade
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
