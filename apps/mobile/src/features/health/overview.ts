/**
 * O prontuário como o app o entende: os tipos de `GET /app/overview` e as derivações
 * PURAS que as telas desenham.
 *
 * ## Por que os tipos são frouxos onde são
 *
 * Os campos vêm do Postgres em `snake_case` e várias tabelas ganharam colunas ao longo
 * de nove migrations. Campos que a tela não desenha ficam de fora do tipo, e os que
 * podem faltar são `| null` — nunca obrigatórios. Um tipo apertado aqui não protege
 * nada em runtime (não há validação de schema nesta borda) e transforma coluna nova em
 * erro de compilação num app que já está publicado.
 *
 * ## O que estas funções recusam fazer
 *
 * Nenhuma delas inventa valor ausente: alergia sem gravidade não vira "leve", exame sem
 * data não vira hoje, dia sem dose não vira zero. Num prontuário, o "não sei" precisa
 * chegar à tela como não-sei — é o paciente que lê isso, e às vezes o médico dele.
 */
import { adherenceScore, adherenceSeries, type AdherenceDay, type DoseLogEntry } from '@iasaude/shared';
import { msDe } from '@/lib/br-format';

// ─── Formas cruas da resposta ───────────────────────────────────────────────────

export interface OverviewUser {
  id: string;
  full_name?: string | null;
  preferred_name?: string | null;
  phone_e164?: string | null;
  birth_date?: string | null;
  city?: string | null;
  adherence_score_30d?: number | null;
}

export interface Condition {
  id: string;
  name: string;
  icd10?: string | null;
  severity?: string | null;
  onset_date?: string | null;
  active?: boolean | null;
  notes?: string | null;
}

export interface Allergy {
  id: string;
  substance: string;
  reaction?: string | null;
  severity?: string | null;
}

/**
 * ⚠️ O nome da coluna é `medication_name`, NÃO `name`.
 *
 * Escrevi `name` na primeira versão: o typecheck passou (é campo opcional de um tipo que
 * eu mesmo declarei), o backend devolveu os 5 medicamentos certinhos, e a tela mostrou
 * cinco cartões com dosagem e SEM nome nenhum. Tipo declarado à mão sobre JSON de rede
 * não valida nada — só documenta o que eu acho que vem. `apps/web/app/app/saude/page.tsx`
 * já lia `medication_name` desde sempre; era ali que estava a resposta.
 */
export interface Medication {
  id: string;
  medication_name: string;
  active_ingredient?: string | null;
  dosage?: string | null;
  form?: string | null;
  frequency?: string | null;
  notes?: string | null;
  active?: boolean | null;
  /** `tarja_vermelha` (receita comum) | `tarja_preta` (especial) | null = venda livre. */
  controlled_class?: string | null;
  needs_prescription?: boolean | null;
  last_taken_at?: string | null;
}

export interface Treatment {
  id: string;
  name?: string | null;
  condition_id?: string | null;
  status?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  notes?: string | null;
}

export interface Prescriber {
  id: string;
  name: string;
  crm?: string | null;
  crm_state?: string | null;
  specialty?: string | null;
}

export interface ExamResult {
  id: string;
  exam_type: string;
  /** Título que o extrator deu ao laudo, quando conseguiu. */
  title?: string | null;
  /** O resumo em prosa — o campo que eu chamei de `notes` por engano. */
  summary?: string | null;
  /** JSONB livre: `{ "hemoglobina": "13,2 g/dL", ... }`, lista, ou texto do laudo. */
  findings?: unknown;
  exam_date?: string | null;
  source?: string | null;
  confidence?: number | null;
  created_at?: string | null;
}

export interface MemoryCard {
  id: string;
  kind: string;
  text: string;
  tags?: string[] | null;
  confidence?: number | null;
  source?: string | null;
  last_seen_at?: string | null;
}

export interface Symptom {
  id: string;
  name: string;
  intensity?: number | null;
  duration_hours?: number | null;
  red_flag_triggered?: boolean | null;
  created_at?: string | null;
}

