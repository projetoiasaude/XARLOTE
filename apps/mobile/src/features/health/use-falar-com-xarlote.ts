/**
 * A única ESCRITA que as telas de dados fazem: mandar uma mensagem pronta pra Xarlote.
 *
 * ## Por que isto existe
 *
 * A Saúde 360 devolvia o paciente pro chat com uma frase em cada seção — "me conta no
 * chat", "me pede no chat". Para alguém de 55 anos, formular a frase certa é mais
 * difícil que tocar num botão, e quando a formulação sai errada o erro é silencioso.
 * Aqui o app FAZ o pedido: o texto é montado a partir do dado que está na tela (o nome
 * e a dose do remédio que está acabando, o tipo e o mês do exame antigo), o paciente
 * confere e confirma, e a conversa já está aberta com o pedido dentro.
 *
 * ## Confirmação obrigatória, e com o texto à mostra
 *
 * Mensagem enviada não volta — e esta some da tela em que foi disparada, o que é o pior
 * tipo de irreversível: sem prova do que foi dito. O `Alert` mostra o texto EXATO antes
 * de mandar. É a mesma assimetria que o app já respeita em cancelar lembrete e derrubar
 * link do médico.
 *
 * ## Por que não reusar o `useChat`
 *
 * `useChat` carrega a query infinita do histórico e ABRE uma assinatura de SSE. Montá-lo
 * na Saúde só pra ter o `enviar` custaria uma segunda conexão de eventos por tela de
 * dados aberta. O contrato do `POST /app/messages` é pequeno e estável
 * (`{clientId, text, sentAtMs}`) — o que este arquivo NÃO faz é reimplementar a fila de
 * pendentes: aqui não há bolha otimista, o envio ou dá certo e o chat mostra a linha do
 * servidor, ou falha e diz que falhou.
 *
 * ## 🤝 E ele RECUSA quando a bolsa aberta é de outra pessoa
 *
 * `POST /app/messages` não tem noção de sujeito: a conversa é sempre a de quem está
 * logado. Como as frases são montadas em primeira pessoa a partir do dado da TELA
 * ("Minha Losartana está acabando"), um toque na Saúde da mãe cotava o remédio dela no
 * chat da filha — e o profile-enricher podia anotar que a filha toma Losartana. A decisão
 * mora em `features/care/escrita.ts` e é aplicada aqui, no funil, além dos botões.
 *
 * ## Este hook NÃO mexe no cache da conversa, e isso é o conserto
 *
 * A primeira versão fazia `await qc.invalidateQueries({predicate: 'chat'})` ANTES de
 * navegar. Três coisas erradas de uma vez:
 *
 * 1. A rota responde **202**: quem escreve a linha em `messages` é o worker. No instante
 *    da resposta a mensagem ainda não existe no banco — a busca que a invalidação
 *    dispara não pode trazê-la.
 * 2. `['chat', userId]` é uma `useInfiniteQuery`. Invalidar refaz **todas** as páginas
 *    carregadas, em sequência — exatamente a patologia que `features/chat/resync.ts`
 *    foi escrito pra matar. Quem tinha rolado 10 páginas pagava 10 requisições.
 * 3. Estava no caminho da navegação, com `await`: numa rede ruim o paciente ficava com
 *    o spinner do botão por segundos, atravessava N idas à rede, e chegava ao chat sem
 *    ver o pedido, que só apareceria depois pelo SSE.
 *
 * O que traz a linha à tela é o SSE: `publishMessageEvent` (em `handlers/inbound-user`)
 * anuncia a mensagem com `clientId`, e ao montar o chat toda conexão nova chama
 * `onResync`, que busca **uma** página e funde. A atualização acontece atrás da tela,
 * sem este arquivo saber a chave de query de ninguém.
 */
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { apiFetch } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSujeito } from '@/lib/care/sujeito';
import { decidirFalarComXarlote, TITULO_SO_NO_PROPRIO } from '@/features/care/escrita';

