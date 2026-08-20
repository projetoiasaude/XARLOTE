/**
 * Criar um lembrete: três campos, e a frase que diz quando ele vai tocar.
 *
 * ## Por que três campos e não uma frase pra Xarlote
 *
 * Antes desta tela, o único jeito de criar um lembrete era digitar no chat *"me lembra
 * do losartana todo dia às 8"*. Para o público do app — muita gente de 50+ — formular
 * essa frase com nome do remédio, periodicidade e horário numa tacada é MAIS difícil que
 * preencher três campos, e quando a LLM entende errado o erro é silencioso: nada na tela
 * diz que ela ouviu "às 8 da noite".
 *
 * ## Nenhum seletor nativo de hora, e é decisão
 *
 * O `@react-native-community/datetimepicker` seria mais bonito e é uma DEPENDÊNCIA
 * NATIVA — e toda dependência nativa nova significa build novo, o que emperra um app que
 * já roda no aparelho do paciente. O campo de texto com teclado numérico aceita `8`,
 * `830`, `08:30` e `8h30` (ver `normalizarHorario`), então o custo real do atalho é
 * zero e o ganho é a prévia em português abaixo do campo, que um seletor de roda não dá.
 *
 * ## A prévia é o que substitui a confirmação
 *
 * Criar lembrete é reversível (dá pra cancelar na linha, com confirmação), então não pede
 * diálogo. O que ele pede é não surpreender: "Todo dia às 08:00 — o primeiro é amanhã"
 * aparece ANTES de salvar, calculado pela mesma regra que o servidor vai aplicar.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Check, X } from 'lucide-react-native';
import { GlassButton, GlassCard, GlassInput } from '@/components/ui';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';
import {
  TIPOS_NOVO_LEMBRETE,
  descreverNovoLembrete,
  validarNovoLembrete,
  type CorpoNovoLembrete,
  type TipoNovoLembrete,
} from './format';

interface Props {
  salvando: boolean;
  /** Erro do servidor já em português (teto de ativos, rede, 500). */
  erroServidor?: string | null;
  onSalvar: (corpo: CorpoNovoLembrete) => void;
  onCancelar: () => void;
}

