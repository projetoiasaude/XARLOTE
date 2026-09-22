/**
 * Quem eu sou, no app — e o botão pra consertar isso.
 *
 * ## O estado vazio que não ensinava nada
 *
 * Sem `preferred_name`, o Perfil escrevia "Sem nome ainda" e parava ali: nenhum campo,
 * nenhum botão, nenhuma explicação. Para o público deste app, ver o próprio nome escrito
 * certo é o principal sinal de que aquele aplicativo é dele — e a tela comunicava o
 * oposto, no lugar mais pessoal que ela tem.
 *
 * ## Como a escrita acontece sem rota de escrita
 *
 * Não existe `PATCH /app/me`. Quem grava `users.preferred_name` é a Xarlote, pela tool
 * `save_user_profile_fact({category:'identity'})`. Então o app faz a parte difícil: o
 * paciente digita só o nome, e o app monta a frase e a manda pela conversa, com
 * confirmação e com o texto à vista. Ele sai daqui pro chat e vê a Xarlote confirmar com
 * a própria voz — que é melhor do que um "salvo" nosso, porque é a Xarlote quem passa a
 * usar o nome.
 *
 * A alternativa preguiçosa era escrever "me pede no chat". É a resposta proibida: pedir a
 * alguém de 55 anos para formular a frase certa é mais difícil que digitar o nome, e o
 * erro de formulação seria silencioso.
 *
 * ## Confirmação
 *
 * Mensagem enviada não volta, então o envio passa pelo `Alert` de `useFalarComXarlote`,
 * que mostra o texto EXATO. O editor fecha quando o envio COMEÇA (não quando o botão é
 * tocado): se a pessoa cancelar o alerta, o que ela digitou continua na tela.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Check, Pencil, X } from 'lucide-react-native';
import { Avatar, GlassButton, GlassCard, GlassInput } from '@/components/ui';
import { useFalarComXarlote } from '@/features/health/use-falar-com-xarlote';
import { formatPhonePretty } from '@/lib/phone-input';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';
import { checarNome, fraseDeApelido, MAX_NOME, recadoDoProblema } from './nome';

const CHAVE_PEDIDO = 'perfil:nome';

interface Props {
  nome: string | null;
  telefone: string;
  /**
   * A Xarlote está ligada? Quando não está, a mensagem entra no histórico e ninguém
   * responde — o nome não mudaria e a tela teria prometido à toa. Vem de
   * `GET /app/me → flags.xarloteEnabled`.
   */
  xarloteLigada: boolean;
}

export function CartaoIdentidade({ nome, telefone, xarloteLigada }: Props) {
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState('');
  // 🤝 `sobreOProprio`: o apelido vem do `GET /app/me`, ou seja, é de quem está logado —
  // mesmo com a bolsa de outra pessoa aberta, esta frase vai pro prontuário certo.
  const { falar, emVoo } = useFalarComXarlote({ sobreOProprio: true });
  const enviando = emVoo === CHAVE_PEDIDO;

  // Fecha o editor quando o envio COMEÇA. Cancelar o alerta de confirmação não passa por
  // aqui, então o rascunho sobrevive ao "Cancelar" — que é o que a pessoa espera.
  useEffect(() => {
    if (enviando) {
      setEditando(false);
      setRascunho('');
    }
  }, [enviando]);

  const abrir = useCallback(() => {
    setRascunho(nome ?? '');
    setEditando(true);
  }, [nome]);

  const fechar = useCallback(() => {
    setEditando(false);
    setRascunho('');
  }, []);

  const checagem = checarNome(rascunho, nome);
  const recado = recadoDoProblema(checagem.problema);

  const mandar = useCallback(() => {
    const c = checarNome(rascunho, nome);
    if (!c.ok) return;
    falar(fraseDeApelido(c.nome), CHAVE_PEDIDO);
  }, [falar, nome, rascunho]);

  if (editando) {
    return (
      <GlassCard style={styles.cardEditando}>
        <Text style={styles.rotulo}>Como você quer que eu te chame?</Text>
        <GlassInput
          value={rascunho}
          onChangeText={setRascunho}
          placeholder="seu nome ou apelido"
          autoFocus
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={MAX_NOME}
          returnKeyType="done"
          onSubmitEditing={mandar}
          error={checagem.problema === 'curto' || checagem.problema === 'numero'}
        />
        {/* Botão desabilitado calado é o defeito do login. Quando o campo não serve, a
            tela DIZ o que falta. */}
        {recado ? <Text style={styles.recado}>{recado}</Text> : null}

        <View style={styles.botoes}>
          <GlassButton
            variant="primary"
            size="md"
            disabled={!checagem.ok || enviando}
            loading={enviando}
            onPress={mandar}
            icon={<Check size={16} color={colors.textOnFill} />}
          >
            Pedir pra Xarlote
          </GlassButton>
          <GlassButton
            variant="ghost"
            size="md"
            onPress={fechar}
            icon={<X size={16} color={colors.textDim} />}
          >
            Deixa
          </GlassButton>
        </View>

        <Text style={styles.ajuda}>
          Eu mando isso na nossa conversa e a Xarlote confirma por lá. Daí em diante ela te
          chama assim.
        </Text>
      </GlassCard>
    );
  }

  return (
    <GlassCard
      style={styles.card}
      {...(xarloteLigada ? { onPress: abrir } : {})}
    >
      <Avatar name={nome ?? telefone} size="lg" />
      <View style={styles.textos}>
        <Text style={styles.nome}>{nome ?? 'Ainda não sei seu nome'}</Text>
        <Text style={styles.telefone}>{formatPhonePretty(telefone)}</Text>
        {/*
          O convite é explícito, e o motivo do "não" também é.

          Sem nome, o cartão precisa dizer o que fazer — um vazio que só informa o
          problema é o defeito que este arquivo existe pra fechar. Com a Xarlote em
          manutenção, ele diz por que não dá agora: negar pode estar certo, mentir sobre
          o motivo nunca.
        */}
        {xarloteLigada ? (
          <Text style={styles.convite}>
            {nome ? 'toque pra corrigir' : 'toque pra me dizer seu nome'}
          </Text>
        ) : (
          <Text style={styles.convite}>
            Pra mudar o nome eu preciso falar com a Xarlote, e ela está em manutenção.
          </Text>
        )}
      </View>
      {xarloteLigada ? <Pencil size={16} color={colors.textDim} /> : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  /** 76 de altura garante o alvo mínimo com folga — o cartão inteiro é o botão. */
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, minHeight: 76 },
  cardEditando: { padding: 16, gap: 12 },
  textos: { flex: 1, gap: 2 },
  nome: { color: colors.text, fontSize: 18, fontWeight: '600' },
  telefone: { color: colors.textDim, fontSize: FONTE_CLINICA },
  convite: { color: colors.accentHi, fontSize: FONTE_MINIMA, marginTop: 2, lineHeight: 17 },
  rotulo: { color: colors.text, fontSize: 15, fontWeight: '600' },
  recado: { color: colors.warn, fontSize: FONTE_MINIMA, lineHeight: 17 },
  botoes: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  ajuda: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
});
