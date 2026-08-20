/**
 * Saúde 360 — o prontuário do paciente na mão dele, e o que fazer com ele.
 *
 * ## A pergunta da tela e o que mudou
 *
 * A pergunta é "estou seguindo o tratamento?", e a resposta estava num subtítulo de
 * 12px ao lado de um gráfico: a adesão agora é o herói em 38px, com a frase empática
 * embaixo, e o gráfico é a segunda leitura. Antes desta sessão a tela respondia bem a
 * uma pergunta diferente — "o que existe no meu prontuário?" — e para essa ninguém abre
 * um app duas vezes.
 *
 * ## De exibição pra AÇÃO
 *
 * "Tomo Losartana 50mg" é uma linha com que ninguém faz nada. A faixa **Cuidar disso**
 * inverte isso: "sua Losartana acaba em 4 dias" com um botão que MANDA o pedido de
 * cotação (o mesmo fluxo que o `inventory-tracker` já oferece sozinho no WhatsApp), e
 * "seu último hemograma foi de dez/2025 — vale repetir?" com a pergunta pronta. As
 * derivações são puras e vivem em `features/health/insights.ts`.
 *
 * E a faixa tem TETO: ela é a lista do que pede atenção hoje, não o acervo. Três avisos
 * abertos, o resto atrás de um toque com o número dito. Sem isso, um paciente com
 * histórico de verdade abria a tela com seis cartões de ~130px entre o herói e as
 * alergias — todo dia, sem nada pra dispensar.
 *
 * ## Toda seção tem por onde ENTRAR
 *
 * As seis seções ensinavam como o dado entra ("me conta", "me manda a foto no chat") e
 * nenhuma deixava ele entrar. Agora cada uma tem a sua ação no cabeçalho (`AcaoDaSecao`),
 * que abre a conversa com a frase pronta — a mesma máquina dos avisos. "Me pede no chat"
 * é resposta proibida quando o app pode fazer o pedido.
 *
 * ## A ordem das seções não é estética
 *
 * Alergias vêm ANTES de medicamentos e condições: é o dado que muda conduta numa
 * emergência, e é o que alguém procura às pressas — inclusive um médico com o celular
 * do paciente na mão. E logo abaixo delas fica o **192**, que era a linha menos legível
 * e menos alcançável do app (10px, no rodapé, depois de seis seções, sem ser tocável)
 * numa persona definida por "orienta SAMU 192 em sinais de emergência".
 *
 * ## Nada some, nada é cortado em silêncio
 *
 * Toda seção é um `CollapsibleSection` com contador — inclusive quando o contador é
 * zero, e aí o `emptyHint` ensina como o dado entra. Condições, médicos e sintomas
 * simplesmente desapareciam quando vazios (`{x.length > 0 && …}`), o que faz o paciente
 * concluir que o app não guarda aquilo — e aí ele nunca conta, e a seção nunca aparece.
 * Onde a lista é longa, `ListaComTeto` diz quantos ficaram fora em vez de fatiar mudo.
 */
import { useCallback, useMemo } from 'react';
import { Alert, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  Activity,
  ChevronRight,
  FlaskConical,
  HeartPulse,
  ListChecks,
  PhoneCall,
  Pill,
  ShieldAlert,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, LoadFailure, Skeleton } from '@/components/ui';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Screen } from '@/components/xarlote/Screen';
import { AdherenceChart } from '@/features/health/AdherenceChart';
import { CardAviso } from '@/features/health/CardAviso';
import { ListaComTeto, LinhaNavegacao } from '@/features/health/Secoes';
import { useAgora } from '@/features/health/use-agora';
import { useFalarComXarlote } from '@/features/health/use-falar-com-xarlote';
import { useOverview } from '@/features/health/use-overview';
import {
  adesaoEmPartes,
  detalheDoMedicamento,
  ordenarAlergias,
  resumoAdesao,
  tarjaDoMedicamento,
  tomDaSeveridade,
} from '@/features/health/overview';
import { avisosDoProntuario, DIAS_ESTOQUE_BAIXO, estoqueDoMedicamento } from '@/features/health/insights';
import { brData, brDiaMes } from '@/lib/br-format';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';

