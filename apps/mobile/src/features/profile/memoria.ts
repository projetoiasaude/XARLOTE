/**
 * A memória da Xarlote vista pelo PACIENTE: agrupar, contar, buscar, e sobretudo
 * **dizer de onde cada anotação veio**.
 *
 * ## Por que este arquivo existe separado de `features/health/overview.ts`
 *
 * O `agruparMemoria` de lá devolve só os grupos QUE TÊM card. Serve pro dashboard, e é
 * exatamente o defeito na tela do paciente: um grupo que não existe some, e some
 * também a explicação de como aquele tipo de anotação entra. A pessoa conclui que o app
 * não guarda "preferências" — quando a verdade é que ela ainda não contou nenhuma. Aqui
 * os quatro tipos conhecidos aparecem SEMPRE, com contador (zero inclusive) e com uma
 * frase que ensina o que cai ali dentro.
 *
 * ## O ponto mais delicado: origem
 *
 * A tela antiga decidia a origem com `source === 'self_reported' ? 'você me disse' :
 * 'eu percebi'`. Isso transforma `source = null` (linha antiga, importação, bug do
 * enricher) numa AFIRMAÇÃO de que nós deduzimos aquilo — e a pessoa passa a acreditar
 * que a Xarlote inferiu algo que talvez ela mesma tenha dito. É o mesmo erro que
 * `ordenarAlergias` recusa cometer com gravidade ausente: desconhecido não é o mesmo
 * que "o valor mais comum". São TRÊS estados, e o terceiro se chama pelo nome.
 *
 * ## Nada aqui apaga nada — e a tela não pode fingir que apaga
 *
 * As funções são puras: elas descrevem a memória e produzem a FRASE que o paciente
 * manda pra Xarlote quando uma anotação está errada. O apagamento item-a-item depende
 * de uma rota que ainda não existe (ver `APAGAR_CARD_DISPONIVEL`) — então **nenhuma
 * frase daqui pede pra tirar uma anotação** enquanto esse interruptor estiver desligado.
 * Pedir a remoção a quem não tem a ferramenta produz o pior desfecho possível: a LLM
 * responde "pronto, tirei", e a memória clínica continua exatamente onde estava.
 */
import { ORDEM_MEMORIA, ROTULO_MEMORIA, type MemoryCard } from '@/features/health/overview';
import { dobrar, limitar } from './texto';

// ─── Apagar um card: a porta que ainda não abriu ────────────────────────────────

/**
 * `DELETE /app/memory/:id` **não existe** na API (conferi os verbos de
 * `apps/api/src/routes/app/`: só `DELETE /account` e `DELETE /devices` e
 * `DELETE /shares/:id`). A Xarlote também NÃO tem tool de esquecer um item — as tools
 * de `packages/llm/src/tools/xarlote-tools.ts` só sabem SALVAR fato; `deleteUserMemory`
 * existe no backend mas é chamado apenas dentro do forget-me da conta inteira.
 *
 * Ou seja: hoje o único apagamento possível é o total. Esta constante é o interruptor —
 * a interface do botão, a confirmação e o hook estão prontos e testados; quando a rota
 * subir, isto vira `true` num commit de uma linha. Enquanto for `false`, a tela **diz a
 * verdade** e aponta o caminho que funciona (Meus dados), em vez de exibir um botão que
 * falharia ou, pior, uma promessa de que "é só pedir no chat" — que era o texto antigo
 * do rodapé e não tinha nada atrás.
 *
 * O `: boolean` explícito não é ruído: sem ele o tipo é o literal `false`, e todo lugar
 * que ramifica no interruptor (aqui, `fraseDeCorrecao`) passa a ter um braço que o
 * compilador considera morto — que é exatamente o braço que precisa continuar vivo e
 * legível pra quem for ligar a rota.
 */
export const APAGAR_CARD_DISPONIVEL: boolean = true;

/**
 * A Xarlote sabe esquecer um card quando alguém PEDE NO CHAT? Não.
 *
 * Este interruptor nasceu separado do de cima porque eles governam capacidades
 * diferentes, e tratá-los como um só produz exatamente a mentira que o outro evitava:
 *
 * · `APAGAR_CARD_DISPONIVEL` — o BOTÃO da tela, servido por `DELETE /app/memory/:id`.
 *   Existe, apaga nos dois lugares (JSONB canônico e espelho indexado) e é auditado.
 * · `XARLOTE_SABE_ESQUECER` — a LLM cumprindo "pode tirar" dito na conversa. As tools de
 *   `packages/llm/src/tools/xarlote-tools.ts` só sabem SALVAR fato; não há nenhuma de
 *   esquecer. Uma LLM sem a ferramenta responde "pronto, tirei" — confirmação falsa
 *   sobre memória clínica.
 *
 * Ligar a rota, portanto, NÃO autoriza `fraseDeCorrecao` a pedir remoção. Quando existir
 * a tool, este vira `true` e a frase volta ao fecho curto.
 */
