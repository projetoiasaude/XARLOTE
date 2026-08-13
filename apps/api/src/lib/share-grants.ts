/**
 * O link do médico — as decisões, puras e testáveis.
 *
 * ## O que este link é
 *
 * O paciente gera um endereço e manda pro médico dele. O médico abre no navegador e vê o
 * resumo clínico: alergias, medicamentos em uso, condições, exames recentes. Sem app, sem
 * cadastro, sem login. É a superfície da Xarlote para o profissional.
 *
 * ## O que ele NÃO pode ser
 *
 * Um endereço que dá acesso a prontuário, sem autenticação, é um objeto perigoso por
 * construção. As defesas, e o porquê de cada uma:
 *
 * · **Token de 256 bits, e o banco guarda só o hash.** Um vazamento do banco não entrega
 *   links funcionando. Mesmo modelo do refresh token da sessão.
 * · **Validade curta** (72h padrão, 7 dias no máximo). Link de prontuário não é para
 *   durar: o paciente mostra na consulta e ele morre sozinho. Sem validade, um link
 *   compartilhado uma vez fica aberto para sempre.
 * · **PIN opcional de 4 dígitos**, com trava em 5 erros. Protege o caso real de o link
 *   ser encaminhado adiante — o WhatsApp do médico, o grupo da clínica.
 * · **404 indistinguível.** Expirado, revogado, inexistente e PIN errado devolvem a MESMA
 *   forma de resposta. Um 410 "expirado" confirmaria ao atacante que o token existiu, e
 *   transformaria a busca por tokens válidos num jogo com feedback.
 * · **Nada em URL de log.** O token vai no CORPO do POST, nunca na query string — access
 *   log de proxy é o lugar onde credencial some sem ninguém notar.
 *
 * PURO: `nowMs` e o gerador de aleatoriedade são injetados. O I/O fica na rota.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TTL_PADRAO_H = 72;
export const SHARE_TTL_MAX_H = 7 * 24;
export const PIN_MAX_TENTATIVAS = 5;

/** Token opaco em base64url — o que vai na URL que o paciente manda. */
export function novoShareToken(randomBytes: (n: number) => Buffer): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Hash do PIN COM sal por link.
 *
 * O sal existe porque o espaço é ridiculamente pequeno: 10 mil PINs de 4 dígitos. Sem
 * sal, uma tabela pré-computada resolve todos os links de uma vez; com sal por link, cada
 * um precisa ser atacado sozinho — e a trava em 5 tentativas fecha esse caminho.
 */
