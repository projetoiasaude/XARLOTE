/**
 * care-notify — o paciente sabe quando alguém mexe no registro dele.
 *
 * ─── POR QUE ISTO NÃO É OPCIONAL ──────────────────────────────────────────────
 * O vínculo de cuidado é consentido, mas consentimento dado uma vez não é vigilância
 * permanente. Quem autorizou o filho a acompanhar sua saúde em março precisa continuar
 * enxergando, em agosto, o que ele anda fazendo — senão o acesso vira uma porta que
 * ninguém mais olha.
 *
 * É o mesmo princípio do push "seu médico abriu o link" que o `share_grants` já prometia.
 * E tem uma função de segurança concreta: se aparecer um aviso que a pessoa não esperava,
 * ela descobre AGORA que precisa revogar — não seis meses depois.
 *
 * ─── O QUE AVISA, E O QUE NÃO ─────────────────────────────────────────────────
 * Só o que MUDA o registro dela. Leitura não avisa: um filho que abre a tela da mãe todo
 * dia geraria uma mensagem diária e ela pararia de ler todas — inclusive a que importa.
 *
 * `red_flag_check` fica de fora de propósito: no meio de uma emergência, a última coisa
 * que ajuda é o telefone dela apitar com aviso de sistema.
 */
import { db, writeLog, writeEvent } from '@iasaude/db';
import { checkKeyedRateLimit } from '../middleware/rate-limit.js';
import { sendOutbound } from './outbound.js';

/** Ações que mudam o registro — e por isso o dono precisa saber. */
const O_QUE_MUDOU: Record<string, string> = {
  create_reminder: 'criou um lembrete',
  cancel_reminders: 'cancelou um lembrete',
  save_exam_result: 'guardou um exame',
  log_medication_taken: 'registrou uma dose de remédio',
  log_symptom: 'anotou um sintoma',
  save_user_profile_fact: 'atualizou uma informação',
};

export const ACOES_QUE_PESAM: readonly string[] = Object.keys(O_QUE_MUDOU);

export function acaoPesa(tool: string): boolean {
  return tool in O_QUE_MUDOU;
}

/**
 * Avisa o sujeito. Best-effort e sem nunca derrubar a ação que já aconteceu.
 *
 * Uma janela de uma hora POR TIPO de ação: criar cinco lembretes seguidos gera um aviso
 * só, e um cancelamento no meio disso continua passando — porque é outro tipo, e silenciar
 * um lembrete de remédio é justamente o que ela mais precisa saber.
 */
export async function avisarSujeitoDeAcaoDoCuidador(args: {
  subjectUserId: string;
  caregiverUserId: string;
  toolName: string;
  traceId: string;
}): Promise<void> {
  try {
    const oQue = O_QUE_MUDOU[args.toolName];
    if (!oQue) return;

    const cd = await checkKeyedRateLimit(`care:aviso:${args.subjectUserId}:${args.toolName}`, { max: 1, windowS: 3600 });
    // Limitador cego (Redis fora) NÃO cala o aviso: um aviso repetido incomoda, um aviso
    // que não sai esconde de alguém o que fizeram no prontuário dela. A assimetria decide.
    if (cd.count !== -1 && !cd.allowed) return;

    const [{ data: sujeito }, { data: cuidador }] = await Promise.all([
      db.from('users').select('preferred_name, full_name, account_kind').eq('id', args.subjectUserId).maybeSingle(),
      db.from('users').select('preferred_name, full_name').eq('id', args.caregiverUserId).maybeSingle(),
    ]);

    // Dependente não tem canal próprio — não há a quem avisar, e a transparência dele
    // acontece na tela de quem o representa.
    if (sujeito?.account_kind === 'dependente') return;

    const { data: conv } = await db
      .from('conversations')
      .select('id, whatsapp_jid')
      .eq('user_id', args.subjectUserId)
      .eq('party_type', 'user')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const tel = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
    if (!conv?.id || !tel) return;

    const quem = String(cuidador?.preferred_name || cuidador?.full_name || 'quem te acompanha').split(/\s+/)[0];
    const nome = String(sujeito?.preferred_name || sujeito?.full_name || '').split(/\s+/)[0];

    const texto = `${nome ? `Oi, ${nome}! ` : 'Oi! '}Só pra você ficar sabendo: ${quem} ${oQue} aqui no seu acompanhamento 💙\n\n`
      + `Se não foi combinado, me avisa que a gente resolve — você pode tirar o acesso quando quiser.`;

    const saiu = await sendOutbound(conv.id, `+${tel}`, texto, args.traceId, {}, { dedup: true, dedupWindowMs: 10 * 60_000 });

    // O evento vale mesmo quando a mensagem não sai (janela de 24h fechada): é o que
    // sustenta a tela "quem mexeu no meu registro" no app, que não depende do WhatsApp.
    void writeEvent({
      eventName: 'care.subject_notified',
      userId: args.subjectUserId,
      payload: { por_cuidador: args.caregiverUserId, acao: args.toolName, entregue: saiu },
    });
  } catch (err) {
    // Nunca derruba a ação que JÁ aconteceu. O aviso é sobre ela, não parte dela.
    await writeLog('warn', 'care', `aviso ao sujeito falhou: ${String(err).slice(0, 120)}`, { traceId: args.traceId });
  }
}
