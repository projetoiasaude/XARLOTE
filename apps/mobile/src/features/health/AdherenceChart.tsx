/**
 * O gráfico de adesão — 30 dias de doses, sem inventar nenhum.
 *
 * ## A decisão de desenho que mais importa
 *
 * Dia sem registro (`ratio: null`) **não é uma barra de altura zero**. Zero significa
 * "tinha remédio pra tomar e não tomou"; null significa "não havia nada agendado". O
 * gráfico marca esses dias com um traço fino na linha de base, visualmente distinto de
 * uma barra curta. Um gráfico que desenha zero em dia vazio inventa uma queda de adesão
 * que nunca existiu — e o link do médico (F4) mostra essa mesma tela a um profissional
 * que pode mudar conduta com base nela.
 *
 * ## Sem juízo de valor na cor
 *
 * Todas as barras usam o mesmo tom. Pintar de vermelho os dias ruins seria repreender o
 * paciente numa tela que ele abre justamente nos dias ruins — o oposto do tom da
 * Xarlote (`adherenceLabel`, em shared, tem o mesmo cuidado nas palavras).
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import type { AdherenceDay } from '@iasaude/shared';
import { colors, radii } from '@/theme';

interface Props {
  serie: readonly AdherenceDay[];
  /** Altura da área de barras. */
  altura?: number;
}

const ESPACO_MIN = 1.5;

export function AdherenceChart({ serie, altura = 92 }: Props) {
  const [largura, setLargura] = useState(0);

  if (serie.length === 0) return null;

  const n = serie.length;
  // A barra é o que sobra depois dos espaços. `max(2, …)` porque numa janela de 90 dias
  // num aparelho estreito a conta daria menos de um pixel e o gráfico sumiria.
  const passo = largura > 0 ? largura / n : 0;
  const larguraBarra = Math.max(2, passo - ESPACO_MIN);

  const comRegistro = serie.filter((d) => d.ratio !== null).length;

  return (
    <View>
      <View style={styles.area} onLayout={(e) => setLargura(e.nativeEvent.layout.width)}>
        {largura > 0 && (
          <Svg width={largura} height={altura}>
            {/* Linha dos 100%: dá escala ao olho sem precisar de eixo numérico. */}
            <Line x1={0} y1={1} x2={largura} y2={1} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
            {serie.map((d, i) => {
              const x = i * passo;
              if (d.ratio === null) {
                // O traço do "sem registro" — na base, 2px, cor apagada. Fica claro que
                // é ausência de dado, e não uma barra que quase não subiu.
                return (
                  <Rect
                    key={d.day}
                    x={x}
                    y={altura - 2}
                    width={larguraBarra}
                    height={2}
                    rx={1}
                    fill="rgba(255,255,255,0.14)"
                  />
                );
              }
              // Mínimo de 3px: 1 dose de 10 tomada tem que aparecer. Barra invisível
              // faria um dia de adesão baixa parecer um dia sem registro.
              const h = Math.max(3, Math.round(d.ratio * (altura - 4)));
              return (
                <Rect
                  key={d.day}
                  x={x}
                  y={altura - h}
                  width={larguraBarra}
                  height={h}
                  rx={Math.min(3, larguraBarra / 2)}
                  fill={colors.accent}
                  opacity={0.85}
                />
              );
            })}
          </Svg>
        )}
      </View>

      <View style={styles.legenda}>
        <Text style={styles.legendaTexto}>{n} dias</Text>
        <View style={styles.chaveGrupo}>
          <View style={styles.chave}>
            <View style={[styles.amostra, { backgroundColor: colors.accent, opacity: 0.85 }]} />
            <Text style={styles.legendaTexto}>doses tomadas</Text>
          </View>
          {/* A chave do "sem registro" só aparece quando ela EXPLICA algo na tela.
              Mostrá-la com zero dias vazios sugeriria buracos que não existem. */}
          {comRegistro < n && (
            <View style={styles.chave}>
              <View style={[styles.amostra, styles.amostraVazia]} />
              <Text style={styles.legendaTexto}>{n - comRegistro} sem registro</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  area: { width: '100%' },
  legenda: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  chaveGrupo: { flexDirection: 'row', gap: 14 },
  chave: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  amostra: { width: 8, height: 8, borderRadius: radii.md / 3 },
  amostraVazia: { height: 2, width: 10, backgroundColor: 'rgba(255,255,255,0.14)' },
  legendaTexto: { color: colors.textFaint, fontSize: 10, letterSpacing: 0.2 },
});
