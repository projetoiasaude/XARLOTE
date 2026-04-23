export const LGPD_POLICY_VERSION = process.env['PRIVACY_POLICY_VERSION'] ?? '1.0';
export const LGPD_POLICY_URL = process.env['PRIVACY_POLICY_URL'] ?? 'https://iadasaude.com/privacidade';

export const ONBOARDING_CONSENT_MESSAGE = `Oi! 💙 Aqui é a *Xarlote*, sua assistente de saúde da IA da Saúde.

Posso te ajudar com medicamentos, lembretes, dúvidas do dia a dia e até negociar com farmácias por você — tudo aqui no WhatsApp.

Antes de começar, preciso do seu consentimento pra cuidar dos seus dados com segurança (LGPD):

👉 *Leia e aceite a política clicando neste link:*
${LGPD_POLICY_URL}

Ao acessar o link e clicar em *"Aceitar"*, você autoriza o uso dos seus dados de saúde para te atender melhor. Você pode revogar a qualquer momento.

Depois de aceitar, me manda uma mensagem aqui pra continuar! 😊`;

export const ONBOARDING_CONSENT_REPEAT_MESSAGE = `Para continuar, preciso que você aceite os termos de uso pelo link:

👉 ${LGPD_POLICY_URL}

Após aceitar, é só me enviar qualquer mensagem que eu continuo! 😊`;

export const CONSENT_ACCEPTED_PATTERNS = [
  /^sim\s*aceito$/i,
  /^aceito$/i,
  /^sim$/i,
  /^concordo$/i,
  /^ok\s*aceito?$/i,
  /^sim\s*eu\s*aceito$/i,
  /^topei$/i,
  /^pode$/i,
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
  OUTBOUND_SARA: 'outbound-whatsapp:sara',
  OUTBOUND_AGENT: 'outbound-whatsapp:agent',
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
