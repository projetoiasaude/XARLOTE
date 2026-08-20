/**
 * "O que eu lembro de você" — recolhido, contado, buscável, e contestável.
 *
 * ## O que estava errado
 *
 * O Perfil renderizava TODOS os memory cards (o servidor manda até 80), cada um como um
 * cartão de vidro com texto, badge e data, em quatro grupos, sem contador e sem corte. Um
 * paciente de alguns meses de conversa transformava a tela numa rolagem de dezenas de
 * cartões — e enterrava no fim dela o único botão de sair do app. O fundador viu isso e
 * pediu para recolher.
 *
 * ## Recolher é metade. A outra metade é controle
 *
 * Esta é a memória que a Xarlote formou sobre uma pessoa. Um app de saúde que afirma
 * coisas sobre alguém sem deixar essa pessoa corrigir é assustador. Então cada anotação
 * diz de onde veio (ela contou / eu deduzi / não registrei) e abre num toque com a porta
 * de contestar.
 *
 * ## As quatro seções aparecem sempre
 *
 * Inclusive vazias, com contador zero e a frase que ensina o que cai ali. A alternativa
 * — o `{x.length > 0 &&}` que a tela usava — é uma lacuna que se auto-lacra: quem não vê
 * a seção conclui que o app não guarda aquilo, nunca conta, e a seção nunca aparece.
 *
 * ## Custo de montagem
 *
 * Tudo nasce fechado, e ao abrir a seção mostra as 5 mais recentes com "ver todas (N)".
 * O `Screen` é uma `ScrollView` crua — sem virtualização — então o número de superfícies
 * montadas aqui é uma decisão de produto, não um detalhe: 4 cabeçalhos fechados custam
 * quatro linhas, e 80 cartões custavam 80 sombras, 80 gradientes e 80 recortes
 * arredondados que o Android compõe a cada quadro, com o dedo parado.
 *
 * ## Uma seção, não cinco
 *
 * O bloco inteiro vive dentro de UMA `CollapsibleSection`. Não é gosto: fechado, ele
 * são 48pt entre a última linha de privacidade e o "Sair da conta" — e a constituição
 * pede que o Perfil caiba numa tela (identidade + 4 linhas + Sair). Aberto como estava,
 * o cabeçalho, o campo de busca e as quatro subseções somavam ~370pt e empurravam o
 * botão de sair pra fora do viewport de um Android intermediário: o MESMO sintoma que
 * motivou esta reescrita, uma escala menor.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Brain, Search } from 'lucide-react-native';
import { GlassInput } from '@/components/ui';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';
import type { MemoryCard } from '@/features/health/overview';
/**
 * O envio reusa o funil da Saúde 360 de propósito.
 *
 * `useFalarComXarlote` já resolve confirmação com o texto à vista, `clientId` de
 * idempotência, invalidação da conversa, aviso honesto quando falha e navegação pro
 * chat. Escrever um segundo caminho de envio aqui criaria dois lugares para o mesmo
 * estado bom — e a regra da casa é que estado alcançável por N caminhos precisa de funil
 * ÚNICO. Ele mora em `features/health` por ter nascido lá; o que ele faz não é de saúde.
 */
import { useFalarComXarlote } from '@/features/health/use-falar-com-xarlote';
import { CardMemoria } from './CardMemoria';
import {
  APAGAR_CARD_DISPONIVEL,
  chaveDeCorrecao,
  chaveDeSecao,
  filtrarMemoria,
  fraseDeCorrecao,
  idDaCorrecao,
  LIMIAR_BUSCA,
  recorte,
  secoesDeMemoria,
  type ResumoMemoria,
} from './memoria';
import { useEsquecerCard } from './use-memoria';

interface Props {
  cards: MemoryCard[];
  resumo: ResumoMemoria;
  agoraMs: number;
}