export interface DoseLogRow {
  id: string;
  status: string;
  scheduled_at: string;
  responded_at?: string | null;
  medication_id?: string | null;
}

export interface ReminderRow {
  id: string;
  type?: string | null;
  title?: string | null;
  body?: string | null;
  scheduled_at?: string | null;
  rrule?: string | null;
  next_run_at?: string | null;
  status: string;
  medication_id?: string | null;
  last_confirmed_at?: string | null;
  created_at?: string | null;
}

export interface Supplier {
  id: string;
  name: string;
  address?: string | null;
  city?: string | null;
  rating?: number | null;
}

export interface Quote {
  id: string;
  status?: string | null;
  total?: number | null;
  delivery_fee?: number | null;
  eta_minutes?: number | null;
  payment_methods?: string[] | null;
  distance_km?: number | null;
  suppliers?: Supplier | null;
}

export interface Order {
  id: string;
  status: string;
  items?: unknown;
  payment_method?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  selected_quote_id?: string | null;
  quotes?: Quote[] | null;
}

export interface Clinic {
  id: string;
  name: string;
  city?: string | null;
  rating?: number | null;
}

export interface ConsultationQuote {
  id: string;
  status?: string | null;
  proposed_datetime?: string | null;
  price_brl?: number | null;
  modality?: string | null;
  notes?: string | null;
  clinics?: Clinic | null;
}

export interface Consultation {
  id: string;
  status: string;
  specialty?: string | null;
  urgency?: string | null;
  modality?: string | null;
  city?: string | null;
  scheduled_at?: string | null;
  created_at?: string | null;
  consultation_quotes?: ConsultationQuote[] | null;
}

export interface Overview {
  user: OverviewUser;
  conversationId: string | null;
  conditions: Condition[];
  allergies: Allergy[];
  medications: Medication[];
  inventory: unknown[];
  treatments: Treatment[];
  prescribers: Prescriber[];
  reminders: ReminderRow[];
  orders: Order[];
  consultations: Consultation[];
  memoryCards: MemoryCard[];
  symptoms: Symptom[];
  medicationLog: DoseLogRow[];
  examResults: ExamResult[];
}

// ─── Derivações puras ───────────────────────────────────────────────────────────

/** As linhas de log no formato que `@iasaude/shared` calcula adesão. */
export function paraDoses(log: readonly DoseLogRow[]): DoseLogEntry[] {
  return log.map((l) => ({ scheduledAt: l.scheduled_at, status: l.status }));
}

export interface AdesaoResumo {
  serie: AdherenceDay[];
  /** 0–1, ou null quando não houve NENHUMA dose registrada na janela. */
  score: number | null;
  /** Dias da janela que têm registro — o denominador honesto do gráfico. */
  diasComRegistro: number;
}

/**
 * Adesão da janela pedida, série + número, pela definição do BANCO.
 *
 * `score` sai de `adherenceScore` (doses cruas) e não da média da série: média de
 * médias pesaria igual um dia de 1 dose e um dia de 8, e daria um número diferente do
 * `users.adherence_score_30d` que a mesma tela mostra. Ver o cabeçalho de
 * `packages/shared/src/adherence.ts`.
 */
export function resumoAdesao(log: readonly DoseLogRow[], days: number, nowMs: number): AdesaoResumo {
  const doses = paraDoses(log);
  const serie = adherenceSeries(doses, { days, nowMs });
  return {
    serie,
    score: adherenceScore(doses, { days, nowMs }),
    diasComRegistro: serie.filter((d) => d.ratio !== null).length,
  };
}

export interface GrupoExames {
  /** 'ago/2026' */
  rotulo: string;
  exames: ExamResult[];
}

/**
 * Exames agrupados por mês, do mais recente pro mais antigo.
 *
 * `exam_date` pode ser null (exame extraído de foto sem data legível). Esses não são
 * descartados — vão pro fim, num grupo próprio: um exame que existe e não aparece na
 * biblioteca é pior do que um exame com data incerta.
 */
