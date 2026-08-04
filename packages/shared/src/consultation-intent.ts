/**
 * consultation-intent — detecta que o paciente PEDIU uma consulta, para que a intenção
 * exista como ESTADO e não só como texto na conversa. PURO e testável.
 *
 * ─── POR QUE ISTO EXISTE (auditoria 04/08, caso Glauber) ──────────────────────
 * Transcrição real de produção:
 *
 *   01/08 Glauber: "quero marcar uma consulta"
 *   01/08 Xarlote: "É pra qual especialidade?"
 *   01/08 Glauber: "Cardiologista"
 *   01/08 Xarlote: "É em Goiânia mesmo? E vai usar algum plano de saúde ou é particular?"
 *   02/08 Glauber: "Não precisa"
 *   02/08 Xarlote: "Tá certo, então deixo pra lá?"
 *
 * `start_consultation_search` NUNCA foi chamada. E aí está o ponto que importa: **nunca
 * existiu linha em `consultations`**, então nenhum dos vigilantes do sistema — que todos
 * varrem tabela — podia ver aquela intenção morrer. Ela era invisível por construção.
 *
 * Já corrigimos os dois gatilhos (ambiguidade não encerra mais; a busca abre com só a
 * especialidade). Mas gatilho é sintoma. A raiz é que **um pedido do paciente só passa a
 * ser vigiável quando vira registro**, e entre o pedido e o registro havia uma janela de
 * conversa onde ele podia se perder para sempre.
 *
 * Este módulo fecha essa janela: se o paciente pediu e nada foi registrado, o runtime
 * marca a intenção como ABERTA. Daí em diante o prompt fala dela em todo turno e um
 * worker a cobra — sem depender de o modelo ter lembrado de chamar a tool.
 *
 * Conservador de propósito: falso positivo aqui custa uma pergunta ("você quer que eu
 * procure?"); falso negativo custa o evento mais escasso do produto.
 */
import { foldPt } from './br-datetime.js';

/** Verbos/expressões com que um paciente pede consulta. */
const PEDIDO = [
  /\b(quero|queria|gostaria|preciso|precisava|pretendo|desejo)\b/,
  /\b(pode|poderia|consegue|conseguiria|da|d[aá]|tem como|teria como)\b[^.!?]{0,18}\b(marcar|agendar|achar|procurar|encontrar|ver)\b/,
  /\bme (ajuda|ajudaria|ajude)\b/,
  /\b(procura|procure|acha|ache|marca|marque|agenda|agende|v[eê])\b/,
  /\bestou (procurando|buscando|querendo)\b/,
  /\bto (procurando|buscando|querendo)\b/,
];

/** O OBJETO do pedido: consulta / médico / especialista. */
const OBJETO = [
  /\bconsulta(s)?\b/,
  /\bm[eé]dic[oa](s)?\b/,
  /\bespecialista\b/,
  /\bdoutor(a)?\b/,
  /\bdr\.?\b/,
  /\bprofissional de sa[uú]de\b/,
  // Profissão/área: qualquer "-logista", "-logia", "-iatra", "-pedista"
  /\b\w{4,}(logista|logia|iatra|pedista|cirurgi[ãa]o|nutricionista|fisioterapeuta)\b/,
];

/** Sufixos que identificam uma especialidade solta ("Cardiologista", "reumatologia"). */
const SUFIXO_ESPECIALIDADE = /\b(\w{4,}(?:logista|logia|iatra|pedista))\b|\b(cl[ií]nico geral|clinico geral|nutricionista|fisioterapeuta|cirurgi[ãa]o)\b/;

/** Contextos que NÃO são pedido de consulta, mesmo casando os padrões acima. */
const NAO_E_PEDIDO = [
  /\b(rem[eé]dio|medicamento|farm[aá]cia|comprimido|caixa|receita|gen[eé]rico)\b/, // fluxo de FARMÁCIA
  /\bj[aá] (marquei|tenho|consultei|fui)\b/,
  /\b(cancela|cancelar|desmarcar|desmarca)\b/,
  /\bexame(s)?\b/, // exame é outro fluxo
];

