/**
 * Variantes do 9º dígito de celular BR.
 *
 * O WhatsApp/Meta às vezes ENTREGA o número sem o 9 (+55 62 8345-024x) enquanto a
 * pessoa/nós usamos COM o 9 (+55 62 9 8345-024x) — e vice-versa. Isso quebra
 * qualquer match por número/jid: mandamos template pra 13 dígitos (com 9), a
 * resposta volta com 12 (sem 9), e a conversa não bate → a mensagem cai na lane
 * errada. Sempre casar por TODAS as variantes.
 */

/** E.164 (com/sem o 9º dígito) — sempre inclui o original primeiro. */
export function brPhoneVariants(phoneE164: string): string[] {
  const variants = [phoneE164];
  const m = phoneE164.match(/^\+?55(\d{2})(\d+)$/);
  if (m) {
    const [, ddd, subscriber] = m;
    if (subscriber!.length === 9 && subscriber!.startsWith('9')) {
      variants.push(`+55${ddd}${subscriber!.slice(1)}`); // remove o 9
    } else if (subscriber!.length === 8) {
      variants.push(`+55${ddd}9${subscriber}`); // insere o 9
    }
  }
  return [...new Set(variants)];
}

/**
 * jids `<digitos>@s.whatsapp.net` de TODAS as variantes do número — pra casar
 * conversas independentemente do 9º dígito. Aceita E.164, dígitos ou um jid.
 */
export function whatsappJidVariants(phoneOrJid: string): string[] {
  const digits = phoneOrJid.replace(/@.*$/, '').replace(/\D/g, '');
  const e164 = `+${digits}`;
  return brPhoneVariants(e164).map((p) => `${p.replace(/\D/g, '')}@s.whatsapp.net`);
}
