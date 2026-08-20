/**
 * O sinal de "a Xarlote está pensando", visível de fora da árvore do chat.
 *
 * ## Por que um sinal, e não uma prop
 *
 * O orb do `OrbNav` já aceita `typing` e já sabe entrar em modo `thinking` — mas ele é
 * montado em `app/(main)/_layout.tsx`, FORA do Stack, de propósito (é o mesmo orb
 * atravessando as telas). O estado "pensando" nasce dentro do chat, três níveis abaixo.
 * Não há prop que suba daqui até lá sem levar o estado do chat pro layout, e o layout
 * remontaria a cada tecla digitada.
 *
 * A consequência de não ter esse caminho foi cara: a tela do chat montava um SEGUNDO
 * `LiquidCore` no rodapé da lista só pra dizer "pensando" — 3 blobs com `withRepeat`
 * infinito e 3 SVGs de degradê radial, em modo `thinking` (2,6× mais rápido), aparecendo
 * exatamente no instante em que a lista recebe item novo e as bolhas re-renderizam. Seis
 * animações infinitas simultâneas no pior momento possível, porque o orb que EXISTE pra
 * mostrar isso nunca podia ser avisado.
 *
 * ## Por que `useSyncExternalStore`
 *
 * É a API que o React oferece justamente pra ler estado que vive fora dele, sem tearing.
 * Um Context aqui obrigaria um Provider acima do layout e re-renderizaria toda a árvore
 * logada a cada mudança; assim só quem chama o hook (o orb) re-renderiza.
 *
 * O estado é de MÓDULO, o que normalmente é armadilha (vaza entre chamadas). Aqui é
 * deliberado — é um sinal de UI, único por processo, e o dono (`use-chat`) o zera ao
 * desmontar. Sem essa limpeza, um logout no meio de um turno deixaria o orb pensando
 * pra sempre.
 */
import { useSyncExternalStore } from 'react';

let digitando = false;
const ouvintes = new Set<() => void>();

function inscrever(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

/** Ninguém deve chamar isto fora do `use-chat` — é ele que conhece o turno. */
export function publicarXarloteDigitando(valor: boolean): void {
  // Guarda de igualdade: sem ela, cada re-render do chat avisaria o orb à toa.
  if (valor === digitando) return;
  digitando = valor;
  for (const ouvinte of ouvintes) ouvinte();
}

export function useXarloteDigitando(): boolean {
  return useSyncExternalStore(
    inscrever,
    () => digitando,
    // Snapshot do servidor: o app não tem SSR, mas o hook exige o terceiro argumento
    // quando alguém roda em react-native-web.
    () => false,
  );
}
