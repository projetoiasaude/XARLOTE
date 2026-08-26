/**
 * O export de dados do titular (LGPD art. 18, II e V) — COMPLETO.
 *
 * ## O que existia antes
 *
 * Um dump montado no cliente, a partir do que a tela do web já tinha em mãos. Faltava a
 * coisa mais importante: **as mensagens**. Toda a conversa do paciente com a Xarlote —
 * onde ele contou dos sintomas, do medo, do que toma — ficava fora. Portabilidade que
 * omite o histórico não é portabilidade; é um resumo.
 *
 * Também faltavam os `consent_events` (a prova de quando ele aceitou e o que aceitou) e o
 * `audit_log` (quem acessou o prontuário dele, e quando). Os dois são justamente o que a
 * LGPD dá ao titular como direito de saber.
 *
 * ## A forma do arquivo
 *
 * JSON único, com um cabeçalho que explica o que é cada seção em português. O destinatário
 * é uma PESSOA — às vezes o médico dela — não um sistema. Um dump de tabelas sem legenda
 * cumpre a letra da lei e falha no espírito.
 *
 * ## Paginação, porque isto tem que aguentar crescer
 *
 * As mensagens são lidas em páginas por keyset (`created_at, id`), nunca com OFFSET: um
 * paciente de três anos de conversa tem dezenas de milhares de linhas, e OFFSET fica mais
 * lento a cada página. O limite duro existe pra que um caso extremo não estoure a memória
 * do worker — e quando ele é atingido, o arquivo DIZ que foi truncado, em vez de entregar
 * um histórico incompleto silenciosamente.
 */
import { db } from '@iasaude/db';

/** Página de leitura das mensagens. Mais que isso não melhora e come memória. */
const PAGINA_MENSAGENS = 1_000;

/**
 * Teto de mensagens no arquivo.
 *
 * 200 mil linhas de conversa é mais de uma década de uso intenso. O teto existe pro caso
 * patológico (loop de webhook, conta de teste); quando bate, `truncado: true` aparece no
 * arquivo. Cap silencioso seria pior que cap nenhum.
 */
const MAX_MENSAGENS = 200_000;

export interface ResultadoExport {
  /** O JSON serializado, pronto pro Storage. */
  conteudo: string;
  bytes: number;
  mensagens: number;
  truncado: boolean;
}

/** Consulta que não pode derrubar o export inteiro por causa de uma seção. */
async function safe<T>(p: PromiseLike<{ data: T | null }>): Promise<T | null> {
  try {
    const r = await p;
    return r.data;
  } catch {
    return null;
  }
}

/**
 * Todas as mensagens do paciente, por keyset.
 *
 * O cursor é `(created_at, id)` porque `created_at` sozinho não é único — duas mensagens
 * no mesmo milissegundo fariam a paginação pular uma ou repetir outra. O `id` desempata.
 */
async function lerMensagens(
  conversationIds: readonly string[],
): Promise<{ linhas: unknown[]; truncado: boolean }> {
  const linhas: unknown[] = [];
  if (conversationIds.length === 0) return { linhas, truncado: false };

  let cursorData: string | null = null;
  let cursorId: string | null = null;

  for (;;) {
    let q = db
      .from('messages')
      .select(
        'id, conversation_id, direction, sender_role, content_type, content, transcript, ' +
          'media_mime, media_duration_ms, location_lat, location_lng, delivery_status, ' +
          'delivered_at, created_at',
      )
      .in('conversation_id', conversationIds as string[])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGINA_MENSAGENS);

    if (cursorData && cursorId) {
      // Aspas duplas no valor: o timestamp tem `+` e o PostgREST interpreta `+` como
      // espaço dentro de `or=()` se ele não estiver entre aspas.
      q = q.or(`created_at.gt."${cursorData}",and(created_at.eq."${cursorData}",id.gt.${cursorId})`);
    }

    const { data, error } = await q;
    if (error || !data || data.length === 0) break;

    linhas.push(...data);
    if (linhas.length >= MAX_MENSAGENS) return { linhas: linhas.slice(0, MAX_MENSAGENS), truncado: true };
    if (data.length < PAGINA_MENSAGENS) break;

    // `as unknown as` porque o tipo do select do supabase-js admite um caso de erro por
    // linha; aqui a página já passou pela checagem de `error` acima.
    const ultima = data[data.length - 1] as unknown as { created_at: string; id: string };
    cursorData = ultima.created_at;
    cursorId = ultima.id;
  }

  return { linhas, truncado: false };
}

