/**
 * Os dois degraus de densidade que faltavam ao lado do `CollapsibleSection`.
 *
 * A escada de densidade do projeto é "encerrado é linha, pede ação é cartão, pede
 * leitura é tela". O primitivo compartilhado (`components/ui/collapsible-section`)
 * resolve a SEÇÃO; estes dois resolvem o que acontece dentro dela e o que leva pra fora:
 *
 * · `ListaComTeto` — corta a lista longa DIZENDO quanto cortou. Nenhum `slice()` mudo
 *   sobrevive numa tela que usa isto: ou você vê os 20, ou você lê "ver os outros 12".
 *   É a diferença entre esconder e oferecer.
 * · `LinhaNavegacao` — caminho de verdade pra outra tela. `<Text onPress>` de 12px tem
 *   alvo real de ~50×16pt contra o piso de 44, não tem `accessibilityRole`, e errar o
 *   toque não dá retorno nenhum. A biblioteca de exames — a tela que materializa a
 *   promessa "nunca mais procurar exame em papel" — vivia atrás de um desses.
 *
 * Nenhum dos dois anima ao abrir, de propósito: vinte linhas de vidro entrando por
 * animação de layout é o custo de composição que esta sessão está removendo, e o
 * chevron já diz o que a animação diria. O retorno do toque é o háptico.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { ALVO_MINIMO, colors, FONTE_CLINICA } from '@/theme';

function tocar(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

// ─── Lista com teto dito ────────────────────────────────────────────────────────

interface ListaProps<T> {
  itens: readonly T[];
  /** Quantos aparecem antes do "ver os outros". */
  teto: number;
  chave: (item: T) => string;
  /** Como chamar o conjunto no rótulo: "exames", "alergias". */
  substantivo: string;
  children: (item: T) => ReactNode;
}

export function ListaComTeto<T>({ itens, teto, chave, substantivo, children }: ListaProps<T>) {
  const [tudo, setTudo] = useState(false);
  const escondidos = itens.length - teto;
  const visiveis = tudo || escondidos <= 0 ? itens : itens.slice(0, teto);

  const alternar = useCallback(() => {
    tocar();
    setTudo((t) => !t);
  }, []);

  return (
    <View style={styles.lista}>
      {visiveis.map((item) => (
        <View key={chave(item)}>{children(item)}</View>
      ))}
      {escondidos > 0 ? (
        <Pressable
          onPress={alternar}
          accessibilityRole="button"
          accessibilityState={{ expanded: tudo }}
          hitSlop={8}
          style={styles.rodapeLista}
        >
          <Text style={styles.rodapeTexto}>
            {tudo
              ? 'mostrar menos'
              : `ver ${escondidos === 1 ? `mais 1 ${substantivo}` : `os outros ${escondidos} ${substantivo}`}`}
          </Text>
          {tudo ? (
            <ChevronDown size={16} color={colors.accentHi} />
          ) : (
            <ChevronRight size={16} color={colors.accentHi} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Linha que navega ───────────────────────────────────────────────────────────

interface LinhaProps {
  rotulo: string;
  detalhe?: string;
  icone?: ReactNode;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}

export function LinhaNavegacao({ rotulo, detalhe, icone, onPress, style }: LinhaProps) {
  const acionar = useCallback(() => {
    tocar();
    onPress();
  }, [onPress]);

  return (
    <Pressable
      onPress={acionar}
      accessibilityRole="button"
      accessibilityLabel={detalhe ? `${rotulo}. ${detalhe}` : rotulo}
      style={[styles.linha, style]}
    >
      {icone ? <View style={styles.icone}>{icone}</View> : null}
      <View style={styles.linhaTextos}>
        <Text style={styles.linhaRotulo}>{rotulo}</Text>
        {detalhe ? <Text style={styles.linhaDetalhe}>{detalhe}</Text> : null}
      </View>
      <ChevronRight size={18} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lista: { gap: 10 },
  rodapeLista: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: ALVO_MINIMO,
  },
  rodapeTexto: { color: colors.accentHi, fontSize: 14, fontWeight: '600' },

  icone: { width: 22, alignItems: 'center' },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingVertical: 8,
  },
  linhaTextos: { flex: 1, gap: 2 },
  linhaRotulo: { color: colors.text, fontSize: 15, fontWeight: '600' },
  linhaDetalhe: { color: colors.textDim, fontSize: FONTE_CLINICA },
});
