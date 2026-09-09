/**
 * claim-guard — a Xarlote não anuncia o que o sistema não fez.
 *
 * ─── O QUE ACONTECEU (Ciro, 25/08/2026) ───────────────────────────────────────
 * 09:27 — ele: *"Teremos que cancelar, avisa por favor"*.
 * 09:36 — a Rita, do consultório, confirma o cancelamento.
 * 09:37 — a Xarlote: *"Tudo certo, Ciro! Cancelamento confirmado com a clínica e já
 *          cancelei o lembrete da consulta aqui também 💙"*.
 *
 * No MESMO minuto, o log:
 *   `Tool cancel_consultation recusou executar: NADA FOI CANCELADO: há mais de uma
 *    consulta possível`
 *
 * A consulta seguiu `scheduled` pra 26/08 e o lembrete "Consulta em 2 horas" seguiu
 * armado pras 08:00 do dia seguinte. Das duas afirmações, nenhuma era verdade.
 *
 * ─── POR QUE A RECUSA NÃO BASTOU ──────────────────────────────────────────────
 * O `ToolFailure` volta ao modelo com `ok:false` e a mensagem explicando o que NÃO foi
 * feito ("NÃO diga que cancelou"). Todo o mecanismo funcionou. O modelo leu e escreveu o
 * contrário assim mesmo.
 *
 * É a mesma lição do `sanity.ts`, um ano de incidentes depois: **entre gerar e enviar não
 * havia etapa nenhuma**. Instrução no prompt é pedido; guarda determinística é garantia.
 * Um turno ruim de um modelo não pode virar promessa quebrada com um paciente.
 *
 * ─── CALIBRAGEM ───────────────────────────────────────────────────────────────
 * Duas faixas, porque as evidências têm forças diferentes:
 *
 *   • BLOQUEIO — uma ferramenta que produz esse anúncio FALHOU neste turno e nenhuma
 *     outra que o produz teve sucesso. Aqui a mentira está provada.
 *   • SUSPEITA — o texto anuncia algo e nenhuma ferramenta do tipo rodou. Pode ser
 *     referência legítima ao passado ("aquele pedido que a gente cancelou"), então só
 *     registra pra auditoria. Bloquear seria calar conversa honesta.
 *
 * PURO: sem I/O, sem relógio, sem LLM. Não custa token e não falha junto com o modelo.
 */
import { foldPt } from './br-datetime.js';

/** O que um texto pode anunciar como FEITO. */
export type ClaimKind =
  | 'cancelamento'
  | 'lembrete_cancelado'
  | 'agendamento'
  | 'pedido_fechado'
  | 'mensagem_a_terceiro'
  | 'registro_salvo';

/** Quais ferramentas tornam cada anúncio verdadeiro. */
const PROVAS: Record<ClaimKind, readonly string[]> = {
  cancelamento: ['cancel_consultation', 'cancel_order'],
  lembrete_cancelado: ['cancel_reminders'],
  agendamento: ['confirm_consultation_selection'],
  pedido_fechado: ['confirm_order_selection'],
  mensagem_a_terceiro: [
    'message_supplier', 'contact_establishment', 'nudge_consultation',
    'relay_answer_to_establishment', 'forward_media_to_establishment',
  ],
  registro_salvo: ['save_exam_result', 'parse_prescription_image', 'log_medication_taken', 'log_symptom'],
};

/**
 * Frases que afirmam o feito. Rodam sobre texto dobrado (minúsculo, sem acento) e por
 * ORAÇÃO — a unidade importa, porque "falei com a clínica, mas não consegui cancelar"
 * tem as duas coisas e só a segunda manda.
 */
