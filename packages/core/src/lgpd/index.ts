import { CONSENT_ACCEPTED_PATTERNS, FORGET_ME_PATTERNS, LGPD_POLICY_VERSION } from '@iasaude/shared';

export function isConsentAccepted(text: string): boolean {
  return CONSENT_ACCEPTED_PATTERNS.some((p) => p.test(text.trim()));
}

export function isForgetMeRequest(text: string): boolean {
  return FORGET_ME_PATTERNS.some((p) => p.test(text));
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