export function hashPin(pin: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

/** Comparação em tempo constante — evita descobrir o PIN medindo o tempo da resposta. */
export function pinConfere(pin: string, salt: string, hashEsperado: string): boolean {
  const a = Buffer.from(hashPin(pin, salt), 'hex');
  const b = Buffer.from(hashEsperado, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Validade pedida → instante de expiração, clampada no teto. */
export function expiraEm(horasPedidas: number | undefined, nowMs: number): Date {
  const h = Math.min(Math.max(horasPedidas ?? SHARE_TTL_PADRAO_H, 1), SHARE_TTL_MAX_H);
  return new Date(nowMs + h * 3_600_000);
}

export interface ShareGrantRow {
  expires_at: string;
  revoked_at: string | null;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_attempts: number;
}

export type VeredictoShare =
  /** libera o resumo */
  | { kind: 'ok' }
  /** precisa de PIN e não veio (ou veio errado) — a tela pede/repete */
  | { kind: 'pin_necessario'; tentativasRestantes: number }
  /**
   * Não existe, expirou, foi revogado, ou o PIN travou. **Um só desfecho de propósito**:
   * quem chama devolve sempre a mesma resposta, para não confirmar a existência do token.
   */
  | { kind: 'indisponivel' };

/**
 * O link pode abrir?
 *
 * A ordem das checagens importa: revogado e expirado vêm ANTES do PIN, senão um link
 * morto ainda aceitaria tentativas de PIN — e cada tentativa é um sinal de que o token
 * existe.
 */
export function avaliarShare(
  grant: ShareGrantRow,
  pinFornecido: string | undefined,
  nowMs: number,
): VeredictoShare {
  if (grant.revoked_at) return { kind: 'indisponivel' };

  const expira = Date.parse(grant.expires_at);
  if (!Number.isFinite(expira) || nowMs > expira) return { kind: 'indisponivel' };

  // Sem PIN configurado: o token sozinho basta.
  if (!grant.pin_hash || !grant.pin_salt) return { kind: 'ok' };

  // Travado por tentativas: indistinguível de inexistente, para não virar oráculo.
  if (grant.pin_attempts >= PIN_MAX_TENTATIVAS) return { kind: 'indisponivel' };

  const restantes = PIN_MAX_TENTATIVAS - grant.pin_attempts;
  if (!pinFornecido) return { kind: 'pin_necessario', tentativasRestantes: restantes };

  if (!pinConfere(pinFornecido, grant.pin_salt, grant.pin_hash)) {
    // `- 1` porque ESTA tentativa acabou de ser gasta: quem chama incrementa no banco.
    const sobrando = restantes - 1;
    return sobrando <= 0
      ? { kind: 'indisponivel' }
      : { kind: 'pin_necessario', tentativasRestantes: sobrando };
  }

  return { kind: 'ok' };
}

/** PIN válido: exatamente 4 dígitos. Vazio/ausente = link sem PIN. */
export function pinValido(pin: string | undefined | null): boolean {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

// ─── O resumo que o médico vê ──────────────────────────────────────────────────

export interface ResumoClinico {
  gerado_em: string;
  paciente: { nome: string | null; idade: number | null };
  alergias: Array<{ substancia: string; reacao: string | null; gravidade: string | null }>;
  medicamentos: Array<{ nome: string; dosagem: string | null; frequencia: string | null }>;
  condicoes: Array<{ nome: string; desde: string | null }>;
  exames: Array<{ tipo: string; data: string | null; resumo: string | null }>;
  adesao_30d: number | null;
}

/**
 * Idade a partir da data de nascimento.
 *
 * O resumo mostra IDADE e não a data: é o que o médico usa para decidir, e é menos
 * identificante que a data exata numa página que pode ser encaminhada adiante.
 */
export function idadeEm(birthDate: string | null | undefined, nowMs: number): number | null {
  if (!birthDate) return null;
  const nasc = Date.parse(birthDate);
  if (!Number.isFinite(nasc)) return null;
  const anos = (nowMs - nasc) / (365.2425 * 86_400_000);
  return anos >= 0 && anos < 130 ? Math.floor(anos) : null;
}

/**
 * O que entra no resumo — e o que fica de fora.
 *
 * Fica de fora, de propósito: telefone, CPF, endereço, o histórico de conversas e a
 * memória. O médico precisa do quadro clínico, não da vida do paciente; e esta página
 * pode acabar encaminhada. Menos dado exposto, menos dano se o link circular.
 */
export function montarResumo(
  dados: {
    user: { preferred_name?: string | null; full_name?: string | null; birth_date?: string | null; adherence_score_30d?: number | null };
    alergias: Array<{ substance: string; reaction?: string | null; severity?: string | null }>;
    medicamentos: Array<{ medication_name: string; dosage?: string | null; frequency?: string | null }>;
    condicoes: Array<{ name: string; onset_date?: string | null }>;
    exames: Array<{ exam_type: string; title?: string | null; exam_date?: string | null; summary?: string | null }>;
  },
  nowMs: number,
): ResumoClinico {
  return {
    gerado_em: new Date(nowMs).toISOString(),
    paciente: {
      nome: dados.user.preferred_name ?? dados.user.full_name ?? null,
      idade: idadeEm(dados.user.birth_date, nowMs),
    },
    alergias: dados.alergias.map((a) => ({
      substancia: a.substance,
      reacao: a.reaction ?? null,
      gravidade: a.severity ?? null,
    })),
    medicamentos: dados.medicamentos.map((m) => ({
      nome: m.medication_name,
      dosagem: m.dosage ?? null,
      frequencia: m.frequency ?? null,
    })),
    condicoes: dados.condicoes.map((c) => ({ nome: c.name, desde: c.onset_date ?? null })),
    exames: dados.exames.slice(0, 10).map((e) => ({
      tipo: e.title?.trim() || e.exam_type,
      data: e.exam_date ?? null,
      resumo: e.summary ?? null,
    })),
    adesao_30d: dados.user.adherence_score_30d ?? null,
  };
}
