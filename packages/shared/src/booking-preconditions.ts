/**
 * booking-preconditions — o que a clínica exige ANTES de a vaga existir.
 *
 * ─── POR QUE ISTO EXISTE (caso Duda, 24/08/2026) ──────────────────────────────
 * A recepção da Dra Mayra Storti mandou, junto com o horário:
 *
 *   "Para garantir seu agendamento, solicitamos um depósito de 30% do valor da
 *    consulta, correspondente a R$ 180,00. […] Ressaltamos que a reserva do horário
 *    só será confirmada após a realização do pagamento inicial. Em caso de
 *    cancelamento, o valor do andiantamento não é reembolsável."
 *
 * Tudo isso foi guardado em `consultation_quotes.notes` — texto livre que ninguém lê —
 * e o card que chegou à paciente dizia apenas `💰 R$ 600,00`. Ela ficou acreditando
 * que tinha consulta marcada sem saber que faltava um sinal de R$ 180 não reembolsável
 * pra vaga sequer existir.
 *
 * ─── A DISTINÇÃO QUE O MÓDULO FAZ ─────────────────────────────────────────────
 * Nem toda menção a dinheiro trava a reserva, e tratar as duas igual seria alarme
 * falso a cada mensagem de clínica:
 *
 *   • `deposit`       — dinheiro amarrado ao ATO DE RESERVAR. Sem ele não há vaga.
 *   • `document`      — papel exigido antes de agendar (pedido médico, guia).
 *   • `payment_terms` — como/quando se paga a CONSULTA. Informa, não trava.
 *
 * O discriminador é o vínculo com a reserva ("para garantir seu agendamento", "a
 * reserva só será confirmada após"), não a presença de um valor.
 *
 * PURO e testável: sem I/O, sem relógio. Quem decide o que fazer com isso é o
 * chamador — este módulo só lê.
 */
import { foldPt } from './br-datetime.js';

export type PreconditionKind = 'deposit' | 'document' | 'payment_terms';

export interface BookingPrecondition {
  kind: PreconditionKind;
  /** Valor em reais quando o texto informa ("R$ 180,00" → 180). */
  amountBrl: number | null;
  /** Percentual quando o texto informa ("30% do valor" → 30). */
  percent: number | null;
  /** `false` quando o texto diz que não devolve; `null` quando não fala no assunto. */
  refundable: boolean | null;
  /** O que foi exigido, em palavras da própria clínica (pedido médico, guia…). */
  item: string | null;
  /** Trecho literal que provou — auditoria e log. */
  evidence: string;
}

/**
 * Vínculo com a RESERVA. É isto que separa "pague o sinal pra eu segurar a vaga" de
 * "a consulta se paga na recepção".
 */
const VINCULO_RESERVA: RegExp[] = [
  /\b(?:para|pra)\s+(?:garantir|confirmar|reservar|efetivar|assegurar)\b/,
  /\breserva\w*\b[^.!?]{0,45}\b(?:so|somente|apenas)\b/,
  /\b(?:so|somente|apenas)\b[^.!?]{0,45}\b(?:apos|mediante|depois)\b/,
  /\b(?:agendament|marcac|reserva)\w*\b[^.!?]{0,30}\b(?:apos|mediante)\b/,
  /\b(?:antes|previamente)\b[^.!?]{0,25}\b(?:agendar|marcar|reservar)\b/,
];

/** Dinheiro que serve pra SEGURAR a vaga (não o preço da consulta em si). */
const SINAL = /\b(?:deposit|sinal|entrada|adiantament|andiantament|antecipa\w*|pre[\s-]?pagament|pagamento\s+inicial|taxa\s+de\s+reserva|caucao)\w*/;

/** Papel exigido. `andiantamento` acima e `inteiro médico` aqui saem de textos reais. */
const DOCUMENTOS: Array<[RegExp, string]> = [
  [/\bpedido\s+(?:inteiro\s+)?medic\w*|\bpedido\b[^.!?]{0,15}\bmedic\w*/, 'pedido médico'],
  [/\bencaminhament\w*/, 'encaminhamento'],
  [/\bguia\b[^.!?]{0,20}\b(?:consulta|autorizacao|plano)\b|\bguia\s+medica\b/, 'guia'],
  [/\bcarteirinha\b/, 'carteirinha do plano'],
  [/\b(?:laudo|exame)s?\s+anterior\w*/, 'exames anteriores'],
];

/** Exigência de envio — "envio de uma foto legível", "mandar o pedido". */
const EXIGE_ENVIO = /\b(?:envi\w+|mand\w+|apresent\w+|trag\w+|anex\w+|foto|copia|imagem)\b/;

/** Formas/momento de pagamento da CONSULTA — informa, não trava. */
const FORMA_PAGAMENTO = /\b(?:dinheiro|pix|cartao|credito|debito|transferencia|boleto)\b/;
const MOMENTO_PAGAMENTO = /\b(?:na\s+recepcao|antes\s+d[oa]\s+(?:inicio|consulta|atendimento)|no\s+dia\s+d[oa]\s+(?:consulta|atendimento)|apos\s+a\s+consulta)\b/;

/** "não é reembolsável", "não devolvemos", "sem devolução". */
const NAO_REEMBOLSAVEL = /\bnao\b[^.!?]{0,30}\b(?:reembols\w*|devolv\w*|restitu\w*)|\bsem\s+(?:reembolso|devolucao)\b|\bnao\s+reembolsavel\b/;

/**
 * Quebra em orações. A unidade de análise TEM que ser a frase: numa mensagem inteira,
 * "para garantir seu agendamento" (frase 1) e "pago na recepção" (frase 3) conviveriam
 * e o vínculo com a reserva grudaria na cobrança errada.
 */
