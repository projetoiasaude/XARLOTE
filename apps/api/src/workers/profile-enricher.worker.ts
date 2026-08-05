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
function loadModels(): { model: string; apiKey: string; fallbackModel: string | null } {
  const cfg = loadPrompts();
  const model = cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini';
  // Modelo de SEGUNDA tentativa. Re-tentar o mesmo que acabou de devolver vazio é esperar que
  // o dado mude sozinho — em 05/08 as duas tentativas voltaram vazias com 10s de intervalo.
  // `gpt-4.1-mini` é o que já está configurado pra visão neste projeto, então não introduz
  // dependência nova; se o primário JÁ for ele, não há fallback a oferecer.
  const alternativo = cfg.vision_model || 'openai/gpt-4.1-mini';
  return {
    model,
    apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'] || '',
    fallbackModel: alternativo && alternativo !== model ? alternativo : null,
  };
}

/**
 * Extrai o objeto JSON de uma resposta de LLM, tolerando o que o modelo faz de verdade.
 *
 * Cobre (auditoria 05/08): cerca markdown (```json), prosa antes/depois, e — o caso que
 * mais dói — JSON **TRUNCADO** pelo teto de tokens, que morria no parse com o dado quase
 * pronto. Fechar chaves/colchetes pendentes recupera os `facts` já emitidos em vez de
 * jogar o turno inteiro no lixo.
 */
export function extractJsonObject(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const semCerca = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
  const ini = semCerca.indexOf('{');
  if (ini < 0) return null;

  // Varre equilibrando, respeitando string e escape — chave dentro de texto não conta.
  let prof = 0;
  const pilha: string[] = [];
  let emString = false;
  let escape = false;
  let fim = -1;
  for (let i = ini; i < semCerca.length; i += 1) {
    const c = semCerca[i]!;
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === '{' || c === '[') { pilha.push(c === '{' ? '}' : ']'); prof += 1; }
    else if (c === '}' || c === ']') { pilha.pop(); prof -= 1; if (prof === 0) { fim = i; break; } }
  }
  if (fim >= 0) return semCerca.slice(ini, fim + 1);

  // TRUNCADO: fecha o que ficou aberto. Remove cauda parcial (vírgula/chave/valor pela metade)
  // pra não gerar JSON inválido de propósito.
  let corpo = semCerca.slice(ini);
  if (emString) corpo += '"';
  corpo = corpo.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  const fecho = pilha.reverse().join('');
  const candidato = corpo + fecho;
  try { JSON.parse(candidato); return candidato; } catch { return null; }
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

  const { model, apiKey, fallbackModel } = loadModels();
  if (!apiKey) {
    await writeLog('warn', 'enrichment', 'Profile enricher sem API key — pulando', { traceId });
    return;
  }

  // 4. Chama LLM extrator — com RETRY (review item 11): o glm-5.2 às vezes devolve prosa antes/depois
  // do JSON (ou nenhum JSON). Uma 2ª tentativa com instrução mais firme costuma resolver — sem ela a
  // memória DESTE turno se perdia (afetou o Waldik em 09/07). Roda no worker (async), sem custo p/ o user.
  let parsed: EnrichOutput | null = null;
  for (let attempt = 1; attempt <= 2 && parsed === null; attempt++) {
    try {
      const resp = await chat(transcript, {
        model,
        apiKey,
        systemInstruction:
          attempt === 1
            ? PROFILE_ENRICHER_SYSTEM
            : `${PROFILE_ENRICHER_SYSTEM}\n\nIMPORTANTE: responda APENAS com o objeto JSON válido, sem nenhum texto, explicação ou markdown antes ou depois.`,
        temperature: 0.1,
        // 800 era apertado: uma resposta longa era CORTADA no meio do JSON e o parse morria
        // com o dado quase pronto. O custo de 1200 é irrelevante perto de perder a memória.
        maxOutputTokens: 1200,
        timeoutMs: 30_000,
        // 🔴 JSON pelo PROTOCOLO, não pelo pedido (auditoria 05/08). Nas 8 falhas registradas,
        // 7 tinham `preview: ''` — o modelo devolveu VAZIO, não JSON quebrado. A instrução
        // firme no prompt da 2ª tentativa não mudou nada: às 13:20 as duas tentativas voltaram
        // vazias, 10 segundos uma da outra. Quando a saída TEM que ser JSON, pedir no protocolo
        // é mais forte que pedir no prompt.
        jsonMode: true,
        // Cross-model na 2ª tentativa: re-tentar o MESMO modelo que acabou de voltar vazio é
        // esperar que o dado mude sozinho. Foi a lição do turno vazio do agente-clínica.
        ...(attempt === 2 && fallbackModel ? { model: fallbackModel } : {}),
      });
      // Vazio e malformado são falhas DIFERENTES e precisam ser distinguíveis no log: uma é
      // do modelo, a outra é do parser, e confundi-las custou uma investigação inteira.
      if (!resp.text.trim()) {
        await writeLog(attempt === 1 ? 'info' : 'warn', 'enrichment', `Enricher: modelo devolveu VAZIO (tentativa ${attempt}/2) [${resp.model}] ${resp.tokensIn}in/${resp.tokensOut}out`, {
          traceId, model: resp.model, tokensOut: resp.tokensOut,
        });
        continue;
      }
      const jsonMatch = extractJsonObject(resp.text);
      if (!jsonMatch) {
        await writeLog(attempt === 1 ? 'info' : 'warn', 'enrichment', `Enricher: resposta sem JSON reconhecível (tentativa ${attempt}/2)`, { traceId, preview: resp.text.slice(0, 200) });
        continue; // re-tenta com a instrução firme
      }
      parsed = JSON.parse(jsonMatch) as EnrichOutput;
    } catch (err) {
      // JSON.parse malformado OU o chat lançou (timeout/rede). Re-tenta na 1ª; na 2ª, desiste.
      await writeLog(attempt === 1 ? 'info' : 'error', 'enrichment', `Enricher parse/LLM falhou (tentativa ${attempt}/2): ${String(err).slice(0, 160)}`, { traceId });
      if (attempt === 2) captureError(err, { traceId, phase: 'enricher-llm', conversationId });
    }
  }
  if (parsed === null) {
    await writeLog('warn', 'enrichment', 'Enricher: sem JSON válido após 2 tentativas — memória deste turno não enriquecida', { traceId });
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
    } catch (e) { await writeLog('debug', 'enrichment', `enricher: insert estruturado falhou — ${String(e).slice(0, 90)}`, { traceId }); }
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
    } catch (e) { await writeLog('debug', 'enrichment', `enricher: insert estruturado falhou — ${String(e).slice(0, 90)}`, { traceId }); }
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
    } catch (e) { await writeLog('debug', 'enrichment', `enricher: insert estruturado falhou — ${String(e).slice(0, 90)}`, { traceId }); }
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
    } catch (e) { await writeLog('debug', 'enrichment', `enricher: insert estruturado falhou — ${String(e).slice(0, 90)}`, { traceId }); }
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
    let embFails = 0;
    for (const o of orphans ?? []) {
      try {
        const emb = await embed(o.text, { apiKey, timeoutMs: 12_000 });
        await db.from('memory_cards_index').update({ embedding: emb }).eq('id', o.id);
      } catch {
        // 1 falha NÃO abandona o lote (antes era `break` → um erro transitório
        // deixava os outros órfãos invisíveis por horas). Só para se instável (3+).
        embFails++;
        if (embFails >= 3) break;
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
