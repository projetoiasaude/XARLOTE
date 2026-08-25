/**
 * reminder-fadiga — parar de falar com quem parou de ouvir.
 *
 * ─── OS NÚMEROS (25/08/2026) ──────────────────────────────────────────────────
 * Uma paciente tem SETE lembretes de água por dia (8:00, 10:30, 13:00, 15:30, 18:00,
 * 20:30 e 23:00), criados em 02/07. São quase dois meses e por volta de 380 mensagens.
 * Ela **nunca respondeu a nenhuma**. Outro paciente recebe dois de exercício às 5:00 e
 * 5:05 — o segundo cobra o primeiro ("Já respondeu 'acordei' no lembrete anterior?") —
 * desde 17/07, também sem uma única resposta.
 *
 * Um lembrete que ninguém lê há dois meses não é cuidado, é ruído. E o ruído tem custo
 * real: ele treina a pessoa a ignorar a Xarlote, inclusive no dia em que a mensagem for
 * sobre remédio.
 *
 * ─── POR QUE SEPARAR POR TIPO, E NÃO POR HORA ─────────────────────────────────
 * A tentação é aplicar silêncio noturno a tudo. Seria errado: às 5h da manhã o lembrete
 * de exercício é EXATAMENTE o que aquele paciente pediu, e às 23h um remédio pode ser a
 * dose da noite. A assimetria manda:
 *
 *   • `medication` e `appointment` — NUNCA são silenciados nem freados. Calar um remédio
 *     pra poupar incômodo é trocar um desconforto por um risco clínico.
 *   • hidratação, exercício e hábitos — podem esperar o dia e podem ser pausados.
 *
 * ─── E POR QUE PERGUNTAR EM VEZ DE SÓ PARAR ───────────────────────────────────
 * Serviço que some sozinho é falha silenciosa: a pessoa pediu aquilo um dia. Ao bater o
 * limiar, a Xarlote fala UMA vez e devolve a escolha a ela. Parar sem avisar seria o
 * mesmo erro de sempre, só que na direção contrária.
 *
 * PURO: sem I/O, sem relógio. Quem tem o relógio e o banco é o worker.
 */

/** Tipos que nunca são silenciados nem freados — o custo de errar é clínico. */
const CRITICOS = new Set(['medication', 'appointment']);

/** Fora desta janela, lembrete de hábito espera o dia seguinte. */
export const SILENCIO_INICIO_BRT = 22;
export const SILENCIO_FIM_BRT = 7;

/**
 * Quantos disparos seguidos sem UMA palavra do paciente antes de perguntar.
 *
 * 20 é ~3 dias pra quem tem 7 lembretes/dia e ~10 dias pra quem tem 2. Alto o bastante
 * pra não confundir uma viagem de fim de semana com desinteresse, baixo o bastante pra
 * não deixar chegar aos 380.
 */
export const LIMIAR_SEM_RESPOSTA = 20;

export interface EntradaFadiga {
  tipo: string | null;
  /** Hora local de Brasília no momento do disparo (0–23). */
  horaBrt: number;
  /** Disparos consecutivos deste lembrete sem nenhuma resposta do paciente. */
  disparosSemResposta: number;
  /** `true` se a Xarlote já perguntou se ele quer continuar (não pergunta duas vezes). */
  jaPerguntou?: boolean;
}

export type VeredictoFadiga =
  | { enviar: true }
  | { enviar: false; motivo: 'silencio_noturno' }
  | { enviar: false; motivo: 'sem_engajamento'; perguntar: boolean };

/** `true` quando o tipo é clínico e não admite silêncio nem freio. */
export function ehCritico(tipo: string | null | undefined): boolean {
  return CRITICOS.has((tipo ?? '').trim().toLowerCase());
}

/** `true` se a hora cai na faixa de silêncio (22h–7h). */
export function ehMadrugada(horaBrt: number): boolean {
  return horaBrt >= SILENCIO_INICIO_BRT || horaBrt < SILENCIO_FIM_BRT;
}

/**
 * Deve este lembrete sair agora?
 *
 * Ordem: criticidade primeiro (ela vence tudo), depois desengajamento, depois hora. O
 * desengajamento vem antes do silêncio porque a PERGUNTA que ele dispara é o que resolve
 * o caso — e ela deve sair de dia, junto do disparo que a motivou.
 */
export function avaliarFadiga(e: EntradaFadiga): VeredictoFadiga {
  if (ehCritico(e.tipo)) return { enviar: true };

  if (e.disparosSemResposta >= LIMIAR_SEM_RESPOSTA) {
    // Pergunta uma vez, e só em hora civilizada — perguntar "quer continuar?" às 23h
    // seria cometer o incômodo que a pergunta existe pra encerrar.
    return { enviar: false, motivo: 'sem_engajamento', perguntar: !e.jaPerguntou && !ehMadrugada(e.horaBrt) };
  }

  if (ehMadrugada(e.horaBrt)) return { enviar: false, motivo: 'silencio_noturno' };

  return { enviar: true };
}

/** A pergunta que devolve a escolha ao paciente. Uma vez só. */
export function perguntaDeContinuidade(titulo: string | null, nome: string | null): string {
  const oque = (titulo ?? '').trim() || 'esses lembretes';
  const quem = (nome ?? '').trim();
  return `${quem ? `${quem}, ` : ''}reparei que os lembretes de "${oque}" não estão te ajudando muito — faz um tempo que eles chegam e você não precisa responder 💙\n\n`
    + `Quer que eu continue mandando, mude pra outro horário, ou pare com eles? Do jeito que for melhor pra você.`;
}
