/**
 * Uma anotação da Xarlote, com a porta pra contestá-la.
 *
 * ## Por que este cartão abre
 *
 * Fechado ele responde "o que ela sabe de mim?" numa linha. Aberto ele responde a
 * pergunta que vem em seguida e que a tela antiga não respondia: **"e se estiver
 * errado?"**. Um cartão marcado como dedução, sem porta de saída, é um convite sem
 * porta — o texto do badge diz "eu deduzi" justamente pra convidar à correção, e a
 * correção exigia sair do app e formular uma frase.
 *
 * Só um cartão fica aberto por vez (o pai controla). Não é economia de pixel: cada
 * cartão aberto é mais uma pilha de superfícies que o Android compõe a cada quadro, e a
 * lição desta sessão foi que empilhar custa mesmo parado.
 *
 * ## Onde o toque NÃO fica
 *
 * O `GlassCard` não recebe `onPress`. O alvo é uma `Pressable` INTERNA, com 44pt de
 * altura, e o motivo é o formulário de correção: um `TextInput` dentro de um `Pressable`
 * que recolhe o cartão faria o teclado abrir e o campo desaparecer no mesmo toque.
 *
 * ## O que ele recusa afirmar
 *
 * A origem vem de `origemDoCard`, que tem TRÊS estados — e o terceiro ("origem não
 * registrada") é o que impede o cartão de dizer "eu deduzi" sobre uma linha antiga em
 * que ninguém gravou a procedência. Confiança ausente não vira certeza; confiança baixa
 * é dita em palavras.
 *
 * ## E o que ele PRECISA dizer depois da correção
 *
 * O laço da correção não fecha no banco: a mensagem vai pro chat, e nada no caminho
 * apaga ou reescreve `memory_cards_index` — não existe caminho de reescrita em lugar
 * nenhum do sistema (`packages/db/src/memory.ts` sabe inserir, refrescar e apagar tudo;
 * `save_user_profile_fact` escreve em `users`/`user_allergies`/… e nunca toca no índice
 * de memória). Se o cartão voltasse igual, com o mesmo badge de antes, a leitura da
 * pessoa seria "reclamar não adiantou". Então quando ela contesta, o cartão passa a
 * DIZER isso (`contestado`): a correção foi levada pra conversa, e esta anotação
 * continua aqui do jeito que está. Prometer "até eu reescrever" seria anunciar um
 * futuro que não chega — reparar não é reanunciar, e prometer também não é reparar.
 *
 * ## O rascunho da correção sobrevive ao "Cancelar"
 *
 * `onCorrigir` só ABRE o alerta de confirmação do `useFalarComXarlote` e volta na hora.
 * Limpar o campo ali dentro (era o que este arquivo fazia) fecha o formulário na cara de
 * quem ainda não confirmou: o alerta aparece por cima de um cartão que já voltou ao
 * estado anterior, e quem toca em "Cancelar" perde o que digitou. Então quem fecha o
 * formulário é o `useEffect` do `enviando` — a mesma forma do `CartaoIdentidade`, que é
 * o outro cartão desta tela a mandar mensagem pela Xarlote. Dois comportamentos opostos
 * pro mesmo gesto, no mesmo diretório, é o defeito que isto fecha.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ChevronDown, MessageSquareX, Trash2 } from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, GlassInput } from '@/components/ui';
import { brDesde } from '@/lib/br-format';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';
import type { MemoryCard } from '@/features/health/overview';
import {
  duvidaDoCard,
  EXPLICACAO_CONTESTADA,
  origemDoCard,
  ROTULO_CONTESTADO,
} from './memoria';

interface Props {
  card: MemoryCard;
  aberto: boolean;
  /** O pai guarda qual cartão está aberto — um por vez. */
  onAlternar: (id: string) => void;
  /** Manda a correção pra Xarlote. `certo` vazio = "isso não vale mais pra mim". */
  onCorrigir: (card: MemoryCard, certo: string) => void;
  /**
   * A correção DESTE cartão passou do alerta e está indo pra rede.
   *
   * É o único sinal que diz que a pessoa confirmou — `onCorrigir` retorna antes disso,
   * com o alerta ainda aberto. É por ele que o formulário fecha e o rascunho é jogado
   * fora; sem ele, cancelar o alerta apagava o que a pessoa tinha acabado de escrever.
   *
   * Resíduo conhecido, o mesmo que o `CartaoIdentidade` carrega: se o POST falhar depois
   * do "Mandar", o rascunho já foi embora — `useFalarComXarlote` avisa em alerta mas não
   * devolve o desfecho. Some sozinho quando o hook expuser sucesso/falha.
   */
  enviando: boolean;
  /** Já foi contestado nesta sessão: o cartão para de fingir que nada aconteceu. */
  contestado: boolean;
  /** Ligado só quando `DELETE /app/memory/:id` existir (ver memoria.ts). */
  podeApagar: boolean;
  onApagar?: (id: string) => void;
  /**
   * 🤝 A memória na tela é de quem está sendo cuidado — corrigir manda uma mensagem em
   * primeira pessoa pra conversa de QUEM ESTÁ LOGADO, que é outro prontuário. O botão
   * fica à vista e desabilitado; o porquê é dito uma vez no topo do bloco.
   */
  bloqueado?: boolean;
  /** O "agora" da tela, congelado por render (ver features/health/use-agora.ts). */
  agoraMs: number;
}

