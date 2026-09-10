/**
 * reminder-guards — as decisões PURAS que ficam entre um lembrete e o paciente.
 *
 * ─── AUDITORIA 07→10/09/2026: CINCO DEFEITOS, UMA FAMÍLIA ───────────────────────────
 * Todos nasceram do mesmo jeito: o modelo mandou um campo, e o servidor ou o honrou sem
 * critério (`all: true` apagando o prontuário), ou o descartou em silêncio (`BYMINUTE=30,0`
 * virando 30), ou aceitou uma segunda cópia sem avisar (três Nimesulidas). Nenhum era "código
 * faltando": era código que NÃO PERGUNTAVA. Este arquivo é onde as perguntas passam a ser
 * feitas — puro, sem I/O, testável com os casos reais.
 *
 *   1. `pediuCancelarTudo`     — "cancelar todos" só com a FALA do paciente pedindo todos
 *                                 (Glauber perdeu 4 medicações por um `all: true` que ele
 *                                 nunca pediu, 08 e 09/09)
 *   2. `ehRruleComListaDeMinutos` — dois horários com minutos diferentes NÃO cabem num rrule
 *                                 ("11h30 e 20h" virou 20h30, 09/09)
 *   3. `agruparDuplicatasDeDisparo` — mesmo paciente, mesmo título, mesmo minuto = UMA
 *                                 mensagem (duas Nimesulidas às 20:00:31 e 20:00:34, 08/09)
 *   4. `shouldPauseRoutineSilent` — rotina não-clínica para quem está mudo há 7 dias
 *                                 (Ciro: 16 mensagens de creatina, zero respostas, 02→10/09)
 *   5. `consertarConfusiveis`    — "Cansei os lembretes" é "Cancelei" (saiu duas vezes, 08 e
 *                                 09/09; é palavra real, nenhum corretor pega)
 */
import { foldPt } from './br-datetime.js';

// ─── 1. cancelar TUDO exige que o paciente tenha pedido TUDO ─────────────────────────

/** "todo dia", "todos os dias" são HORÁRIO, não pedido de apagar tudo — saem antes. */
const AGENDA_RE = /\btod[oa]s?\s+(?:os\s+|as\s+)?dias?\b|\btoda\s+(?:manh[aã]|noite|tarde|semana)\b/g;
const TUDO_RE = /\b(?:todos?|todas?|tudo|geral)\b/;
const VERBO_DE_PARAR_RE = /\b(?:cancel\w*|par[ae]r?\b|para\b|apag\w*|desativ\w*|tir[ae]r?\b|remov\w*|deslig\w*|encerr\w*|exclu\w*|delet\w*)/;
const NENHUM_RE = /\bn[aã]o\s+quero\s+(?:mais\s+)?(?:nenhum|lembrete)|\bnenhum\s+lembrete|\bsem\s+lembrete\s+nenhum/;

/**
 * O paciente pediu, com as PRÓPRIAS palavras, para cancelar TODOS os lembretes?
 * É a mesma escola do gate de consentimento do laboratório: a prova é a fala dele, não a
 * afirmação do modelo. "Cancela todos os meus lembretes" → sim. "Me lembra todo dia às 8h"
 * → não (é agenda). "Tenho de tomar 12 comprimidos…" → não (foi o caso real).
 */
export function pediuCancelarTudo(texto: string | null | undefined): boolean {
  const t = foldPt(texto ?? '').replace(AGENDA_RE, ' ');
  if (!t.trim()) return false;
  if (NENHUM_RE.test(t)) return true;
  return TUDO_RE.test(t) && VERBO_DE_PARAR_RE.test(t);
}

// ─── 2. dois horários com minutos diferentes = dois lembretes ────────────────────────

/** `BYMINUTE=30,0` — lista de minutos. Em RFC 5545 é produto cartesiano com BYHOUR. */
export function ehRruleComListaDeMinutos(rrule: string | null | undefined): boolean {
  return /BYMINUTE=\d+\s*,/i.test(rrule ?? '');
}

// ─── 3. mesmo paciente + mesmo título + mesmo minuto = uma mensagem ──────────────────

export interface DisparoPendente {
  id: string;
  user_id: string;
  title: string | null;
  next_run_at: string;
  created_at?: string | null;
}

