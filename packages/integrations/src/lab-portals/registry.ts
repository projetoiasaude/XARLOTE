/**
 * Registry de adapters — igual ao das redes de farmácia: uma lista, do mais específico ao
 * genérico, e a primeira que `casa()` vence.
 *
 * Hoje só há o genérico. Um adapter específico entra aqui quando alguém OLHOU o portal real
 * e escreveu seletores contra ele. Adapter escrito no escuro é adapter que quebra em
 * silêncio — o Instituto Goiano (caso Glauber) é o primeiro candidato e não foi escrito por
 * esse motivo.
 */
import type { LabAdapter, AlvoDoPortal } from './types.js';
import { adapterGenerico } from './generico.js';

export const ADAPTERS: readonly LabAdapter[] = [
  // específicos primeiro (nenhum ainda)
  adapterGenerico,
];

export function escolherAdapter(alvo: AlvoDoPortal): LabAdapter {
  return ADAPTERS.find((a) => a.casa(alvo)) ?? adapterGenerico;
}

/**
 * Sem URL impressa no protocolo, o genérico não tem para onde ir. Devolve a URL de entrada:
 * a do protocolo, se houver e for http(s); senão a padrão do adapter; senão null.
 */
export function urlDeEntrada(alvo: AlvoDoPortal, adapter: LabAdapter): string | null {
  const u = (alvo.url ?? '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  // Protocolo impresso sem esquema: "resultados.laboratorio.com.br"
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u)) return `https://${u}`;
  return adapter.urlPadrao ?? null;
}