function CardMemoriaBase({
  card,
  aberto,
  onAlternar,
  onCorrigir,
  enviando,
  contestado,
  podeApagar,
  onApagar,
  bloqueado = false,
  agoraMs,
}: Props) {
  const [corrigindo, setCorrigindo] = useState(false);
  const [certo, setCerto] = useState('');
  const origem = origemDoCard(card);
  const duvida = duvidaDoCard(card);
  const quando = brDesde(card.last_seen_at, agoraMs);

  // Fecha o formulário quando o envio COMEÇA — não quando o botão é tocado. Cancelar o
  // alerta de confirmação não passa por aqui, então o rascunho sobrevive ao "Cancelar",
  // que é o que a pessoa espera (e o que o `CartaoIdentidade` já fazia).
  useEffect(() => {
    if (enviando) {
      setCorrigindo(false);
      setCerto('');
    }
  }, [enviando]);

  const alternar = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Fechar o cartão fecha o formulário: deixar um rascunho pendurado num cartão
    // recolhido é dado do paciente escondido atrás de um toque que ele não sabe que deu.
    setCorrigindo(false);
    setCerto('');
    onAlternar(card.id);
  }, [card.id, onAlternar]);

  const abrirCorrecao = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCorrigindo(true);
  }, []);

  const desistir = useCallback(() => {
    setCorrigindo(false);
    setCerto('');
  }, []);

  const mandar = useCallback(() => {
    // A confirmação com o texto à vista está em `useFalarComXarlote`, no caminho de
    // envio: a regra é uma confirmação, não duas.
    //
    // E nada é limpo aqui: `onCorrigir` só ABRE o alerta e volta na hora. Quem fecha o
    // formulário é o efeito do `enviando`, lá em cima, que só dispara depois do "Mandar".
    onCorrigir(card, certo);
  }, [card, certo, onCorrigir]);

  const apagar = useCallback(() => {
    onApagar?.(card.id);
  }, [card.id, onApagar]);

  return (
    <GlassCard style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: aberto }}
        accessibilityLabel={
          contestado
            ? `${card.text}. ${origem.rotulo}. ${ROTULO_CONTESTADO}.`
            : `${card.text}. ${origem.rotulo}.`
        }
        onPress={alternar}
        style={styles.gatilho}
      >
        <View style={styles.textos}>
          <Text style={styles.texto}>{card.text}</Text>
          <View style={styles.meta}>
            <GlassBadge tone={origem.tom} size="xs">
              {origem.rotulo}
            </GlassBadge>
            {contestado ? (
              <GlassBadge tone="warn" size="xs">
                {ROTULO_CONTESTADO}
              </GlassBadge>
            ) : null}
            {/* Depois que a pessoa disse que está errado, a minha dúvida sobre a minha
                própria dedução virou assunto vencido — e um badge a menos numa linha
                que já tem dois. */}
            {!contestado && duvida ? (
              <GlassBadge tone="warn" size="xs">
                {duvida}
              </GlassBadge>
            ) : null}
            {quando ? <Text style={styles.quando}>{quando}</Text> : null}
          </View>
        </View>
        {/* A seta não gira: rotação por cartão são N worklets numa lista. O estado
            aberto já está dito pelo conteúdo que apareceu — e pelo `accessibilityState`,
            que é o que o leitor de tela anuncia. */}
        <ChevronDown
          size={18}
          color={colors.textDim}
          style={aberto ? styles.setaAberta : undefined}
        />
      </Pressable>

      {aberto ? (
        <View style={styles.detalhe}>
          <Text style={[styles.explicacao, contestado && styles.explicacaoContestada]}>
            {contestado ? EXPLICACAO_CONTESTADA : origem.explicacao}
          </Text>

          {corrigindo ? (
            <View style={styles.formulario}>
              <Text style={styles.rotuloCampo}>O certo é (se quiser dizer):</Text>
              {/*
                A tecla de enviar do teclado é uma SAÍDA, e aqui ela é necessária.

                O `ScrollView` do `Screen` não passa `keyboardShouldPersistTaps`, e o
                padrão do RN é 'never': com o teclado aberto, o primeiro toque fora do
                campo só fecha o teclado e NÃO chega no botão. Num campo `multiline` sem
                tecla de envio, isso vira "toquei em Falar com a Xarlote e não aconteceu
                nada" — e a segunda tentativa é onde a paciente de 55 anos já desistiu.
                O conserto de verdade é uma linha no `Screen` (fora do alcance deste
                arquivo); enquanto ele não vem, o teclado ganha a tecla que manda.

                Perder o "novalinha" não custa nada aqui: a correção é uma frase, o campo
                tem teto de 300, e a mensagem montada é de linha única de propósito.
              */}
              <GlassInput
                value={certo}
                onChangeText={setCerto}
                placeholder="ex.: eu parei esse remédio em junho"
                autoFocus
                multiline
                maxLength={300}
                returnKeyType="send"
                submitBehavior="blurAndSubmit"
                onSubmitEditing={mandar}
                style={styles.campo}
              />
              {/*
                Esta ajuda já mentiu duas vezes, e as duas mentiras eram promessas de
                desfecho.

                A primeira: "pode mandar sem escrever nada — eu entendo que essa anotação
                não vale mais" convidava a pedir a REMOÇÃO, que é justamente o que a
                Xarlote não sabe fazer (o rodapé do bloco diz isso com todas as letras,
                duas polegadas abaixo).

                A segunda: "assim eu passo a considerar o certo … ela fica aqui até eu
                reescrever". Nenhum caminho do sistema reescreve um card — nem o enricher,
                nem `save_user_profile_fact`, nem tool nenhuma. "Até eu reescrever" era um
                futuro que não chega, escrito na tela cujo assunto inteiro é confiança.
                O que fica escrito agora é só o que de fato acontece.
              */}
              <Text style={styles.ajuda}>
                Escreve o que vale: eu mando isso na nossa conversa e é de lá que eu leio.
                Esta anotação antiga continua aqui do jeito que está — mexer nela de
                dentro do app eu ainda não sei fazer.
              </Text>
              <View style={styles.botoes}>
                <GlassButton
                  variant="primary"
                  size="sm"
                  loading={enviando}
                  disabled={enviando}
                  onPress={mandar}
                >
                  Falar com a Xarlote
                </GlassButton>
                <GlassButton variant="ghost" size="sm" onPress={desistir}>
                  Deixa
                </GlassButton>
              </View>
            </View>
          ) : (
            <View style={styles.botoes}>
              <GlassButton
                variant="secondary"
                size="sm"
                disabled={bloqueado}
                onPress={abrirCorrecao}
                icon={<MessageSquareX size={14} color={colors.text} />}
              >
                Não é isso
              </GlassButton>
              {/* Apagar também não é oferecido no modo cuidador: `DELETE /app/memory/:id`
                  não aceita `?subject=`, então o id da outra pessoa só renderia um
                  "sem acesso" — botão que falha é pior que botão ausente. */}
              {podeApagar && onApagar && !bloqueado ? (
                <GlassButton
                  variant="ghost"
                  size="sm"
                  onPress={apagar}
                  icon={<Trash2 size={14} color={colors.danger} />}
                  textStyle={styles.textoApagar}
                >
                  Apagar
                </GlassButton>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </GlassCard>
  );
}

/**
 * `memo` com propósito: o pai re-renderiza a cada toque (um cartão abre, outro fecha) e
 * a cada refetch do overview. Sem isto, cada toque reconstrói a subárvore de TODOS os
 * cartões. Só funciona porque `onAlternar`/`onCorrigir`/`onApagar` são estáveis lá em
 * cima — dependência instável faz o memo não segurar nada, que foi o defeito encontrado
 * no cartão de lembrete.
 */
export const CardMemoria = memo(CardMemoriaBase);

const styles = StyleSheet.create({
  card: { paddingHorizontal: 14, paddingVertical: 4 },
  /** 44 de piso: o alvo é o mínimo tocável, não a altura do texto. */
  gatilho: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingVertical: 10,
  },
  textos: { flex: 1, gap: 6 },
  texto: { color: colors.text, fontSize: FONTE_CLINICA, lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  quando: { color: colors.textDim, fontSize: FONTE_MINIMA },
  setaAberta: { transform: [{ rotate: '180deg' }] },
  detalhe: {
    gap: 12,
    paddingBottom: 12,
    paddingTop: 2,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    marginTop: 2,
  },
  explicacao: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19, paddingTop: 10 },
  /** Contestado sobe um degrau de contraste: é a única linha que responde "e agora?". */
  explicacaoContestada: { color: colors.text },
  formulario: { gap: 8 },
  rotuloCampo: { color: colors.text, fontSize: FONTE_CLINICA, fontWeight: '500' },
  campo: { minHeight: 64, textAlignVertical: 'top', borderRadius: radii.md },
  ajuda: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
  botoes: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  textoApagar: { color: colors.danger },
});
