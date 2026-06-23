// Resolve qual provedor de WhatsApp atende cada instância.
//
// A IA da Saúde roda DUAL-PROVIDER durante e depois da migração:
//   - sara  (Xarlote, voltada ao usuário) → API OFICIAL via zpro/WABA
//   - agent (bot das farmácias)            → uazapi (não-oficial), por enquanto
//
// A escolha é por env, no mesmo padrão dinâmico do client uazapi:
//   WHATSAPP_PROVIDER_SARA=zpro   (ou WHATSAPP_PROVIDER como default global)
// Se nada for setado, cai num auto-detect: usa zpro quando ele está
// configurado para a instância E não há token uazapi para ela.

export type WhatsappProvider = 'uazapi' | 'zpro';

/** zpro está configurado para esta instância? (base + apiId + token) */
export function zproConfigured(instance: string): boolean {
  const upper = instance.toUpperCase();
  return !!(
    process.env['ZPRO_BASE_URL'] &&
    process.env[`ZPRO_${upper}_API_ID`] &&
    process.env[`ZPRO_${upper}_TOKEN`]
  );
}

/** uazapi está configurado para esta instância? (server + token) */
export function uazapiConfigured(instance: string): boolean {
  const upper = instance.toUpperCase();
  return !!(process.env['UAZAPI_SERVER_URL'] && process.env[`UAZAPI_${upper}_TOKEN`]);
}

export function providerFor(instance: string): WhatsappProvider {
  const upper = instance.toUpperCase();
  const explicit = (
    process.env[`WHATSAPP_PROVIDER_${upper}`] ??
    process.env['WHATSAPP_PROVIDER'] ??
    ''
  )
    .trim()
    .toLowerCase();
  if (explicit === 'zpro' || explicit === 'uazapi') return explicit;

  // Auto-detect: prefere zpro quando configurado e sem uazapi para a instância.
  if (zproConfigured(instance) && !uazapiConfigured(instance)) return 'zpro';
  return 'uazapi';
}
