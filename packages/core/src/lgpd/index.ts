import { CONSENT_ACCEPTED_PATTERNS, LGPD_POLICY_VERSION, pediuEsquecimento } from '@iasaude/shared';

export function isConsentAccepted(text: string): boolean {
  const raw = text.trim();
  // Tolera pontuação/emoji no FIM ("aceito!", "Sim.", "ok 👍") — os padrões são ancorados
  // em $ e a resposta natural de idoso vem pontuada (review 10/07 #24). Só usa a versão
  // limpa se sobrar algo (senão "👍" puro se auto-apagaria e deixaria de casar).
  const stripped = raw.replace(/[\s.,!…"'👍💙✅🙏😊]+$/u, '');
  const candidates = stripped && stripped !== raw ? [raw, stripped] : [raw];
  return CONSENT_ACCEPTED_PATTERNS.some((p) => candidates.some((c) => p.test(c)));
}

/**
 * @deprecated Use `decidirEsquecimento` (@iasaude/shared) — ela também sabe CONFIRMAR,
 * que é a metade perigosa. Esta função só responde "a pessoa pediu?" e sobrevive pelos
 * chamadores antigos.
 */
export function isForgetMeRequest(text: string): boolean {
  return pediuEsquecimento(text);
}

export function buildConsentEvent(userId: string, messageId: string, evidenceText: string) {
  return {
    user_id: userId,
    event_type: 'accept' as const,
    policy_version: LGPD_POLICY_VERSION,
    channel: 'whatsapp',
    evidence_message_id: messageId,
    evidence_text: evidenceText,
  };
}
