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
import { adapterSynapse } from './synapse.js';

export const ADAPTERS: readonly LabAdapter[] = [
  // específicos primeiro — cada um escrito OLHANDO o portal real
  adapterSynapse, // CDI Goiânia e outros Synapse EIS/RIS (21/09/2026, caso Ciro)
  adapterGenerico,
];

export function escolherAdapter(alvo: AlvoDoPortal): LabAdapter {
  return ADAPTERS.find((a) => a.casa(alvo)) ?? adapterGenerico;
}

/**
 * Depois de abrir a página: algum adapter específico se reconhece nela? O protocolo do CDI
 * diz "cdig.com.br" (a home, sem login); a página de resultados se apresenta como Synapse.
 * A detecção pela página vence a escolha pela URL.
 */
export function escolherAdapterPelaPagina(html: string, atual: LabAdapter): LabAdapter {
  return ADAPTERS.find((a) => a.detecta?.(html)) ?? atual;
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