export const XARLOTE_SABE_ESQUECER: boolean = false;

// ─── Seções ────────────────────────────────────────────────────────────────────

/**
 * O que cai em cada tipo, na voz da Xarlote. É o `emptyHint` da seção vazia — e o que
 * transforma uma lacuna em convite: sem isto, contador zero só informa a ausência.
 */
export const DICA_MEMORIA: Record<string, string> = {
  fact:
    'Coisas concretas suas: o que você toma, do que tem alergia, quem cuida de você. ' +
    'Vão entrando aqui conforme a gente conversa.',
  affect:
    'Como você se sente com as coisas — o que te dá medo, o que te alivia, o que te ' +
    'cansa. Guardo pra não te tratar como um caso, e sim como você.',
  preference:
    'Do jeito que você prefere: como quer ser chamado, o horário que te serve, se ' +
    'prefere texto ou áudio.',
  episode:
    'Momentos que vale lembrar depois — a consulta que te marcou, a crise da semana ' +
    'passada, aquele dia difícil.',
};

const DICA_PADRAO =
  'Anotações de um tipo novo, que esta versão do app ainda não sabe nomear. Aparecem ' +
  'aqui pra não ficarem invisíveis.';

export interface SecaoMemoria {
  kind: string;
  rotulo: string;
  /** O que entra nesta seção, pra quando ela estiver vazia. */
  dica: string;
  /** Do mais recente pro mais antigo. */
  cards: MemoryCard[];
}

/**
 * Ordena por `last_seen_at` decrescente, e sem data vai pro FIM.
 *
 * Não é enfeite: a tela promete "as 5 mais recentes" ao abrir a seção. Se a ordem
 * viesse do servidor por acidente, um dia em que o `order` de lá mudasse a tela
 * continuaria dizendo "recentes" mostrando as antigas. A promessa é local, então a
 * garantia é local.
 */
function porRecencia(cards: readonly MemoryCard[]): MemoryCard[] {
  return [...cards].sort((a, b) => {
    const ta = a.last_seen_at ? Date.parse(a.last_seen_at) : NaN;
    const tb = b.last_seen_at ? Date.parse(b.last_seen_at) : NaN;
    const va = Number.isFinite(ta) ? ta : -Infinity;
    const vb = Number.isFinite(tb) ? tb : -Infinity;
    return vb - va;
  });
}

/**
 * As seções da memória — **os quatro tipos conhecidos sempre**, mesmo com zero card,
 * mais qualquer `kind` novo que o enricher tenha inventado, no fim.
 */
export function secoesDeMemoria(cards: readonly MemoryCard[]): SecaoMemoria[] {
  const porKind = new Map<string, MemoryCard[]>();
  for (const c of cards) {
    const lista = porKind.get(c.kind);
    if (lista) lista.push(c);
    else porKind.set(c.kind, [c]);
  }

  const secoes: SecaoMemoria[] = [];
  for (const kind of ORDEM_MEMORIA) {
    secoes.push({
      kind,
      rotulo: ROTULO_MEMORIA[kind] ?? kind,
      dica: DICA_MEMORIA[kind] ?? DICA_PADRAO,
      cards: porRecencia(porKind.get(kind) ?? []),
    });
    porKind.delete(kind);
  }
  for (const [kind, cs] of porKind) {
    secoes.push({
      kind,
      rotulo: ROTULO_MEMORIA[kind] ?? 'Outras anotações',
      dica: DICA_MEMORIA[kind] ?? DICA_PADRAO,
      cards: porRecencia(cs),
    });
  }
  return secoes;
}

// ─── Origem ────────────────────────────────────────────────────────────────────

export type Origem = 'contou' | 'deduzi' | 'desconhecida';

export interface RotuloOrigem {
  origem: Origem;
  /** O que vai no badge, curto. */
  rotulo: string;
  tom: 'accent' | 'neutral' | 'warn';
  /** A frase inteira, mostrada quando o card abre. */
  explicacao: string;
}

/**
 * De onde veio esta anotação — em três estados, porque são três coisas diferentes.
 *
 * `self_reported` é o que o enricher marca quando o paciente DITOU; `inferred` é
 * dedução nossa. Qualquer outra coisa (nulo, string desconhecida) é **origem não
 * registrada**, e dizer isso em voz alta é o que permite ao paciente decidir se
 * confia. Chamar de dedução o que não sabemos seria inventar procedência de um dado
 * clínico.
 */
