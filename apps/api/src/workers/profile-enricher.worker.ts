/**
 * Profile Enricher — extrai fatos das últimas mensagens do usuário e atualiza:
 *   - Tabelas estruturadas: user_health_conditions / allergies / medications / addresses
 *   - memory_cards: fact / episode / preference / affect (com embedding pra retrieval)
 *
 * Roda em background depois de cada turn do usuário (enfileirado pelo
 * inbound-user). Falhar é OK — não impacta a resposta da Xarlote.
 */
import { Worker, type Job } from 'bullmq';
import { db, saveMemoryCard, writeLog, writeAudit, auditMemoryWrite } from '@iasaude/db';
import { chat, embed } from '@iasaude/llm';
import { PROFILE_ENRICHER_SYSTEM } from '@iasaude/llm';
import type { ProfileEnricherJob } from '@iasaude/shared';
import { QUEUE_NAMES } from '@iasaude/shared';
import { captureError } from '../observability/sentry.js';
import { getRedisConnection } from '../queue-config.js';
import { loadPrompts } from '../config/prompts.js';
import { withUserLock } from '../concurrency/user-lock.js';

interface EnrichOutput {
  facts?: Array<{ text: string; tags?: string[]; confidence: number }>;
  episodes?: Array<{ text: string; tags?: string[]; confidence: number }>;
  preferences?: Array<{ text: string; tags?: string[]; confidence: number }>;
  affects?: Array<{ text: string; tags?: string[]; confidence: number }>;
  allergies?: Array<{ substance: string; severity?: string; confidence: number }>;
  conditions?: Array<{ name: string; severity?: string; confidence: number }>;
  medications?: Array<{ medication_name: string; dosage?: string; frequency?: string; confidence: number }>;
  addresses?: Array<{ label?: string; street?: string; neighborhood?: string; city?: string; state?: string; cep?: string; confidence: number }>;
}

const MIN_CONFIDENCE = 0.7;

// Config de modelos pela MESMA via da API (loadPrompts resolve o prompts.json
// via __dirname — process.cwd() quebrava quando o worker não roda da raiz do repo).
function loadModels(): { model: string; apiKey: string } {
  const cfg = loadPrompts();
  return {
    model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
    apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'] || '',
  };
}

