import { describe, it, expect } from 'vitest';
import {
  fundirPrimeiraPagina,
  inserirDoEvento,
  type PaginaChat,
} from '../apps/mobile/src/features/chat/resync.js';
import { mergeMessages, type ServerMessage } from '../apps/mobile/src/features/chat/merge.js';

/**
 * O resync do chat.
 *
 * Este arquivo existe por causa de um defeito que NÃO aparece na tela: costurar a página
 * fresca no lugar da antiga apaga as mensagens do meio, e a conversa fica com um buraco
 * que nada denuncia. A pessoa rola pra cima e simplesmente não encontra o que a Xarlote
 * respondeu ontem.
 *
 * O invariante que os testes protegem: **a página 0 contém tudo entre agora e o
 * `nextCursor` dela.** Acrescentar mensagens mais novas preserva isso; substituir não.
 */

const m = (id: string, seg: number, over: Partial<ServerMessage> = {}): ServerMessage => ({
  id,
  direction: 'out',
  contentType: 'text',
  text: `msg ${id}`,
  createdAt: `2026-08-18T12:00:${String(seg).padStart(2, '0')}.000Z`,
  ...over,
});

/** Um `clientId` de verdade: é uuid v4 em produção (`Crypto.randomUUID`). */
const CLIENT = '33333333-3333-4333-8333-333333333333';

const pag = (messages: ServerMessage[], nextCursor: string | null = null): PaginaChat => ({
  conversationId: 'conv-1',
  messages,
  nextCursor,
});

describe('cache vazio', () => {
  it('a página fresca vira a única página', () => {
    const r = fundirPrimeiraPagina(pag([m('a', 1)]), []);
    expect(r.tipo).toBe('fundido');
    if (r.tipo !== 'fundido') return;
    expect(r.paginas).toHaveLength(1);
    expect(r.paginas[0]!.messages.map((x) => x.id)).toEqual(['a']);
  });
});

describe('uma página só carregada', () => {
  it('UNE, e fica com o cursor novo — não há página seguinte pra ficar órfã', () => {
    const antiga = pag([m('a', 1), m('b', 2)], 'cursor-a');
    const fresca = pag([m('b', 2), m('c', 3)], 'cursor-b');
    const r = fundirPrimeiraPagina(fresca, [antiga]);
    expect(r.tipo).toBe('fundido');
    if (r.tipo !== 'fundido') return;
    // `a` sobrevive: substituir apagaria do cache uma mensagem que existe e que a
    // pessoa está vendo. União só pode conter mensagens A MAIS.
    expect(r.paginas[0]!.messages.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.paginas[0]!.nextCursor).toBe('cursor-b');
  });

  /**
   * A corrida que apagava a mensagem recém-enviada.
   *
   * O evento do SSE insere a linha na página 0 na hora. Se uma busca já estava em voo
   * quando ele chegou, a resposta dela foi calculada ANTES da linha existir — e
   * substituir a página por essa resposta apagava da tela a bolha que acabara de
   * aparecer. Como o pedido seguinte era descartado pela guarda de "em voo" e fora do
   * modo degradado não há polling, ela ficava sumida até o próximo evento.
   */
  it('a mensagem que o evento inseriu SOBREVIVE a uma resposta que a antecede', () => {
    const comEvento = pag([m('a', 1), m('b', 2), m('nova', 3)], 'cursor-a');
    const frescaVelha = pag([m('a', 1), m('b', 2)], 'cursor-b');
    const r = fundirPrimeiraPagina(frescaVelha, [comEvento]);
    expect(r.tipo).toBe('fundido');
    if (r.tipo !== 'fundido') return;
    expect(r.paginas[0]!.messages.map((x) => x.id)).toEqual(['a', 'b', 'nova']);
  });

  it('sem NENHUMA mensagem em comum → recomeçar, e não uma costura com buraco', () => {
    // O cache do chat sobrevive em disco: quem volta uma semana depois tem a página
    // antiga inteira em mãos e uma página fresca que não a alcança. Unir ali desenharia
    // um buraco no meio da conversa que nada na tela denuncia.
    const antiga = pag([m('a', 1), m('b', 2)], 'cursor-a');
    const fresca = pag([m('x', 50), m('y', 51)], 'cursor-x');
    expect(fundirPrimeiraPagina(fresca, [antiga]).tipo).toBe('recomecar');
  });

  it('resposta vazia contra cache cheio recomeça — ghost de histórico apagado não sobrevive', () => {
    // Decisão consciente: uma fresca vazia é indistinguível de "o histórico foi apagado"
    // e de "a busca é anterior à primeira mensagem da conversa". Entre manter mensagens
    // que talvez não existam mais e perder por um instante uma que existe, ganha o
    // recomeço — o pedido ADIADO do `use-chat` (ver `pedidoPendente`) roda logo em
    // seguida e traz a linha de volta.
    expect(fundirPrimeiraPagina(pag([], null), [pag([m('primeira', 1)], null)]).tipo).toBe('recomecar');
  });

  it('duas páginas vazias não escrevem no cache (o polling roda a cada 5s)', () => {
    expect(fundirPrimeiraPagina(pag([], null), [pag([], null)]).tipo).toBe('inalterado');
  });

  it('nada mudou → `inalterado`, e o chamador não escreve no cache', () => {
    // Escrever no cache re-renderiza a lista inteira. O polling do modo degradado roda a
    // cada 5s: sem este ramo, a conversa re-renderizaria 12 vezes por minuto à toa.
    const p = pag([m('a', 1)], 'cursor-a');
    expect(fundirPrimeiraPagina(pag([m('a', 1)], 'cursor-a'), [p]).tipo).toBe('inalterado');
  });

  it('mesmo id com TEXTO diferente não é inalterado', () => {
    const p = pag([m('a', 1, { text: 'antigo' })], 'c');
    const r = fundirPrimeiraPagina(pag([m('a', 1, { text: 'corrigido' })], 'c'), [p]);
    expect(r.tipo).toBe('fundido');
  });

  it('mesmo id que GANHOU mídia não é inalterado', () => {
    // O dia em que o servidor passar a devolver `mediaId`, a foto tem que aparecer no
    // primeiro resync — não no próximo reinício do app.
    const p = pag([m('a', 1)], 'c');
    const r = fundirPrimeiraPagina(pag([m('a', 1, { mediaId: 'mid-1' })], 'c'), [p]);
    expect(r.tipo).toBe('fundido');
  });
});

