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
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ban, Eye, Link2, Share2, ShieldCheck } from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, GlassInput, SectionHeader } from '@/components/ui';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Screen } from '@/components/xarlote/Screen';
import { useCriarShare, useRevogarShare, useShares } from '@/features/share/use-shares';
import { useAgora } from '@/features/health/use-agora';
import { brDesde, brQuando } from '@/lib/br-format';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';

const OPCOES_VALIDADE = [
  { rotulo: '24 horas', horas: 24 },
  { rotulo: '3 dias', horas: 72 },
  { rotulo: '7 dias', horas: 168 },
] as const;

export default function CompartilharScreen() {
  const { data } = useShares();
  const { criar, criando, criado, erro, esquecer } = useCriarShare();
  const { revogar } = useRevogarShare();

  const [horas, setHoras] = useState<number>(72);
  const [usarPin, setUsarPin] = useState(false);
  const [pin, setPin] = useState('');
  /**
   * O relógio vem do `useAgora`, não de um `useState` na montagem.
   *
   * "Vale até amanhã às 14h" e "aberto pela última vez há 2 min" eram calculados no
   * instante em que a tela nasceu — e esta tela fica montada. Um link que EXPIROU
   * continuava listado como ativo enquanto o app não fosse reiniciado, o que num link de
   * prontuário é a informação errada mais cara que a tela pode dar.
   */
  const agora = useAgora();

  // Ao sair, o link em claro sai da memória junto. Ver o cabeçalho do use-shares.
  useEffect(() => () => esquecer(), [esquecer]);

  const podeCriar = !criando && (!usarPin || /^\d{4}$/.test(pin));

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

  /**
   * Vivos e mortos, separados — e os mortos CONTADOS, não sumidos.
   *
   * A tela mostrava só os ativos. Quem criou um link ontem, viu ele expirar e volta aqui
   * não encontrava vestígio nenhum — e a conclusão razoável é que o app perdeu o
   * registro, ou que o link nunca existiu. Num recurso que entrega prontuário a
   * terceiros, o histórico de quem recebeu acesso é justamente a parte que o paciente
   * tem direito de auditar.
   */
  const todos = data?.shares ?? [];
  const ativos = todos.filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > agora);
  const encerrados = todos.filter((s) => s.revokedAt || Date.parse(s.expiresAt) <= agora);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen title="Mostrar ao meu médico" voltar>
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
              Envie agora: por segurança, eu não guardo o link — só sei conferir se ele é
              válido. Se sair desta tela sem enviar, é só criar outro.
            </Text>
            {/*
              Só "Enviar", sem um botão de copiar separado.

              A folha de compartilhamento do sistema JÁ tem "Copiar" dentro dela, junto de
              WhatsApp, e-mail e o resto. Um botão dedicado exigiria `expo-clipboard` — um
              módulo NATIVO novo, e módulo nativo novo só existe depois de um build novo do
              app. Não vale trocar a compatibilidade do binário atual por um atalho que o
              sistema já oferece. (O texto acima é selecionável, então dá pra copiar à mão
              também.)
            */}
            <GlassButton
              variant="primary"
              size="md"
              onPress={() => void compartilhar()}
              icon={<Share2 size={16} color={colors.textOnFill} />}
            >
              Enviar pro meu médico
            </GlassButton>
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
                  accessibilityRole="radio"
                  accessibilityState={{ selected: horas === o.horas }}
                  accessibilityLabel={`Link válido por ${o.rotulo}`}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setHoras(o.horas);
                  }}
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

            {/* 44pt e papel de interruptor: era uma linha de 16px de altura com hitSlop 8. */}
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: usarPin }}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setUsarPin((v) => !v);
              }}
              style={styles.linhaPin}
            >
              <ShieldCheck size={16} color={usarPin ? colors.success : colors.textDim} />
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
              icon={<Link2 size={16} color={colors.textOnFill} />}
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
                  {/* Ação destrutiva: 44pt de alvo e rótulo próprio. Era um par
                      ícone+texto de 11px com hitSlop 10 — dedo grande erra, e errar aqui
                      significa deixar no ar um link de prontuário que se queria derrubar. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Derrubar este link"
                    onPress={() => confirmarRevogar(s.id)}
                    style={styles.revogar}
                  >
                    <Ban size={16} color={colors.danger} />
                    <Text style={styles.revogarTexto}>derrubar</Text>
                  </Pressable>
                </GlassCard>
              ))}
            </View>
          </>
        )}

        {/*
          Encerrado é LINHA, não cartão — e recolhido, com contador.

          A decisão de não esconder o que terminou está certa (o registro de acesso é
          auditoria); o que estava errado era o encerrado ocupar o mesmo peso visual do
          que ainda pede decisão. Aqui ele existe, diz quantos são, e não empurra nada.
        */}
        {encerrados.length > 0 ? (
          <CollapsibleSection
            title="Links que já não abrem"
            count={encerrados.length}
            style={styles.secaoEncerrados}
          >
            {encerrados.map((s) => (
              <View key={s.id} style={styles.linhaEncerrada}>
                <Text style={styles.encerradoTitulo}>
                  {s.revokedAt ? 'Derrubado por você' : 'Expirou'} ·{' '}
                  {brDesde(s.revokedAt ?? s.expiresAt, agora)}
                </Text>
                <Text style={styles.linhaHint}>
                  {s.acessos === 0
                    ? 'nunca foi aberto'
                    : `foi aberto ${s.acessos}${s.acessos === 1 ? ' vez' : ' vezes'}`}
                </Text>
              </View>
            ))}
          </CollapsibleSection>
        ) : null}

        <Text style={styles.rodape}>
          Toda vez que alguém abrir um link seu, eu registro. Você pode ver aqui quantas
          vezes foi aberto.
        </Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 12, marginTop: 12 },
  cardLink: { borderColor: 'rgba(74,222,128,0.25)', backgroundColor: 'rgba(74,222,128,0.05)' },
  tituloLinha: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  linhaPin: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  tituloCard: { color: colors.text, fontSize: 15, fontWeight: '600' },
  corpo: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  corpoFraco: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 18 },
  enfase: { color: colors.text, fontWeight: '600' },
  rotulo: { color: colors.text, fontSize: FONTE_CLINICA, fontWeight: '500' },
  opcoes: { flexDirection: 'row', gap: 8 },
  opcao: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassFillLo,
  },
  opcaoAtiva: { borderColor: 'rgba(124,135,255,0.5)', backgroundColor: 'rgba(124,135,255,0.15)' },
  opcaoTexto: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '600' },
  opcaoTextoAtivo: { color: colors.accentHi },
  badge: { alignSelf: 'flex-start' },
  /** O link é lido em voz alta e digitado à mão às vezes: piso clínico. */
  url: { color: colors.text, fontSize: FONTE_CLINICA, lineHeight: 19 },
  aviso: { color: colors.warn, fontSize: FONTE_MINIMA, lineHeight: 18 },
  erro: { color: colors.warn, fontSize: FONTE_CLINICA, lineHeight: 19 },
  secao: { marginTop: 28, marginBottom: 12 },
  lista: { gap: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14 },
  linhaTextos: { flex: 1, gap: 2 },
  linhaTitulo: { color: colors.text, fontSize: FONTE_CLINICA, fontWeight: '600' },
  linhaHint: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
  revogar: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingLeft: 8 },
  revogarTexto: { color: colors.danger, fontSize: FONTE_CLINICA, fontWeight: '600' },
  secaoEncerrados: { marginTop: 26 },
  linhaEncerrada: { paddingVertical: 8, gap: 2 },
  encerradoTitulo: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '500' },
  rodape: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 18, marginTop: 26, textAlign: 'center' },
});
