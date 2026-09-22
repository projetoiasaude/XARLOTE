/**
 * 🤝 Quem pode FALAR com a Xarlote — a trava que faltava no modo cuidador.
 *
 * ## O defeito que isto fecha
 *
 * O cuidado compartilhado foi ligado nas LEITURAS: a filha abre a Saúde da mãe e vê o
 * prontuário dela, porque toda consulta carrega `?subject=`. As telas de dados, porém,
 * têm uma escrita — os botões "+ Contar", "+ Registrar", "Pedir na farmácia", "corrigir
 * o que eu anotei" —, e essa escrita vai por `POST /app/messages`, que **não tem noção
 * de sujeito**: a conversa é sempre a de quem está logado.
 *
 * Resultado sem esta trava: a filha vê "sua Losartana acaba em 4 dias" no registro da
 * mãe, toca "Pedir na farmácia", e a Xarlote cota Losartana **para a filha**, no chat da
 * filha, com a frase em primeira pessoa que a tela montou ("Minha Losartana está
 * acabando"). O profile-enricher, que lê o turno, pode anotar que a filha toma Losartana.
 * É a mesma classe do incidente do `para_quem` de 31/08, entrando por outra porta.
 *
 * ## Por que BLOQUEAR e não mandar com sujeito
 *
 * "Falar com a Xarlote em nome de outra pessoa" é um degrau de produto que nenhum vínculo
 * abre hoje: exige a persona saber que quem escreve é a cuidadora e o assunto é a mãe, e
 * exige a própria pessoa ter consentido com isso. Enquanto esse degrau não existe, a
 * resposta honesta é dizer de quem é a conversa — e não escrever no prontuário errado
 * nem calar o botão sem explicação.
 *
 * Isto é função pura de propósito: a decisão é testada em `tests/mobile-care-sujeito.test.ts`,
 * não no aparelho de um paciente.
 */

export interface DecisaoDeFalar {
  /** `true` = a mensagem vai pro prontuário certo (o de quem está logado). */
  pode: boolean;
  /**
   * A frase que a tela mostra quando não pode. `null` quando pode — nenhuma tela precisa
   * decidir se mostra algo lendo string vazia.
   */
  aviso: string | null;
}

/** O título do alerta quando alguma ação ainda assim chega ao envio. */
export const TITULO_SO_NO_PROPRIO = 'Essa conversa é a sua';

/**
 * Sem nome não se inventa um: "da própria pessoa" é vago, mas é verdade. Um nome errado
 * na frase seria pior que nenhum, porque a pessoa acreditaria nele.
 */
function comoChamar(nome: string | null): string {
  const limpo = (nome ?? '').trim();
  return limpo ? `de ${limpo}` : 'da própria pessoa';
}

/**
 * Pode mandar a mensagem pronta pra Xarlote a partir desta tela?
 *
 * A frase diz as duas metades que importam: onde o pedido VALE (o WhatsApp de quem é o
 * registro) e de quem é a conversa que o app abriria (a de quem está logado). Sem a
 * segunda metade, "não dá" soa como defeito; com ela, é o desenho.
 */
export function decidirFalarComXarlote(alvo: {
  cuidandoDeOutro: boolean;
  nome: string | null;
}): DecisaoDeFalar {
  if (!alvo.cuidandoDeOutro) return { pode: true, aviso: null };
  return {
    pode: false,
    aviso: `Isso eu registro no WhatsApp ${comoChamar(alvo.nome)} 💙 — aqui a conversa é a sua.`,
  };
}
