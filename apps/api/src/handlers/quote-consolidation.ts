import { db, writeLog } from '@iasaude/db';
import { sendOutbound } from './outbound.js';

interface QuoteRow {
  id: string;
  status: string;
  total: number | null;
  subtotal: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  payment_link: string | null;
  notes: string | null;
  distance_km: number | null;
  supplier_id: string;
}

interface SupplierRow {
  id: string;
  name: string;
}

export async function consolidateQuotes(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  // Guard: only consolidate once per order
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order || ['quoted', 'confirming', 'handed_off', 'cancelled'].includes(order.status)) return;

  // Mark order as quoted immediately to prevent double-consolidation
  await db.from('orders').update({ status: 'quoted' }).eq('id', orderId).eq('status', 'quoting');

  const { data: quotes } = await db
    .from('quotes')
    .select('id, status, total, subtotal, delivery_fee, eta_minutes, payment_methods, pix_key, payment_link, notes, distance_km, supplier_id')
    .eq('order_id', orderId);

  const successful = (quotes ?? []).filter((q) => q.status === 'quoted') as QuoteRow[];

  if (successful.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      'Infelizmente não consegui cotação em nenhuma farmácia próxima agora 😔 Posso tentar de novo mais tarde ou em uma região diferente?',
      traceId,
    );
    await db.from('orders').update({ status: 'failed' }).eq('id', orderId);
    await writeLog('warn', 'order', 'No successful quotes for order', { traceId, orderId });
    return;
  }

  // Load supplier names
  const supplierIds = successful.map((q) => q.supplier_id);
  const { data: suppliers } = await db.from('suppliers').select('id, name').in('id', supplierIds);
  const supplierMap = new Map<string, string>((suppliers ?? []).map((s: SupplierRow) => [s.id, s.name]));

  // Sort by total price (ascending)
  const sorted = [...successful]
    .filter((q) => q.total != null)
    .sort((a, b) => (a.total ?? 999) - (b.total ?? 999))
    .slice(0, 3);

  if (sorted.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      'As farmácias responderam mas sem preço claro 😕 Posso tentar contato novamente?',
      traceId,
    );
    return;
  }

  // Build message
  const NUMBERS = ['1️⃣', '2️⃣', '3️⃣'];
  const lines: string[] = ['Consegui cotações pra você! 🎉\n'];

  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i] as QuoteRow;
    const name = supplierMap.get(q.supplier_id) ?? 'Farmácia';
    const total = q.total?.toFixed(2);
    const frete = q.delivery_fee != null ? (q.delivery_fee === 0 ? 'frete grátis' : `frete R$${q.delivery_fee.toFixed(2)}`) : '';
    const eta = q.eta_minutes ? `~${q.eta_minutes}min` : '';
    const payment = (q.payment_methods ?? []).join('/') || 'consulte';
    const pix = q.pix_key ? ` · Pix: ${q.pix_key}` : '';

    const parts = [frete, eta, payment].filter(Boolean).join(' · ');
    lines.push(`${NUMBERS[i] ?? `${i + 1}.`} *${name}* — R$${total}\n   ${parts}${pix}`);
  }

  const unavailableCount = (quotes ?? []).filter((q) => ['unavailable', 'timeout'].includes(q.status)).length;
  if (unavailableCount > 0) {
    lines.push(`\n_(${unavailableCount} farmácia${unavailableCount > 1 ? 's' : ''} não respondeu ou não tinha em estoque)_`);
  }

  lines.push('\nQual você prefere? Pode me dizer o número ou o nome da farmácia 😊');

  await sendOutbound(userConversationId, userPhoneE164, lines.join('\n'), traceId);

  // Store quote options in order summary so Xarlote can reference quote_ids when user picks
  const summaryForLLM = {
    order_id: orderId,
    status: 'quoted',
    options: sorted.map((q, i) => ({
      option: i + 1,
      quote_id: q.id,
      supplier_name: supplierMap.get(q.supplier_id) ?? 'Farmácia',
      total: q.total,
      delivery_fee: q.delivery_fee,
      eta_minutes: q.eta_minutes,
      payment_methods: q.payment_methods,
      pix_key: q.pix_key,
      payment_link: q.payment_link,
    })),
    instructions: 'Quando o usuário escolher uma opção (ex: "quero a 1", "prefiro a Droga Raia", "pode ser a mais barata"), identifique qual option corresponde e chame confirm_order_selection com o order_id e o quote_id corretos.',
  };

  await db.from('orders').update({
    summary: JSON.stringify(summaryForLLM, null, 2),
  }).eq('id', orderId);

  await writeLog('info', 'order', `Consolidated ${sorted.length} quotes for order`, {
    traceId, orderId, quotes: sorted.length,
  });
}
