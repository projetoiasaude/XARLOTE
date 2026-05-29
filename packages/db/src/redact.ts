/**
 * Redação de PII pra logs/telemetria (LGPD — regra: nada sensível em nível ≥ info).
 *
 * Estratégia dupla:
 *   1. Chaves sensíveis (telefone, cpf, endereço, lat/lng, pix, nomes pessoais,
 *      contato de emergência) → valor inteiro vira '[redacted]'.
 *   2. Strings livres (mensagem do log, evidência) → mascaramos PADRÕES
 *      (telefone E.164/BR, CPF, e-mail) mesmo dentro do texto.
 *
 * Mantém intactas as chaves operacionais (trace_id, conversation_id, category,
 * contadores) pra não destruir a capacidade de debug.
 */

const SENSITIVE_KEY = new RegExp(
  [
    'phone', 'telefone', 'whatsapp', 'jid', 'cpf', 'rg', 'email', 'e_mail',
    'address', 'endereco', 'endereço', 'street', 'rua', 'logradouro', 'cep',
    'lat', 'lng', 'latitude', 'longitude', 'geo', 'coord',
    'pix', 'card', 'cartao', 'cartão',
    'full_name', 'preferred_name', 'patient_name', 'contact_name',
    'emergency_contact_name', 'emergency_contact_phone',
    'birth', 'nascimento', 'rg', 'passport',
  ].join('|'),
  'i',
);

// Telefone BR/E.164 (com ou sem +55, com separadores), CPF, e-mail.
const PHONE_RE = /(\+?55\s?)?(\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}/g;
const CPF_RE = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function maskString(s: string): string {
  if (!s) return s;
  return s
    .replace(EMAIL_RE, '[email]')
    .replace(CPF_RE, '[cpf]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m));
}

export function redactPII<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return maskString(value) as unknown as T;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactPII(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactPII(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}
