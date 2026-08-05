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
    'address', 'endereco', 'endereço', 'street', 'road', 'rua', 'logradouro', 'cep', 'postcode', 'postal',
    'complement', 'complemento', 'bairro', 'neighborhood', 'numero', 'quadra', 'lote',
    'lat', 'lng', 'latitude', 'longitude', 'geo', 'coord',
    'pix', 'card', 'cartao', 'cartão',
    'full_name', 'preferred_name', 'patient_name', 'contact_name',
    'emergency_contact_name', 'emergency_contact_phone',
    'birth', 'nascimento', 'rg', 'passport',
    // dados clínicos de PERFIL (LGPD dado sensível — CLAUDE.md #3). NÃO inclui 'medication'/
    // 'medicamento' de propósito: é amplo demais (o fluxo de pedido loga o nome do remédio pra
    // debug operacional); aqui só os campos de condição/alergia/diagnóstico/sintoma do perfil.
    'condition', 'allergy', 'alergia', 'diagnos', 'clinical', 'clinico',
    'symptom', 'sintoma', 'substance', 'prescription', 'receita',
  ].join('|'),
  'i',
);

// Telefone BR/E.164 (com ou sem +55, com separadores), CPF, e-mail.
//
// 🔴 O lookbehind/lookahead NÃO é decoração (auditoria 05/08). Sem eles o padrão casava
// 8 dígitos DENTRO de qualquer token — e o primeiro segmento de um uuid tem 8 caracteres
// hex, que em ~2% dos casos saem todos numéricos. Resultado real em produção:
//
//   "traceId": "[phone]-79fd-4e65-877f-d17ae23628e4"
//
// O traceId era destruído e com ele a capacidade de seguir um turno pelos logs — foi
// exatamente o que me travou ao investigar a conversa da Ludmila. Um redator que corrompe
// identificador operacional não está protegendo o paciente, está cegando a operação.
const PHONE_RE = /(?<![\w-])(\+?55\s?)?(\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}(?![\w-])/g;
const CPF_RE = /(?<![\w-])\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?![\w-])/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Par de coordenadas lat,lng (decimal com ponto, 4-7 casas — o formato `toFixed(4/5)` dos logs).
// Não colide com preço BR ("1.234,56" usa vírgula como decimal, não este shape).
const COORD_RE = /-?\d{1,3}\.\d{4,7}\s*,\s*-?\d{1,3}\.\d{4,7}/g;

/**
 * IDENTIFICADORES que precisam sair INTACTOS do redator.
 *
 * A defesa é ESTRUTURAL, não uma lista de nomes de chave: um uuid e um hex-token longo têm
 * forma inconfundível, e nenhum telefone/CPF do mundo tem essa forma. Blindar a forma cobre
 * `traceId`, `wa_key`, `messageId`, `externalKey` e qualquer identificador que apareça no
 * futuro, sem ninguém precisar se lembrar de adicioná-lo numa lista.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/**
 * Hash/chave hexadecimal (wa_key, sendToken). 12+ pra não pegar palavra comum nem preço.
 *
 * ⚠️ `(?![0-9]+\b)` É OBRIGATÓRIO — dígito é subconjunto de hex. Sem essa guarda, um telefone
 * colado de 12-13 dígitos (`551188887777`, `+5562983450244`) era "protegido" como token e
 * **deixava de ser mascarado**: vazamento de PII criado justamente pela correção que blinda
 * identificadores. Pego na revisão adversarial desta mudança.
 *
 * O custo é aceitar que um wa_key todo numérico (~0,8% dos casos) seja mascarado como
 * telefone. Na dúvida entre proteger o paciente e preservar um id, protege o paciente — e o
 * traceId, que é o id que importa pra correlação, tem forma de uuid e está coberto acima.
 */
const HEX_TOKEN_RE = /\b(?![0-9]+\b)[0-9a-f]{12,}\b/gi;

/**
 * Mascara PII em texto livre, preservando identificadores operacionais.
 *
 * Como: tira os identificadores de cena (sentinela com caractere de controle, que nenhum dos
 * padrões de PII consegue casar), mascara o que sobrou, e devolve os identificadores ao
 * lugar. É o único jeito de garantir que um padrão de PII nunca "coma" um id, por mais que
 * os padrões evoluam depois.
 */
export function maskString(s: string): string {
  if (!s) return s;

  const guardados: string[] = [];
  // Sentinela com NUL: nenhum padrão de PII casa caractere de controle, e NUL não aparece
  // em texto vindo do WhatsApp. Um sentinela "legível" (número entre espaços, por exemplo)
  // colidiria com número REAL do texto e o restore devolveria um id no lugar de conteúdo do
  // paciente. Constante nomeada em vez de byte literal no fonte: NUL cru no arquivo sobrevive
  // mal a editor, diff e cópia.
  const NUL = String.fromCharCode(0);
  const guardar = (m: string): string => {
    guardados.push(m);
    return `${NUL}${guardados.length - 1}${NUL}`;
  };
  // UUID antes de HEX_TOKEN: o uuid contém trechos hex de 12 (o último grupo) e seria
  // fatiado em pedaços, voltando desmontado.
  const protegido = s.replace(UUID_RE, guardar).replace(HEX_TOKEN_RE, guardar);

  const mascarado = protegido
    .replace(EMAIL_RE, '[email]')
    .replace(CPF_RE, '[cpf]')
    .replace(COORD_RE, '[geo]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m));

  const restore = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');
  return mascarado.replace(restore, (_all, i: string) => guardados[Number(i)] ?? '');
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
