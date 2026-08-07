/**
 * Tradução de falha de API pra algo que o paciente entenda — e pra uma DECISÃO.
 *
 * Duas regras que valem mais que o resto:
 *
 * 1. **A mensagem do servidor ganha.** Quando o backend manda `message`, ele sabe
 *    algo que o app não sabe (ex.: "o template ainda não foi aprovado, manda um oi
 *    pra Xarlote"). Sobrescrever isso com um texto genérico apaga a única
 *    orientação útil que existia.
 * 2. **`kind` é o que o app OBEDECE, `message` é o que o paciente LÊ.** Nenhuma tela
 *    decide fluxo lendo string — texto muda, comportamento não pode mudar junto.
 */

export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_code'
  | 'code_expired'
  | 'too_many_attempts'
  | 'unauthenticated'
  | 'consent_required'
  | 'unavailable'
  | 'not_found'
  | 'unknown';

export interface ApiFailure {
  kind: ApiErrorKind;
  /** PT-BR, na voz da Xarlote, pronto pra mostrar. */
  message: string;
  /** Tentar de novo tem chance de dar certo sem o paciente mudar nada? */
  retryable: boolean;
  /** Código cru do servidor, pra log/telemetria — nunca pra decidir fluxo. */
  code?: string;
}

/** Fallback por código, usado só quando o servidor não mandou `message`. */
const FALLBACK: Record<ApiErrorKind, string> = {
  network: 'Sem conexão agora. Confere a internet e tenta de novo.',
  timeout: 'A resposta demorou demais. Tenta de novo?',
  rate_limited: 'Muitas tentativas seguidas. Espera uns minutinhos e tenta de novo.',
  invalid_code: 'Esse código não confere. Dá uma olhada na mensagem do WhatsApp.',
  code_expired: 'Esse código já expirou. Pede um novo que eu te mando na hora.',
  too_many_attempts: 'Errou o código vezes demais. Pede um código novo pra continuar.',
  unauthenticated: 'Sua sessão expirou. Entra de novo, é rapidinho.',
  consent_required: 'Falta você aceitar os termos de uso dos seus dados de saúde.',
  unavailable: 'Estou meio indisponível agora. Tenta de novo em instantes.',
  not_found: 'Não encontrei isso.',
  unknown: 'Algo saiu do esperado. Tenta de novo?',
};

/** Códigos que o backend emite → o `kind` que o app entende. */
const CODE_TO_KIND: Record<string, ApiErrorKind> = {
  rate_limited: 'rate_limited',
  invalid_code: 'invalid_code',
  invalid_phone: 'invalid_code',
  code_expired: 'code_expired',
  too_many_attempts: 'too_many_attempts',
  invalid_refresh: 'unauthenticated',
  token_expired: 'unauthenticated',
  missing_token: 'unauthenticated',
  session_revoked: 'unauthenticated',
  consent_required: 'consent_required',
  otp_unavailable: 'unavailable',
  app_auth_not_configured: 'unavailable',
};

/** Por status HTTP, quando o corpo não trouxe código reconhecível. */
function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 404) return 'not_found';
  if (status === 410) return 'code_expired';
  if (status === 428) return 'consent_required';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
  'network',
  'timeout',
  'unavailable',
]);

function readBody(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  return {
    code: typeof b['error'] === 'string' ? b['error'] : undefined,
    message: typeof b['message'] === 'string' && b['message'].trim() ? b['message'].trim() : undefined,
  };
}

export function classifyApiError(status: number, body: unknown): ApiFailure {
  const { code, message } = readBody(body);
  // Código conhecido manda; código novo/desconhecido cai no status HTTP, que é o
  // piso. O backend pode ganhar um `error` novo amanhã sem quebrar o app.
  const kind = (code ? CODE_TO_KIND[code] : undefined) ?? kindFromStatus(status);
  return {
    kind,
    message: message ?? FALLBACK[kind],
    retryable: RETRYABLE.has(kind),
    ...(code ? { code } : {}),
  };
}

/** Falha antes de haver resposta: sem rede, DNS, TLS, ou o AbortController estourou. */
export function classifyTransportError(err: unknown): ApiFailure {
  const aborted =
    typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
  const kind: ApiErrorKind = aborted ? 'timeout' : 'network';
  return { kind, message: FALLBACK[kind], retryable: true };
}

/** Erro que o app carrega pelas camadas sem perder a classificação. */
export class ApiError extends Error {
  readonly failure: ApiFailure;
  readonly status: number;

  constructor(failure: ApiFailure, status: number) {
    super(failure.message);
    this.name = 'ApiError';
    this.failure = failure;
    this.status = status;
  }
}