async function processEnrichment(job: Job<ProfileEnricherJob>): Promise<void> {
  const { conversationId, messageIds, traceId } = job.data;

  // 1. Carrega conversa + user
  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv?.user_id) return;
  const userId = conv.user_id;

  // 2. Carrega últimas N mensagens (transcript prevalece sobre content quando áudio)
  const { data: msgs } = await db
    .from('messages')
    .select('id, direction, sender_role, content, transcript, content_type, created_at')
    .in('id', messageIds)
    .order('created_at', { ascending: true });
  if (!msgs?.length) return;

  // 3. Monta transcrição da turn pra extrator
  const transcript = msgs
    .map((m) => {
      const who = m.sender_role === 'user' ? 'USUÁRIO' : 'XARLOTE';
      const text = m.transcript || m.content || (m.content_type === 'image' ? '[enviou uma imagem]' : `[${m.content_type}]`);
      return `${who}: ${text}`;
    })
    .join('\n');

  if (!transcript.trim()) return;

  const { model, apiKey } = loadModels();
  if (!apiKey) {
    await writeLog('warn', 'enrichment', 'Profile enricher sem API key — pulando', { traceId });
    return;
  }

  // 4. Chama LLM extrator
  let parsed: EnrichOutput;
  try {
    const resp = await chat(transcript, {
      model,
      apiKey,
      systemInstruction: PROFILE_ENRICHER_SYSTEM,
      temperature: 0.1,
      maxOutputTokens: 800,
      timeoutMs: 30_000,
    });
    const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await writeLog('warn', 'enrichment', 'Enricher: sem JSON na resposta', { traceId, preview: resp.text.slice(0, 200) });
      return;
    }
    parsed = JSON.parse(jsonMatch[0]) as EnrichOutput;
  } catch (err) {
    await writeLog('error', 'enrichment', `Enricher LLM falhou: ${String(err).slice(0, 200)}`, { traceId });
    captureError(err, { traceId, phase: 'enricher-llm', conversationId });
    return;
  }

  let saved = 0;

  // escala-segura (Fase 2): serializa SÓ os check-then-insert das tabelas
  // estruturadas (rápidos, é onde mora a corrida). A extração via LLM (acima) e os
  // embeddings dos memory cards (abaixo) rodam FORA do lock — são lentos (HTTP) e
  // segurá-los aqui estouraria o TTL do lock, reabrindo a corrida que ele evita.
  const acquired = await withUserLock(userId, async () => {
  // 5. Salva nas tabelas estruturadas (com source='inferred')
  for (const a of parsed.allergies ?? []) {
    if (a.confidence < MIN_CONFIDENCE) continue;
    try {
      // check-then-insert: upsert com onConflict 'user_id,substance' ERRA porque
      // essa unique constraint não existe no schema — alergia inferida nunca salvava.
      const { data: existing } = await db
        .from('user_allergies')
        .select('id')
        .eq('user_id', userId)
        .ilike('substance', a.substance)
        .maybeSingle();
      if (!existing) {
        const { error } = await db.from('user_allergies').insert({
          user_id: userId,
          substance: a.substance,
          severity: a.severity ?? null,
          source: 'inferred',
        });
        if (!error) saved++;
      }
    } catch {}
  }
  for (const c of parsed.conditions ?? []) {
    if (c.confidence < MIN_CONFIDENCE) continue;
    try {
      const { data: existing } = await db
        .from('user_health_conditions')
        .select('id')
        .eq('user_id', userId)
        .ilike('name', c.name)
        .maybeSingle();
      if (!existing) {
        const { error } = await db.from('user_health_conditions').insert({
          user_id: userId,
          name: c.name,
          severity: c.severity ?? null,
          active: true,
          source: 'inferred',
        });
        if (!error) saved++;
      }
    } catch {}
  }
  for (const m of parsed.medications ?? []) {
    if (m.confidence < MIN_CONFIDENCE) continue;
    try {
      const { data: existing } = await db
        .from('user_medications')
        .select('id')
        .eq('user_id', userId)
        .ilike('medication_name', m.medication_name)
        .maybeSingle();
      if (!existing) {
        const { error } = await db.from('user_medications').insert({
          user_id: userId,
          medication_name: m.medication_name,
          dosage: m.dosage ?? null,
          frequency: m.frequency ?? null,
          active: true,
          source: 'inferred',
        });
        if (!error) saved++;
      }
    } catch {}
  }
  for (const ad of parsed.addresses ?? []) {
    if (ad.confidence < MIN_CONFIDENCE) continue;
    if (!ad.street && !ad.cep) continue;
    try {
      // Dedupe: janelas de turno sobrepostas re-extraem o mesmo endereço — sem
      // checagem, cada turno inseria uma linha nova.
      let dupQuery = db.from('user_addresses').select('id').eq('user_id', userId).limit(1);
      dupQuery = ad.street ? dupQuery.ilike('street', ad.street) : dupQuery.eq('cep', ad.cep!);
      const { data: existing } = await dupQuery.maybeSingle();
      if (existing) continue;

      const { error } = await db.from('user_addresses').insert({
        user_id: userId,
        label: ad.label ?? 'inferido',
        street: ad.street ?? null,
        neighborhood: ad.neighborhood ?? null,
        city: ad.city ?? null,
        state: ad.state ?? null,
        cep: ad.cep ?? null,
        is_default: false,
      });
      if (!error) saved++;
    } catch {}
  }
  }); // withUserLock — fim da seção serializada (só os check-then-insert estruturados)

  // Lock ocupado e não liberou na janela → o check-then-insert desta turn foi
  // pulado (outro enricher do mesmo user está escrevendo). Observabilidade: loga
  // com os ids pra não ser invisível. (Cards/embeddings abaixo seguem normalmente.)
  if (acquired === null) {
    await writeLog('warn', 'enrichment', 'Enricher: lock de usuário ocupado — inserts estruturados pulados nesta turn', {
      traceId, conversationId, userId,
    });
  }

  // 6. Memory cards (com embedding)
  type CardCandidate = { kind: 'fact' | 'episode' | 'preference' | 'affect'; text: string; tags: string[]; confidence: number };
  const candidates: CardCandidate[] = [
    ...(parsed.facts ?? []).map((c) => ({ kind: 'fact' as const, text: c.text, tags: c.tags ?? [], confidence: c.confidence })),
    ...(parsed.episodes ?? []).map((c) => ({ kind: 'episode' as const, text: c.text, tags: c.tags ?? [], confidence: c.confidence })),
    ...(parsed.preferences ?? []).map((c) => ({ kind: 'preference' as const, text: c.text, tags: c.tags ?? [], confidence: c.confidence })),
    ...(parsed.affects ?? []).map((c) => ({ kind: 'affect' as const, text: c.text, tags: c.tags ?? [], confidence: c.confidence })),
  ].filter((c) => c.confidence >= MIN_CONFIDENCE && c.text.length > 0 && c.text.length <= 200);

  for (const c of candidates) {
    let embedding: number[] | null = null;
    try {
      embedding = await embed(c.text, { apiKey, timeoutMs: 12_000 });
    } catch (err) {
      // embedding falha não bloqueia — card vai sem embedding (cai no fallback de retrieval)
      await writeLog('warn', 'enrichment', `embed falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
    const card = await saveMemoryCard({
      userId,
      conversationId,
      kind: c.kind,
      text: c.text,
      tags: c.tags,
      confidence: c.confidence,
      source: 'inferred',
      embedding,
    });
    if (card?.id) {
      await auditMemoryWrite({
        userId,
        cardId: card.id,
        kind: c.kind,
        text: c.text,
        confidence: c.confidence,
        operation: 'saved',
        conversationId,
        traceId,
      });
    }
    saved++;
  }

  // 7. Backfill de embeddings: card que nasceu sem embedding (falha transitória
  //    do /embeddings) ficava INVISÍVEL pro retrieval semântico pra sempre.
  //    Cada turno re-tenta um lote pequeno — auto-cura sem job dedicado.
  try {
    const { data: orphans } = await db
      .from('memory_cards_index')
      .select('id, text')
      .eq('user_id', userId)
      .is('embedding', null)
      .limit(10);
    for (const o of orphans ?? []) {
      try {
        const emb = await embed(o.text, { apiKey, timeoutMs: 12_000 });
        await db.from('memory_cards_index').update({ embedding: emb }).eq('id', o.id);
      } catch {
        break; // /embeddings instável agora — tenta de novo no próximo turno
      }
    }
  } catch {}

  await writeLog('info', 'enrichment', `Enricher gravou ${saved} item(s)`, {
    traceId, conversationId, userId,
    counts: {
      cards: candidates.length,
      allergies: parsed.allergies?.length ?? 0,
      conditions: parsed.conditions?.length ?? 0,
      medications: parsed.medications?.length ?? 0,
      addresses: parsed.addresses?.length ?? 0,
    },
  });
}

export function startProfileEnricherWorker(): Worker {
  const worker = new Worker(QUEUE_NAMES.PROFILE_ENRICHER, processEnrichment, {
    connection: getRedisConnection(),
    concurrency: 2,
  });
  worker.on('failed', (job, err) => {
    const traceId = (job?.data as ProfileEnricherJob | undefined)?.traceId;
    console.error(`[enricher] job ${job?.id} failed:`, err.message);
    captureError(err, { traceId, phase: 'enricher-job', jobId: job?.id });
  });
  return worker;
}
