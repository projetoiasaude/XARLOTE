/**
 * A tela de Lembretes decidida por funções puras: em que bloco cada lembrete cai, que
 * ações ele aceita, e — o mais importante — o que o servidor VAI responder.
 *
 * ## O eco otimista aqui não é um chute
 *
 * `reminderActionPatch` foi extraída pra `@iasaude/shared` na F0 justamente pra que o
 * app possa aplicar a MESMA decisão do servidor antes da resposta chegar. É o que
 * evita o defeito clássico do otimismo: mostrar "concluído" num lembrete recorrente e,
 * um segundo depois, ele voltar pra "pendente às 7h de amanhã" — porque foi isso que o
 * servidor decidiu. Com a função compartilhada, a tela mostra de imediato o resultado
 * CERTO, e a resposta só confirma.
 *
 * O único ingrediente que o app não tem de graça é a próxima ocorrência do `rrule` —
 * e `nextOccurrence` também vem de shared, então nem esse falta.
 */
import { nextOccurrence, reminderActionPatch, type ReminderAppAction } from '@iasaude/shared';
import { diffDiasBrt, msDe } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';

export type BlocoLembrete = 'atrasado' | 'hoje' | 'amanha' | 'semana' | 'depois' | 'encerrado';

export const ROTULO_BLOCO: Record<BlocoLembrete, string> = {
  atrasado: 'Passou da hora',
  hoje: 'Hoje',
  amanha: 'Amanhã',
  semana: 'Nos próximos dias',
  depois: 'Mais pra frente',
  encerrado: 'Já resolvidos',
};

/** Status que o paciente não age mais em cima. `acknowledged` de recorrente não cai aqui. */
function encerrado(status: string): boolean {
  return status === 'cancelled' || status === 'acknowledged' || status === 'failed';
}

/**
 * Em que bloco o lembrete aparece.
 *
 * "Passou da hora" é um bloco de verdade, e não uma linha vermelha no meio de "Hoje":
 * um remédio cujo horário passou é a única coisa nessa tela que pede AÇÃO AGORA — e a
 * adesão de 44% do Arthur nasceu exatamente de doses que ninguém viu que tinham passado.
 */
export function blocoDoLembrete(r: ReminderRow, agoraMs: number): BlocoLembrete {
  if (encerrado(r.status)) return 'encerrado';

  const alvo = msDe(r.next_run_at) ?? msDe(r.scheduled_at);
  // Pendente sem horário nenhum: não some da tela — vai pro fim, visível, porque um
  // lembrete que existe no banco e não aparece em lugar algum é dado perdido.
  if (alvo === null) return 'depois';

  // Horário já passou e o lembrete segue pendente → atrasado, mesmo que seja de
  // semanas atrás. Isso é de propósito: o lembrete indeliverável em loop (incidente
  // A8) ficava invisível justamente por ser antigo demais pra caber em "hoje".
  if (alvo < agoraMs) return 'atrasado';

  const dias = diffDiasBrt(alvo, agoraMs);
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'amanha';
  if (dias <= 7) return 'semana';
  return 'depois';
}

export interface GrupoLembretes {
  bloco: BlocoLembrete;
  rotulo: string;
  lembretes: ReminderRow[];
}

const ORDEM_BLOCOS: BlocoLembrete[] = ['atrasado', 'hoje', 'amanha', 'semana', 'depois', 'encerrado'];

/**
 * Lembretes em blocos, cada bloco ordenado pelo horário.
 *
 * Blocos vazios NÃO entram — cabeçalho de seção sem nada embaixo faz a tela parecer
 * quebrada. Quem quer dizer "não tem nada" é o estado vazio da tela, com uma frase.
 */
