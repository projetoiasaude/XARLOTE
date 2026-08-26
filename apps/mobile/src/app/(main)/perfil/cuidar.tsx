/**
 * "Cuidar de alguém" — a tela dos dois lados do vínculo.
 *
 * ## Por que as duas direções na mesma tela
 *
 * "De quem eu cuido" e "quem cuida de mim" parecem assuntos diferentes e são o mesmo:
 * um vínculo, visto de cada ponta. Separá-los em duas telas esconderia a segunda — e é
 * justamente a segunda que dá à pessoa o controle sobre quem enxerga o prontuário dela.
 * Quem abre aqui pra conectar o pai acaba vendo, na mesma rolagem, quem tem acesso ao seu.
 *
 * ## O código sai daqui, não entra
 *
 * Quem gera o código é quem VAI SER CUIDADO. A tela deixa isso explícito porque a
 * intuição de todo mundo é a contrária ("eu convido meu pai"), e um convite por telefone
 * digitado seria um pedido de acesso a prontuário indo parar num estranho.
 */
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ban, HeartHandshake, KeyRound, UserPlus } from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, GlassInput, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import {
  RELACOES, rotuloDaRelacao, useConectar, useGerarCodigo, useRevogar, useVinculos,
  type QuemEuCuido,
} from '@/features/care/use-cuidado';
import { useSujeito } from '@/lib/care/sujeito';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';

