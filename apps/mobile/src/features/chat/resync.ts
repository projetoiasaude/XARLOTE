/**
 * O resync do chat, decidido por uma função pura.
 *
 * ## O comentário que era mentira
 *
 * O `use-chat` dizia, com todas as letras: *"Invalida só a PRIMEIRA página: refazer
 * todas as páginas a cada reconexão puxaria a conversa inteira num túnel de metrô."* E
 * chamava `invalidateQueries`.
 *
 * Conferido no fonte instalado (`@tanstack/query-core@5.101.4`,
 * `infiniteQueryBehavior.js`): num refetch sem `direction`, `remainingPages = pages ??
 * oldPages.length` e o `do...while` refaz **TODAS** as páginas carregadas, em sequência.
 * O parâmetro `pages` só é preenchido por `fetchInfiniteQuery` — `invalidateQueries`
 * nunca o passa.
 *
 * O custo real: `resync()` roda a cada evento do SSE, a cada reconexão, e a cada 5s no
 * modo degradado. Quem rolou 10 páginas do histórico pagava 10 requisições sequenciais
 * por CADA resposta da Xarlote — e no modo degradado (que liga justamente quando a rede
 * está ruim) 10 requisições a cada 5 segundos, indefinidamente.
 *
 * ## Por que não `maxPages`, e por que não trocar a página
 *
 * `maxPages` é a receita óbvia e está ERRADA aqui: ele descarta pela frente do array, e
 * a frente é a página MAIS NOVA. Fetching histórico antigo apagaria o fim da conversa —
 * a pessoa rola pra cima, volta pra baixo, e as últimas mensagens sumiram.
 *
 * Substituir a página 0 pela fresca também é errado, e o defeito é pior porque é
 * invisível. Com duas páginas carregadas (N1..N30 e N31..N60) e 3 mensagens novas, a
 * página fresca vira A1..A3,N1..N27 — e N28, N29, N30 deixam de existir no cache. Um
 * BURACO no meio da conversa, sem nada na tela sugerindo que ele está ali.
 *
 * ## O que esta função faz
 *
 * FUNDE a página fresca na página 0 — nunca troca, nem quando a página 0 é a única
 * carregada. A invariante que ela protege: *a página 0 contém tudo entre agora e o
 * `nextCursor` dela.* Acrescentar mensagens mais novas preserva isso; trocar não —
 * trocar apaga do cache o que o evento do SSE acabou de inserir, porque a resposta em
 * voo foi calculada antes daquela linha existir. Com duas ou mais páginas o `nextCursor`
 * ANTIGO fica (ele é a ponte pra página 1); com uma só, o novo.
 *
 * E quando não dá para fundir — nenhuma mensagem em comum entre a fresca e a antiga,
 * porque a pessoa ficou fora por mais de uma página, ou porque o histórico foi apagado
 * (forget-me) — ela diz `recomecar`. Recomeçar é honesto; desenhar buraco não é.
 */
import type { ServerMessage } from './merge';

export interface PaginaChat {
  conversationId: string | null;
  messages: ServerMessage[];
  nextCursor: string | null;
}

export type Fusao =
  /** Nada mudou — o chamador NÃO deve escrever no cache (escrever re-renderiza a lista). */
  | { tipo: 'inalterado' }
  | { tipo: 'fundido'; paginas: PaginaChat[] }
  /** Há lacuna entre a página fresca e o que estava em cache: só um recomeço é honesto. */
  | { tipo: 'recomecar' };

function mesmasMensagens(a: readonly ServerMessage[], b: readonly ServerMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    // Compara o que a tela DESENHA. Duas linhas com o mesmo id podem diferir em texto
    // (a Xarlote corrigiu) ou ganhar mídia depois — e aí não é "inalterado".
    if (x.id !== y.id || x.text !== y.text || x.contentType !== y.contentType) return false;
    if ((x.mediaId ?? null) !== (y.mediaId ?? null)) return false;
    if ((x.mediaMime ?? null) !== (y.mediaMime ?? null)) return false;
  }
  return true;
}

/**
 * União por id das duas páginas, em ordem ascendente por (createdAt, id).
 *
 * A fresca VENCE em caso de id repetido: ela é a versão canônica mais recente. A ordem é
 * a mesma da resposta do servidor (o keyset devolve `created_at desc, id desc` e a rota
 * inverte antes de mandar), pra que a página em cache continue parecida com o que a rota
 * devolveria.
 */
