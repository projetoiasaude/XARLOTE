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

/** Sinal POSITIVO mais forte: a farmácia RESPONDEU. Carimba por id (barato, idempotente). */
export async function markSupplierVerifiedById(supplierId: string): Promise<void> {
  await db
    .from('suppliers')
    .update({ whatsapp_verified_at: new Date().toISOString() })
    .eq('id', supplierId)
    .is('whatsapp_verified_at', null);
}