export function agruparExamesPorMes(exames: readonly ExamResult[], rotuloMes: (iso: string) => string): GrupoExames[] {
  const comData: ExamResult[] = [];
  const semData: ExamResult[] = [];
  for (const e of exames) {
    (msDe(e.exam_date) === null ? semData : comData).push(e);
  }

  comData.sort((a, b) => (msDe(b.exam_date) ?? 0) - (msDe(a.exam_date) ?? 0));

  const grupos: GrupoExames[] = [];
  for (const e of comData) {
    const rotulo = rotuloMes(e.exam_date!);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.rotulo === rotulo) ultimo.exames.push(e);
    else grupos.push({ rotulo, exames: [e] });
  }

  if (semData.length > 0) grupos.push({ rotulo: 'sem data', exames: semData });
  return grupos;
}

/**
 * Os pares rótulo/valor de um exame, prontos pra desenhar.
 *
 * `findings` é JSONB livre porque o extrator de exames grava o que consegue ler do laudo.
 * Aceita objeto (`{hemoglobina: '13,2'}`), lista de `{name, value}` e string solta. O
 * que não casa com nada volta lista vazia — a tela cai no `notes`, e o exame continua
 * visível. Um `values` estranho não pode ser motivo pra sumir um exame do histórico.
 */
export function paresDoExame(findings: unknown): Array<{ rotulo: string; valor: string }> {
  if (findings === null || findings === undefined) return [];

  if (typeof findings === 'string') {
    const t = findings.trim();
    return t ? [{ rotulo: 'Resultado', valor: t }] : [];
  }

  if (Array.isArray(findings)) {
    const pares: Array<{ rotulo: string; valor: string }> = [];
    for (const item of findings) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const rotulo = o['name'] ?? o['label'] ?? o['exam'] ?? o['key'];
        const valor = o['value'] ?? o['result'] ?? o['valor'];
        if (typeof rotulo === 'string' && valor !== undefined && valor !== null) {
          pares.push({ rotulo, valor: String(valor) });
        }
      } else if (typeof item === 'string' && item.trim()) {
        pares.push({ rotulo: '•', valor: item.trim() });
      }
    }
    return pares;
  }

  if (typeof findings === 'object') {
    return Object.entries(findings as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ({
        rotulo: k.replace(/_/g, ' '),
        // Valor aninhado (`{ref: '12-16', value: '13,2'}`) vira JSON em vez de
        // "[object Object]" — feio, mas legível, e não esconde o dado do paciente.
        valor: typeof v === 'object' ? JSON.stringify(v) : String(v),
      }));
  }

  return [];
}

/** Os `kind` de memory card na ordem em que a Xarlote os trata como importantes. */
export const ORDEM_MEMORIA = ['fact', 'affect', 'preference', 'episode'] as const;

export const ROTULO_MEMORIA: Record<string, string> = {
  fact: 'Fatos sobre você',
  affect: 'Como você se sente',
  preference: 'Suas preferências',
  episode: 'Momentos que guardei',
};

export interface GrupoMemoria {
  kind: string;
  rotulo: string;
  cards: MemoryCard[];
}

/**
 * Memória agrupada por tipo, na ordem de `ORDEM_MEMORIA`, e `kind` desconhecido no fim.
 *
 * `kind` novo não pode desaparecer da tela: o enricher é a única via que escreve
 * memória e pode passar a gravar um tipo que este app não conhece. Cair num grupo
 * genérico é o comportamento certo — memória invisível vira memória inauditável, e a
 * portabilidade LGPD depende de o paciente ver o que guardamos dele.
 */