/** Quantos itens cada lista longa mostra antes do "ver os outros N". */
const TETO_LISTA = 5;
/** Exames na Saúde: a biblioteca inteira é uma tela própria, aqui é só o mais recente. */
const TETO_EXAMES = 3;
/**
 * Quantos avisos ficam abertos na faixa "Cuidar disso".
 *
 * A faixa crescia sem teto: um cartão por medicamento acabando MAIS um por tipo de exame
 * antigo. Um paciente com histórico de verdade recebia seis cartões de ~130px, cada um
 * com botão de 44pt, entre o herói e as Alergias — todo dia, sem nada pra dispensar.
 * Três é o que cabe antes de a faixa empurrar o prontuário pra fora da primeira tela; o
 * resto continua a UM toque e o rodapé da lista diz quantos são (`ListaComTeto`), porque
 * corte mudo é o defeito que esta tela existe pra não ter.
 */
const TETO_AVISOS = 3;

interface AcaoProps {
  /** O que o botão diz: "+ Contar", "+ Registrar". */
  rotulo: string;
  /** A frase que VAI pra Xarlote, na voz do paciente. */
  mensagem: string;
  /** Identidade do envio em voo — nunca colide com a `chave` de um aviso. */
  chave: string;
  acessivel: string;
  emVoo: string | null;
  onFalar: (mensagem: string, chave: string) => void;
}

/**
 * O caminho de ENTRADA de cada seção — o que apaga o "me pede no chat".
 *
 * Seis seções ensinavam como o dado entra ("me conta", "me manda a foto do resultado no
 * chat") e nenhuma deixava ele entrar: não havia nem um "+", nem um atalho pra conversa.
 * A regra da casa é que toda tela que mostra um dado deixa consertar aquele dado ali
 * mesmo, e a máquina pra isso já existia pronta e testada — `useFalarComXarlote` abre a
 * conversa com a frase certa dentro, depois de mostrar o texto exato pra confirmação.
 *
 * Fica no `action` do `CollapsibleSection`, que é FORA da área de recolher: dá pra pedir
 * sem abrir a seção, e o toque no cabeçalho continua sendo só recolher. O alvo de 44pt
 * vem do `hitSlop` que o próprio `GlassButton` calcula pro tamanho `sm`.
 */
function AcaoDaSecao({ rotulo, mensagem, chave, acessivel, emVoo, onFalar }: AcaoProps) {
  return (
    <GlassButton
      size="sm"
      variant="secondary"
      loading={emVoo === chave}
      onPress={() => onFalar(mensagem, chave)}
      accessibilityLabel={acessivel}
    >
      {rotulo}
    </GlassButton>
  );
}