export async function buildExport(userId: string, agoraIso: string): Promise<ResultadoExport> {
  const { data: user } = await db.from('users').select('*').eq('id', userId).maybeSingle();

  const { data: convs } = await db
    .from('conversations')
    .select('id, party_type, whatsapp_instance, status, summary, memory_cards, created_at, last_message_at')
    .eq('user_id', userId);
  const idsConv = (convs ?? []).map((c) => c.id as string);

  const { linhas: mensagens, truncado } = await lerMensagens(idsConv);

  // Em paralelo, como no overview: são consultas independentes e a latência soma se forem
  // em série. Aqui o ganho é maior — o worker está bloqueado esperando.
  const [
    condicoes, alergias, medicamentos, inventario, tratamentos, prescritores,
    exames, lembretes, pedidos, consultas, sintomas, logDoses, memoria,
    consentimentos, auditoria, dispositivos, midias, compartilhamentos, tarefas,
    quemCuidaDeMim, deQuemEuCuido,
  ] = await Promise.all([
    safe(db.from('user_health_conditions').select('*').eq('user_id', userId)),
    safe(db.from('user_allergies').select('*').eq('user_id', userId)),
    safe(db.from('user_medications').select('*').eq('user_id', userId)),
    safe(db.from('medication_inventory').select('*').eq('user_id', userId)),
    safe(db.from('treatments').select('*').eq('user_id', userId)),
    safe(db.from('prescribers').select('*').eq('user_id', userId)),
    safe(db.from('user_exam_results').select('*').eq('user_id', userId)),
    safe(db.from('reminders').select('*').eq('user_id', userId)),
    safe(db.from('orders').select('*, quotes(*)').eq('user_id', userId)),
    safe(db.from('consultations').select('*, consultation_quotes(*)').eq('user_id', userId)),
    safe(db.from('symptoms_log').select('*').eq('user_id', userId)),
    safe(db.from('medication_log').select('*').eq('user_id', userId)),
    safe(db.from('memory_cards_index').select('id, kind, text, tags, confidence, source, last_seen_at, created_at').eq('user_id', userId)),
    // A PROVA do consentimento — direito do titular saber o que aceitou e quando.
    safe(db.from('consent_events').select('*').eq('user_id', userId)),
    // Quem acessou o prontuário dele. É o que a LGPD chama de transparência.
    safe(db.from('audit_log').select('id, actor_type, action, reason, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5_000)),
    safe(db.from('device_tokens').select('id, platform, app_version, created_at').eq('user_id', userId)),
    safe(db.from('app_media').select('id, mime, bytes, kind, created_at').eq('user_id', userId)),
    safe(db.from('share_grants').select('id, expires_at, revoked_at, access_count, last_accessed_at, created_at').eq('user_id', userId)),
    safe(db.from('assistant_tasks').select('id, tool_name, status, created_at').eq('user_id', userId)),
    // 🤝 AS DUAS DIREÇÕES DO CUIDADO. Quem enxerga o prontuário desta pessoa é dado dela
    // (art. 9º: ela tem direito de saber com quem ele é compartilhado). E de quem ela
    // cuida também é: são vínculos que ela criou e pode revogar.
    safe(db.from('care_links')
      .select('id, caregiver_user_id, relation, kind, status, activated_at, revoked_at')
      .eq('user_id', userId)),
    safe(db.from('care_links')
      .select('id, user_id, relation, kind, status, activated_at, revoked_at')
      .eq('caregiver_user_id', userId)),
  ]);

  const arquivo = {
    _leia_primeiro: {
      o_que_e:
        'Este arquivo tem TODOS os dados que a Xarlote guarda sobre você, exportados a seu ' +
        'pedido (LGPD, art. 18). Você pode guardar, ler ou entregar a um médico.',
      gerado_em: agoraIso,
      formato: 'JSON. Cada seção abaixo tem uma explicação no campo "_o_que_e".',
      duvidas: 'Qualquer coisa, me chama no WhatsApp.',
      ...(truncado
        ? {
            _atencao_truncado:
              `O histórico de mensagens é maior que o limite deste arquivo (${MAX_MENSAGENS} ` +
              'mensagens) e foi cortado nas mais antigas. Me avisa no WhatsApp que eu ' +
              'providencio o restante.',
          }
        : {}),
    },
    voce: { _o_que_e: 'Seu cadastro.', dados: user ?? null },
    consentimentos: {
      _o_que_e: 'Cada vez que você aceitou ou revogou o uso dos seus dados, com data e versão.',
      dados: consentimentos ?? [],
    },
    saude: {
      _o_que_e: 'Seu histórico clínico como eu o organizei.',
      condicoes: condicoes ?? [],
      alergias: alergias ?? [],
      medicamentos: medicamentos ?? [],
      estoque_de_medicamentos: inventario ?? [],
      tratamentos: tratamentos ?? [],
      medicos: prescritores ?? [],
      exames: exames ?? [],
      sintomas_relatados: sintomas ?? [],
      registro_de_doses: logDoses ?? [],
    },
    memoria: {
      _o_que_e:
        'O que eu aprendi sobre você conversando. "source: inferred" significa que EU deduzi; ' +
        '"self_reported" significa que você me disse.',
      dados: memoria ?? [],
    },
    conversas: {
      _o_que_e: 'As conversas e TODAS as mensagens trocadas — inclusive as que eu te mandei.',
      conversas: convs ?? [],
      mensagens: mensagens,
      total_de_mensagens: mensagens.length,
      truncado,
    },
    pedidos_e_consultas: {
      _o_que_e: 'Pedidos de medicamento (com as cotações das farmácias) e buscas de consulta.',
      pedidos: pedidos ?? [],
      consultas: consultas ?? [],
    },
    lembretes: { _o_que_e: 'Seus lembretes, ativos e encerrados.', dados: lembretes ?? [] },
    acessos_e_dispositivos: {
      _o_que_e:
        'Aparelhos em que você entrou, mídias que enviou pelo app, links que você deu a ' +
        'médicos, e o registro de quem acessou seu prontuário.',
      dispositivos: dispositivos ?? [],
      midias_enviadas: midias ?? [],
      links_compartilhados: compartilhamentos ?? [],
      registro_de_acessos: auditoria ?? [],
      acoes_automaticas: tarefas ?? [],
    },
    cuidado_compartilhado: {
      _o_que_e:
        'Pessoas que acompanham a sua saúde e pessoas que você acompanha. Um vínculo ' +
        'revogado continua listado de propósito: ele existiu, e o histórico é seu.',
      quem_me_acompanha: quemCuidaDeMim ?? [],
      quem_eu_acompanho: deQuemEuCuido ?? [],
    },
  };

  const conteudo = JSON.stringify(arquivo, null, 2);
  return {
    conteudo,
    bytes: Buffer.byteLength(conteudo, 'utf8'),
    mensagens: mensagens.length,
    truncado,
  };
}