export function agruparMemoria(cards: readonly MemoryCard[]): GrupoMemoria[] {
  const porKind = new Map<string, MemoryCard[]>();
  for (const c of cards) {
    const lista = porKind.get(c.kind);
    if (lista) lista.push(c);
    else porKind.set(c.kind, [c]);
  }

  const grupos: GrupoMemoria[] = [];
  for (const kind of ORDEM_MEMORIA) {
    const cs = porKind.get(kind);
    if (cs?.length) grupos.push({ kind, rotulo: ROTULO_MEMORIA[kind]!, cards: cs });
    porKind.delete(kind);
  }
  for (const [kind, cs] of porKind) {
    grupos.push({ kind, rotulo: ROTULO_MEMORIA[kind] ?? 'Outras anotações', cards: cs });
  }
  return grupos;
}

/** Alergia grave primeiro — é o dado que salva vida, não pode ficar no fim da lista. */
const PESO_SEVERIDADE: Record<string, number> = {
  anafilaxia: 0, anaphylaxis: 0, severe: 1, grave: 1, moderate: 2, moderada: 2, mild: 3, leve: 3,
};

export function ordenarAlergias(alergias: readonly Allergy[]): Allergy[] {
  return [...alergias].sort((a, b) => {
    // Sem gravidade registrada NÃO é o mesmo que leve: fica no meio (2.5), acima de
    // "leve". Tratar desconhecido como brando é a forma silenciosa de esconder risco.
    const pa = PESO_SEVERIDADE[(a.severity ?? '').toLowerCase()] ?? 2.5;
    const pb = PESO_SEVERIDADE[(b.severity ?? '').toLowerCase()] ?? 2.5;
    return pa - pb || a.substance.localeCompare(b.substance, 'pt-BR');
  });
}

/**
 * Valores que o extrator grava quando NÃO conseguiu identificar o campo.
 *
 * São strings de verdade no banco, não nulos — vistos ao vivo em 12/08: a tela mostrava
 * "500mg · não especificado" pra dipirona. "Não especificado" ocupa o mesmo espaço que
 * uma informação e não é uma; ausência silenciosa comunica melhor do que ruído.
 */
const PREENCHIMENTO_VAZIO = new Set([
  'não especificado', 'nao especificado', 'não informado', 'nao informado',
  'desconhecido', 'n/a', 'na', '-', '--', 'null', 'undefined', '?',
]);

function valorUtil(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  return PREENCHIMENTO_VAZIO.has(t.toLowerCase()) ? null : t;
}

/**
 * O detalhe de um medicamento numa linha: dosagem, forma, frequência.
 *
 * Junta só o que EXISTE. A primeira versão concatenava um campo `purpose` que nem é
 * coluna da tabela — e o resultado era um " · " solto no meio da frase.
 */
export function detalheDoMedicamento(m: Medication): string {
  const partes = [m.dosage, m.form, m.frequency].map(valorUtil).filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : 'sem detalhes ainda';
}

/**
 * A tarja do medicamento, quando há uma.
 *
 * Não existe coluna `critical` na tabela — eu tinha inventado uma. O que existe é
 * `controlled_class` (tarja vermelha/preta) e `needs_prescription`, e isso é informação
 * útil de verdade pro paciente: é o que decide se ele precisa da receita em mãos antes
 * de a Xarlote cotar em farmácia.
 */
export function tarjaDoMedicamento(m: Medication): { rotulo: string; tom: 'danger' | 'warn' | 'neutral' } | null {
  if (m.controlled_class === 'tarja_preta') return { rotulo: 'tarja preta', tom: 'danger' };
  if (m.controlled_class === 'tarja_vermelha') return { rotulo: 'tarja vermelha', tom: 'warn' };
  if (m.needs_prescription) return { rotulo: 'precisa de receita', tom: 'neutral' };
  return null;
}

export function tomDaSeveridade(severity: string | null | undefined): 'danger' | 'warn' | 'neutral' {
  const s = (severity ?? '').toLowerCase();
  if (s === 'anafilaxia' || s === 'anaphylaxis' || s === 'severe' || s === 'grave') return 'danger';
  if (s === 'moderate' || s === 'moderada') return 'warn';
  return 'neutral';
}