export interface ConsultationIntentHit {
  /** Especialidade dita, se identificável no texto. `null` = pediu sem dizer qual. */
  specialty: string | null;
  /** Trecho que gerou o hit — vai pro log e pro prompt, nunca inventado. */
  evidence: string;
}

/**
 * O paciente está pedindo uma consulta nesta mensagem?
 *
 * Duas formas de casar:
 *   1. PEDIDO + OBJETO  → "quero marcar uma consulta", "preciso de um cardiologista"
 *   2. ESPECIALIDADE SOLTA → "Cardiologista" (a resposta do Glauber a "qual especialidade?").
 *      Só vale para mensagem CURTA: num texto longo, um nome de especialidade solto
 *      geralmente é contexto ("meu cardiologista disse que…"), não pedido.
 */
export function detectConsultationIntent(text: string): ConsultationIntentHit | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const f = foldPt(raw);

  if (NAO_E_PEDIDO.some((re) => re.test(f))) return null;

  const temPedido = PEDIDO.some((re) => re.test(f));
  const temObjeto = OBJETO.some((re) => re.test(f));
  const esp = SUFIXO_ESPECIALIDADE.exec(f);
  const curta = f.split(/\s+/).length <= 4;

  if (temPedido && temObjeto) {
    return { specialty: esp ? (esp[1] ?? esp[2] ?? null) : null, evidence: raw.slice(0, 90) };
  }
  if (curta && esp) {
    return { specialty: esp[1] ?? esp[2] ?? null, evidence: raw.slice(0, 90) };
  }
  return null;
}

/** Estado da intenção aberta, guardado em `users.metadata.open_consultation_intent`. */
export interface OpenConsultationIntent {
  specialty: string | null;
  /** ISO de quando o paciente pediu. */
  at: string;
  /** Quantas vezes já cobramos — o freio contra virar perseguição. */
  nudged: number;
  /** ISO da última cobrança, se houve. */
  last_nudge_at?: string;
  evidence?: string;
}

/** Quantas cobranças no máximo antes de encerrar por silêncio. */
export const INTENT_MAX_NUDGES = 2;
/** Só cobra depois deste tempo desde o pedido (ou desde a última cobrança). */
export const INTENT_NUDGE_AFTER_MS = 6 * 60 * 60_000;

/**
 * Devemos cobrar esta intenção agora? PURO.
 *
 * `null` = não cobrar; o motivo sai no `reason` para o log ser legível.
 */
export function shouldNudgeIntent(
  intent: OpenConsultationIntent | null | undefined,
  nowMs: number,
  opts: { hasLiveConsultation: boolean; quietHours: boolean },
): { nudge: boolean; reason: string } {
  if (!intent) return { nudge: false, reason: 'sem intenção aberta' };
  if (opts.hasLiveConsultation) return { nudge: false, reason: 'já existe consulta viva — a intenção foi atendida' };
  if (opts.quietHours) return { nudge: false, reason: 'quiet hours' };
  if (intent.nudged >= INTENT_MAX_NUDGES) return { nudge: false, reason: `já cobrado ${intent.nudged}× — para de insistir` };

  const ancora = Date.parse(intent.last_nudge_at ?? intent.at);
  if (!Number.isFinite(ancora)) return { nudge: false, reason: 'âncora de tempo inválida' };
  // O intervalo CRESCE: a 2ª cobrança espera o dobro da 1ª. Insistir no mesmo ritmo é o
  // que transforma follow-up em incômodo.
  const espera = INTENT_NUDGE_AFTER_MS * (intent.nudged + 1);
  if (nowMs - ancora < espera) return { nudge: false, reason: 'ainda dentro da janela de espera' };

  return { nudge: true, reason: `intenção aberta há ${Math.round((nowMs - Date.parse(intent.at)) / 3_600_000)}h, cobrança ${intent.nudged + 1}` };
}
