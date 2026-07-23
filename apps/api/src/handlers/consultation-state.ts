/**
 * consultation-state — injeta o ESTADO DA CONSULTA ativa no prompt do paciente (espelho do
 * buildOrderStateBlock da farmácia). Sem isto, a Xarlote fica CEGA à consulta em andamento: o
 * paciente diz "insiste em marcar" e — numa persona farmácia-first, sem âncora de consulta — o
 * LLM chuta o fluxo de farmácia e responde "não achei um pedido recente com farmácias" (incidente
 * Vadivino 22/07). O bloco dá o anchor: há uma consulta viva, é ESTA, e é assim que se continua.
 */
import { db } from '@iasaude/db';

export async function buildConsultationStateBlock(userId: string): Promise<string | null> {
  let { data: c } = await db
    .from('consultations')
    .select('id, status, specialty, preferences, created_at')
    .eq('user_id', userId)
    .in('status', ['searching', 'quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Sem consulta ATIVA, mas houve uma que FALHOU nas últimas 24h? Mantém o anchor: é justo quando o
  // paciente costuma cobrar ("insiste em marcar") e o LLM, sem o bloco, cairia na farmácia de novo.
  let recentlyFailed = false;
  if (!c) {
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data: f } = await db
      .from('consultations')
      .select('id, status, specialty, preferences, created_at')
      .eq('user_id', userId).eq('status', 'failed').gt('created_at', since)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (f) { c = f; recentlyFailed = true; }
  }
  if (!c) return null;

  const prefs = (c.preferences as Record<string, unknown> | null) ?? {};
  const doctor = (prefs['requested_doctor'] as string | null) ?? null;
  const specialtyClean = c.specialty && c.specialty !== 'consulta' ? (c.specialty as string) : '';
  const alvo = doctor
    ? `com ${doctor}${specialtyClean ? ` (${specialtyClean})` : ''}`
    : specialtyClean ? `de ${specialtyClean}` : 'médica';

  const statusHuman: Record<string, string> = {
    searching: 'estou em contato com o consultório/clínica, aguardando horário',
    quoting: 'negociando com o consultório',
    quoted: 'já apresentei opções de horário — aguardando o paciente escolher',
    confirming: 'o paciente escolheu — confirmando a reserva com a clínica',
    failed: 'a última tentativa não fechou — dá pra RETOMAR (o paciente pode insistir)',
  };

  // Pergunta pendente da clínica ainda sem resposta (só faz sentido numa consulta VIVA).
  const { data: pendingQ } = recentlyFailed ? { data: null } : await db
    .from('consultation_quotes')
    .select('clarification_question')
    .eq('consultation_id', c.id)
    .eq('clarification_status', 'awaiting_user')
    .order('clarification_asked_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const header = recentlyFailed
    ? `## 🩺 ÚLTIMA CONSULTA (não fechou — RETOMÁVEL; isto NÃO é um pedido de farmácia)`
    : `## 🩺 CONSULTA ATIVA (em andamento — isto NÃO é um pedido de farmácia)`;
  const lines: string[] = [
    header,
    `- Consulta ${alvo} — status: ${statusHuman[c.status] ?? c.status}.`,
  ];
  if (pendingQ?.clarification_question) {
    lines.push(
      `- ⏳ Você levou uma pergunta ao paciente e aguarda a resposta dele: "${pendingQ.clarification_question}". Se a mensagem dele responder isso (mesmo em parte), use **relay_answer_to_establishment**.`,
    );
  }
  lines.push(
    `- Se o paciente COBRAR ou INSISTIR nesta consulta ("insiste", "e aí?", "já marcou?", "tenta de novo", "continua", "vê isso pra mim"), é sobre ESTA consulta — **NÃO** é farmácia. Use **nudge_consultation** pra eu dar um alô no consultório e retomar (nunca message_supplier / start_pharmacy_order). Se ele quiser desistir, **cancel_consultation**.`,
  );
  return lines.join('\n');
}
