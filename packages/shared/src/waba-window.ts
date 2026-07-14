/**
 * Janela de 24h do WhatsApp Business API (Meta oficial). Fora dela, texto livre é
 * rejeitado pela Meta — só template HSM passa. Incidente Elizabet 13/07.
 *
 * A margem é APENAS clock-skew (2min), NÃO horas: lembrete diário dispara a cada ~24h;
 * quem responde rápido (poucos minutos após o lembrete) ficaria com ~23h55 desde o inbound
 * no disparo do dia seguinte — uma margem de 1h suprimiria JUSTAMENTE o usuário aderente,
 * mesmo com a janela real do Meta ainda aberta (review 13/07).
 */
export const WABA_WINDOW_MS = 24 * 60 * 60 * 1000 - 2 * 60 * 1000;

/** A janela de 24h está aberta? (último inbound REAL do WhatsApp < 24h−2min atrás). */
export function isWabaWindowOpen(lastInboundMs: number | null | undefined, nowMs: number): boolean {
  if (lastInboundMs == null) return false;
  return nowMs - lastInboundMs < WABA_WINDOW_MS;
}
