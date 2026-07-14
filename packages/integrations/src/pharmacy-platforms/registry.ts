/**
 * Registro das grandes redes e como acessá-las (probe real 2026-07-14, ver
 * docs/PHARMACY_PLATFORMS.md). `access`:
 *   - 'rest'   → API REST pública do VTEX responde server-side direto (Grupo A).
 *   - 'akamai' → REST público bloqueado (403/503); só via anti-WAF/GraphQL (Grupo B, fase 2).
 *   - 'custom' → plataforma própria; adaptador dedicado (Grupo C, fase 3).
 *
 * `enabled` liga/desliga a rede na cotação. Grupo A vem ligado; B/C desligados até
 * termos anti-WAF / adaptador. Também sobreponível por env `PLATFORM_QUOTE_NETWORKS`
 * (lista de ids separada por vírgula) — permite ligar/desligar sem deploy.
 */

export type PlatformAccess = 'rest' | 'akamai' | 'custom';

export interface PlatformNetwork {
  id: string;
  label: string;
  /** origin sem barra final (ex.: https://www.drogariasaopaulo.com.br) */
  host: string;
  /** sales channel VTEX (trade policy) */
  salesChannel: string;
  access: PlatformAccess;
  /** grupo econômico — usado pra deduplicar catálogo compartilhado */
  group: string;
  enabled: boolean;
}

export const PLATFORM_REGISTRY: readonly PlatformNetwork[] = [
  // ── Grupo A: VTEX REST aberto (server-side direto) ──
  { id: 'pague-menos', label: 'Pague Menos', host: 'https://www.paguemenos.com.br', salesChannel: '1', access: 'rest', group: 'PagueMenos', enabled: true },
  { id: 'extrafarma', label: 'Extrafarma', host: 'https://www.extrafarma.com.br', salesChannel: '1', access: 'rest', group: 'PagueMenos', enabled: true },
  { id: 'drogaria-sao-paulo', label: 'Drogaria São Paulo', host: 'https://www.drogariasaopaulo.com.br', salesChannel: '1', access: 'rest', group: 'DPSP', enabled: true },
  { id: 'pacheco', label: 'Drogaria Pacheco', host: 'https://www.drogariaspacheco.com.br', salesChannel: '1', access: 'rest', group: 'DPSP', enabled: true },
  { id: 'sao-joao', label: 'Farmácias São João', host: 'https://www.saojoaofarmacias.com.br', salesChannel: '1', access: 'rest', group: 'SaoJoao', enabled: true },

  // ── Grupo B: Akamai (fase 2 — anti-WAF) ──
  { id: 'drogasil', label: 'Drogasil', host: 'https://www.drogasil.com.br', salesChannel: '1', access: 'akamai', group: 'RD', enabled: false },
  { id: 'droga-raia', label: 'Droga Raia', host: 'https://www.drogaraia.com.br', salesChannel: '1', access: 'akamai', group: 'RD', enabled: false },
  { id: 'araujo', label: 'Drogaria Araujo', host: 'https://www.araujo.com.br', salesChannel: '1', access: 'akamai', group: 'Araujo', enabled: false },

  // ── Grupo C: plataforma própria (fase 3 — adaptador dedicado) ──
  { id: 'nissei', label: 'Farmácias Nissei', host: 'https://www.farmaciasnissei.com.br', salesChannel: '1', access: 'custom', group: 'Nissei', enabled: false },
  { id: 'panvel', label: 'Panvel', host: 'https://www.panvel.com', salesChannel: '1', access: 'custom', group: 'Dimed', enabled: false },
];

/**
 * Redes que devem ser cotadas AGORA. Default = as `enabled` do registry que são 'rest'.
 * Sobreponível por env `PLATFORM_QUOTE_NETWORKS` (csv de ids) — ex.: pra ligar a RD assim
 * que o anti-WAF existir, ou desligar uma rede que começou a bloquear, sem deploy.
 */
export function activeNetworks(): PlatformNetwork[] {
  const override = (process.env['PLATFORM_QUOTE_NETWORKS'] ?? '').trim();
  if (override) {
    const ids = new Set(override.split(',').map((s) => s.trim()).filter(Boolean));
    return PLATFORM_REGISTRY.filter((n) => ids.has(n.id));
  }
  return PLATFORM_REGISTRY.filter((n) => n.enabled && n.access === 'rest');
}
