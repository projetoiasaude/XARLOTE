/**
 * Esquecimento (LGPD art. 18) — a decisão de apagar TUDO, isolada e testável.
 *
 * ## O defeito que isto existe pra matar (auditoria 22/09, P0-3)
 *
 * O gatilho era `texto.toLowerCase().includes('confirmo apagar')` — sem estado, sem
 * âncora e sem negação. Três consequências, todas reais:
 *
 *   • *"não! eu não confirmo apagar nada"* **apagava o prontuário**.
 *   • `/quero sair/` estava na lista de PEDIDOS: *"quero sair de casa às 8h, me lembra?"*
 *     virava pedido de esquecimento — e, pior, o turno era engolido (o lembrete nunca
 *     era criado) porque o handler retornava ali.
 *   • Um "CONFIRMO APAGAR" solto, sem nada antes, apagava na hora.
 *
 * ## As três travas
 *
 * 1. **Âncora**: a confirmação é a frase INTEIRA (`^confirmo apagar$`, com variações
 *    curtas), depois de tirar pontuação, emoji e markdown. Nenhuma negação passa por
 *    uma âncora — "não confirmo apagar nada" simplesmente não casa.
 * 2. **Pedido pendente**: só confirma quem pediu, e há no máximo 15 minutos. Uma
 *    confirmação sem pedido não apaga: ela RE-PERGUNTA (e re-arma a janela).
 * 3. **Objeto obrigatório no pedido**: "sair" precisa de "do Xarlote/do app/do
 *    cadastro"; "apagar" precisa de "meus dados/minha conta". Sair de casa, apagar a
 *    luz e cancelar a consulta seguem o turno normal.
 *
 * Direção do erro, escolhida de propósito: **não apagar é recuperável** (a pessoa pede
 * de novo); **apagar errado não é**. Toda dúvida cai em "pergunta de novo".
 */

/** Quanto tempo um pedido fica de pé esperando o "CONFIRMO APAGAR". */
export const JANELA_DE_CONFIRMACAO_MS = 15 * 60_000;

export type MotivoDaPergunta =
  /** A pessoa pediu pra apagar: perguntamos pra ela confirmar. */
  | 'pediu'
  /** Mandou a frase de confirmação sem ter pedido antes (ou depois de reiniciarmos). */
  | 'confirmou_sem_pedido'
  /** Pediu, mas a confirmação chegou depois da janela — o pedido esfriou. */
  | 'confirmou_tarde';

export type DecisaoDeEsquecimento =
  | { acao: 'perguntar'; motivo: MotivoDaPergunta }
  | { acao: 'apagar' }
  /** Nada a ver com apagamento — o turno segue normal (inclusive virando lembrete). */
  | { acao: 'seguir' };

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Só as palavras: tira pontuação, emoji, asterisco de markdown e espaço repetido.
 * É o que faz `*CONFIRMO APAGAR!!*` casar com a âncora sem afrouxá-la.
 */