/**
 * Devolve `duplicata → dono`: quem NÃO deve mandar a própria mensagem porque outro lembrete
 * idêntico do mesmo paciente já vai sair no mesmo minuto. O dono é o mais antigo (foi o que
 * o paciente pediu primeiro; os outros são cópias que o modelo criou sem cancelar).
 *
 * Só título IGUAL (dobrado). "Venlafaxina" e "Venlafaxina (reforço 21h30)" são coisas
 * diferentes de propósito; "Nimesulida 100mg" três vezes é o defeito.
 */
export function agruparDuplicatasDeDisparo(due: readonly DisparoPendente[]): Map<string, string> {
  const grupos = new Map<string, DisparoPendente[]>();
  for (const r of due) {
    const titulo = foldPt(r.title ?? '').replace(/\s+/g, ' ').trim();
    if (!titulo) continue;
    const minuto = Math.floor(new Date(r.next_run_at).getTime() / 60_000);
    if (!Number.isFinite(minuto)) continue;
    const chave = `${r.user_id}|${titulo}|${minuto}`;
    const g = grupos.get(chave) ?? [];
    g.push(r);
    grupos.set(chave, g);
  }
  const duplicataDe = new Map<string, string>();
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    const ordenado = [...g].sort((a, b) => {
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ca - cb || a.id.localeCompare(b.id);
    });
    const dono = ordenado[0]!;
    for (const r of ordenado.slice(1)) duplicataDe.set(r.id, dono.id);
  }
  return duplicataDe;
}

// ─── 4. rotina não-clínica pausa quando a pessoa some ────────────────────────────────

/** Dias de silêncio a partir dos quais lembrete de ROTINA (não remédio/consulta) pausa. */
export const ROUTINE_SILENT_PAUSE_DAYS = 7;

/**
 * Pausar o envio deste lembrete porque o paciente está mudo há dias?
 *
 * Só rotina (creatina, whey, água, loção…): remédio e consulta NUNCA pausam por silêncio —
 * a não-entrega deles é o que exige alerta, não pausa. Só recorrente: um aviso único que não
 * chegou tem o próprio caminho de re-tentativa. A retomada é automática: no instante em que
 * a pessoa responder, `silentDays` cai e a condição some — nada precisa ser "despausado".
 */
export function shouldPauseRoutineSilent(args: {
  recurring: boolean;
  critical: boolean;
  silentDays: number;
  pauseAfterDays?: number;
}): boolean {
  if (!args.recurring || args.critical) return false;
  if (!Number.isFinite(args.silentDays)) return true; // nunca falou por WhatsApp = mudo desde sempre
  return args.silentDays >= (args.pauseAfterDays ?? ROUTINE_SILENT_PAUSE_DAYS);
}

/**
 * O ÚNICO aviso antes da pausa — vai como variável de template (sem quebra de linha, ≤300).
 * Diz o que pausa, por quê, e como volta. Nunca culpa.
 */
export function avisoDePausaPorSilencio(titulo: string): string {
  const t = (titulo ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'seus lembretes';
  return `Percebi que você não tá respondendo os lembretes de ${t}, então vou dar uma pausa neles pra não te encher. Quando quiser voltar, é só me mandar um oi aqui que eu retomo na hora 💙`;
}

// ─── 5. confusíveis que nenhum corretor pega ─────────────────────────────────────────

/**
 * Troca de letra que vira OUTRA palavra real — passa por qualquer verificação lexical.
 * Lista curta e explícita de propósito: cada entrada aqui saiu de verdade pra um paciente.
 */
const CONFUSIVEIS: Array<[RegExp, string]> = [
  // "Cansei os lembretes antigos" (Glauber, 08 e 09/09) — o modelo quis dizer "Cancelei".
  [/\bCansei\s+(?=(?:os?|as?|todos?|todas?|esse|essa|aquele|aquela)\s+lembrete)/g, 'Cancelei '],
  [/\bcansei\s+(?=(?:os?|as?|todos?|todas?|esse|essa|aquele|aquela)\s+lembrete)/g, 'cancelei '],
];

export function consertarConfusiveis(texto: string): { texto: string; reparos: string[] } {
  let t = texto ?? '';
  const reparos: string[] = [];
  for (const [re, sub] of CONFUSIVEIS) {
    if (re.test(t)) {
      t = t.replace(re, sub);
      reparos.push(`${re.source.slice(0, 20)}… → "${sub.trim()}"`);
    }
    re.lastIndex = 0;
  }
  return { texto: t, reparos };
}