export function origemDoCard(card: MemoryCard): RotuloOrigem {
  const fonte = (card.source ?? '').trim().toLowerCase();
  if (fonte === 'self_reported') {
    return {
      origem: 'contou',
      rotulo: 'você me contou',
      tom: 'accent',
      explicacao:
        'Isto está aqui porque você me disse. Se mudou, me manda o certo: a correção vai ' +
        'pra nossa conversa e eu passo a considerar o novo.',
    };
  }
  if (fonte === 'inferred') {
    return {
      origem: 'deduzi',
      rotulo: 'eu deduzi',
      tom: 'neutral',
      explicacao:
        'Isto eu concluí sozinha, das nossas conversas — você nunca me disse com essas ' +
        'palavras. Se eu entendi errado, me manda o certo aqui e eu levo pra conversa.',
    };
  }
  return {
    origem: 'desconhecida',
    rotulo: 'origem não registrada',
    tom: 'warn',
    explicacao:
      'Esta anotação é antiga e eu não guardei se foi você quem me contou ou se fui eu ' +
      'que deduzi. Confere: se estiver errada, me diz.',
  };
}

/**
 * Abaixo disto, uma dedução vira "não tenho certeza".
 *
 * O enricher só escreve com confiança ≥ 0.7, então a faixa 0.70–0.79 é justamente a
 * das conclusões frágeis — as que mais precisam de um par de olhos humanos. O CLAUDE.md
 * manda a Xarlote PERGUNTAR antes de assumir quando a confiança é baixa; mostrar a
 * dúvida na tela é a mesma regra na superfície visual.
 */
export const LIMIAR_DUVIDA = 0.8;

/** A dúvida em palavras, ou `null` quando não há nada honesto a dizer. */
export function duvidaDoCard(card: MemoryCard): string | null {
  if (origemDoCard(card).origem !== 'deduzi') return null;
  const c = card.confidence;
  // `null` não vira 100%: sem medida, nenhuma afirmação sobre certeza.
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  return c < LIMIAR_DUVIDA ? 'não tenho certeza desta' : null;
}

// ─── Contestado: o laço que se fecha na tela, porque não fecha no banco ─────────

/**
 * O badge do cartão que a pessoa já contestou **nesta sessão**.
 *
 * Nada no caminho da correção escreve em `memory_cards_index`: a mensagem vai pro chat,
 * a Xarlote lê, e o enricher pode — no futuro, assíncrono — ADICIONAR um card novo. O
 * card errado não sai. Sem dizer isso, a pessoa volta ao Perfil, encontra a mesma frase
 * errada sobre a saúde dela com o mesmo badge de antes, e conclui a pior coisa possível
 * num app de saúde: que reclamar não adianta.
 */
export const ROTULO_CONTESTADO = 'você me corrigiu';

/**
 * A explicação que substitui a de origem depois que a correção foi mandada.
 *
 * ## "Até eu reescrever" era um futuro que não chega
 *
 * A versão anterior dizia que a anotação ficava "até eu reescrever". **Nenhum caminho do
 * sistema reescreve um card.** `packages/db/src/memory.ts` só sabe inserir, refrescar
 * (`last_seen_at` + confiança) ou apagar tudo; `save_user_profile_fact` escreve em
 * `users`/`user_allergies`/`user_health_conditions`/`user_medications` e nunca toca em
 * `memory_cards_index`; não existe tool de esquecer nem de editar em `xarlote-tools.ts`.
 * Prometer o reparo é o mesmo defeito que a tela inteira foi escrita pra evitar, uma
 * casa adiante: em vez de anunciar um reparo que não houve, anunciava um que não vem.
 *
 * Pior: o enricher grava a correção com embedding, e o dedup semântico a 0.85 aproxima
 * negação e afirmação do mesmo fato ("é alérgica a dipirona" × "não é alérgica a
 * dipirona"). Quando cai acima do limiar, a correção não entra — o código REFRESCA o
 * card errado (`last_seen_at` novo, confiança +0.05). Ou seja, corrigir pode deixar a
 * anotação errada mais recente e mais confiante. Enquanto isso for verdade, esta frase
 * não pode insinuar que a correção conserta o registro: ela afirma só o que de fato
 * acontece — a correção está na conversa, e é de lá que a Xarlote lê.
 */