describe('duas ou mais páginas — o buraco silencioso', () => {
  const p0 = pag([m('n3', 3), m('n2', 4), m('n1', 5)], 'cursor->p1');
  const p1 = pag([m('o1', 1), m('o2', 2)], 'cursor->p2');

  it('a mensagem nova ENTRA na página 0 e nada do meio desaparece', () => {
    const fresca = pag([m('n2', 4), m('n1', 5), m('novo', 6)], 'cursor-novo');
    const r = fundirPrimeiraPagina(fresca, [p0, p1]);
    expect(r.tipo).toBe('fundido');
    if (r.tipo !== 'fundido') return;
    // `n3` estava só na página antiga e SOBREVIVE. Substituir a página o teria apagado.
    expect(r.paginas[0]!.messages.map((x) => x.id)).toEqual(['n3', 'n2', 'n1', 'novo']);
  });

  it('o `nextCursor` ANTIGO é preservado — ele é a ponte pra página 1', () => {
    const fresca = pag([m('n1', 5), m('novo', 6)], 'cursor-novo');
    const r = fundirPrimeiraPagina(fresca, [p0, p1]);
    if (r.tipo !== 'fundido') throw new Error('esperava fundido');
    expect(r.paginas[0]!.nextCursor).toBe('cursor->p1');
  });

  it('as páginas seguintes ficam intactas, na mesma ordem', () => {
    const r = fundirPrimeiraPagina(pag([m('n1', 5), m('novo', 6)]), [p0, p1]);
    if (r.tipo !== 'fundido') throw new Error('esperava fundido');
    expect(r.paginas).toHaveLength(2);
    expect(r.paginas[1]).toBe(p1);
  });

  it('sem NENHUMA mensagem em comum → recomeçar, nunca costurar', () => {
    // Cenário real: a pessoa ficou fora por mais de 30 mensagens. A página fresca não
    // alcança o topo do que estava em cache, então existe uma lacuna. Costurar aqui
    // desenharia um buraco invisível no meio da conversa.
    const fresca = pag([m('x1', 40), m('x2', 41)], 'cursor-x');
    expect(fundirPrimeiraPagina(fresca, [p0, p1]).tipo).toBe('recomecar');
  });

  it('histórico apagado (forget-me) também cai em recomeçar', () => {
    expect(fundirPrimeiraPagina(pag([]), [p0, p1]).tipo).toBe('recomecar');
  });

  it('a versão FRESCA vence quando o id repete', () => {
    const antiga = pag([m('n1', 5, { text: 'sem mídia' })], 'ponte');
    const fresca = pag([m('n1', 5, { text: 'sem mídia', mediaId: 'mid-9' })], 'outro');
    const r = fundirPrimeiraPagina(fresca, [antiga, p1]);
    if (r.tipo !== 'fundido') throw new Error('esperava fundido');
    expect(r.paginas[0]!.messages[0]!.mediaId).toBe('mid-9');
  });

  it('a ordem final é cronológica ascendente, desempatando pelo id', () => {
    // O mesmo critério do keyset do servidor (`created_at, id`). Se divergisse, rolar
    // pra cima traria mensagem fora de lugar.
    const antiga = pag([m('b', 9), m('a', 9)], 'ponte');
    const fresca = pag([m('a', 9), m('c', 9)]);
    const r = fundirPrimeiraPagina(fresca, [antiga, p1]);
    if (r.tipo !== 'fundido') throw new Error('esperava fundido');
    expect(r.paginas[0]!.messages.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('inserirDoEvento — a bolha aparece antes da requisição', () => {
  const base = pag([m('a', 1)], 'c');

  it('acrescenta a mensagem do envelope do SSE', () => {
    const r = inserirDoEvento(base, { id: 'novo', direction: 'out', text: 'oi', at: Date.parse('2026-08-18T12:00:09.000Z') });
    expect(r).not.toBeNull();
    expect(r!.messages.map((x) => x.id)).toEqual(['a', 'novo']);
    expect(r!.messages[1]!.text).toBe('oi');
  });

  it('o `nextCursor` não se mexe — o evento não pagina nada', () => {
    const r = inserirDoEvento(base, { id: 'novo', direction: 'out', at: 1 });
    expect(r!.nextCursor).toBe('c');
  });

  it('id que já está na página devolve null (nada a escrever)', () => {
    // O evento e o refetch trazem a mesma linha. Sem esta guarda, cada resposta da
    // Xarlote escreveria no cache duas vezes.
    expect(inserirDoEvento(base, { id: 'a', direction: 'out', at: 1 })).toBeNull();
  });

  it('sem texto (foto/áudio) sobrevive como mensagem de mídia', () => {
    const r = inserirDoEvento(base, { id: 'f', direction: 'in', contentType: 'image', at: 1 });
    expect(r!.messages[1]!.text).toBeNull();
    expect(r!.messages[1]!.contentType).toBe('image');
  });

  it('o `clientId` do evento ATRAVESSA — é ele que liga a linha à foto deste aparelho', () => {
    const r = inserirDoEvento(base, { id: 'f', direction: 'in', contentType: 'image', clientId: CLIENT, at: 1 });
    expect(r!.messages[1]!.clientId).toBe(CLIENT);
  });

  it('evento sem clientId (mensagem que veio do WhatsApp) não inventa um', () => {
    const r = inserirDoEvento(base, { id: 'f', direction: 'out', at: 1 });
    expect(r!.messages[1]!.clientId ?? null).toBeNull();
  });

  /**
   * O fio inteiro, que é onde o defeito morava: o servidor publica a mensagem do próprio
   * paciente com o `clientId`; a linha entra no cache pelo evento; o merge usa o
   * `clientId` pra achar no mapa o `mediaId` que ESTE aparelho subiu. Se o `clientId`
   * cair no meio do caminho, a foto recém-enviada vira a frase "Foto enviada" no mesmo
   * quadro em que a bolha otimista sai — e só volta quando (e se) o resync canônico
   * chegar.
   */
  it('evento → cache → tela: a foto continua foto', () => {
    const pagina = inserirDoEvento(pag([], null), {
      id: 'srv-1',
      direction: 'in',
      contentType: 'image',
      clientId: CLIENT,
      at: Date.parse('2026-08-18T12:00:09.000Z'),
    })!;
    const itens = mergeMessages(pagina.messages, [], new Map([[CLIENT, 'media-77']]));
    expect(itens).toHaveLength(1);
    expect(itens[0]!.mediaId).toBe('media-77');
  });
});
