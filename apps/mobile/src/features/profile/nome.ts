/**
 * O nome do paciente — validar, normalizar, e montar o pedido.
 *
 * ## Por que o app não escreve o nome direto no banco
 *
 * Não existe rota de escrita de perfil na API: conferi os verbos de
 * `apps/api/src/routes/app/` e há `GET /me`, mas nenhum `PATCH`. O único caminho que
 * grava `users.preferred_name` hoje é a Xarlote chamando
 * `save_user_profile_fact({category:'identity', payload:{preferred_name}})` —
 * a tool existe e está em produção (`packages/llm/src/tools/xarlote-tools.ts`).
 *
 * Então o app faz o que pode fazer bem: **o paciente digita só o nome**, num campo
 * rotulado, e o app monta a frase certa e a manda pela conversa. A alternativa que a
 * tela tinha antes era "Sem nome ainda" e ponto — um estado vazio que informa um
 * problema e não ensina nada, no lugar mais pessoal do app. A alternativa preguiçosa
 * seria escrever "me pede no chat", que é justamente a resposta proibida: transferir
 * pra uma pessoa de 55 anos a tarefa de formular a frase é mais difícil que a tarefa de
 * digitar o nome, e um erro de formulação vira dado errado no prontuário.
 *
 * Quando `PATCH /app/me` existir, `fraseDeApelido` deixa de ser usada e o resto deste
 * arquivo continua valendo igual — a validação é do campo, não do transporte.
 */
import { colapsarEspacos, dobrar } from './texto';

/** Curto demais pra ser nome — "M" é quase sempre dedo errado. */
export const MIN_NOME = 2;

/**
 * Teto do campo. Não é limite de coluna (é `text` no Postgres): é o que cabe no
 * cabeçalho do Perfil e no "Bom dia, ___" do chat sem quebrar em duas linhas.
 */
export const MAX_NOME = 40;

/** Como o app quer guardar: sem sobra nas pontas, sem espaço duplo, sem quebra de linha. */
export function normalizarNome(bruto: string): string {
  return colapsarEspacos(bruto);
}

export type ProblemaNome = 'vazio' | 'curto' | 'longo' | 'numero' | 'igual';

export interface ChecagemNome {
  /** Já normalizado — é ISTO que vai no pedido, não o texto cru do campo. */
  nome: string;
  problema: ProblemaNome | null;
  ok: boolean;
}

/**
 * O campo está pronto pra mandar?
 *
 * `atual` entra na conta porque pedir à Xarlote pra te chamar pelo nome que ela já usa
 * gasta um turno de conversa e devolve "combinado" pra nada. Comparação DOBRADA (sem
 * acento, sem caixa): "marcia" e "Márcia" são a mesma pessoa, e insistir na diferença
 * faria o app pedir uma correção que não corrige.
 */
export function checarNome(bruto: string, atual: string | null): ChecagemNome {
  const nome = normalizarNome(bruto);

  if (nome.length === 0) return { nome, problema: 'vazio', ok: false };
  if (nome.length < MIN_NOME) return { nome, problema: 'curto', ok: false };
  if (nome.length > MAX_NOME) return { nome, problema: 'longo', ok: false };
  // Dígito em nome é quase sempre o campo errado (telefone, idade, CPF). Recusar aqui
  // é mais barato que a Xarlote gravar "Maria 62" e chamar a pessoa assim por meses.
  if (/\d/.test(nome)) return { nome, problema: 'numero', ok: false };
  if (atual && dobrar(atual) === dobrar(nome)) return { nome, problema: 'igual', ok: false };

  return { nome, problema: null, ok: true };
}

/**
 * O que a tela diz quando o campo não serve.
 *
 * Botão desabilitado calado é o defeito que já apareceu no login (número recusado sem
 * motivo). Cada problema tem uma frase que diz o que fazer — e 'vazio'/'igual' devolvem
 * `null` porque nesses dois casos não há nada a corrigir: a pessoa ainda não digitou,
 * ou digitou o nome que já vale.
 */
export function recadoDoProblema(p: ProblemaNome | null): string | null {
  switch (p) {
    case 'curto':
      return 'Escreve pelo menos duas letras.';
    case 'longo':
      return `Ficou comprido — até ${MAX_NOME} letras.`;
    case 'numero':
      return 'Só o nome, sem números.';
    default:
      return null;
  }
}

/**
 * A frase que vai pra conversa. Primeira pessoa do paciente, porque é ele quem manda —
 * a mensagem aparece no histórico como dele, e mensagem em nome de alguém tem que soar
 * como aquela pessoa.
 *
 * "Pode me chamar de X" e não "meu nome é X": o campo é o APELIDO
 * (`preferred_name`), e alguém que se chama Maria das Graças e quer ser chamada de
 * Graça está dizendo a primeira coisa, não a segunda.
 */
export function fraseDeApelido(nome: string): string {
  return `Pode me chamar de ${normalizarNome(nome)}.`;
}

/**
 * O primeiro nome, pra saudação e pro avatar. Sem `split(' ')[0]` solto na tela: nome
 * vazio ou só-espaços devolve `null`, nunca string vazia — o layout absorve a ausência,
 * mas "Bom dia, !" o paciente lê.
 */
export function primeiroNome(nome: string | null | undefined): string | null {
  const limpo = normalizarNome(nome ?? '');
  if (limpo.length === 0) return null;
  return limpo.split(' ')[0] ?? null;
}