export function sentencasDe(texto: string): string[] {
  return (texto ?? '')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** "R$ 180,00" / "R$1.250,50" / "180 reais" → número. `null` quando não há valor. */
export function valorEmReais(texto: string): number | null {
  const m = /\br?\$\s*([\d.]+(?:,\d{1,2})?)|\b(\d{2,6}(?:[.,]\d{2})?)\s*reais\b/i.exec(texto ?? '');
  if (!m) return null;
  const bruto = (m[1] ?? m[2] ?? '').replace(/\./g, '').replace(',', '.');
  const n = Number.parseFloat(bruto);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "30% do valor" → 30. */
export function percentualDe(texto: string): number | null {
  const m = /\b(\d{1,3})\s*%/.exec(texto ?? '');
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

function algum(folded: string, tabela: RegExp[]): boolean {
  return tabela.some((re) => re.test(folded));
}

/**
 * Lê a mensagem da clínica e devolve as pré-condições que ela impôs.
 *
 * Ordem do resultado: o que TRAVA vem antes do que só informa — quem monta a mensagem
 * ao paciente lê de cima pra baixo, e o que trava é o que ele precisa saber primeiro.
 */
export function readBookingPreconditions(text: string): BookingPrecondition[] {
  const raw = (text ?? '').trim();
  if (!raw) return [];
  const frases = sentencasDe(raw);
  const foldedTudo = foldPt(raw);

  // Reembolso é dito numa frase à parte ("Em caso de cancelamento, o valor do
  // andiantamento não é reembolsável") — vale pra mensagem toda, não pra aquela oração.
  const reembolsavel: boolean | null = NAO_REEMBOLSAVEL.test(foldedTudo) ? false : null;

  let deposito: BookingPrecondition | null = null;
  const documentos: BookingPrecondition[] = [];
  let formaPagamento: BookingPrecondition | null = null;

  for (const frase of frases) {
    const f = foldPt(frase);
    const temVinculo = algum(f, VINCULO_RESERVA);

    // 1. SINAL — dinheiro amarrado à reserva.
    if (SINAL.test(f) || (temVinculo && valorEmReais(frase) !== null)) {
      const valor = valorEmReais(frase);
      const pct = percentualDe(frase);
      if (!deposito) {
        deposito = { kind: 'deposit', amountBrl: valor, percent: pct, refundable: reembolsavel, item: null, evidence: frase.slice(0, 180) };
      } else {
        // Frases seguidas descrevem o MESMO sinal ("solicitamos 30%…" / "…só será
        // confirmada após o pagamento inicial"). Uma pré-condição, não duas.
        deposito.amountBrl ??= valor;
        deposito.percent ??= pct;
      }
      continue;
    }

    // 2. DOCUMENTO — papel exigido antes de agendar.
    const doc = DOCUMENTOS.find(([re]) => re.test(f));
    if (doc && (temVinculo || EXIGE_ENVIO.test(f))) {
      if (!documentos.some((d) => d.item === doc[1])) {
        documentos.push({ kind: 'document', amountBrl: null, percent: null, refundable: null, item: doc[1], evidence: frase.slice(0, 180) });
      }
      continue;
    }

    // 3. FORMA DE PAGAMENTO — informa o paciente, não trava a reserva.
    if (!formaPagamento && FORMA_PAGAMENTO.test(f) && MOMENTO_PAGAMENTO.test(f)) {
      formaPagamento = { kind: 'payment_terms', amountBrl: valorEmReais(frase), percent: null, refundable: null, item: null, evidence: frase.slice(0, 180) };
    }
  }

  return [...(deposito ? [deposito] : []), ...documentos, ...(formaPagamento ? [formaPagamento] : [])];
}

/**
 * `true` quando alguma pré-condição impede a vaga de existir.
 *
 * É o predicado que separa "sua consulta está marcada" de "a clínica segura esse
 * horário assim que você pagar o sinal" — a diferença entre a Duda ir ao consultório
 * e a Duda descobrir na porta que não havia reserva nenhuma.
 */
export function blocksReservation(pcs: readonly BookingPrecondition[]): boolean {
  return pcs.some((p) => p.kind === 'deposit' || p.kind === 'document');
}

/** Valor do sinal em reais — do valor explícito ou do percentual sobre o preço. */
export function valorDoSinal(pc: BookingPrecondition, precoConsulta: number | null): number | null {
  if (pc.amountBrl != null) return pc.amountBrl;
  if (pc.percent != null && precoConsulta != null) return Math.round(precoConsulta * pc.percent) / 100;
  return null;
}

function reais(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

/**
 * Linhas em PT-BR pro paciente. Uma por pré-condição, na voz da Xarlote — curtas,
 * sem jargão, e dizendo a consequência (o que trava) em vez de só descrever o fato.
 */
export function describePreconditionsForPatient(
  pcs: readonly BookingPrecondition[],
  precoConsulta: number | null = null,
): string[] {
  const linhas: string[] = [];
  for (const pc of pcs) {
    if (pc.kind === 'deposit') {
      const v = valorDoSinal(pc, precoConsulta);
      const quanto = v != null
        ? `${reais(v)}${pc.percent != null ? ` (${pc.percent}% do valor)` : ''}`
        : pc.percent != null ? `${pc.percent}% do valor` : 'um sinal';
      const devolve = pc.refundable === false ? ' Esse valor **não é devolvido** se você cancelar.' : '';
      linhas.push(`⚠️ A clínica só segura o horário depois de um sinal de ${quanto}.${devolve}`);
    } else if (pc.kind === 'document') {
      linhas.push(`⚠️ Eles só agendam depois de receber ${pc.item ? `o seu ${pc.item}` : 'um documento seu'}.`);
    } else {
      linhas.push(`💳 ${pc.evidence}`);
    }
  }
  return linhas;
}