export function BlocoMemoria({ cards, resumo, agoraMs }: Props) {
  const [busca, setBusca] = useState('');
  const [abertoId, setAbertoId] = useState<string | null>(null);
  const [tudoAberto, setTudoAberto] = useState<Record<string, boolean>>({});
  const [contestados, setContestados] = useState<ReadonlySet<string>>(() => new Set<string>());
  const { falar, emVoo } = useFalarComXarlote();
  const { esquecer, disponivel } = useEsquecerCard();

  const buscando = busca.trim().length > 0;
  const encontrados = useMemo(() => filtrarMemoria(cards, busca), [cards, busca]);
  const secoes = useMemo(() => secoesDeMemoria(encontrados), [encontrados]);

  /**
   * QUEM está sendo enviado agora — o id do cartão cuja correção passou do alerta.
   *
   * Um valor só, lido em dois lugares: o efeito abaixo (que marca o cartão como
   * contestado) e o `enviando` de cada `CardMemoria` (que fecha o formulário e joga o
   * rascunho fora). Eram duas leituras do mesmo sinal; duas expressões que precisam
   * concordar sempre são uma expressão que concorda por acaso.
   */
  const idEmVoo = idDaCorrecao(emVoo);

  /**
   * Marca o cartão como contestado quando a mensagem SAI — não quando o botão é tocado.
   *
   * `emVoo` só recebe a chave dentro do despacho do `useFalarComXarlote`, ou seja,
   * depois do "Mandar" no alerta de confirmação. Marcar em `corrigir` marcaria também
   * quem leu o texto no alerta e desistiu — um badge afirmando uma correção que nunca
   * aconteceu, na tela cujo assunto inteiro é não afirmar o que não houve.
   *
   * O resíduo conhecido: se o POST falhar, o hook avisa em alerta ("Não consegui
   * mandar") mas não devolve o desfecho, e o cartão fica marcado à toa. Dos três erros
   * possíveis é o menor — a pessoa acabou de ler o alerta de falha, enquanto marcar
   * quem desistiu seria invisível, e não marcar nada é o defeito que isto conserta.
   * Some sozinho quando o hook expuser sucesso/falha.
   */
  useEffect(() => {
    if (idEmVoo === null) return;
    setContestados((atual) => (atual.has(idEmVoo) ? atual : new Set(atual).add(idEmVoo)));
  }, [idEmVoo]);

  const alternarCard = useCallback((id: string) => {
    // Um aberto por vez: tocar em outro fecha o anterior.
    setAbertoId((atual) => (atual === id ? null : id));
  }, []);

  const corrigir = useCallback(
    (card: MemoryCard, certo: string) => {
      falar(fraseDeCorrecao(card, certo), chaveDeCorrecao(card.id));
    },
    [falar],
  );

  const verTodas = useCallback((chave: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTudoAberto((atual) => ({ ...atual, [chave]: true }));
  }, []);

  return (
    <CollapsibleSection
      icon={<Brain size={16} color={colors.accentHi} />}
      title="O que eu lembro de você"
      count={resumo.total}
      emptyHint={
        'Ainda não guardei nada sobre você — vou anotando conforme a gente conversa, e ' +
        'tudo o que eu anotar aparece aqui.'
      }
      style={styles.bloco}
    >
      {/* Só a procedência: o total já está dito no contador do cabeçalho, uma linha
          acima, e um dado é dito uma vez por tela. */}
      {resumo.origens.length > 0 ? (
        <Text style={styles.origens}>{resumo.origens}</Text>
      ) : null}

      {/* A busca só nasce quando rolar já não resolve. Um campo vazio a mais é uma
          decisão a mais pra quem só queria olhar. */}
      {resumo.total > LIMIAR_BUSCA ? (
        <View style={styles.buscaLinha}>
          <Search size={16} color={colors.textDim} />
          <GlassInput
            value={busca}
            onChangeText={setBusca}
            placeholder="procurar nas anotações"
            autoCorrect={false}
            style={styles.buscaCampo}
          />
        </View>
      ) : null}

      {buscando && encontrados.length === 0 ? (
        <Text style={styles.semResultado}>
          Nenhuma anotação com “{busca.trim()}”. Ainda tenho {resumo.total} guardadas —
          apaga a busca pra ver todas.
        </Text>
      ) : null}

      {secoes.map((s) => {
        /*
          A chave carrega o MODO (buscando ou não) e é a MESMA coisa em três lugares: a
          `key` de remontagem, o estado do "ver todas" e o gatilho que o liga.

          Ela existe pra `defaultOpen`, que só é lido na montagem: sem isso, digitar na
          busca filtraria seções que continuam fechadas e a pessoa concluiria que não
          achou nada. Só dois valores, então a remontagem acontece ao entrar e ao sair da
          busca — nunca a cada letra.

          E o estado do "ver todas" precisa do mesmo par porque a lista FILTRADA e a
          lista COMPLETA são duas listas: com a chave só pelo `kind`, tocar em "ver todas
          (7)" num resultado de busca ligava o interruptor da lista de 40 — que voltava
          inteira ao apagar a busca, sem "ver todas" à vista pra desfazer.
        */
        const chave = chaveDeSecao(s.kind, buscando);
        const { visiveis, escondidos } = recorte(s.cards, tudoAberto[chave] === true);
        return (
          <CollapsibleSection
            key={chave}
            title={s.rotulo}
            count={s.cards.length}
            defaultOpen={buscando}
            emptyHint={buscando ? undefined : s.dica}
          >
            {visiveis.map((c) => (
              <CardMemoria
                key={c.id}
                card={c}
                aberto={abertoId === c.id}
                onAlternar={alternarCard}
                onCorrigir={corrigir}
                enviando={idEmVoo === c.id}
                contestado={contestados.has(c.id)}
                podeApagar={disponivel}
                {...(disponivel ? { onApagar: esquecer } : {})}
                agoraMs={agoraMs}
              />
            ))}
            {escondidos > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Ver todas as ${s.cards.length} anotações de ${s.rotulo}`}
                onPress={() => verTodas(chave)}
                style={styles.verTodas}
              >
                <Text style={styles.verTodasTexto}>ver todas ({s.cards.length})</Text>
              </Pressable>
            ) : null}
          </CollapsibleSection>
        );
      })}

      {/*
        A verdade sobre apagar, escrita na tela.

        O rodapé antigo dizia "Quer que eu esqueça algo? Me fala no chat — 'esquece que
        eu…'". Não havia nada atrás disso: a Xarlote não tem tool de esquecer um item
        (as de `xarlote-tools.ts` só salvam fato), e `deleteUserMemory` só é chamado no
        apagamento da conta inteira. Era uma promessa vazia num app de saúde, e ainda
        anunciava uma frase mágica errada ("APAGAR MEUS DADOS", quando o app pede
        "APAGAR MINHA CONTA" e o chat pede "CONFIRMO APAGAR").

        Enquanto a rota não existir, o que fica escrito é o que é verdade — e o caminho
        que funciona está a uma polegada acima, na mesma tela.
      */}
      {!APAGAR_CARD_DISPONIVEL ? (
        <Text style={styles.aviso}>
          Apagar uma anotação sozinha eu ainda não sei fazer — não quero prometer o que
          não cumpro. Dá pra me corrigir (é o “não é isso” em cada uma), e dá pra apagar
          tudo de uma vez em <Text style={styles.avisoForte}>Meus dados</Text>, ali em cima.
        </Text>
      ) : null}
    </CollapsibleSection>
  );
}

const styles = StyleSheet.create({
  bloco: { marginTop: 28 },
  origens: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19, marginBottom: 10 },
  buscaLinha: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  buscaCampo: { flex: 1 },
  semResultado: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 20, marginBottom: 14 },
  /** Alvo de 44: era um `<Text onPress>` de 12px em outras telas, e dedo grande erra. */
  verTodas: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 2 },
  verTodasTexto: { color: colors.accentHi, fontSize: FONTE_CLINICA, fontWeight: '600' },
  aviso: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 18, marginTop: 2 },
  avisoForte: { color: colors.text, fontWeight: '600' },
});