export function NovoLembrete({ salvando, erroServidor, onSalvar, onCancelar }: Props) {
  const [titulo, setTitulo] = useState('');
  const [horario, setHorario] = useState('');
  const [diario, setDiario] = useState(true);
  const [tipo, setTipo] = useState<TipoNovoLembrete>('medication');
  const [erro, setErro] = useState<{ campo: 'titulo' | 'horario'; mensagem: string } | null>(null);

  const bruto = useMemo(() => ({ titulo, horario, diario, tipo }), [titulo, horario, diario, tipo]);
  const validacao = useMemo(() => validarNovoLembrete(bruto), [bruto]);

  /**
   * A prévia é recalculada com `Date.now()` a cada render de propósito.
   *
   * Um `agora` congelado na montagem faria o formulário aberto às 07:59 dizer "o
   * primeiro é hoje às 08:00" um minuto depois de já ser 08:01 — rótulo calculado na
   * montagem envelhece, e aqui ele envelhece durante a digitação.
   */
  const previa = validacao.ok ? descreverNovoLembrete(validacao.corpo, Date.now()) : '';

  const salvar = useCallback(() => {
    const v = validarNovoLembrete({ titulo, horario, diario, tipo });
    if (!v.ok) {
      setErro({ campo: v.campo, mensagem: v.mensagem });
      return;
    }
    setErro(null);
    onSalvar(v.corpo);
  }, [titulo, horario, diario, tipo, onSalvar]);

  return (
    <GlassCard style={styles.card} spec>
      <Text style={styles.titulo}>Novo lembrete</Text>

      <View style={styles.campo}>
        <Text style={styles.rotulo}>Do que é?</Text>
        <GlassInput
          value={titulo}
          onChangeText={(t) => {
            setTitulo(t);
            if (erro?.campo === 'titulo') setErro(null);
          }}
          placeholder="Losartana 50mg"
          autoCapitalize="sentences"
          maxLength={80}
          error={erro?.campo === 'titulo'}
          returnKeyType="next"
        />
      </View>

      <View style={styles.campo}>
        <Text style={styles.rotulo}>Que horas?</Text>
        <GlassInput
          value={horario}
          onChangeText={(t) => {
            setHorario(t);
            if (erro?.campo === 'horario') setErro(null);
          }}
          placeholder="08:00"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          error={erro?.campo === 'horario'}
          returnKeyType="done"
          onSubmitEditing={salvar}
        />
      </View>

      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: diario }}
        accessibilityLabel="Todo dia"
        onPress={() => setDiario((d) => !d)}
        style={styles.linhaSwitch}
      >
        <View style={styles.switchTextos}>
          <Text style={styles.switchTitulo}>Todo dia</Text>
          <Text style={styles.switchDica}>
            {diario ? 'Repete todos os dias nesse horário.' : 'Só uma vez, na próxima vez que der esse horário.'}
          </Text>
        </View>
        <Switch
          value={diario}
          onValueChange={setDiario}
          trackColor={{ false: 'rgba(255,255,255,0.14)', true: colors.accent }}
          thumbColor="#ffffff"
        />
      </Pressable>

      <View style={styles.chips}>
        {TIPOS_NOVO_LEMBRETE.map((t) => {
          const ativo = t.tipo === tipo;
          return (
            <Pressable
              key={t.tipo}
              accessibilityRole="button"
              accessibilityState={{ selected: ativo }}
              accessibilityLabel={t.rotulo}
              onPress={() => setTipo(t.tipo)}
              style={[styles.chip, ativo && styles.chipAtivo]}
            >
              <Text style={[styles.chipTexto, ativo && styles.chipTextoAtivo]}>{t.rotulo}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* A prévia e o erro ocupam a MESMA linha: uma ou outra, nunca as duas, senão o
          cartão pula de altura no meio da digitação. */}
      {erro || erroServidor ? (
        <Text style={styles.erro}>{erro?.mensagem ?? erroServidor}</Text>
      ) : previa ? (
        <Text style={styles.previa}>{previa}</Text>
      ) : (
        <Text style={styles.previa}>Preenche os dois campos e eu te digo quando vou avisar.</Text>
      )}

      <View style={styles.acoes}>
        <GlassButton
          variant="ghost"
          size="md"
          icon={<X size={16} color={colors.textDim} />}
          onPress={onCancelar}
          accessibilityLabel="Cancelar"
        >
          Cancelar
        </GlassButton>
        <GlassButton
          variant="primary"
          size="md"
          icon={<Check size={16} color="#ffffff" />}
          loading={salvando}
          onPress={salvar}
          accessibilityLabel="Salvar lembrete"
          style={styles.salvar}
        >
          Salvar
        </GlassButton>
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14, marginBottom: 4 },
  titulo: { color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.3 },
  campo: { gap: 6 },
  rotulo: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '500' },
  /** 52 de altura: a linha inteira é o alvo, não só o interruptor de 34pt do sistema. */
  linhaSwitch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
  },
  switchTextos: { flex: 1, gap: 2 },
  switchTitulo: { color: colors.text, fontSize: 15, fontWeight: '600' },
  switchDica: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassFillLo,
  },
  chipAtivo: { borderColor: 'rgba(124,135,255,0.45)', backgroundColor: 'rgba(124,135,255,0.14)' },
  chipTexto: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '600' },
  chipTextoAtivo: { color: colors.accentHi },
  previa: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19 },
  erro: { color: colors.danger, fontSize: FONTE_CLINICA, lineHeight: 19 },
  acoes: { flexDirection: 'row', gap: 10 },
  salvar: { flex: 1 },
});