export const EXPLICACAO_CONTESTADA =
  'Você já me disse que isto está errado, e a sua correção foi pra nossa conversa: é lá ' +
  'que eu leio o que você me conta, e é ela que eu levo em conta quando a gente fala. ' +
  'Esta anotação antiga continua aqui do jeito que está — mexer nela de dentro do app eu ' +
  'ainda não sei fazer.';

/**
 * O prefixo da chave que identifica um pedido de correção em voo no
 * `useFalarComXarlote`.
 *
 * A chave existe pro pai saber QUEM está sendo enviado. Aqui ela ganha um segundo uso:
 * é o único sinal que diz que a pessoa passou do alerta de confirmação e a mensagem
 * saiu de fato. Marcar o cartão em `onCorrigir` marcaria também quem tocou em "Mandar
 * pra Xarlote?" e desistiu no alerta — um badge afirmando uma correção que nunca houve.
 */
export const PREFIXO_CORRECAO = 'memoria:';

export function chaveDeCorrecao(id: string): string {
  return `${PREFIXO_CORRECAO}${id}`;
}

/** O id do cartão dentro da chave em voo, ou `null` quando o que está em voo é outra coisa. */
export function idDaCorrecao(chave: string | null | undefined): string | null {
  if (!chave || !chave.startsWith(PREFIXO_CORRECAO)) return null;
  const id = chave.slice(PREFIXO_CORRECAO.length);
  return id.length > 0 ? id : null;
}

// ─── Busca ─────────────────────────────────────────────────────────────────────

/**
 * Acima deste total, a memória ganha campo de busca. Abaixo, rolar é mais rápido do
 * que digitar — e um campo vazio a mais é uma decisão a mais pra quem só quer olhar.
 */
export const LIMIAR_BUSCA = 12;

/**
 * Filtra por texto e por tag, sem caixa e sem acento. Termo vazio devolve TUDO (e o
 * mesmo array, pra não invalidar `memo` de lista à toa).
 */
export function filtrarMemoria(cards: readonly MemoryCard[], termo: string): MemoryCard[] {
  const alvo = dobrar(termo);
  if (alvo.length === 0) return cards as MemoryCard[];
  return cards.filter((c) => {
    if (dobrar(c.text).includes(alvo)) return true;
    return (c.tags ?? []).some((t) => dobrar(t).includes(alvo));
  });
}

// ─── Recorte com contador ──────────────────────────────────────────────────────

/** Quantos cards a seção mostra ao abrir, antes do "ver todos". */
export const TETO_ABERTO = 5;

/**
 * A identidade de uma seção na tela — e ela **inclui o modo**.
 *
 * A lista de "Fatos sobre você" filtrada por "losartana" e a lista inteira de "Fatos
 * sobre você" são duas listas diferentes com o mesmo `kind`. Quando o "ver todas (7)"
 * da filtrada guardava o estado só sob `kind`, ele ligava o mesmo interruptor da lista
 * completa: apagar a busca devolvia 40 cartões de vidro de uma vez, num `ScrollView`
 * sem virtualização, sem nenhum "ver todas" à vista pra desfazer — exatamente a rolagem
 * que este bloco foi escrito pra matar, reintroduzida por um toque numa lista de 7.
 *
 * A chave de estado e a `key` de remontagem passam a ser a MESMA coisa, por isso ela
 * mora aqui e não inline no JSX: duas expressões que precisam concordar sempre são uma
 * expressão que concorda por acaso.
 */
export function chaveDeSecao(kind: string, buscando: boolean): string {
  return `${kind}:${buscando ? 'busca' : 'tudo'}`;
}

/**
 * O recorte da lista — e **quantos ficaram fora**.
 *
 * Um `slice()` mudo é proibido na constituição por um motivo prático: a pessoa não tem
 * como saber que existe mais, então o que ficou fora é indistinguível do que nunca
 * existiu. Devolver o número é o que permite escrever "ver todas (18)".
 */
export function recorte<T>(
  itens: readonly T[],
  mostrarTodos: boolean,
  teto: number = TETO_ABERTO,
): { visiveis: T[]; escondidos: number } {
  if (mostrarTodos || itens.length <= teto) {
    return { visiveis: itens as T[], escondidos: 0 };
  }
  return { visiveis: itens.slice(0, teto), escondidos: itens.length - teto };
}

// ─── Resumo ────────────────────────────────────────────────────────────────────

export interface ResumoMemoria {
  total: number;
  contados: number;
  deduzidos: number;
  semOrigem: number;
  /** Uma linha inteira, pra quem NÃO tem contador ao lado. O estado cheio DIZ o tamanho. */
  frase: string;
  /**
   * Só a procedência ("todas vindas de você", "4 são dedução minha"), pra quando o
   * total já está dito no contador do cabeçalho. Um dado é dito uma vez por tela: com
   * "· 23" no cabeçalho da seção, repetir "23 anotações" logo abaixo é ruído. Vazia
   * quando não há nada guardado — aí quem fala é o `emptyHint` da seção.
   */
  origens: string;
}

