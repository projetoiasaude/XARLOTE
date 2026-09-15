/**
 * adherence-guard — um "tomei" confirma o lembrete que TOCOU, não o que o modelo escolheu.
 *
 * ─── O QUE ACONTECEU (Glauber, 04/09/2026, 07:40) ───────────────────────────────
 * 07:00  lembrete: "Hora do Esomeprazol em jejum. Já tomou?"
 * 07:40  ele: "Tomei"        → log_medication_taken(Esomeprazol)          ✔ certo
 * 07:40  ele: "Tomei" (de novo, 19 s depois)
 *        → log_medication_taken(Esomeprazol)                              ✘ duplicado
 *        → log_medication_taken("Domperidona 10mg (jantar)")              ✘ às 07:40 da MANHÃ
 * O segundo "Tomei" era só o dedo escorregando. O modelo, sem nada pendente da manhã,
 * atribuiu a confirmação à próxima dose da lista — a do JANTAR, doze horas no futuro — e
 * a Xarlote respondeu "Esomeprazol e Domperidona do jantar marcados como tomados ✅".
 * Às 20:02 a dose do jantar foi registrada DE NOVO (a de verdade). Três linhas falsas de
 * adesão em um dia, no prontuário de um paciente oncológico.
 *
 * ─── AS DUAS REGRAS ──────────────────────────────────────────────────────────────
 * 1. RESPOSTA NUA confirma o que TOCOU. Se o paciente não NOMEOU o remédio ("tomei",
 *    "sim", "ok"), a dose só pode ser de um lembrete que disparou há pouco e ainda não foi
 *    confirmado. Um lembrete que não tocou nas últimas horas NÃO recebe essa confirmação
 *    — enquanto existir outro que tocou. Se ele NOMEOU ("tomei a domperidona do jantar,
 *    vou sair"), a palavra dele vence: registra, em qualquer horário.
 * 2. A MESMA DOSE NÃO ENTRA DUAS VEZES. Registro do mesmo remédio, com o mesmo status,
 *    há menos de 30 minutos, é a mesma dose. A segunda chamada vira "já estava anotado".
 *
 * PURO: recebe o que o banco sabe e devolve a decisão + a frase que o modelo lê. Quem
 * grava é o handler; quem decide é isto — e isto é testável sem banco.
 */
import { foldPt } from './br-datetime.js';

export interface LembreteParaDose {
  id: string;
  title: string;
  type: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_confirmed_at: string | null;
  medication_id?: string | null;
}

export interface RegistroDeDoseRecente {
  status: string;
  created_at: string;
}

export type DecisaoDeDose =
  | { acao: 'registrar'; lembrete: LembreteParaDose | null; ocorrenciaIso: string | null; nota: string | null }
  | { acao: 'recusar'; motivo: string }
  | { acao: 'ja_registrado'; nota: string };

/** Janela em que um disparo ainda "está pendente" de confirmação. */
export const JANELA_DISPARO_MS = 6 * 60 * 60_000;
/** Duas confirmações do mesmo remédio dentro disto são a MESMA dose. */
export const JANELA_DUPLICATA_MS = 30 * 60_000;
/**
 * Até quando um "tomei" ainda se refere ao ÚLTIMO disparo (e não a "agora"). A Vossa confirma a
 * Venlafaxina das 21h às 06:12 do dia seguinte: a dose é a das 21h, não uma das 06:12 (14/09).
 * Meio dia: além disso, o disparo é da rodada anterior e o "tomei" é uma dose nova.
 */
export const JANELA_OCORRENCIA_MS = 12 * 60 * 60_000;

const TOKEN_DE_DOSE = /^\d+(?:[.,]\d+)?(?:mg|mcg|ml|g|ui|%)?$/;

/** Palavras "de nome" do remédio: ≥4 letras e que não sejam dosagem nem rótulo de horário. */
function palavrasDoNome(nome: string): string[] {
  return foldPt(nome)
    .replace(/\([^)]*\)/g, ' ') // "(jantar)", "(almoço)" são rótulos de horário, não nome
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !TOKEN_DE_DOSE.test(w));
}

/**
 * O paciente NOMEOU este remédio na fala dele? Uma palavra da fala com 4+ letras que seja
 * prefixo de uma palavra do nome (ou o contrário) basta: "dompe" ↔ "domperidona",
 * "esomeprazol" ↔ "esomeprazol magnesico". Rótulo de horário e dosagem não contam.
 */