export interface FalarComXarlote {
  /** Pede confirmação, envia, e leva pra conversa. `chave` é só pra tela saber quem está em voo. */
  falar: (mensagem: string, chave: string) => void;
  /** A `chave` do pedido em voo, ou null. */
  emVoo: string | null;
  /**
   * 🤝 A bolsa aberta não é a de quem está logado — nada daqui pode ser enviado.
   *
   * As telas usam isto pra DESABILITAR o botão e dizer por quê (`aviso`), em vez de
   * mostrar um botão que some do jeito errado ou escreve no prontuário errado.
   */
  bloqueado: boolean;
  /** A frase honesta, pronta pra tela. `null` quando dá pra mandar. */
  aviso: string | null;
}

export interface OpcoesDeFalar {
  /**
   * 🤝 A frase desta tela é montada com o dado de QUEM ESTÁ LOGADO, não com o da bolsa
   * aberta — então ela vai pro prontuário certo mesmo em modo cuidador.
   *
   * Hoje existe um único caso: o apelido no `CartaoIdentidade`, que sai do `GET /app/me`
   * (o titular do JWT) e não do overview do sujeito. Sem esta saída, quem cuida da mãe
   * não conseguiria trocar o próprio nome sem sair do registro dela — e, pior, leria
   * "isso eu registro no WhatsApp de Maria" sobre uma ação que é dele. Frase honesta
   * também vale pra recusa: recusar pelo motivo errado é mentir.
   *
   * O padrão é `false` (recusar) de propósito: quem escrever a próxima tela precisa
   * PARAR e afirmar de quem é o dado, em vez de herdar permissão por descuido.
   */
  sobreOProprio?: boolean;
}

export function useFalarComXarlote({ sobreOProprio = false }: OpcoesDeFalar = {}): FalarComXarlote {
  const router = useRouter();
  const [emVoo, setEmVoo] = useState<string | null>(null);
  const { pessoa, cuidandoDeOutro } = useSujeito();
  /**
   * A trava fica no FUNIL, não só nos botões.
   *
   * Sete telas chamam este hook hoje e a oitava é escrita amanhã. Confiar só no `disabled`
   * de cada uma significa que a próxima nasce escrevendo no prontuário do cuidador — e o
   * defeito é invisível: a mensagem some da tela onde foi disparada e reaparece num chat
   * que a pessoa não está olhando. Ver `features/care/escrita.ts`.
   */
  const decisao = decidirFalarComXarlote({
    cuidandoDeOutro: cuidandoDeOutro && !sobreOProprio,
    nome: pessoa?.nome ?? null,
  });

  const despachar = useCallback(
    async (mensagem: string, chave: string) => {
      setEmVoo(chave);
      try {
        await apiFetch('/app/messages', {
          method: 'POST',
          body: {
            // `randomUUID` do expo-crypto (não `Math.random`): este id é a chave de
            // idempotência no banco e na fila.
            clientId: Crypto.randomUUID(),
            text: mensagem,
            sentAtMs: Date.now(),
          },
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Direto pra conversa. Nada de invalidar cache alheio no caminho: o resync de
        // uma página que o próprio chat dispara ao abrir o SSE é mais barato e mais
        // certo (a linha nem existe no banco ainda quando esta resposta chega).
        router.navigate('/');
      } catch (err) {
        const f = err instanceof ApiError ? err.failure : null;
        // Falha NUNCA vira sucesso silencioso: sem este aviso o paciente sairia
        // acreditando que pediu o remédio.
        Alert.alert(
          'Não consegui mandar',
          f?.kind === 'consent_required'
            ? 'Falta você aceitar os termos de uso dos seus dados de saúde.'
            : (f?.message ?? 'Tenta de novo em instantes?'),
        );
      } finally {
        setEmVoo(null);
      }
    },
    [router],
  );

  const falar = useCallback(
    (mensagem: string, chave: string) => {
      const texto = mensagem.trim();
      if (!texto) return;
      // Bloqueado NUNCA cai em silêncio nem em envio: a tela diz de quem é a conversa.
      if (!decisao.pode) {
        Alert.alert(TITULO_SO_NO_PROPRIO, decisao.aviso ?? '');
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      Alert.alert('Mandar pra Xarlote?', `"${texto}"`, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Mandar', onPress: () => void despachar(texto, chave) },
      ]);
    },
    [despachar, decisao.pode, decisao.aviso],
  );

  return { falar, emVoo, bloqueado: !decisao.pode, aviso: decisao.aviso };
}