const ANUNCIOS: Record<ClaimKind, RegExp> = {
  cancelamento: /\b(?:cancelei|cancelamos|desmarquei|desmarcamos)\b|\b(?:cancelamento|consulta|pedido)\b[^.!?]{0,25}\b(?:cancelad[oa]|desmarcad[oa]|confirmad[oa])\b|\bcancelad[oa]\s+(?:com|na|no)\b/,
  lembrete_cancelado: /\bcancelei\b[^.!?]{0,20}\blembrete/,
  agendamento: /\b(?:marquei|agendei|reservei)\b|\b(?:consulta|horario)\b[^.!?]{0,25}\b(?:confirmad[oa]|agendad[oa]|marcad[oa]|reservad[oa])\b/,
  pedido_fechado: /\bfechei\b[^.!?]{0,20}\bpedido\b|\bpedido\b[^.!?]{0,20}\b(?:fechad[oa]|confirmad[oa])\b/,
  // ⚠️ ENCAMINHAR conta como falar com terceiro (pendência de revisor, fechada em 26/08).
  // A primeira versão só conhecia `falei|avisei|mandei|pedi`, e deixava passar justamente
  // os verbos de DOCUMENTO — "encaminhei seu exame pra farmácia", "repassei o pedido
  // médico". Era a frase exata que o revisor apontou: a Xarlote dizendo que encaminhou o
  // exame pra uma farmácia que não recebeu nada.
  // Duas formas: verbo + estabelecimento, ou verbo + documento (encaminhar documento já é,
  // por definição, uma ação sobre terceiro).
  mensagem_a_terceiro: /\bja\s+(?:falei|avisei|mandei|pedi|encaminhei|repassei|enviei)\b|\b(?:falei|avisei|mandei|encaminhei|repassei|enviei)\b[^.!?]{0,45}\b(?:farmacia|clinica|consultorio|eles|secretaria|drogaria)\b|\b(?:encaminhei|repassei|enviei)\b[^.!?]{0,35}\b(?:exame|receita|pedido|carteirinha|documento|foto|laudo|guia)\b|\bentrei\s+em\s+contato\b|\b(?:dei|mandei)\s+(?:um\s+)?(?:alo|al[ôo]|toque)\b|\b(?:cutuquei|insisti|reforcei|refor[çc]ei)\b/,
  // ⚠️ AMPLIADO em 08/09/2026 (caso Ludmila/Hiago, 04/09): "Já guardei tudo aqui no perfil"
  // — sem NENHUMA ferramenta no turno — passava, porque só a forma verbo+objeto era
  // conhecida. Entram: verbo + "tudo"; objeto + particípio ("exame guardado"); e o estado
  // ("já está salvo", "ficou registrado"). "Anotado, Glauber ✅" sozinho NÃO entra: é a
  // fórmula de confirmação de dose, coberta pelo backstop determinístico de adesão.
  registro_salvo: /\b(?:guardei|salvei|registrei|anotei)\b[^.!?]{0,30}\b(?:exame|resultado|laudo|receita|perfil|historico|prontuario|tudo)\b|\b(?:exame|resultado|laudo|receita)\b[^.!?]{0,30}\b(?:guardad[oa]|salv[oa]|registrad[oa]|anotad[oa])\b|\b(?:ja\s+)?(?:esta|estao|ta|tao|ficou|ficaram|foi|foram)\s+(?:tudo\s+)?(?:guardad[oa]s?|salv[oa]s?|registrad[oa]s?)\b/,
};

/**
 * Famílias cujo anúncio no passado, SEM ferramenta no turno, não pode sair como "suspeita
 * só pra auditoria" quando o turno gira em torno de um ARQUIVO do paciente. "Já guardei
 * tudo" sobre o exame que acabou de chegar não é referência ao passado — é o fato que o
 * paciente vai levar pra casa. O call-site dá ao modelo UMA rodada pra se corrigir (chamar
 * a ferramenta ou reescrever) e, se ele insistir, derruba a oração (`semAnuncios`).
 */
export const FAMILIAS_COM_PROVA_NO_TURNO: readonly ClaimKind[] = ['registro_salvo'];

/**
 * Devolve o texto SEM as orações que anunciam qualquer das famílias em `kinds`.
 * Orações negadas ("não consegui guardar") ficam — elas são a verdade.
 */
export function semAnuncios(texto: string, kinds: readonly ClaimKind[]): { texto: string; removidas: string[] } {
  const removidas: string[] = [];
  const mantidas: string[] = [];
  for (const frase of oracoes(texto ?? '')) {
    const f = foldPt(frase);
    const anuncia = !NEGADO.test(f) && kinds.some((k) => ANUNCIOS[k].test(f));
    if (anuncia) removidas.push(frase);
    else mantidas.push(frase);
  }
  return { texto: mantidas.join(' ').replace(/\s{2,}/g, ' ').trim(), removidas };
}

