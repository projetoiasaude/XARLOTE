/**
 * Datas e horas em PT-BR, no fuso do PACIENTE, sem `Intl`.
 *
 * ## Por que não usar Intl aqui
 *
 * O portão de Hermes (`shared-smoke.ts`) provou que `Intl.DateTimeFormat` com
 * `timeZone` funciona neste build — mas provar que funciona num aparelho não é o
 * mesmo que apostar toda a formatação de datas do app nisso. Estas funções são
 * puras, determinísticas e testáveis no vitest sem simulador; o mesmo raciocínio que
 * levou `packages/shared/src/adherence.ts` ao deslocamento fixo.
 *
 * O deslocamento é -03:00 fixo porque o Brasil aboliu o horário de verão em 2019.
 * Está errado para um paciente fora do fuso de Brasília — e é aceito de propósito:
 * a base é Goiânia, e o erro de um paciente viajando (uma hora no rótulo) é menor do
 * que o erro de uma dose migrar de dia no gráfico, que era o risco de calcular em UTC.
 *
 * ## Nada aqui inventa dado
 *
 * ISO inválido volta string vazia, nunca "Invalid Date" nem a data de hoje. Um rótulo
 * vazio o layout absorve; uma data errada num prontuário o paciente acredita.
 */

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
] as const;

const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'] as const;

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

/**
 * Os campos de calendário do instante NO FUSO DE BRASÍLIA.
 *
 * O truque é deslocar o instante e ler os campos em UTC: `getUTCHours()` de
 * `t - 3h` é a hora de Brasília. Ler `getHours()` daria a hora do FUSO DO APARELHO —
 * que num simulador configurado em Cupertino mostra o remédio das 8h como 4h.
 */
function partesBrt(ms: number): { ano: number; mes: number; dia: number; hora: number; min: number; semana: number } {
  const d = new Date(ms + BRT_OFFSET_MS);
  return {
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth(),
    dia: d.getUTCDate(),
    hora: d.getUTCHours(),
    min: d.getUTCMinutes(),
    semana: d.getUTCDay(),
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `AAAA-MM-DD` puro — uma coluna DATE do Postgres (`exam_date`, `birth_date`, `since`),
 * que não tem hora nem fuso: significa aquele dia do calendário, e nada mais.
 */
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ms do ISO, ou null se não der pra confiar.
 *
 * ## Data-sem-hora recebe meia-noite de BRASÍLIA, não de UTC
 *
 * `Date.parse('2026-08-01')` devolve meia-noite **UTC** — que lido com o deslocamento
 * de -03:00 vira 21h do dia 31 de JULHO. Sem esta correção, todo exame do dia 1º
 * aparecia no mês anterior, e o agrupamento da biblioteca mostrava "jul/2026" pra um
 * exame de agosto. Um teste pegou isso; no aparelho passaria como esquisitice sem
 * causa aparente.
 *
 * Somar 3h ancora a data na meia-noite de Brasília: aí a leitura deslocada devolve
 * exatamente o dia que estava escrito na coluna. ISO com hora (`timestamptz`, como
 * `next_run_at`) não passa por aqui — tem instante real e já está certo.
 */
export function msDe(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return SO_DATA.test(iso) ? ms - BRT_OFFSET_MS : ms;
}

/** 'AAAA-MM-DD' do dia de Brasília — a MESMA chave que `brDayKey` de shared/adherence. */
export function diaBrt(ms: number): string {
  const p = partesBrt(ms);
  return `${p.ano}-${pad(p.mes + 1)}-${pad(p.dia)}`;
}

/** A hora (0–23) em Brasília — pra saudação, faixa do dia, nada de rótulo. */
export function horaBrt(ms: number): number {
  return partesBrt(ms).hora;
}

/** '08:30' */
export function brHora(iso: string | null | undefined): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const p = partesBrt(ms);
  return `${pad(p.hora)}:${pad(p.min)}`;
}

/** '12/08' — sem o ano, pra rótulo curto de lista. */
export function brDiaMes(iso: string | null | undefined): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const p = partesBrt(ms);
  return `${pad(p.dia)}/${pad(p.mes + 1)}`;
}

