/**
 * A CONFIRMAÇÃO DE DOSE COMO O PACIENTE ESCREVE (caso Glauber, 11–12/09/2026).
 *
 * "Simmmmm" às 07:02 respondendo ao Esomeprazol: o modelo disse "Anotado ✅" e não chamou
 * tool; o backstop casava `^sim$` literal e não reconheceu a letra esticada. Nada foi
 * registrado — e a frase "Anotado" saiu mesmo assim. Às 20:00, Domperidona e Nimesulida
 * tocam juntas; "Tomei" confirmava só a mais recente (`limit(1)`).
 *
 * Aqui ficam as decisões PURAS do backstop de adesão: normalizar o ack do jeito que gente
 * escreve no WhatsApp, classificar (forte/fraco/negado), escolher TODOS os lembretes que
 * tocaram juntos, e a honestidade quando nada foi registrado.
 */

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Normaliza o texto pra casar os padrões de confirmação:
 *  - tira emoji/pontuação do fim ("Tomado!! 👍" → "Tomado");
 *  - colapsa letra esticada: 3+ iguais em qualquer lugar → 1 ("siiim" → "sim"), e 2+ iguais
 *    no FIM da palavra → 1 ("simm" → "sim", "okk" → "ok", "tomeii" → "tomei").
 *    Dupla no MEIO da palavra fica ("surra", "carro") — "tomei uma surra" continua não sendo dose.
 */
