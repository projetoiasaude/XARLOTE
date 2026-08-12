/** GlassBadge — 7 tons do web, mesmos valores de fill/texto/borda. */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { radii } from '@/theme';
import { StatusPing } from './status-ping';
import { ehTextoCru } from './text-child';

export type BadgeTone = 'success' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent' | 'live';

interface Props {
  tone?: BadgeTone;
  size?: 'xs' | 'sm';
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const TONE: Record<BadgeTone, { bg: string; border: string; fg: string }> = {
  success: { bg: 'rgba(74,222,128,0.15)', border: 'rgba(74,222,128,0.25)', fg: '#86efac' },
  warn: { bg: 'rgba(251,191,36,0.15)', border: 'rgba(251,191,36,0.25)', fg: '#fcd34d' },
  danger: { bg: 'rgba(251,113,133,0.15)', border: 'rgba(251,113,133,0.25)', fg: '#fda4af' },
  info: { bg: 'rgba(56,189,248,0.15)', border: 'rgba(56,189,248,0.25)', fg: '#7dd3fc' },
  neutral: { bg: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.12)', fg: 'rgba(255,255,255,0.70)' },
  accent: { bg: 'rgba(124,135,255,0.15)', border: 'rgba(124,135,255,0.30)', fg: '#a3acff' },
  live: { bg: 'rgba(74,222,128,0.20)', border: 'rgba(74,222,128,0.30)', fg: '#bbf7d0' },
};

/** O ping do badge reusa o StatusPing — `live` é o único que pulsa (igual ao web). */
const PING_TONE: Record<BadgeTone, 'success' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  success: 'success',
  warn: 'warn',
  danger: 'danger',
  info: 'accent',
  neutral: 'neutral',
  accent: 'accent',
  live: 'success',
};

export function GlassBadge({ tone = 'neutral', size = 'sm', dot = false, style, children }: Props) {
  const t = TONE[tone];
  const textStyle: TextStyle = {
    color: t.fg,
    fontSize: size === 'xs' ? 10 : 12,
    fontWeight: '600',
  };
  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: t.bg,
          borderColor: t.border,
          height: size === 'xs' ? 20 : 24,
          paddingHorizontal: size === 'xs' ? 8 : 10,
        },
        style,
      ]}
    >
      {dot && <StatusPing tone={PING_TONE[tone]} pulse={tone === 'live'} />}
      {ehTextoCru(children) ? <Text style={textStyle}>{children}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radii.full,
    alignSelf: 'flex-start',
  },
});
