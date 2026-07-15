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
  // Regionais VTEX-abertas (probe ao vivo 14/07): cobrem SP/RJ/SC além do Grupo A nacional.
  { id: 'drogal', label: 'Drogal', host: 'https://www.drogal.com.br', salesChannel: '1', access: 'rest', group: 'Drogal', enabled: true },
  { id: 'venancio', label: 'Drogaria Venancio', host: 'https://www.drogariavenancio.com.br', salesChannel: '1', access: 'rest', group: 'Venancio', enabled: true },
  { id: 'drogaria-globo', label: 'Drogaria Globo', host: 'https://www.drogariaglobo.com.br', salesChannel: '1', access: 'rest', group: 'Globo', enabled: true },
  { id: 'catarinense', label: 'Drogaria Catarinense', host: 'https://www.drogariacatarinense.com.br', salesChannel: '1', access: 'rest', group: 'Catarinense', enabled: true },
  { id: 'indiana', label: 'Farmácia Indiana', host: 'https://www.farmaciaindiana.com.br', salesChannel: '1', access: 'rest', group: 'Indiana', enabled: true },

  // ── Grupo B: Akamai — via proxy ZenRows (rd-adapter). Drogasil é o REPRESENTANTE do grupo
  // RD (Raia/Onofre têm o mesmo catálogo/preço → ficam off pra não gastar crédito à toa). ──
  { id: 'drogasil', label: 'Drogasil', host: 'https://www.drogasil.com.br', salesChannel: '1', access: 'akamai', group: 'RD', enabled: true },
  { id: 'droga-raia', label: 'Droga Raia', host: 'https://www.drogaraia.com.br', salesChannel: '1', access: 'akamai', group: 'RD', enabled: false },
  { id: 'araujo', label: 'Drogaria Araujo', host: 'https://www.araujo.com.br', salesChannel: '1', access: 'akamai', group: 'Araujo', enabled: false },
  { id: 'onofre', label: 'Onofre', host: 'https://www.onofre.com.br', salesChannel: '1', access: 'akamai', group: 'RD', enabled: false },

  // ── Grupo C: plataforma própria (adaptador dedicado por rede) ──
  // Nissei (Django) e Ultrafarma (Angular SSR) são ABERTAS server-side → LIGADAS (sem proxy).
  // Panvel (API atrás do Azion + cadeia de headers user-id/client-ip/sessionId) fica registry-ready
  // e DESLIGADA — o ZenRows renderiza preço/nome mas o link de produto ainda não sai limpo (ver docs).
  { id: 'nissei', label: 'Farmácias Nissei', host: 'https://www.farmaciasnissei.com.br', salesChannel: '1', access: 'custom', group: 'Nissei', enabled: true },
  { id: 'ultrafarma', label: 'Ultrafarma', host: 'https://www.ultrafarma.com.br', salesChannel: '1', access: 'custom', group: 'Ultrafarma', enabled: true },
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
  // RD (access 'akamai', via rd-adapter/ZenRows) entra só se o proxy estiver configurado.
  // 'custom' (Nissei/Ultrafarma via adaptador próprio) entra quando enabled — são abertas server-side.
  const zenrows = !!(process.env['ZENROWS_API_KEY'] ?? '').trim();
  return PLATFORM_REGISTRY.filter(
    (n) => n.enabled && (n.access === 'rest' || n.access === 'custom' || (n.access === 'akamai' && zenrows)),
  );
}