export function agruparLembretes(lembretes: readonly ReminderRow[], agoraMs: number): GrupoLembretes[] {
  const porBloco = new Map<BlocoLembrete, ReminderRow[]>();
  for (const r of lembretes) {
    const b = blocoDoLembrete(r, agoraMs);
    const lista = porBloco.get(b);
    if (lista) lista.push(r);
    else porBloco.set(b, [r]);
  }

  const grupos: GrupoLembretes[] = [];
  for (const bloco of ORDEM_BLOCOS) {
    const lista = porBloco.get(bloco);
    if (!lista?.length) continue;
    lista.sort((a, b) => {
      const ma = msDe(a.next_run_at) ?? msDe(a.scheduled_at) ?? Number.MAX_SAFE_INTEGER;
      const mb = msDe(b.next_run_at) ?? msDe(b.scheduled_at) ?? Number.MAX_SAFE_INTEGER;
      // Encerrados na ordem inversa: o que acabou de ser confirmado fica no topo do
      // bloco, onde o paciente espera ver a confirmação que ele mesmo acabou de dar.
      return bloco === 'encerrado' ? mb - ma : ma - mb;
    });
    grupos.push({ bloco, rotulo: ROTULO_BLOCO[bloco], lembretes: lista });
  }
  return grupos;
}

/** Que botões a linha mostra. Cancelado não aceita nada — é terminal no servidor. */
export function acoesDisponiveis(r: ReminderRow): ReminderAppAction[] {
  if (r.status === 'cancelled') return [];
  if (r.status === 'acknowledged' && !r.rrule) return [];
  return ['done', 'snooze', 'cancel'];
}

/**
 * O lembrete como ele VAI ficar depois da ação — a MESMA decisão do servidor.
 *
 * Volta `null` quando o servidor recusaria (cancelado é terminal): a tela então não
 * finge que fez nada. Otimismo que aplica o que o servidor vai rejeitar é pior que
 * nenhum otimismo, porque a linha pisca e volta.
 */
export function lembreteOtimista(r: ReminderRow, acao: ReminderAppAction, minutos: number | undefined, agoraMs: number): ReminderRow | null {
  const proxima = r.rrule ? nextOccurrence(r.rrule) : null;
  const decisao = reminderActionPatch(
    { status: r.status, rrule: r.rrule ?? null, nextRecurringIso: proxima?.toISOString() ?? null },
    acao,
    minutos,
    agoraMs,
  );
  if (decisao.kind === 'reject') return null;

  // O patch usa as chaves do BANCO (snake_case) — as mesmas do row, de propósito:
  // é o que permite aplicá-lo direto, sem um mapa de tradução que sairia de sincronia.
  return { ...r, ...(decisao.patch as Partial<ReminderRow>) };
}

/**
 * A frase de confirmação que a Xarlote diria — falada, não robótica.
 *
 * Recorrente confirmado NÃO diz "concluído": diz que o de hoje está feito e quando é o
 * próximo. Dizer "concluído" num remédio de todo dia sugere que acabou o tratamento.
 */
export function fraseDaAcao(r: ReminderRow, acao: ReminderAppAction, minutos: number | undefined): string {
  if (acao === 'done') return r.rrule ? 'Anotado, o de hoje está feito.' : 'Prontinho, marquei como feito.';
  if (acao === 'cancel') return 'Cancelei esse lembrete.';
  return `Te chamo de novo em ${minutos ?? 30} minutos.`;
}

export type TomLembrete = 'danger' | 'warn' | 'success' | 'accent' | 'neutral';

/** A cor do estado. Atraso é `warn`, não `danger`: a Xarlote acompanha, não repreende. */
export function tomDoBloco(bloco: BlocoLembrete): TomLembrete {
  switch (bloco) {
    case 'atrasado': return 'warn';
    case 'hoje': return 'accent';
    case 'encerrado': return 'neutral';
    default: return 'neutral';
  }
}

const ROTULO_TIPO: Record<string, string> = {
  medication: 'Remédio',
  medication_backup: 'Reforço',
  appointment: 'Consulta',
  exam: 'Exame',
  refill: 'Recomprar',
  hydration: 'Água',
  custom: 'Lembrete',
};

export function rotuloDoTipo(tipo: string | null | undefined): string {
  return ROTULO_TIPO[tipo ?? ''] ?? 'Lembrete';
}