export default function CuidarScreen() {
  const router = useRouter();
  const { data } = useVinculos();
  const { trocarPara } = useSujeito();
  const gerar = useGerarCodigo();
  const conectar = useConectar();
  const revogar = useRevogar();

  const [codigo, setCodigo] = useState('');
  const [relacao, setRelacao] = useState<string>('mae');

  // Ao sair, o código em claro sai da memória junto — mesma disciplina do link do médico.
  useEffect(() => () => gerar.esquecer(), [gerar]);

  function abrirBolsaDe(v: QuemEuCuido) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    trocarPara({ id: v.pessoa.id, nome: v.pessoa.nome, relation: v.relation, tipo: v.tipo });
    // Leva direto pra Saúde: abrir a bolsa de alguém e continuar numa tela de
    // configuração faria a troca parecer que não aconteceu.
    router.push('/saude');
  }

  function confirmarRevogacao(id: string, quem: string, ehMeuAcesso: boolean) {
    Alert.alert(
      ehMeuAcesso ? `Parar de acompanhar ${quem}?` : `Tirar o acesso de ${quem}?`,
      ehMeuAcesso
        ? 'Você deixa de ver o registro dessa pessoa. Ela continua com tudo dela.'
        : 'Essa pessoa deixa de ver o seu registro agora mesmo. Você pode autorizar de novo depois.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', style: 'destructive', onPress: () => revogar.mutate(id) },
      ],
    );
  }

  const cuido = data?.cuido ?? [];
  const cuidamDeMim = data?.cuidamDeMim ?? [];

  return (
    <>
      <Stack.Screen options={{ title: 'Cuidar de alguém' }} />
      <Screen title="Cuidar de alguém" subtitle="Acompanhe a saúde de quem você cuida — e veja quem acompanha a sua." voltar>

        {/* ── Quem eu acompanho ─────────────────────────────────────────── */}
        <SectionHeader icon={<HeartHandshake size={16} color={colors.textDim} />} title="Quem eu acompanho" />
        {cuido.length === 0 ? (
          <GlassCard style={styles.vazio}>
            <Text style={styles.vazioTexto}>
              Você ainda não acompanha ninguém. Peça um código à pessoa e digite abaixo.
            </Text>
          </GlassCard>
        ) : (
          cuido.map((v) => (
            <GlassCard key={v.pessoa.id} style={styles.linha}>
              <Pressable style={styles.linhaToque} onPress={() => abrirBolsaDe(v)} accessibilityRole="button">
                <View style={styles.linhaTexto}>
                  <Text style={styles.nome}>{v.pessoa.nome ?? 'Sem nome'}</Text>
                  <Text style={styles.sub}>
                    {rotuloDaRelacao(v.relation)}
                    {v.tipo === 'dependente' ? ' · perfil sem WhatsApp' : ''}
                  </Text>
                </View>
                <GlassBadge>Abrir</GlassBadge>
              </Pressable>
            </GlassCard>
          ))
        )}

        {/* ── Conectar ──────────────────────────────────────────────────── */}
        <SectionHeader icon={<KeyRound size={16} color={colors.textDim} />} title="Conectar com alguém" />
        <GlassCard style={styles.bloco}>
          <Text style={styles.explica}>
            Peça à pessoa que abra a Xarlote dela e gere um <Text style={styles.forte}>código de 6 dígitos</Text>.
            Ela precisa te passar o código — é assim que ela autoriza.
          </Text>
          <GlassInput
            value={codigo}
            onChangeText={setCodigo}
            placeholder="000000"
            keyboardType="number-pad"
            maxLength={7}
            accessibilityLabel="Código de 6 dígitos"
          />
          <Text style={styles.rotulo}>Quem é essa pessoa pra você?</Text>
          <View style={styles.chips}>
            {RELACOES.map((r) => (
              <Pressable
                key={r.valor}
                onPress={() => setRelacao(r.valor)}
                style={[styles.chip, relacao === r.valor && styles.chipAtivo]}
                accessibilityRole="button"
                accessibilityState={{ selected: relacao === r.valor }}
              >
                <Text style={[styles.chipTexto, relacao === r.valor && styles.chipTextoAtivo]}>{r.rotulo}</Text>
              </Pressable>
            ))}
          </View>
          <GlassButton
            loading={conectar.isPending}
            disabled={codigo.replace(/\D/g, '').length !== 6 || conectar.isPending}
            onPress={() => {
              conectar.mutate(
                { codigo: codigo.replace(/\D/g, ''), relation: relacao },
                {
                  onSuccess: (r) => {
                    setCodigo('');
                    Alert.alert('Pronto!', `Agora você acompanha ${r.pessoa.nome ?? 'essa pessoa'}.`);
                  },
                  // A mensagem vem do servidor de propósito: ela distingue "código já usado"
                  // de "esse código é seu", que são confusões bem diferentes.
                  onError: (e) => Alert.alert('Não deu', e instanceof Error ? e.message : 'Confere o código e tenta de novo.'),
                },
              );
            }}
          >
            {conectar.isPending ? 'Conectando…' : 'Conectar'}
          </GlassButton>
        </GlassCard>

        {/* ── Meu código ────────────────────────────────────────────────── */}
        <SectionHeader icon={<UserPlus size={16} color={colors.textDim} />} title="Deixar alguém me acompanhar" />
        <GlassCard style={styles.bloco}>
          {gerar.codigo ? (
            <>
              <Text style={styles.codigo}>{gerar.codigo.codigo}</Text>
              <Text style={styles.explica}>
                Passe estes seis dígitos pra quem vai te acompanhar. Ele vale por 30 minutos e
                <Text style={styles.forte}> aparece só desta vez</Text> — se sumir, é só gerar outro.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.explica}>
                Gere um código e entregue à pessoa que vai acompanhar sua saúde. Ela vai poder ver
                seus exames, lembretes e remédios, e registrar coisas por você.
              </Text>
              <GlassButton loading={gerar.isPending} disabled={gerar.isPending} onPress={() => gerar.mutate()}>
                {gerar.isPending ? 'Gerando…' : 'Gerar código'}
              </GlassButton>
            </>
          )}
        </GlassCard>

        {/* ── Quem me acompanha ─────────────────────────────────────────── */}
        <SectionHeader icon={<Ban size={16} color={colors.textDim} />} title="Quem acompanha a minha saúde" />
        {cuidamDeMim.length === 0 ? (
          <GlassCard style={styles.vazio}>
            <Text style={styles.vazioTexto}>Ninguém tem acesso ao seu registro.</Text>
          </GlassCard>
        ) : (
          cuidamDeMim.map((c) => (
            <GlassCard key={c.vinculoId} style={styles.linha}>
              <View style={styles.linhaToque}>
                <View style={styles.linhaTexto}>
                  <Text style={styles.nome}>{c.pessoa.nome ?? 'Sem nome'}</Text>
                  <Text style={styles.sub}>{rotuloDaRelacao(c.relation)}</Text>
                </View>
                <Pressable
                  onPress={() => confirmarRevogacao(c.vinculoId, c.pessoa.nome ?? 'essa pessoa', false)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Tirar o acesso de ${c.pessoa.nome ?? 'essa pessoa'}`}
                >
                  <Text style={styles.tirar}>Tirar acesso</Text>
                </Pressable>
              </View>
            </GlassCard>
          ))
        )}
        <Text style={styles.rodape}>
          Você pode tirar o acesso de alguém a qualquer momento, sozinho, sem precisar avisar antes.
        </Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  bloco: { padding: 16, gap: 12, marginBottom: 8 },
  vazio: { padding: 16, marginBottom: 8 },
  vazioTexto: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 20 },
  linha: { padding: 14, marginBottom: 8 },
  linhaToque: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 },
  linhaTexto: { flex: 1, gap: 2 },
  nome: { color: colors.text, fontSize: 16, fontWeight: '600' },
  sub: { color: colors.textDim, fontSize: FONTE_MINIMA },
  explica: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 20 },
  forte: { color: colors.text, fontWeight: '700' },
  rotulo: { color: colors.text, fontSize: FONTE_CLINICA, fontWeight: '600', marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder,
  },
  chipAtivo: { backgroundColor: 'rgba(124,135,255,0.18)', borderColor: colors.accent },
  chipTexto: { color: colors.textDim, fontSize: FONTE_MINIMA },
  chipTextoAtivo: { color: colors.text, fontWeight: '600' },
  /** Números grandes e espaçados: alguém vai ditar isto por telefone. */
  codigo: {
    color: colors.text, fontSize: 40, fontWeight: '700',
    letterSpacing: 8, textAlign: 'center', paddingVertical: 8,
  },
  tirar: { color: colors.dangerSoft, fontSize: FONTE_MINIMA, fontWeight: '600' },
  rodape: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 18, marginTop: 8, marginBottom: 4 },
});