export default function SaudeScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const router = useRouter();
  // Congelado por render (duas funções puras da mesma tela não podem discordar na
  // virada do dia) mas NÃO por sessão: `useAgora` reacerta ao voltar do segundo plano.
  const agora = useAgora();
  const { falar, emVoo } = useFalarComXarlote();

  const adesao = useMemo(
    () => (data ? resumoAdesao(data.medicationLog, 30, agora) : null),
    [data, agora],
  );
  const alergias = useMemo(() => (data ? ordenarAlergias(data.allergies) : []), [data]);
  const avisos = useMemo(() => (data ? avisosDoProntuario(data, agora) : []), [data, agora]);

  const aoAtualizar = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void refetch();
  }, [refetch]);

  const abrirExame = useCallback((id: string) => router.push(`/exames/${id}`), [router]);

  /**
   * O 192 sem confirmação em app, de propósito.
   *
   * A regra da casa pede confirmação em ação irreversível, e uma ligação é irreversível.
   * Aqui o sistema operacional JÁ é essa confirmação: `tel:` abre o discador com o número
   * preenchido (Android) ou uma folha de confirmação (iOS) — ninguém liga por acidente.
   * Um alerta nosso em cima disso seria um toque a mais numa emergência, que é o único
   * momento do app em que um toque a mais tem consequência de verdade.
   */
  const ligar192 = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Linking.openURL('tel:192').catch(() => {
      // Falha nunca vira silêncio: se o discador não abre, o número vai na tela.
      Alert.alert('Não consegui abrir o telefone', 'Disca 192 — é o SAMU, a ligação é gratuita.');
    });
  }, []);

  if (isLoading && !data) {
    return (
      <Screen title="Saúde" subtitle="seu histórico, organizado">
        <Skeleton variant="card" height={150} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={110} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={110} />
      </Screen>
    );
  }

  /**
   * Numa falha de carregamento, esta tela é a MAIS perigosa das três.
   *
   * Ela tem seis seções, cada uma com o seu estado vazio. Sem esta saída antecipada, um
   * erro de rede produziria "Nenhuma alergia registrada", "Nenhum medicamento em uso" e
   * "Nenhum exame guardado" de uma vez — seis afirmações falsas sobre o prontuário de
   * alguém, na mesma tela. Uma mensagem de falha honesta vale mais que seis mentiras
   * bem formatadas.
   */
  if (isError && !data) {
    return (
      <Screen title="Saúde" subtitle="seu histórico, organizado">
        <LoadFailure
          erro={error}
          oQue="seu histórico"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      </Screen>
    );
  }

  const exames = data?.examResults ?? [];
  const medicamentos = data?.medications ?? [];
  const condicoes = data?.conditions ?? [];
  const prescritores = data?.prescribers ?? [];
  const sintomas = data?.symptoms ?? [];
  const inventario = data?.inventory ?? [];
  const partes = adesaoEmPartes(adesao?.score ?? null);

  return (
    <Screen
      title="Saúde"
      subtitle="seu histórico, organizado"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {/* ── Herói: a resposta da tela em zero toque ────────────────────────── */}
      <GlassCard style={styles.cardAdesao}>
        <View style={styles.adesaoTopo}>
          <View style={styles.adesaoNumeros}>
            <Text style={styles.adesaoValor}>{partes.numero}</Text>
            <Text style={styles.adesaoFrase}>{partes.frase}</Text>
          </View>
          <Activity size={18} color={colors.accentHi} />
        </View>
        {/* A janela ("30 dias") e a unidade ("doses tomadas") são ditas UMA vez, pela
            legenda do gráfico — que agora é legível (13px). A linha de texto que ficava
            aqui repetia as duas a 100px de distância, e nas duas vezes abaixo do piso. */}
        {adesao && adesao.diasComRegistro > 0 ? (
          <AdherenceChart serie={adesao.serie} />
        ) : (
          <Text style={styles.vazioInline}>
            Ainda não tenho doses registradas. Quando eu te lembrar de um remédio e você
            responder, o histórico começa a aparecer aqui.
          </Text>
        )}
      </GlassCard>

      {/* ── Cuidar disso: o que tem prazo e o que tem ação ─────────────────── */}
      {avisos.length > 0 && (
        <CollapsibleSection
          title="Cuidar disso"
          count={avisos.length}
          defaultOpen
          icon={<ListChecks size={16} color={colors.warn} />}
          style={styles.secao}
        >
          {/* Três abertos, o resto atrás de "ver os outros N" — e o corte fica com o
              menos urgente porque a ordenação de `avisosDoProntuario` garante isso em
              dois níveis: estoque (que tem prazo) antes de exame (que não tem), e dentro
              do estoque o que acaba primeiro na frente, alfabeto só como desempate. */}
          <ListaComTeto itens={avisos} teto={TETO_AVISOS} chave={(a) => a.chave} substantivo="avisos">
            {(a) => (
              <CardAviso
                aviso={a}
                ocupado={emVoo === a.chave}
                onPerguntar={falar}
                onAbrirExame={abrirExame}
              />
            )}
          </ListaComTeto>
        </CollapsibleSection>
      )}

      {/* ── Alergias (primeiro de propósito) ───────────────────────────────── */}
      <CollapsibleSection
        title="Alergias"
        count={alergias.length}
        defaultOpen
        icon={<ShieldAlert size={16} color={colors.danger} />}
        emptyHint="Não sei de nenhuma alergia sua. Toque em Contar: eu registro, passo a considerar isso em tudo, e o seu médico vê no link que você compartilha."
        action={
          <AcaoDaSecao
            rotulo="+ Contar"
            mensagem="Quero te contar uma alergia minha."
            chave="nova-alergia"
            acessivel="Contar uma alergia pra Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        <ListaComTeto itens={alergias} teto={TETO_LISTA} chave={(a) => a.id} substantivo="alergias">
          {(a) => (
            <GlassCard style={styles.linha}>
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{a.substance}</Text>
                {a.reaction ? <Text style={styles.linhaHint}>{a.reaction}</Text> : null}
              </View>
              {a.severity ? (
                <GlassBadge tone={tomDaSeveridade(a.severity)} size="xs">
                  {a.severity}
                </GlassBadge>
              ) : (
                // Gravidade desconhecida é DITA, não omitida: silêncio aqui seria lido
                // como "é leve", e a ordenação já trata desconhecido como risco médio.
                <GlassBadge tone="neutral" size="xs">
                  gravidade a confirmar
                </GlassBadge>
              )}
            </GlassCard>
          )}
        </ListaComTeto>
      </CollapsibleSection>

      {/* ── Emergência: um toque, logo abaixo das alergias ─────────────────── */}
      <Pressable
        onPress={ligar192}
        accessibilityRole="button"
        accessibilityLabel="Ligar para o SAMU, 192"
        style={styles.emergencia}
      >
        <PhoneCall size={20} color={colors.danger} />
        <View style={styles.emergenciaTextos}>
          <Text style={styles.emergenciaTitulo}>Emergência — ligar 192</Text>
          <Text style={styles.emergenciaHint}>SAMU, gratuito, 24h</Text>
        </View>
      </Pressable>

      {/* ── Medicamentos ───────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Meus medicamentos"
        count={medicamentos.length}
        defaultOpen
        icon={<Pill size={16} color={colors.accentHi} />}
        emptyHint="Toque em Registrar e me diga o que você toma e com que frequência — eu monto os lembretes, acompanho o estoque e cuido das recompras."
        action={
          <AcaoDaSecao
            rotulo="+ Registrar"
            mensagem="Quero registrar um remédio que eu tomo."
            chave="novo-medicamento"
            acessivel="Registrar um medicamento com a Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        <ListaComTeto
          itens={medicamentos}
          teto={TETO_LISTA}
          chave={(m) => m.id}
          substantivo="medicamentos"
        >
          {(m) => {
            const tarja = tarjaDoMedicamento(m);
            const estoque = estoqueDoMedicamento(m, inventario);
            return (
              <GlassCard style={styles.linha}>
                <View style={styles.linhaTextos}>
                  <Text style={styles.linhaTitulo}>{m.medication_name}</Text>
                  <Text style={styles.linhaHint}>{detalheDoMedicamento(m)}</Text>
                  {/* Estoque folgado é dito AQUI; estoque acabando é dito na faixa
                      "Cuidar disso", que tem o botão. Um dado é dito uma vez por tela —
                      repetir o alerta a 60px do cartão que age só rouba atenção dele. */}
                  {estoque && estoque.dias > DIAS_ESTOQUE_BAIXO ? (
                    <Text style={styles.linhaEstoque}>estoque pra uns {estoque.dias} dias</Text>
                  ) : null}
                </View>
                {tarja ? (
                  <GlassBadge tone={tarja.tom} size="xs">
                    {tarja.rotulo}
                  </GlassBadge>
                ) : null}
              </GlassCard>
            );
          }}
        </ListaComTeto>
      </CollapsibleSection>

      {/* ── Exames ─────────────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Meus exames"
        count={exames.length}
        defaultOpen
        icon={<FlaskConical size={16} color={colors.info} />}
        emptyHint="Toque em Enviar e me mande a foto do resultado. Eu leio, organizo por data e guardo aqui pra você não precisar procurar em papel."
        action={
          <AcaoDaSecao
            rotulo="+ Enviar"
            mensagem="Quero te mandar a foto de um exame."
            chave="novo-exame"
            acessivel="Enviar a foto de um exame pra Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        <View style={styles.lista}>
          {exames.slice(0, TETO_EXAMES).map((e) => (
            <GlassCard
              key={e.id}
              style={styles.linha}
              interactive
              onPress={() => abrirExame(e.id)}
            >
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{e.title?.trim() || e.exam_type}</Text>
                <Text style={styles.linhaHint}>{brData(e.exam_date) || 'data não identificada'}</Text>
              </View>
              <ChevronRight size={18} color={colors.textDim} />
            </GlassCard>
          ))}
        </View>
      </CollapsibleSection>

      {/*
        O caminho pra biblioteca fica FORA da seção, e de propósito.
        A biblioteca não está no OrbNav: esta linha é o único acesso a ela. Dentro da
        seção, ela desapareceria justamente quando `count` é 0 — a seção nasce fechada
        quando vazia —, ou seja, ficaria invisível pra quem ainda não mandou nenhum exame,
        que é exatamente quem precisa descobrir que o lugar existe. É uma LINHA de 52pt
        com chevron, e não um "ver todos" de 12px com alvo de toque de 50×16.
      */}
      <LinhaNavegacao
        rotulo={
          exames.length > TETO_EXAMES
            ? `Ver todos os ${exames.length} exames`
            : 'Abrir a biblioteca de exames'
        }
        detalhe="por mês, com os valores que eu consegui ler"
        icone={<FlaskConical size={16} color={colors.info} />}
        onPress={() => router.push('/exames')}
      />

      {/* ── Condições ──────────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Condições de saúde"
        count={condicoes.length}
        icon={<HeartPulse size={16} color={colors.auroraPink} />}
        emptyHint="Diabetes, pressão alta, tireoide… toque em Contar e me diga o que você trata. É o que me faz entender os seus remédios em vez de só listá-los."
        action={
          <AcaoDaSecao
            rotulo="+ Contar"
            mensagem="Quero te contar uma condição de saúde que eu tenho."
            chave="nova-condicao"
            acessivel="Contar uma condição de saúde pra Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        <ListaComTeto itens={condicoes} teto={TETO_LISTA} chave={(c) => c.id} substantivo="condições">
          {(c) => (
            <GlassCard style={styles.linha}>
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{c.name}</Text>
                {c.notes ? (
                  <Text style={styles.linhaHint} numberOfLines={2}>
                    {c.notes}
                  </Text>
                ) : null}
              </View>
              {/* `active` é booleano — a coluna `status` que eu supus não existe.
                  "Em acompanhamento" só é dito quando é VERDADE. */}
              {c.active ? (
                <GlassBadge tone="accent" size="xs">
                  em acompanhamento
                </GlassBadge>
              ) : c.active === false ? (
                <GlassBadge tone="neutral" size="xs">
                  resolvida
                </GlassBadge>
              ) : null}
            </GlassCard>
          )}
        </ListaComTeto>
      </CollapsibleSection>

      {/* ── Médicos ────────────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Meus médicos"
        count={prescritores.length}
        icon={<Stethoscope size={16} color={colors.accentHi} />}
        emptyHint="Toque em Cadastrar e me diga quem te acompanha e de que especialidade. Guardo aqui pra quando você precisar do nome, do CRM, ou de mandar seu histórico pra ele."
        action={
          <AcaoDaSecao
            rotulo="+ Cadastrar"
            mensagem="Quero cadastrar um médico que me acompanha."
            chave="novo-medico"
            acessivel="Cadastrar um médico com a Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        <ListaComTeto itens={prescritores} teto={TETO_LISTA} chave={(p) => p.id} substantivo="médicos">
          {(p) => (
            <GlassCard style={styles.linha}>
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{p.name}</Text>
                <Text style={styles.linhaHint}>
                  {[p.specialty, p.crm ? `CRM ${p.crm}${p.crm_state ? `/${p.crm_state}` : ''}` : null]
                    .filter(Boolean)
                    .join(' · ') || 'sem detalhes'}
                </Text>
              </View>
            </GlassCard>
          )}
        </ListaComTeto>
      </CollapsibleSection>

      {/* ── Sintomas ───────────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="O que você me contou"
        count={sintomas.length}
        icon={<TriangleAlert size={16} color={colors.warn} />}
        emptyHint="Quando algo te incomodar — dor, tontura, falta de ar — toque em Contar na hora. Eu registro com data, e é isso que o médico mais pergunta."
        action={
          <AcaoDaSecao
            rotulo="+ Contar"
            mensagem="Quero te contar um sintoma que estou sentindo."
            chave="novo-sintoma"
            acessivel="Contar um sintoma pra Xarlote"
            emVoo={emVoo}
            onFalar={falar}
          />
        }
        style={styles.secao}
      >
        {/* Abre com TODOS os que o servidor mandou. O `slice(0, 8)` que estava aqui
            escondia doze relatos que a própria pessoa fez sobre o corpo dela, sem nada
            na tela sugerindo que havia mais. */}
        <GlassCard style={styles.sintomas}>
          {sintomas.map((s) => (
            <View key={s.id} style={styles.sintomaLinha}>
              <Text style={styles.sintomaData}>{brDiaMes(s.created_at)}</Text>
              <Text style={styles.sintomaNome} numberOfLines={1}>
                {s.name}
              </Text>
              {typeof s.intensity === 'number' ? (
                <Text style={styles.sintomaIntensidade}>{s.intensity}/10</Text>
              ) : null}
            </View>
          ))}
        </GlassCard>
      </CollapsibleSection>

      {/* Não existe um estado vazio geral aqui de propósito: cada uma das seis seções já
          diz o próprio tamanho e ensina como o dado dela entra. Um sétimo cartão
          dizendo "seu prontuário começa vazio" repetiria as seis dicas de uma vez, que é
          o ruído que a regra de dizer cada coisa uma vez existe pra evitar. */}

      {/* O rodapé médico-legal: a Xarlote NUNCA diagnostica, e a tela diz isso. O 192
          saiu daqui e virou botão — aviso jurídico e recurso de emergência não podem
          ser a mesma linha de texto. */}
      <Text style={styles.rodape}>
        Isto é um histórico organizado, não um diagnóstico. Quem interpreta é o seu médico.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 14 },

  cardAdesao: { padding: 16, gap: 10 },
  adesaoTopo: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  adesaoNumeros: { flex: 1, gap: 2 },
  // 38px: a resposta da tela é lida de longe, por quem talvez não esteja de óculos.
  adesaoValor: { color: colors.text, fontSize: 38, fontWeight: '700', letterSpacing: -1.2 },
  adesaoFrase: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 18 },
  vazioInline: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19 },

  secao: { marginTop: 22 },
  lista: { gap: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14 },
  linhaTextos: { flex: 1, gap: 3 },
  linhaTitulo: { color: colors.text, fontSize: 15, fontWeight: '600' },
  // Dose e frequência são dado clínico: piso de 13px e o tom médio, nunca o mais fraco.
  linhaHint: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 18 },
  linhaEstoque: { color: colors.textFaint, fontSize: FONTE_MINIMA },

  emergencia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
    backgroundColor: 'rgba(248,113,113,0.10)',
  },
  emergenciaTextos: { flex: 1, gap: 2 },
  emergenciaTitulo: { color: colors.dangerSoft, fontSize: 16, fontWeight: '700' },
  emergenciaHint: { color: colors.textDim, fontSize: FONTE_MINIMA },

  sintomas: { padding: 14, gap: 12 },
  sintomaLinha: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sintomaData: { color: colors.textDim, fontSize: FONTE_MINIMA, width: 44 },
  sintomaNome: { color: colors.text, fontSize: FONTE_CLINICA, flex: 1 },
  sintomaIntensidade: { color: colors.warn, fontSize: FONTE_CLINICA, fontWeight: '600' },

  rodape: {
    color: colors.textFaint,
    fontSize: FONTE_MINIMA,
    lineHeight: 18,
    marginTop: 30,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});
