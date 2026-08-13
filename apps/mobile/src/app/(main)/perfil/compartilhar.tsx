/**
 * "Mostrar meu resumo ao meu médico" — a tela que gera o link.
 *
 * ## A tela avisa antes, não depois
 *
 * Compartilhar prontuário é uma decisão, não um toque. Antes de qualquer botão, a tela
 * diz exatamente **o que o médico vai ver** e **o que ele não vai** — as conversas e a
 * memória ficam de fora. Sem isso, o paciente descobre o alcance depois de mandar.
 *
 * ## O link aparece uma vez
 *
 * Depois de criado, ele existe só nesta tela, nesta sessão. O servidor guarda apenas o
 * hash. A tela diz isso com todas as letras, porque a alternativa é o paciente fechar,
 * voltar e não achar — e concluir que o app perdeu o link dele.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ArrowLeft, Ban, Copy, Eye, Link2, Share2, ShieldCheck } from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, GlassInput, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useCriarShare, useRevogarShare, useShares } from '@/features/share/use-shares';
import { brDesde, brQuando } from '@/lib/br-format';
import { colors } from '@/theme';

const OPCOES_VALIDADE = [
  { rotulo: '24 horas', horas: 24 },
  { rotulo: '3 dias', horas: 72 },
  { rotulo: '7 dias', horas: 168 },
] as const;

export default function CompartilharScreen() {
  const router = useRouter();
  const { data } = useShares();
  const { criar, criando, criado, erro, esquecer } = useCriarShare();
  const { revogar } = useRevogarShare();

  const [horas, setHoras] = useState<number>(72);
  const [usarPin, setUsarPin] = useState(false);
  const [pin, setPin] = useState('');
  const [agora] = useState(() => Date.now());

  // Ao sair, o link em claro sai da memória junto. Ver o cabeçalho do use-shares.
  useEffect(() => () => esquecer(), [esquecer]);

  const podeCriar = !criando && (!usarPin || /^\d{4}$/.test(pin));

  const copiar = useCallback(async () => {
    if (!criado?.url) return;
    await Clipboard.setStringAsync(criado.url);
    Alert.alert('Copiado', 'O link está na área de transferência.');
  }, [criado]);

  const compartilhar = useCallback(async () => {
    if (!criado?.url) return;
    await Share.share({
      message:
        `Meu resumo de saúde, organizado pela Xarlote:\n${criado.url}` +
        (criado.comPin ? '\n\nO link pede um PIN de 4 números — te mando separado.' : ''),
    });
  }, [criado]);

  const confirmarRevogar = useCallback(
    (id: string) => {
      Alert.alert('Derrubar este link?', 'Quem tiver o endereço deixa de conseguir abrir, na hora.', [
        { text: 'Manter', style: 'cancel' },
        { text: 'Derrubar', style: 'destructive', onPress: () => revogar(id) },
      ]);
    },
    [revogar],
  );

  const ativos = (data?.shares ?? []).filter(
    (s) => !s.revokedAt && Date.parse(s.expiresAt) > agora,
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen title="Mostrar ao meu médico">
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.voltar} accessibilityRole="button">
          <ArrowLeft size={14} color={colors.textDim} />
          <Text style={styles.voltarTexto}>voltar</Text>
        </Pressable>

        {/* ── O que ele vai ver ─────────────────────────────────────────────── */}
        <GlassCard style={styles.card}>
          <View style={styles.tituloLinha}>
            <Eye size={16} color={colors.info} />
            <Text style={styles.tituloCard}>O que o seu médico vai ver</Text>
          </View>
          <Text style={styles.corpo}>
            Suas <Text style={styles.enfase}>alergias</Text>, os{' '}
            <Text style={styles.enfase}>medicamentos</Text> que você toma, suas{' '}
            <Text style={styles.enfase}>condições de saúde</Text> e os{' '}
            <Text style={styles.enfase}>exames recentes</Text>.
          </Text>
          <Text style={styles.corpoFraco}>
            Ele <Text style={styles.enfase}>não</Text> vê nossas conversas, nem o que eu
            aprendi sobre você, nem seu telefone ou endereço. E o resumo fica congelado no
            momento em que você criar o link — o que você contar depois não vai junto.
          </Text>
        </GlassCard>

        {criado ? (
          /* ── O link, uma vez ────────────────────────────────────────────── */
          <GlassCard style={[styles.card, styles.cardLink]}>
            <GlassBadge tone="success" size="xs" style={styles.badge}>
              link criado
            </GlassBadge>
            <Text selectable style={styles.url}>
              {criado.url ?? criado.token}
            </Text>
            <Text style={styles.aviso}>
              Copie agora: por segurança, eu não guardo o link — só sei conferir se ele é
              válido. Se fechar sem copiar, é só criar outro.
            </Text>
            <View style={styles.botoes}>
              <GlassButton
                variant="primary"
                size="md"
                onPress={() => void compartilhar()}
                icon={<Share2 size={16} color="#fff" />}
              >
                Enviar
              </GlassButton>
              <GlassButton
                variant="secondary"
                size="md"
                onPress={() => void copiar()}
                icon={<Copy size={16} color={colors.textDim} />}
              >
                Copiar
              </GlassButton>
            </View>
            <Text style={styles.corpoFraco}>
              Vale até {brQuando(criado.expiresAt, agora)}.
              {criado.comPin ? ' Pede o PIN que você escolheu.' : ''}
            </Text>
          </GlassCard>
        ) : (
          /* ── Criar ──────────────────────────────────────────────────────── */
          <GlassCard style={styles.card}>
            <Text style={styles.rotulo}>Por quanto tempo o link vale</Text>
            <View style={styles.opcoes}>
              {OPCOES_VALIDADE.map((o) => (
                <Pressable
                  key={o.horas}
                  onPress={() => setHoras(o.horas)}
                  style={[styles.opcao, horas === o.horas && styles.opcaoAtiva]}
                >
                  <Text style={[styles.opcaoTexto, horas === o.horas && styles.opcaoTextoAtivo]}>
                    {o.rotulo}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.corpoFraco}>
              Depois disso ele para de abrir sozinho. Você pode derrubar antes, quando quiser.
            </Text>

            <Pressable onPress={() => setUsarPin((v) => !v)} style={styles.tituloLinha} hitSlop={8}>
              <ShieldCheck size={16} color={usarPin ? colors.success : colors.textFaint} />
              <Text style={styles.rotulo}>
                {usarPin ? 'Com PIN de 4 números' : 'Adicionar um PIN (opcional)'}
              </Text>
            </Pressable>
            {usarPin && (
              <>
                <GlassInput
                  value={pin}
                  onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 4))}
                  placeholder="0000"
                  keyboardType="number-pad"
                  maxLength={4}
                />
                <Text style={styles.corpoFraco}>
                  Protege se o link for repassado adiante. Mande o PIN ao médico por outro
                  caminho — não junto com o link.
                </Text>
              </>
            )}

            <GlassButton
              variant="primary"
              size="md"
              disabled={!podeCriar}
              loading={criando}
              onPress={() => criar(horas, usarPin ? pin : undefined)}
              icon={<Link2 size={16} color="#fff" />}
            >
              Criar o link
            </GlassButton>
            {erro ? <Text style={styles.erro}>{erro}</Text> : null}
          </GlassCard>
        )}

        {/* ── Links ativos ─────────────────────────────────────────────────── */}
        {ativos.length > 0 && (
          <>
            <SectionHeader
              title="Links ativos"
              size="sm"
              subtitle="derrube qualquer um a qualquer momento"
              style={styles.secao}
            />
            <View style={styles.lista}>
              {ativos.map((s) => (
                <GlassCard key={s.id} style={styles.linha}>
                  <View style={styles.linhaTextos}>
                    <Text style={styles.linhaTitulo}>
                      Vale até {brQuando(s.expiresAt, agora)}
                    </Text>
                    <Text style={styles.linhaHint}>
                      {s.acessos === 0
                        ? 'ainda não foi aberto'
                        : `aberto ${s.acessos}${s.acessos === 1 ? ' vez' : ' vezes'}` +
                          (s.ultimoAcesso ? ` · último ${brDesde(s.ultimoAcesso, agora)}` : '')}
                      {s.comPin ? ' · com PIN' : ''}
                    </Text>
                  </View>
                  <Pressable onPress={() => confirmarRevogar(s.id)} hitSlop={10} style={styles.revogar}>
                    <Ban size={14} color={colors.danger} />
                    <Text style={styles.revogarTexto}>derrubar</Text>
                  </Pressable>
                </GlassCard>
              ))}
            </View>
          </>
        )}

        <Text style={styles.rodape}>
          Toda vez que alguém abrir um link seu, eu registro. Você pode ver aqui quantas
          vezes foi aberto.
        </Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  voltar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, alignSelf: 'flex-start' },
  voltarTexto: { color: colors.textDim, fontSize: 13 },
  card: { padding: 16, gap: 12, marginTop: 12 },
  cardLink: { borderColor: 'rgba(74,222,128,0.25)', backgroundColor: 'rgba(74,222,128,0.05)' },
  tituloLinha: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tituloCard: { color: colors.text, fontSize: 15, fontWeight: '600' },
  corpo: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  corpoFraco: { color: colors.textFaint, fontSize: 11, lineHeight: 17 },
  enfase: { color: colors.text, fontWeight: '600' },
  rotulo: { color: colors.text, fontSize: 13, fontWeight: '500' },
  opcoes: { flexDirection: 'row', gap: 8 },
  opcao: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassFillLo,
  },
  opcaoAtiva: { borderColor: 'rgba(124,135,255,0.5)', backgroundColor: 'rgba(124,135,255,0.15)' },
  opcaoTexto: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  opcaoTextoAtivo: { color: colors.accentHi },
  badge: { alignSelf: 'flex-start' },
  url: { color: colors.text, fontSize: 12, lineHeight: 18 },
  aviso: { color: colors.warn, fontSize: 11, lineHeight: 17 },
  botoes: { flexDirection: 'row', gap: 10 },
  erro: { color: colors.warn, fontSize: 12 },
  secao: { marginTop: 28, marginBottom: 12 },
  lista: { gap: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14 },
  linhaTextos: { flex: 1, gap: 2 },
  linhaTitulo: { color: colors.text, fontSize: 13, fontWeight: '600' },
  linhaHint: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
  revogar: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  revogarTexto: { color: colors.danger, fontSize: 11, fontWeight: '600' },
  rodape: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: 26, textAlign: 'center' },
});