/**
 * O tamanho da memória, dito em voz alta.
 *
 * A tela antiga tinha "tudo isso influencia como eu falo com você" — verdadeiro e
 * inútil: não dizia quanto era "tudo isso". Com 80 cards no ar e nenhum número, o
 * paciente não sabe se está vendo a memória inteira ou um pedaço.
 */
export function resumoDeMemoria(cards: readonly MemoryCard[]): ResumoMemoria {
  let contados = 0;
  let deduzidos = 0;
  let semOrigem = 0;
  for (const c of cards) {
    const o = origemDoCard(c).origem;
    if (o === 'contou') contados += 1;
    else if (o === 'deduzi') deduzidos += 1;
    else semOrigem += 1;
  }

  const total = cards.length;
  if (total === 0) {
    return {
      total,
      contados,
      deduzidos,
      semOrigem,
      frase: 'ainda não guardei nada sobre você',
      origens: '',
    };
  }

  const anotacoes = total === 1 ? '1 anotação' : `${total} anotações`;
  const origens =
    deduzidos === 0
      ? 'todas vindas de você'
      : deduzidos === 1
        ? '1 é dedução minha'
        : `${deduzidos} são dedução minha`;
  return { total, contados, deduzidos, semOrigem, frase: `${anotacoes} · ${origens}`, origens };
}

// ─── A frase da correção ───────────────────────────────────────────────────────

/**
 * Teto de cada metade da mensagem de correção.
 *
 * `POST /app/messages` aceita 4000 caracteres; o limite aqui é bem menor de propósito.
 * A mensagem precisa ser LIDA por um humano depois, no histórico do WhatsApp — e uma
 * parede de texto citado esconde justamente a parte que importa, que é a correção.
 */
export const TETO_CITACAO = 300;

/**
 * A mensagem que o app manda à Xarlote quando o paciente diz que uma anotação está
 * errada.
 *
 * ## Por que o app escreve a frase, e não o paciente
 *
 * O caminho que existe hoje é a Xarlote gravar a correção com
 * `save_user_profile_fact`. Pra ela fazer isso, a mensagem precisa CITAR a anotação
 * errada e dizer o que vale. Pedir isso a uma pessoa de 55 anos em linguagem livre é
 * transferir pra ela um trabalho de redação — e um erro de redação aqui vira memória
 * clínica errada. O app já sabe o texto exato do card: quem escreve é ele.
 *
 * A frase é 1ª pessoa do paciente porque é ele quem a envia — ela vai aparecer no
 * histórico como mensagem dele, e mensagem em nome de alguém precisa soar como aquela
 * pessoa.
 *
 * ## O fecho sem correção escrita não pede pra apagar
 *
 * Pedia, e era uma promessa sem nada atrás: não existe `DELETE /app/memory/:id`,
 * `save_user_profile_fact` escreve em `user_health_conditions`/`user_allergies`/
 * `user_medications`/`users` e nunca toca em `memory_cards_index`, e não há tool de
 * esquecer em `xarlote-tools.ts`. Uma LLM que recebe "pode tirar" e não tem a ferramenta
 * responde "pronto, tirei" — confirmação falsa sobre memória clínica, e ainda por cima
 * contradizendo o rodapé DESTA MESMA tela, que diz com todas as letras que apagar uma
 * anotação sozinha ela não sabe. O fecho pede o que ela consegue cumprir: registrar a
 * contestação na conversa. Quando o interruptor de cima virar, o texto de antes volta.
 */
export function fraseDeCorrecao(card: MemoryCard, certo: string): string {
  const errado = limitar(card.text, TETO_CITACAO);
  const correcao = limitar(certo, TETO_CITACAO);
  const abre = `Uma anotação sua sobre mim está errada: "${errado}".`;
  if (correcao.length > 0) return `${abre} O certo é: ${correcao}`;
  // `XARLOTE_SABE_ESQUECER` e não `APAGAR_CARD_DISPONIVEL`: quem lê esta frase é a LLM,
  // e ela continua sem ferramenta de esquecer mesmo agora que o BOTÃO da tela funciona.
  return XARLOTE_SABE_ESQUECER
    ? `${abre} Isso não vale mais — pode tirar.`
    : `${abre} Isso não vale mais pra mim — anota que eu te corrigi.`;
}