export function normalizarAck(texto: string | null | undefined): string {
  return (texto ?? '')
    .trim()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]+/gu, ' ')
    .replace(/([a-zà-ú])\1{2,}/gi, '$1')
    .replace(/([a-zà-ú])\1+(?=[^a-zà-ú]|$)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AckDeDose {
  /** Verbo de tomada de medicação ("tomei", "apliquei"…). */
  forte: boolean;
  /** Verbo genérico que só vale com coerência ("bebi", "passei", "usei"…). */
  generico: boolean;
  /** "ok"/"sim"/"feito"/"tomado" sozinhos — só vale colado ao disparo. */
  fraco: boolean;
  negado: boolean;
  objetoNaoMedicamentoso: boolean;
  /** O texto normalizado usado na classificação. */
  texto: string;
}

export function classificarAckDeDose(textoDoPaciente: string | null | undefined): AckDeDose {
  const original = (textoDoPaciente ?? '').trim();
  const t = normalizarAck(original);
  const forte = /\b(tomei|pinguei|apliquei|injetei)\b/i.test(t);
  const generico = /\b(bebi|passei|usei|coloquei)\b/i.test(t);
  const negado = /\b(n[ãa]o|nao|esqueci|ainda n|depois|daqui a pouco|vou tomar|amanh[ãa])\b/i.test(t);
  // Objeto não-medicamentoso é testado no ORIGINAL (a normalização podia mexer na palavra).
  const objetoNaoMedicamentoso = /\b(tomei|levei)\s+(um\s+)?(susto|caf[ée]|banho|sol|chuva|cerveja|vinho|refri|uma?\s+(decis[ãa]o|surra))|\bpassei\s+(mal|vergonha|raiva)|\busei\s+o\s+(app|aplicativo|site)\b/i.test(original)
    || /\b(tomei|levei)\s+(um\s+)?(susto|caf[ée]|banho|sol|chuva|cerveja|vinho|refri|uma?\s+(decis[ãa]o|surra))|\bpassei\s+(mal|vergonha|raiva)|\busei\s+o\s+(app|aplicativo|site)\b/i.test(t);
  const fraco = /^(ok(ay)?|sim|feito|pronto|tomado|tomada|blz|beleza|joia|j[óo]ia|isso|ja|j[áa] tomei|tomei sim|sim tomei|claro)[.!\s]*$/i.test(t) || /^(👍|✅)$/.test(original);
  return { forte, generico, fraco, negado, objetoNaoMedicamentoso, texto: t };
}

export interface LembreteQueTocou { id: string; last_run_at: string | null }

/**
 * Entre os lembretes disparados na janela, quais tocaram JUNTOS com o mais recente (≤3 min)?
 * "Tomei" depois de Domperidona 20:00:24 e Nimesulida 20:00:26 confirma os dois.
 */
export function lembretesQueTocaramJuntos<T extends LembreteQueTocou>(lembretes: T[], janelaMs = 3 * 60_000): T[] {
  const comHora = lembretes.filter((l) => l.last_run_at && !Number.isNaN(new Date(l.last_run_at).getTime()));
  if (!comHora.length) return [];
  const ord = [...comHora].sort((a, b) => new Date(b.last_run_at as string).getTime() - new Date(a.last_run_at as string).getTime());
  const ref = new Date(ord[0]!.last_run_at as string).getTime();
  return ord.filter((l) => ref - new Date(l.last_run_at as string).getTime() <= janelaMs);
}

/** O texto da Xarlote anuncia que REGISTROU a dose? ("Anotado ✅", "marquei", "registrei") */
export function anunciouRegistroDeDose(textoDaXarlote: string | null | undefined): boolean {
  const f = fold(textoDaXarlote ?? '');
  if (!f.trim()) return false;
  return /\b(anotad[oa]|anotei|marcad[oa]|marquei|registrad[oa]|registrei|guardei|salvei)\b/.test(f);
}

/** A honestidade quando nada foi registrado: pergunta o que registrar, em vez de fingir. */
export function falaHonestaDeDose(titulos: string[]): string {
  const lista = titulos.filter(Boolean);
  const alvo = lista.length === 1 ? `o *${lista[0]}*` : lista.length > 1 ? `${lista.slice(0, -1).map((t) => `*${t}*`).join(', ')} e *${lista[lista.length - 1]}*` : 'o remédio';
  return `Só pra eu registrar certinho: você tomou ${alvo}? Me responde *tomei* que eu marco aqui 💙`;
}

/**
 * SÓ O QUE FOI ENTREGUE TOCOU (casos Glauber e Ciro, 14–15/09/2026).
 *
 * O despachante grava o espelho do lembrete em `messages` mesmo quando o WhatsApp não aceitou
 * (`window_blocked`: janela de 24h fechada; `suppressed`: rotina pausada). O `last_run_at` do
 * lembrete avança do mesmo jeito. Pra quem lê o banco, "tocou"; pro paciente, nada chegou.
 * O Glauber respondeu "Sim" às 06:49 e a dose das 20h da véspera — que ele nunca recebeu —
 * foi registrada "antes do jantar" de manhã. O Ciro disse "sim" pra "está tudo bem por aí?"
 * e ganhou creatina e whey no prontuário.
 *
 * Aqui: dado o lembrete (last_run_at) e as mensagens de saída da conversa (created_at +
 * delivery_status), fica só o lembrete cujo espelho FOI entregue. Espelho ausente (código
 * antigo) conta como entregue — nunca some com um lembrete por falta de prova.
 */
export interface MensagemDeSaida { created_at: string; delivery_status?: string | null; content?: string | null }
export const STATUS_NAO_ENTREGUE = new Set(['window_blocked', 'suppressed', 'failed']);

/**
 * O espelho de UM lembrete é a mensagem de saída perto do disparo que FALA dele (o título
 * está no corpo: "Hora da creatina…", "…lembrar do seu remédio: Esomeprazol"). Perto no tempo
 * não basta: no Ciro, o template "faz uns dias que a gente não conversa" saiu entregue no
 * mesmo segundo em que creatina e whey saíam suprimidos (14/09 07:20). Sem espelho que fale
 * dele, vale o mais próximo no tempo; sem nada na janela, conta como entregue (código antigo).
 */
export function lembreteFoiEntregue(l: LembreteQueTocou & { title?: string | null }, saidas: MensagemDeSaida[], toleranciaMs = 90_000): boolean {
  const run = l.last_run_at ? new Date(l.last_run_at).getTime() : NaN;
  if (Number.isNaN(run)) return false;
  const janela = saidas.filter((m) => Math.abs(new Date(m.created_at).getTime() - run) <= toleranciaMs);
  if (!janela.length) return true;
  const palavras = fold(l.title ?? '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const porTitulo = palavras.length ? janela.filter((m) => { const c = fold(m.content ?? ''); return palavras.some((w) => c.includes(w)); }) : [];
  const candidatos = porTitulo.length
    ? porTitulo
    : [janela.reduce((a, b) => (Math.abs(new Date(b.created_at).getTime() - run) < Math.abs(new Date(a.created_at).getTime() - run) ? b : a))];
  return candidatos.some((m) => !STATUS_NAO_ENTREGUE.has(m.delivery_status ?? ''));
}

export function lembretesEntregues<T extends LembreteQueTocou & { title?: string | null }>(lembretes: T[], saidas: MensagemDeSaida[]): T[] {
  return lembretes.filter((l) => lembreteFoiEntregue(l, saidas));
}
