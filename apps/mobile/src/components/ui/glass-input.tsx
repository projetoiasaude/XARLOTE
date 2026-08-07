/**
 * GlassInput — o campo de texto do design system. Contrato do web + `error`,
 * que aqui é essencial: no celular não há espaço pra mensagem de erro solta ao
 * lado do campo, então a borda muda de cor junto.
 */
import { forwardRef, useState } from 'react';
import { StyleSheet, TextInput, type StyleProp, type TextInputProps, type TextStyle } from 'react-native';
import { colors, radii } from '@/theme';

interface Props extends Omit<TextInputProps, 'style'> {
  /** Borda/halo em tom de erro (a mensagem fica com a tela, não com o campo). */
  error?: boolean;
  style?: StyleProp<TextStyle>;
}

export const GlassInput = forwardRef<TextInput, Props>(function GlassInput(
  { error = false, style, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.textFaint}
      selectionColor={colors.accentHi}
      // Teclado escuro: sem isso o iOS abre o teclado CLARO sobre um app all-dark.
      keyboardAppearance="dark"
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        rest.onBlur?.(e);
      }}
      style={[
        styles.base,
        focused && styles.focused,
        error && styles.error,
        style,
      ]}
      {...rest}
    />
  );
});

const styles = StyleSheet.create({
  base: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: radii.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  focused: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderColor: 'rgba(124,135,255,0.6)',
  },
  error: {
    borderColor: 'rgba(248,113,113,0.7)',
    backgroundColor: 'rgba(248,113,113,0.06)',
  },
});