/** '12/08/2026' */
export function brData(iso: string | null | undefined): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const p = partesBrt(ms);
  return `${pad(p.dia)}/${pad(p.mes + 1)}/${p.ano}`;
}

/** '12 de agosto de 2026' — pro cabeçalho de um exame, onde a data é o assunto. */
export function brDataLonga(iso: string | null | undefined): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const p = partesBrt(ms);
  return `${p.dia} de ${MESES[p.mes]} de ${p.ano}`;
}

/** 'ago/2026' — agrupador de exames por mês. */
export function brMesAno(iso: string | null | undefined): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const p = partesBrt(ms);
  return `${MESES_CURTOS[p.mes]}/${p.ano}`;
}

/**
 * Distância em DIAS DE CALENDÁRIO (Brasília), não em blocos de 24h.
 *
 * A diferença é o que separa "amanhã" de "em 22 horas": às 23h de hoje, o remédio das
 * 7h de amanhã está a 8 horas de distância, mas é AMANHÃ. Contar por 24h chamaria isso
 * de "hoje" e o paciente tomaria o remédio no dia errado.
 */
export function diffDiasBrt(alvoMs: number, agoraMs: number): number {
  const meiaNoite = (ms: number): number => {
    const p = partesBrt(ms);
    return Date.UTC(p.ano, p.mes, p.dia);
  };
  return Math.round((meiaNoite(alvoMs) - meiaNoite(agoraMs)) / 86_400_000);
}

/** 'hoje' | 'amanhã' | 'ontem' | 'depois de amanhã' | null (fora da janela dêitica). */
export function brDeitico(alvoMs: number, agoraMs: number): string | null {
  switch (diffDiasBrt(alvoMs, agoraMs)) {
    case 0: return 'hoje';
    case 1: return 'amanhã';
    case 2: return 'depois de amanhã';
    case -1: return 'ontem';
    default: return null;
  }
}

/**
 * Quando algo VAI acontecer, como a Xarlote falaria: 'hoje às 08:00',
 * 'amanhã às 07:30', 'sex, 22/08 às 09:00'.
 *
 * Dêitico primeiro porque é assim que se fala — ninguém diz "13/08 às 8h" pro remédio
 * de amanhã. Fora da janela de dois dias entra o dia da semana, que é o que faz a
 * pessoa se localizar sem contar no calendário.
 */
export function brQuando(iso: string | null | undefined, agoraMs: number): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const hora = brHora(iso);
  const deitico = brDeitico(ms, agoraMs);
  if (deitico) return `${deitico} às ${hora}`;
  const p = partesBrt(ms);
  return `${DIAS_SEMANA[p.semana]}, ${pad(p.dia)}/${pad(p.mes + 1)} às ${hora}`;
}

/**
 * Quanto tempo FAZ, em linguagem de conversa: 'agora', 'há 5 min', 'há 2 h',
 * 'ontem', 'há 3 dias', e daí pra frente a data seca.
 *
 * Passa a data absoluta depois de uma semana porque "há 34 dias" não diz nada a
 * ninguém — quem olha um exame de mês passado quer a data.
 */
export function brDesde(iso: string | null | undefined, agoraMs: number): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  const diff = agoraMs - ms;
  // Relógio do aparelho adiantado faz o passado parecer futuro: mostra 'agora' em vez
  // de 'em -3 min', que é o tipo de rótulo que faz o paciente desconfiar da tela toda.
  if (diff < 60_000) return 'agora';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `há ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24 && diffDiasBrt(ms, agoraMs) === 0) return `há ${horas} h`;
  const dias = -diffDiasBrt(ms, agoraMs);
  if (dias === 1) return 'ontem';
  if (dias <= 7) return `há ${dias} dias`;
  return brData(iso);
}
