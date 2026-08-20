/**
 * O "agora" das telas de dados — congelado por render, mas NÃO por sessão.
 *
 * ## O bug que isto fecha
 *
 * As abas do expo-router ficam montadas, e voltar do segundo plano não remonta nada.
 * Um `useState(() => Date.now())` cru, que é o que estas telas tinham, prende o relógio
 * no instante em que a aba nasceu — e todo rótulo derivado dele envelhece calado:
 * "faz 5 meses desde o seu último hemograma" continua dizendo 5 depois da virada do
 * mês, e "atualizado há 2 min" continua dizendo 2 min meia hora depois. É a regra da
 * casa: rótulo calculado na montagem envelhece.
 *
 * ## Por que voltar do segundo plano basta, e um timer não entra
 *
 * O que se lê nestas telas tem granularidade de dia (meses desde um exame, data de
 * sintoma) ou de minuto num cartão que já mostra "atualizado há…". Nenhum deles precisa
 * andar com a tela na mão; todos precisam estar certos quando o paciente ABRE o app.
 * Um `setInterval` re-renderizaria a Saúde 360 inteira pra sempre — com as suas dezenas
 * de superfícies de vidro — pra corrigir um rótulo que muda uma vez por dia. É
 * exatamente o custo de fundo que esta sessão está removendo, disfarçado de precisão.
 *
 * O congelamento DENTRO do render continua: um `Date.now()` por chamada faria duas
 * funções puras da mesma tela discordarem na virada do dia.
 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useAgora(): number {
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      // Só 'active'. 'background'/'inactive' não interessam, e re-renderizar ao SAIR
      // seria trabalho para uma tela que ninguém está vendo.
      if (estado === 'active') setAgora(Date.now());
    });
    return () => sub.remove();
  }, []);

  return agora;
}
