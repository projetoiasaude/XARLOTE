/**
 * Profile Enricher — extrai fatos das últimas mensagens do usuário e atualiza:
 *   - Tabelas estruturadas: user_health_conditions / allergies / medications / addresses
 *   - memory_cards: fact / episode / preference / affect (com embedding pra retrieval)
 *
 * Roda em background depois de cada turn do usuário (enfileirado pelo
 * inbound-user). Falhar é OK — não impacta a resposta da Xarlote.
 */
import { Worker, type Job } from 'bullmq';
import { db, saveMemoryCard, writeLog } from '@iasaude/db';
import { chat, embed } from '@iasaude/llm';
import { PROFILE_ENRICHER_SYSTEM } from '@iasaude/llm';
import type { ProfileEnricherJob } from '@iasaude/shared';
import { QUEUE_NAMES } from '@iasaude/shared';
import { getRedisConnection } from '../queue-config.js';
import { readFileSync } from 'fs';
import { join } from 'path';

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

// Carrega config de modelos do prompts.json (mesmo arquivo que API usa).
// Worker e API rodam no mesmo container Railway, então o caminho relativo bate.
function loadModels(): { model: string; apiKey: string } {
  try {
    const raw = readFileSync(
      join(process.cwd(), 'apps/api/data/prompts.json'),
      'utf-8'
    );
    const cfg = JSON.parse(raw) as { llm_model?: string; llm_api_key?: string };
    return {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'] || '',
    };
  } catch {
    return {
      model: process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: process.env['OPENROUTER_API_KEY'] || '',
    };
  }
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
    return;
  }

  let saved = 0;

  // 5. Salva nas tabelas estruturadas (com source='inferred')
  for (const a of parsed.allergies ?? []) {
    if (a.confidence < MIN_CONFIDENCE) continue;
    try {
      const { error } = await db.from('user_allergies').upsert(
        {
          user_id: userId,
          substance: a.substance,
          severity: a.severity ?? null,
          source: 'inferred',
        },
        { onConflict: 'user_id,substance' }
      );
      if (!error) saved++;
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
    await saveMemoryCard({
      userId,
      conversationId,
      kind: c.kind,
      text: c.text,
      tags: c.tags,
      confidence: c.confidence,
      source: 'inferred',
      embedding,
    });
    saved++;
  }

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
    console.error(`[enricher] job ${job?.id} failed:`, err.message);
  });
  return worker;
}
