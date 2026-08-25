/**
 * outreach-hold — quando um humano assume o caso, o robô cala a boca.
 *
 * ─── A LACUNA (Duda, 24/08/2026) ──────────────────────────────────────────────
 * Às 15:48 a Duda recebeu "Confirmado! 🎉" por uma consulta que não existia. O erro foi
 * detectado às 18:09, o estado corrigido no banco, e o fundador ficou de falar com ela.
 *
 * Às 18:53 — no meio disso — o worker de nudge disparou sozinho:
 *   "Oi! As opções de consulta que te mandei ainda estão de pé 💙 Quer confirmar alguma?"
 *
 * Depois do reparo a frase até era verdadeira, mas ela é surda ao que a paciente tinha
 * acabado de passar, e chegou ANTES de qualquer explicação humana. Na hora, eu não tinha
 * como impedir: todo estado vivo dispara algum vigilante, e os únicos que não disparam
 * nada (`cancelled`, `failed`) seriam mentira. Não existia "pausa".
 *
 * ─── O GATILHO CERTO É O PRÓPRIO ATENDIMENTO HUMANO ───────────────────────────
 * A tentação seria uma flag que alguém precisa lembrar de ligar — e flag que depende de
 * memória é flag que falha no dia do incidente (foi assim com `suppressLlmText`). Aqui o
 * gatilho é automático e não pede disciplina de ninguém: **quando um humano manda uma
 * mensagem manual para o paciente, a automação recua por um tempo.** Quem está sendo
 * atendido por uma pessoa não precisa de cutucada de robô no meio da conversa.
 *
 * A pausa é curta e expira sozinha. Silêncio permanente seria a outra falha: o paciente
 * deixaria de receber o que ele de fato precisa, e ninguém notaria.
 *
 * ⚠️ NÃO vale pra lembrete de remédio nem aviso de consulta — esses não são "outreach",
 * são o serviço. Quem consulta esta pausa é o re-engajamento (nudge/rescue).
 *
 * PURO: sem I/O, sem relógio próprio.
 */

/** Quanto tempo a automação recua depois de um humano falar. */
export const PAUSA_PADRAO_MS = 12 * 3_600_000;

/** Teto de segurança: ninguém silencia o re-engajamento por mais de 3 dias. */
export const PAUSA_MAXIMA_MS = 72 * 3_600_000;

/** Onde a pausa mora dentro de `users.metadata`. */
export const CHAVE_PAUSA = '_outreach_hold_until';
export const CHAVE_PAUSA_MOTIVO = '_outreach_hold_reason';

/** `true` se o re-engajamento automático deve ficar quieto agora. */
export function emPausaDeOutreach(metadata: unknown, nowMs: number): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const bruto = (metadata as Record<string, unknown>)[CHAVE_PAUSA];
  if (typeof bruto !== 'string') return false;
  const ate = Date.parse(bruto);
  return Number.isFinite(ate) && ate > nowMs;
}

/** Motivo da pausa, pro log dizer por que ficou quieto. */
export function motivoDaPausa(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = (metadata as Record<string, unknown>)[CHAVE_PAUSA_MOTIVO];
  return typeof m === 'string' && m.trim() ? m : null;
}

/**
 * Devolve `metadata` com a pausa gravada. Não muta a entrada — quem grava é o chamador,
 * que tem o lock.
 *
 * Nunca ENCURTA uma pausa existente: se dois humanos falarem com o mesmo paciente, vale
 * a mais longa. Recuar mais é sempre seguro; recuar menos pode reintroduzir o incidente.
 */
export function comPausaDeOutreach(
  metadata: unknown,
  nowMs: number,
  duracaoMs: number,
  motivo: string,
): Record<string, unknown> {
  const base = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  const pedido = Math.max(0, Math.min(duracaoMs, PAUSA_MAXIMA_MS));
  const novoFim = nowMs + pedido;
  const atualBruto = base[CHAVE_PAUSA];
  const atualFim = typeof atualBruto === 'string' ? Date.parse(atualBruto) : Number.NaN;
  const fim = Number.isFinite(atualFim) && atualFim > novoFim ? atualFim : novoFim;
  return {
    ...base,
    [CHAVE_PAUSA]: new Date(fim).toISOString(),
    [CHAVE_PAUSA_MOTIVO]: motivo.slice(0, 160),
  };
}