function unirPorId(fresca: PaginaChat, antiga: PaginaChat): ServerMessage[] {
  const porId = new Map<string, ServerMessage>();
  for (const m of antiga.messages) porId.set(m.id, m);
  for (const m of fresca.messages) porId.set(m.id, m);

  return [...porId.values()].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function fundirPrimeiraPagina(
  fresca: PaginaChat,
  atuais: readonly PaginaChat[],
): Fusao {
  const primeira = atuais[0];
  if (!primeira) return { tipo: 'fundido', paginas: [fresca] };

  // A ponte: pelo menos uma mensagem em comum prova que a fresca alcançou o topo do que
  // já tínhamos. Sem ela há LACUNA entre as duas metades, e costurá-las desenha o buraco
  // silencioso que este arquivo existe pra impedir.
  const idsAntigos = new Set(primeira.messages.map((m) => m.id));
  const temPonte = fresca.messages.some((m) => idsAntigos.has(m.id));

  /**
   * Uma página só: UNE, não substitui — e fica com o `nextCursor` NOVO.
   *
   * Substituir parecia seguro (não há página 1 pra ficar órfã) e APAGAVA a bolha que o
   * `inserirDoEvento` tinha acabado de colocar: a busca que estava em voo quando o
   * evento chegou foi calculada ANTES da linha existir, e a resposta dela não a contém.
   * A mensagem que o paciente enviou sumia da tela — e só voltava no evento seguinte.
   *
   * A união só pode conter mensagens A MAIS, o `mergeMessages` deduplica por id entre
   * páginas, e a invariante segue valendo: a página 0 contém tudo entre agora e o
   * `nextCursor` dela (com sobra do lado antigo, o que é inofensivo).
   *
   * A ponte vale aqui pelo mesmo motivo do ramo de 2+: quem ficou fora por mais de uma
   * página (o cache do chat sobrevive em disco, então isso é o normal de quem volta uma
   * semana depois) tem fresca e antiga DISJUNTAS — unir ali costuraria duas metades que
   * não se encontram. Com uma página só, recomeçar é exatamente ficar com a fresca.
   */
  if (atuais.length === 1) {
    // A página fresca é IGUAL à que está em cache: nada mudou, e escrever no cache
    // re-renderizaria a conversa inteira à toa (o polling do modo degradado roda a cada
    // 5s). Vem antes da ponte porque duas páginas vazias também não têm o que ligar.
    if (mesmasMensagens(fresca.messages, primeira.messages) && fresca.nextCursor === primeira.nextCursor) {
      return { tipo: 'inalterado' };
    }
    if (!temPonte) return { tipo: 'recomecar' };
    const mensagens = unirPorId(fresca, primeira);
    if (mesmasMensagens(mensagens, primeira.messages) && fresca.nextCursor === primeira.nextCursor) {
      return { tipo: 'inalterado' };
    }
    return {
      tipo: 'fundido',
      paginas: [
        {
          conversationId: fresca.conversationId ?? primeira.conversationId,
          messages: mensagens,
          // O cursor NOVO: ele acompanha o novo fim da página e não há página seguinte
          // carregada pra ficar órfã.
          nextCursor: fresca.nextCursor,
        },
      ],
    };
  }

  // Duas ou mais: a ponte pra página 1 tem que sobreviver.
  if (!temPonte) return { tipo: 'recomecar' };

  const mensagens = unirPorId(fresca, primeira);

  if (mesmasMensagens(mensagens, primeira.messages)) return { tipo: 'inalterado' };

  const nova: PaginaChat = {
    conversationId: fresca.conversationId ?? primeira.conversationId,
    messages: mensagens,
    // O cursor ANTIGO, sempre: ele aponta pro começo da página 1, que continua em cache.
    nextCursor: primeira.nextCursor,
  };
  return { tipo: 'fundido', paginas: [nova, ...atuais.slice(1)] };
}

/**
 * A mensagem que o SSE acabou de anunciar, pronta pra entrar na página 0.
 *
 * O evento não é a linha canônica (não traz `sender_role` nem mídia), mas traz o
 * suficiente pra bolha aparecer NA HORA. O resync canônico vem depois e o merge, que
 * deduplica por id, troca uma pela outra sem piscar.
 *
 * ## O `clientId` tem que atravessar — senão a foto vira texto
 *
 * O servidor publica também a mensagem do PRÓPRIO paciente, com o `clientId` que o app
 * mandou (`handlers/inbound-user.ts`). Se essa linha entrar aqui sem ele, o
 * `mergeMessages` não encontra o `mediaId` no mapa de mídias deste aparelho — e a foto
 * que já estava desenhada na bolha otimista vira a frase "Foto enviada" até o resync
 * canônico chegar. Numa rede ruim isso é a promessa central do produto piscando na cara
 * da pessoa; se o resync falhar, a foto não volta.
 */
export function inserirDoEvento(
  pagina: PaginaChat,
  ev: {
    id: string;
    direction: 'in' | 'out';
    contentType?: string;
    text?: string;
    clientId?: string;
    at: number;
  },
): PaginaChat | null {
  if (pagina.messages.some((m) => m.id === ev.id)) return null;
  const nova: ServerMessage = {
    id: ev.id,
    direction: ev.direction,
    contentType: ev.contentType ?? 'text',
    text: ev.text ?? null,
    createdAt: new Date(ev.at).toISOString(),
    ...(ev.clientId ? { clientId: ev.clientId } : {}),
  };
  return { ...pagina, messages: [...pagina.messages, nova] };
}