/** Nega o anúncio na MESMA oração: "não consegui cancelar" não é anúncio de cancelamento. */
const NEGADO = /\bnao\b[^.!?]{0,30}$|^[^.!?]{0,30}\bnao\b/;

export interface ClaimFinding {
  kind: ClaimKind;
  /** Oração que carregou o anúncio — vai pro log, pra auditoria ser legível. */
  evidence: string;
  /** Ferramenta que falhou e deveria ter sustentado o anúncio (só no bloqueio). */
  tool?: string;
}

export interface ClaimGuardResult {
  /** Mentira PROVADA: a ferramenta que sustentaria o anúncio falhou. Não envie o texto. */
  blocked: ClaimFinding[];
  /** Anúncio sem ferramenta nenhuma no turno. Só registra — pode ser fala sobre o passado. */
  suspect: ClaimFinding[];
}

function oracoes(texto: string): string[] {
  return (texto ?? '')
    .split(/(?<=[.!?\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Relê o que a Xarlote vai dizer ao paciente, à luz do que as ferramentas REALMENTE
 * fizeram neste turno.
 *
 * `falharam`/`funcionaram` são nomes de tool do turno corrente. Uma mesma família pode
 * ter uma falha e um sucesso (duas farmácias, uma alcançada): aí o anúncio é verdadeiro
 * e não há bloqueio — por isso o sucesso vence a falha dentro da família.
 */
export function verificarAnuncios(
  texto: string,
  falharam: readonly string[],
  funcionaram: readonly string[],
): ClaimGuardResult {
  const blocked: ClaimFinding[] = [];
  const suspect: ClaimFinding[] = [];
  const t = (texto ?? '').trim();
  if (!t) return { blocked, suspect };

  const falhou = new Set(falharam);
  const funcionou = new Set(funcionaram);

  for (const frase of oracoes(t)) {
    const f = foldPt(frase);
    if (NEGADO.test(f)) continue;
    for (const kind of Object.keys(ANUNCIOS) as ClaimKind[]) {
      if (!ANUNCIOS[kind].test(f)) continue;
      const provas = PROVAS[kind];
      if (provas.some((p) => funcionou.has(p))) continue;      // o anúncio é verdadeiro
      const quebrada = provas.find((p) => falhou.has(p));
      if (quebrada) {
        if (!blocked.some((b) => b.kind === kind)) blocked.push({ kind, evidence: frase.slice(0, 160), tool: quebrada });
      } else if (!suspect.some((s) => s.kind === kind)) {
        suspect.push({ kind, evidence: frase.slice(0, 160) });
      }
    }
  }
  return { blocked, suspect };
}

/**
 * O que dizer no lugar do anúncio falso.
 *
 * Honesto sem ser derrotista, e sempre terminando numa pergunta: o paciente acabou de
 * pedir algo e precisa de um próximo passo, não de um pedido de desculpas. Nunca afirma
 * o contrário do anúncio ("não cancelei nada") porque pode não ser verdade do lado de
 * fora — no caso do Ciro a clínica FOI avisada; quem falhou foi só o nosso registro.
 */
export function falaHonestaPara(kind: ClaimKind): string {
  switch (kind) {
    case 'cancelamento':
      return 'Deu um problema aqui no meu registro e eu não consegui concluir esse cancelamento do meu lado 😕 Me confirma qual é pra eu resolver agora?';
    case 'lembrete_cancelado':
      return 'Não consegui desligar esse lembrete aqui 😕 Me diz qual é que eu cancelo na hora, pra ele não te incomodar.';
    case 'agendamento':
      return 'Não consegui fechar esse horário ainda 😕 Me confirma qual você quer que eu garanto com eles.';
    case 'pedido_fechado':
      return 'Não consegui fechar esse pedido agora 😕 Me confirma qual opção você quer que eu tento de novo.';
    case 'mensagem_a_terceiro':
      return 'Não consegui alcançar eles agora 😕 Vou continuar tentando e te aviso assim que conseguir falar.';
    case 'registro_salvo':
      return 'Não consegui guardar isso no seu perfil agora 😕 Pode me mandar de novo daqui a pouco?';
  }
}
