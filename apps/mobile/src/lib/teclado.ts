/**
 * O recuo que impede o teclado de tampar o que a pessoa está escrevendo.
 *
 * ## O bug que este arquivo existe para não repetir
 *
 * Toda tela com campo de texto usava a receita clássica do React Native:
 *
 *     behavior={Platform.OS === 'ios' ? 'padding' : undefined}
 *
 * No Android isso desliga o `KeyboardAvoidingView` de propósito — a ideia é deixar o
 * `adjustResize` nativo encolher a janela sozinho. **Essa receita valeu até o Expo 54.**
 * A partir dele o Android desenha de borda a borda por padrão: a janela não encolhe mais,
 * e como nada compensa, o campo fica ATRÁS do teclado. A pessoa digita sem ver o que
 * escreve.
 *
 * Reproduzido num Xiaomi em 19/08/2026, na tela de conversa. E não era só ela: o mesmo
 * padrão estava no `welcome` e no `otp` — ou seja, o teclado tampava o campo já no login,
 * na primeira tela de quem instala o app.
 *
 * ## Por que Reanimated, e não `react-native-keyboard-controller`
 *
 * A biblioteca dedicada é a recomendação usual e resolveria também. Mas ela é um módulo
 * NATIVO novo, e módulo nativo novo só existe depois de um build novo do app — o binário
 * instalado no aparelho não o teria. `useAnimatedKeyboard` faz o que precisamos, lê o
 * inset de IME na thread de interface (então o movimento acompanha o teclado quadro a
 * quadro, em vez de pular quando ele termina de subir), e vem do Reanimated, que já está
 * dentro do binário. A correção viaja pelo ar.
 *
 * ## O `- insetBottom` não é detalhe
 *
 * As telas já reservam a faixa do gesto de navegação embaixo. Sem subtrair, a coluna
 * subiria essa faixa duas vezes e sobraria uma tira morta entre o campo e o teclado.
 */
import { useAnimatedKeyboard, useAnimatedStyle, type AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';

/**
 * Devolve um estilo animado com o `paddingBottom` que acompanha o teclado.
 *
 * @param insetBottom A faixa de segurança inferior que a tela JÁ reserva. Passe 0 quando
 *   a tela não reserva nada — passar um valor que não existe cria uma folga negativa e o
 *   campo volta a encostar no teclado.
 */
export function useRecuoDoTeclado(insetBottom = 0): AnimatedStyle<ViewStyle> {
  const teclado = useAnimatedKeyboard();
  return useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, teclado.height.value - insetBottom),
  }));
}