export function textoMencionaRemedio(texto: string | null | undefined, nome: string): boolean {
  const tokens = foldPt(texto ?? '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !TOKEN_DE_DOSE.test(w));
  if (!tokens.length) return false;
  const nomes = palavrasDoNome(nome);
  return nomes.some((w) => tokens.some((tok) => w.startsWith(tok) || tok.startsWith(w)));
}

function casaTitulo(titulo: string, nome: string): boolean {
  const a = foldPt(titulo).trim();
  const b = foldPt(nome).trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // "Domperidona 10mg (jantar)" ↔ "Domperidona" — a palavra-chave do nome está no título.
  const pal = palavrasDoNome(nome);
  return pal.length > 0 && pal.every((w) => a.includes(w));
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function hhmm(iso: string | null | undefined, tz: string): string | null {
  const t = ms(iso);
  if (t == null) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

/** Disparou dentro da janela e ainda não foi confirmado desde esse disparo. */
function pendenteDeConfirmacao(r: LembreteParaDose, agoraMs: number): boolean {
  const run = ms(r.last_run_at);
  if (run == null || agoraMs - run > JANELA_DISPARO_MS || run > agoraMs + 60_000) return false;
  const conf = ms(r.last_confirmed_at);
  return conf == null || conf < run;
}

export function decidirRegistroDeDose(input: {
  nomeInformado: string;
  status: 'taken' | 'skipped' | 'snoozed';
  textoDoPaciente: string | null | undefined;
  lembretes: LembreteParaDose[];
  registroRecente: RegistroDeDoseRecente | null;
  agora?: Date;
  tz?: string;
}): DecisaoDeDose {
  const agora = (input.agora ?? new Date()).getTime();
  const tz = input.tz ?? 'America/Sao_Paulo';
  const nome = (input.nomeInformado ?? '').trim();

  // Regra 2 primeiro: a duplicata é a mesma dose, seja qual for o lembrete.
  const rec = input.registroRecente;
  const recMs = ms(rec?.created_at);
  if (rec && recMs != null && rec.status === input.status && agora - recMs <= JANELA_DUPLICATA_MS) {
    const quando = hhmm(rec.created_at, tz);
    return {
      acao: 'ja_registrado',
      nota: `"${nome}" já estava registrado${quando ? ` às ${quando}` : ' há poucos minutos'} — NÃO dupliquei. Se o paciente repetiu a confirmação, responda que já está anotado; não registre de novo.`,
    };
  }

  const candidatos = input.lembretes.filter((r) => casaTitulo(r.title, nome));
  // Entre vários com o mesmo nome (almoço/jantar), o que tocou por último é o que ele confirma.
  const alvo = candidatos.sort((a, b) => (ms(b.last_run_at) ?? 0) - (ms(a.last_run_at) ?? 0))[0] ?? null;

  const nomeou = textoMencionaRemedio(input.textoDoPaciente, nome);
  const alvoTocou = alvo ? pendenteDeConfirmacao(alvo, agora) || (ms(alvo.last_run_at) != null && agora - (ms(alvo.last_run_at) as number) <= JANELA_DISPARO_MS) : false;
  const outrosQueTocaram = input.lembretes.filter((r) => r.id !== alvo?.id && pendenteDeConfirmacao(r, agora));

  // Regra 1: resposta nua + alvo que não tocou + outro que tocou = atribuição errada.
  if (!nomeou && alvo && !alvoTocou && outrosQueTocaram.length > 0) {
    const proximo = hhmm(alvo.next_run_at, tz);
    const lista = outrosQueTocaram.map((r) => `"${r.title}"`).join(', ');
    return {
      acao: 'recusar',
      motivo: `NÃO registrei "${nome}": esse lembrete não tocou nas últimas horas${proximo ? ` (o próximo é às ${proximo})` : ''}. O paciente respondeu só "${(input.textoDoPaciente ?? '').trim().slice(0, 40)}" — uma confirmação sem nome de remédio vale pro lembrete que ACABOU de tocar: ${lista}. Registre esse(s) com log_medication_taken, ou pergunte qual remédio ele quis dizer. Não diga que registrou "${nome}".`,
    };
  }

  // Registra. A ocorrência confirmada é o disparo recente do alvo (quando houve).
  const runMs = ms(alvo?.last_run_at);
  const ocorrenciaIso = alvo && runMs != null && agora - runMs <= JANELA_OCORRENCIA_MS ? new Date(runMs).toISOString() : null;
  return { acao: 'registrar', lembrete: alvo, ocorrenciaIso, nota: null };
}
