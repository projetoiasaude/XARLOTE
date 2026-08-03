/**
 * Diretório vivo de fornecedores — quem TEM WhatsApp de verdade (análise 12/07).
 *
 * O Google Places devolve o telefone FIXO do balcão (responde 8%); o celular responde
 * 61%. Este módulo faz o diretório APRENDER sozinho, pedido a pedido — usando SÓ sinais
 * POSITIVOS e confiáveis (review 13/07: NUNCA deduzir "não tem WhatsApp" da AUSÊNCIA de um
 * sinal — o parser de status do zpro é não-documentado e farmácia lenta parece "morta";
 * strikes por silêncio envenenariam o diretório em todo pedido). Só marcamos verificação:
 *   • QUALQUER resposta inbound da farmácia → tem WhatsApp (sinal FORTE e confiável).
 *   • callback de entrega/leitura do zpro (delivered/read) → tem WhatsApp (best-effort;
 *     se o parser não casar o payload real, apenas NÃO carimba — nunca marca falso).
 * A seleção prioriza verificadas/celulares SEM punir ninguém.
 *
 * Sem DDL: usa a coluna que já existe (whatsapp_verified_at).
 */
import { db, writeLog } from '@iasaude/db';
import { brPhoneVariants, toE164BR } from '@iasaude/shared';

/**
 * Sinal POSITIVO vindo do callback de status do zpro: a mensagem foi ENTREGUE/LIDA no
 * número → ele tem WhatsApp. Carimba whatsapp_verified_at em todos os suppliers que
 * casam o telefone (variantes do 9º dígito). Silencioso quando o telefone não é de
 * fornecedor (ex.: status da perna do cliente).
 */
export async function recordSupplierWaDelivery(
  phoneRaw: string,
  kind: 'delivered' | 'read',
  traceId: string,
): Promise<void> {
  const e164 = toE164BR(phoneRaw);
  if (!e164) return;
  const variants = brPhoneVariants(e164);
  // 📬 O eco de entrega é o ÚNICO sinal real de que a Meta entregou. Até agora ele só
  // carimbava `suppliers.whatsapp_verified_at` (um booleano por número) e a linha de
  // `messages` ficava com `delivery_status` NULL pra sempre — "delivered" na perna do
  // estabelecimento significava apenas "o POST pro zpro não lançou".
  //
  // O eco do zpro carrega SÓ o telefone (ver extractZproDeliverySignal), então a
  // correlação é por número + recência. Isso é INFERÊNCIA, não prova, e o código trata
  // assim: só a última mensagem daquele número, só dentro de 10 min, e só promovendo
  // NULL/window_blocked → delivered (nunca rebaixa um veredito já conhecido).
  await stampLastOutboundDelivered(variants, kind, traceId).catch(() => { /* best-effort */ });
  const orExpr = variants.map((p) => `whatsapp_e164.eq.${p}`).join(',');
  const { data: sups } = await db
    .from('suppliers')
    .select('id, whatsapp_verified_at, type')
    .or(orExpr);
  // Só fornecedores (farmácia/clínica) — nunca carimba por engano se o número coincidir
  // com algo que não seja supplier. E só os ainda não verificados.
  const unverified = (sups ?? [])
    .filter((s) => !s.whatsapp_verified_at)
    .map((s) => s.id as string);
  if (!unverified.length) return;
  await db
    .from('suppliers')
    .update({ whatsapp_verified_at: new Date().toISOString() })
    .in('id', unverified);
  await writeLog('info', 'supplier', `📬 WhatsApp VERIFICADO por entrega (${kind}) — ${unverified.length} fornecedor(es)`, {
    traceId, supplierIds: unverified,
  });
}

/** Janela de atribuição do eco: fora dela, não dá pra dizer QUAL mensagem foi entregue. */
const ECHO_ATTRIBUTION_MS = 10 * 60_000;

/**
 * Carimba a última mensagem enviada àquele número como entregue/lida.
 * Conservador de propósito — chute disfarçado de certeza é o erro que estamos consertando.
 */
async function stampLastOutboundDelivered(
  phoneVariants: string[],
  kind: 'delivered' | 'read',
  traceId: string,
): Promise<void> {
  const jids = phoneVariants.map((p) => `whatsapp_jid.eq.${p.replace(/\D/g, '')}@s.whatsapp.net`).join(',');
  const { data: convs } = await db.from('conversations').select('id').or(jids).limit(5);
  const convIds = (convs ?? []).map((c) => c.id as string);
  if (!convIds.length) return;
  const since = new Date(Date.now() - ECHO_ATTRIBUTION_MS).toISOString();
  const { data: msg } = await db.from('messages')
    .select('id, delivery_status')
    .in('conversation_id', convIds)
    .eq('direction', 'out')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!msg?.id) return;
  // Nunca rebaixa: se já sabemos que falhou, o eco (que pode ser de outra mensagem) não
  // reescreve isso. Só preenche o que estava vazio ou bloqueado por janela.
  if (msg.delivery_status && !['window_blocked'].includes(msg.delivery_status as string)) return;
  await db.from('messages')
    .update({ delivery_status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', msg.id as string);
  await writeLog('info', 'outbound', `📬 Entrega ao estabelecimento CONFIRMADA pelo eco (${kind}) — atribuída por telefone+recência, não por id`, { traceId });
}

/** Sinal POSITIVO mais forte: a farmácia RESPONDEU. Carimba por id (barato, idempotente). */
export async function markSupplierVerifiedById(supplierId: string): Promise<void> {
  await db
    .from('suppliers')
    .update({ whatsapp_verified_at: new Date().toISOString() })
    .eq('id', supplierId)
    .is('whatsapp_verified_at', null);
}