function soFala(s: string): string {
  return fold(s).replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A frase INTEIRA, com as variações que uma pessoa realmente digita. */
const CONFIRMACAO =
  /^(sim|isso|ok|ta bom|esta bom|claro|pode)?[\s]*confirmo apagar( tudo| tudo mesmo| meus dados| meus dados mesmo| minha conta)?$/;

/** Palavras que invertem a intenção. Perto do verbo, mandam mais que o verbo. */
const NEGACAO = /\b(nao|nunca|jamais|nem|nada)\b/;

/**
 * Pedidos de esquecimento. Todo padrão exige OBJETO — é o que separa "quero sair do
 * app" de "quero sair de casa às 8h", que era lido como pedido de apagamento.
 */
/** Conjugações que a pessoa realmente usa: "apaga", "apague", "apagar", "apaguem". */
const VERBO_APAGAR = '(esquec(er|a|e)|apag(ar|a|ue|uem)|delet(ar|a|e)|exclu(ir|a|i)|remov(er|a|e))';

const PEDIDOS: RegExp[] = [
  new RegExp(`\\b${VERBO_APAGAR}\\s+(todos?\\s+|tudo\\s+)?(o\\s+|a\\s+|os\\s+|as\\s+)?(meus?|minhas?)\\s+(dados|informacoes|registros|historico|historicos|prontuario)\\b`),
  // "apaga tudo que você sabe sobre mim" / "apaga tudo sobre mim" — sem a palavra "dados".
  new RegExp(`\\b${VERBO_APAGAR}\\s+tudo\\s+(que\\s+(voce|vc)\\s+(sabe|tem|guardou?)\\s+)?(sobre|de)\\s+mim\\b`),
  /\b(apag[ae]r?|delet[ae]r?|exclu[ai]r?|cancel[ae]r?|encerr[ae]r?|derrub[ae]r?)\s+(a\s+|o\s+|meu\s+|minha\s+)*(conta|cadastro|perfil)\b/,
  /\brevog[ao]r?\s+(o\s+)?(meu\s+)?consentimento\b/,
  /\b(quero|queria|gostaria de|desejo|preciso)\s+sair\s+d[oa]s?\s+(xarlote|app|aplicativo|servico|programa|sistema|plataforma|cadastro)\b/,
  /\b(quero|queria|desejo)\s+ser\s+esquecid[oa]\b/,
  /\bdireito\s+ao\s+esquecimento\b/,
];

/** Há negação nas ~5 palavras antes do trecho que casou? Então não é pedido. */
function negadoAntes(texto: string, indiceDoCasamento: number): boolean {
  const antes = texto.slice(0, indiceDoCasamento).trim().split(/\s+/).slice(-5).join(' ');
  return NEGACAO.test(antes);
}

/** A pessoa está PEDINDO pra ser esquecida? (não apaga nada — só faz perguntar) */
export function pediuEsquecimento(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const t = soFala(texto);
  if (!t) return false;
  for (const padrao of PEDIDOS) {
    const m = padrao.exec(t);
    if (m && !negadoAntes(t, m.index)) return true;
  }
  return false;
}

/** O texto é a confirmação exata? (a âncora — nenhuma negação sobrevive a ela) */
export function confirmouEsquecimento(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return CONFIRMACAO.test(soFala(texto));
}

/**
 * A decisão completa.
 *
 * `pedidoPendenteEm` é quando o pedido foi registrado (ms), ou `null` se não há —
 * inclusive quando o Redis está fora, e aí a resposta certa é perguntar de novo, não
 * apagar por otimismo.
 */
export function decidirEsquecimento(
  texto: string | null | undefined,
  pedidoPendenteEm: number | null,
  agora: number = Date.now(),
): DecisaoDeEsquecimento {
  if (confirmouEsquecimento(texto)) {
    if (pedidoPendenteEm === null) return { acao: 'perguntar', motivo: 'confirmou_sem_pedido' };
    if (agora - pedidoPendenteEm > JANELA_DE_CONFIRMACAO_MS) {
      return { acao: 'perguntar', motivo: 'confirmou_tarde' };
    }
    return { acao: 'apagar' };
  }
  if (pediuEsquecimento(texto)) return { acao: 'perguntar', motivo: 'pediu' };
  return { acao: 'seguir' };
}

/** A pergunta, honesta sobre o que vai acontecer e sobre o prazo. */
export function mensagemDeConfirmacaoDeEsquecimento(motivo: MotivoDaPergunta): string {
  const base =
    'Pra confirmar que você quer apagar TUDO que eu guardo sobre você — conversas, lembretes, exames e histórico — responde exatamente *CONFIRMO APAGAR*. Isso é irreversível e não tem volta 💙';
  if (motivo === 'confirmou_tarde') {
    return `Esse pedido já passou do prazo (guardo por 15 minutos, por segurança). ${base}`;
  }
  if (motivo === 'confirmou_sem_pedido') {
    return `Só pra eu ter certeza de que não foi sem querer: ${base}`;
  }
  return `Entendido. ${base}`;
}
