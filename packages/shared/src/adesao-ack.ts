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
