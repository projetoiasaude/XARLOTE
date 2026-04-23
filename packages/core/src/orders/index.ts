import type { Order, Quote } from '@iasaude/shared';
import { QUOTE_CONSOLIDATE_MIN_COMPLETED, QUOTE_CONSOLIDATE_MIN_ELAPSED_MS, QUOTE_TIMEOUT_MS } from '@iasaude/shared';

export type ConsolidationDecision = 'present' | 'wait' | 'fail';

export function shouldConsolidate(order: Order, quotes: Quote[]): ConsolidationDecision {
  const completed = quotes.filter((q) => q.status === 'quoted');
  const failed = quotes.filter((q) => ['unavailable', 'timeout', 'refused'].includes(q.status));
  const total = quotes.length;
  const elapsed = order.created_at
    ? Date.now() - new Date(order.created_at).getTime()
    : 0;

  if (completed.length >= 3) return 'present';
  if (completed.length >= QUOTE_CONSOLIDATE_MIN_COMPLETED && elapsed >= QUOTE_CONSOLIDATE_MIN_ELAPSED_MS) return 'present';
  if (elapsed >= QUOTE_TIMEOUT_MS && completed.length >= 1) return 'present';
  if (elapsed >= QUOTE_TIMEOUT_MS && completed.length === 0 && failed.length === total) return 'fail';
  if (completed.length + failed.length === total && completed.length >= 1) return 'present';
  return 'wait';
}

export function buildConsolidationMessage(quotes: Quote[], supplierNames: Record<string, string>): string {
  const completed = quotes
    .filter((q) => q.status === 'quoted' && q.total !== null)
    .sort((a, b) => (a.total ?? 0) - (b.total ?? 0))
    .slice(0, 3);

  if (completed.length === 0) {
    return 'Não consegui resposta das farmácias nesse momento 😕 Quer que eu tente de novo mais tarde?';
  }

  const emojis = ['1️⃣', '2️⃣', '3️⃣'];
  const lines = completed.map((q, i) => {
    const name = supplierNames[q.supplier_id] ?? 'Farmácia';
    const total = q.total?.toFixed(2).replace('.', ',');
    const frete = q.delivery_fee ? ` (frete R$ ${q.delivery_fee.toFixed(2).replace('.', ',')})` : ' (frete grátis)';
    const eta = q.eta_minutes ? ` · entrega ~${q.eta_minutes}min` : '';
    const payment = q.payment_methods?.join('/') ?? 'Pix';
    return `${emojis[i]} *${name}* — R$ ${total}${frete}${eta} · ${payment}`;
  });

  const cheapest = completed[0];
  const cheapestName = cheapest ? (supplierNames[cheapest.supplier_id] ?? 'a mais barata') : '';

  return (
    `Consegui ${completed.length} opção${completed.length > 1 ? 'ões' : ''} 👇\n\n` +
    lines.join('\n') +
    `\n\nA ${cheapestName} saiu mais em conta. Qual você prefere? 😊`
  );
}
