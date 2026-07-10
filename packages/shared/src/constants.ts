export const LGPD_POLICY_VERSION = process.env['PRIVACY_POLICY_VERSION'] ?? '1.0';
export const LGPD_POLICY_URL = process.env['PRIVACY_POLICY_URL'] ?? 'https://iadasaude.com/privacidade';

export const ONBOARDING_CONSENT_MESSAGE = `Oi! Eu sou a *Xarlote*, sua assistente de saúde 💙

Estou aqui pra te ajudar no dia a dia com medicamentos, lembretes, dúvidas simples, pedir remédios em farmácias, marcar consultas e muito mais. Tudo pelo WhatsApp.

Antes da gente começar, preciso que você aceite nossa política de privacidade. É ela que explica como cuidamos dos seus dados com segurança, seguindo a LGPD.

Dá uma olhadinha aqui:
${LGPD_POLICY_URL}

Depois é só clicar em *Aceitar* aqui embaixo pra autorizar o uso dos seus dados de saúde. Se mudar de ideia, você pode revogar esse consentimento quando quiser.`;

export const ONBOARDING_CONSENT_REPEAT_MESSAGE = `Pra gente continuar, preciso que você aceite nossa política de privacidade pelo link:

${LGPD_POLICY_URL}

Quando aceitar, é só me responder por aqui que eu sigo de onde a gente parou.`;

// Aceite LGPD = manifestação INEQUÍVOCA (art. 5º XII): botão "Aceitar" ou afirmação clara.
// Texto qualquer ("me lembra do remédio") e MÍDIA nunca valem como aceite — ver
// inbound-user (incidente Elizabet 09/07: consent registrado de um áudio nunca transcrito).
export const CONSENT_ACCEPTED_PATTERNS = [
  /^aceitar$/i, // label do BOTÃO do menu de consent (zpro/WABA devolve o texto do botão)
  /^sim,?\s*aceito$/i,
  /^aceito$/i,
  /^(j[áa]\s*)?aceitei$/i, // "aceitei"/"já aceitei" — resposta natural ao re-pedido
  /^aceito,?\s*sim$/i,
  /^sim,?\s*quero$/i,
  /^sim$/i,
  /^concordo$/i,
  /^ok(ay)?$/i,
  /^ok,?\s*aceito?$/i,
  /^sim,?\s*eu\s*aceito$/i,
  /^topei$/i,
  /^pode$/i,
  /^pode\s*ser$/i,
  /^t[áa]\s*bom$/i,
  /^beleza$/i,
  /^blz$/i,
  /^de\s*acordo$/i,
  /^claro$/i,
  /^autorizo$/i,
  /^👍\s*$/u,
  /^✅\s*$/u,
];

export const FORGET_ME_PATTERNS = [
  /esquecer?\s+meus?\s+dados/i,
  /apagar?\s+meus?\s+dados/i,
  /revogar?\s+consentimento/i,
  /cancelar?\s+cadastro/i,
  /deletar?\s+minha\s+conta/i,
  /quero\s+sair/i,
];

export const QUEUE_NAMES = {
  INBOUND_USER: 'inbound-user',
  INBOUND_SUPPLIER: 'inbound-supplier',
  // BullMQ 5 não permite ':' no nome da fila — use '-'.
  OUTBOUND_SARA: 'outbound-whatsapp-sara',
  OUTBOUND_AGENT: 'outbound-whatsapp-agent',
  PHARMACY_DISCOVERY: 'pharmacy-discovery',
  PHARMACY_NEGOTIATION: 'pharmacy-negotiation',
  QUOTE_CONSOLIDATION: 'quote-consolidation',
  REMINDER_DISPATCHER: 'reminder-dispatcher',
  PROFILE_ENRICHER: 'profile-enricher',
} as const;

export const SARA_INSTANCE = 'sara';
export const AGENT_INSTANCE = 'agent';

export const PHARMACY_SEARCH_RADII_KM = [3, 5, 8];
export const MAX_SUPPLIERS_PER_ORDER = 5;
export const QUOTE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const QUOTE_CONSOLIDATE_MIN_COMPLETED = 2;
export const QUOTE_CONSOLIDATE_MIN_ELAPSED_MS = 60 * 1000; // 1 min after 2 quotes
export const PHARMACY_MAX_TURNS = 12;

export const EMERGENCY_KEYWORDS = [
  'infarto', 'acidente', 'overdose', 'tentativa de suicídio', 'suicídio',
  'desmaiou', 'inconsciente', 'parou de respirar', 'convulsão',
  'hemorragia', 'sangramento intenso', 'engasgou', 'não respira',
];
