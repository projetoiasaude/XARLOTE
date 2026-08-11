/**
 * `buildOverview(userId)` — o agregado da Saúde 360 num round-trip.
 *
 * Extraído da rota legada (`routes/app.ts`, o `overviewHandler` que resolvia o usuário
 * por TELEFONE) pra virar fonte ÚNICA: a rota nova autenticada e a legada chamam esta
 * função. Duas cópias divergiriam com o tempo, e divergência aqui significa a tela do
 * app mostrando uma coisa e o web outra pro mesmo paciente.
 *
 * Duas propriedades que o desenho preserva de propósito:
 *
 * · **Uma ida ao banco, em paralelo.** São 14 consultas independentes num `Promise.all`.
 *   Em série seriam 14 idas e voltas — numa rede móvel, a diferença entre a tela abrir
 *   e a tela demorar.
 *
 * · **Tabela ausente NÃO derruba a tela.** O `safe()` engole erro de consulta e devolve
 *   lista vazia. Ambientes parciais (staging sem alguma migration) e tabelas que ainda
 *   vão nascer não podem transformar a Saúde 360 num erro 500 — o paciente perde o
 *   acesso a TUDO por causa de uma seção que não existe.
 */
import { db } from '@iasaude/db';
import { SARA_INSTANCE } from '@iasaude/shared';

/** Erro de consulta vira lista vazia — ver o comentário do cabeçalho. */
function safe<T>(p: PromiseLike<{ data: T | null }>): Promise<{ data: T | null }> {
  return Promise.resolve(p).then(
    (r) => r,
    () => ({ data: null }),
  );
}

/**
 * O usuário que já foi RESOLVIDO por quem chama.
 *
 * Só `id` é exigido — o resto é repassado inteiro na resposta. A assinatura é frouxa
 * de propósito: as duas rotas trazem o usuário de `select('*')` por caminhos
 * diferentes (a legada por telefone, a nova pelo JWT), e apertar o tipo aqui obrigaria
 * uma delas a converter, o que é justamente onde campo se perde no caminho.
 */
export interface OverviewUser {
  id: string;
}

export async function buildOverview(user: OverviewUser): Promise<Record<string, unknown>> {
  const uid = user.id;

  const [
    conv, cond, allg, meds, inv, treat, presc, rem, ords, consults, mem, sympt, medlog, exams,
  ] = await Promise.all([
    safe(
      db.from('conversations').select('id')
        .eq('party_type', 'user').eq('user_id', uid).eq('whatsapp_instance', SARA_INSTANCE)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1).maybeSingle(),
    ),
    safe(db.from('user_health_conditions').select('*').eq('user_id', uid).order('created_at', { ascending: false })),
    safe(db.from('user_allergies').select('*').eq('user_id', uid).order('created_at', { ascending: false })),
    safe(db.from('user_medications').select('*').eq('user_id', uid).eq('active', true).order('created_at', { ascending: false })),
    safe(db.from('medication_inventory').select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(40)),
    safe(db.from('treatments').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
    safe(db.from('prescribers').select('id, name, crm, crm_state, specialty, clinic_id, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
    safe(
      db.from('reminders')
        .select('id, type, title, body, scheduled_at, rrule, next_run_at, status, payload, medication_id, created_at')
        .eq('user_id', uid)
        .order('next_run_at', { ascending: true, nullsFirst: false })
        .limit(60),
    ),
    safe(
      db.from('orders').select(
        `id, status, items, payment_method, delivery_address, created_at, updated_at, selected_quote_id,
         quotes ( id, status, total, subtotal, delivery_fee, eta_minutes, payment_methods, pix_key,
                  payment_link, notes, distance_km, conversation_id, created_at,
                  suppliers ( id, name, address, city, state, rating ) )`,
      ).eq('user_id', uid).order('created_at', { ascending: false }).limit(10),
    ),
    safe(
      db.from('consultations').select(
        `id, status, specialty, urgency, modality, city, scheduled_at, created_at,
         consultation_quotes ( id, status, proposed_datetime, price_brl, modality, notes, created_at,
                               clinics ( id, name, city, rating ) )`,
      ).eq('user_id', uid).order('created_at', { ascending: false }).limit(5),
    ),
    safe(
      db.from('memory_cards_index')
        .select('id, kind, text, tags, confidence, source, last_seen_at, created_at')
        .eq('user_id', uid).order('last_seen_at', { ascending: false }).limit(80),
    ),
    safe(db.from('symptoms_log').select('id, name, intensity, duration_hours, context, red_flag_triggered, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
    safe(db.from('medication_log').select('id, status, scheduled_at, responded_at, medication_id, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(180)),
    // NOVO no app nativo: a biblioteca de exames. A tabela existe desde a 0014 e
    // alimentava só a memória da Xarlote — nunca teve superfície pro paciente ver.
    safe(
      db.from('user_exam_results')
        .select('id, exam_type, exam_date, values, notes, source, created_at')
        .eq('user_id', uid).order('exam_date', { ascending: false, nullsFirst: false }).limit(60),
    ),
  ]);

  return {
    user,
    conversationId: (conv.data as { id: string } | null)?.id ?? null,
    conditions: cond.data ?? [],
    allergies: allg.data ?? [],
    medications: meds.data ?? [],
    inventory: inv.data ?? [],
    treatments: treat.data ?? [],
    prescribers: presc.data ?? [],
    reminders: rem.data ?? [],
    orders: ords.data ?? [],
    consultations: consults.data ?? [],
    memoryCards: mem.data ?? [],
    symptoms: sympt.data ?? [],
    medicationLog: medlog.data ?? [],
    examResults: exams.data ?? [],
  };
}
