/**
 * Conversation Compactor — comprime conversas longas em memory cards "episode".
 *
 * Roda 1×/hora. Procura conversas com mais de 50 mensagens, condensa as 30
 * mais antigas em 1 card episódico, e mantém só as 20 mais recentes no
 * contexto da Xarlote. Mensagens originais ficam no BD (pra LGPD), mas saem
 * do payload da próxima turn.
 *
 * Observação: o "sair do contexto" é gerenciado por `getConversationMessages(_, 30)`
 * em inbound-user.ts — sempre limita a 30. O compactor garante que mesmo
 * histórico longo gere cards persistentes em vez de virar contexto descartado.
 */
import { db, saveMemoryCard, writeLog } from '@iasaude/db';
import { chat, embed } from '@iasaude/llm';
import { randomUUID } from 'crypto';
import { loadPrompts } from '../config/prompts.js';

const COMPACTION_THRESHOLD = 50;        // dispara quando conversa passa disso
const COMPACTION_BATCH_SIZE = 30;       // condensa as N mais antigas dentre as não compactadas
const KEEP_RECENT = 20;                  // mantém últimas 20 sempre

// Config de modelos pela MESMA via da API (loadPrompts resolve via __dirname —
// process.cwd() quebrava quando o worker não roda da raiz do repo).
function loadModels(): { model: string; apiKey: string } {
  const cfg = loadPrompts();
  return {
    model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
    apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'] || '',
  };
}

const COMPACTOR_SYSTEM = `Você condensa conversas WhatsApp entre Xarlote e USUÁRIO em RESUMOS curtos preservando contexto importante de saúde.

Devolva APENAS uma string JSON com a chave "episodes": array de 1 a 3 frases curtas (≤140 chars cada) descrevendo o que aconteceu, em terceira pessoa, focando em decisões/sintomas/eventos durables. Ignore conversa fiada e reconfirmações.

Exemplo: {"episodes": ["Pediu paracetamol 500mg, fechou em Drogasil por R$8 dia 12/04", "Reclamou de dor de cabeça leve à tarde, hidratou e melhorou"]}`;

export async function compactStaleConversations(): Promise<void> {
  const traceId = randomUUID();

  // Procura conversas longas — usa contagem rápida via head:true count:'exact' no Supabase
  const { data: candidates } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('party_type', 'user')
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(50);

  if (!candidates?.length) return;

  const { model, apiKey } = loadModels();
  if (!apiKey) return;

  for (const conv of candidates) {
    if (!conv.user_id) continue;

    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id);

    if (!count || count < COMPACTION_THRESHOLD) continue;

    // Busca msgs antigas (excluindo as KEEP_RECENT mais novas) e que ainda não foram compactadas
    // Compactadas levam flag em raw_payload.compacted_at — assim não viram episode 2x.
    const { data: oldMsgs } = await db
      .from('messages')
      .select('id, sender_role, content, transcript, content_type, created_at, raw_payload')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true })
      .limit(COMPACTION_BATCH_SIZE);

    if (!oldMsgs?.length) continue;
    const notYetCompacted = oldMsgs.filter((m) => {
      const raw = (m.raw_payload as { compacted_at?: string } | null) ?? null;
      return !raw?.compacted_at;
    });
    if (notYetCompacted.length < 10) continue;

    const transcript = notYetCompacted
      .map((m) => `${m.sender_role === 'user' ? 'USUÁRIO' : 'XARLOTE'}: ${m.transcript || m.content || `[${m.content_type}]`}`)
      .join('\n');

    try {
      const resp = await chat(transcript, {
        model,
        apiKey,
        systemInstruction: COMPACTOR_SYSTEM,
        temperature: 0.2,
        maxOutputTokens: 400,
        timeoutMs: 25_000,
      });
      const m = resp.text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]) as { episodes?: string[] };
      for (const ep of parsed.episodes ?? []) {
        if (!ep || ep.length > 200) continue;
        let embedding: number[] | null = null;
        try { embedding = await embed(ep, { apiKey, timeoutMs: 10_000 }); } catch {}
        await saveMemoryCard({
          userId: conv.user_id,
          conversationId: conv.id,
          kind: 'episode',
          text: ep,
          tags: ['compactado'],
          confidence: 0.85,
          source: 'inferred',
          embedding,
        });
      }

      // Marca essas mensagens como compactadas (preserva raw_payload original)
      const ids = notYetCompacted.map((x) => x.id);
      const stamp = new Date().toISOString();
      for (const msgId of ids) {
        const orig = notYetCompacted.find((x) => x.id === msgId);
        const raw = (orig?.raw_payload as Record<string, unknown> | null) ?? {};
        await db.from('messages')
          .update({ raw_payload: { ...raw, compacted_at: stamp } })
          .eq('id', msgId);
      }

      await writeLog('info', 'compactor', `Conv ${conv.id}: ${notYetCompacted.length} msgs → ${parsed.episodes?.length ?? 0} ep(s)`, {
        traceId, conversationId: conv.id,
      });
    } catch (err) {
      await writeLog('warn', 'compactor', `Compactação falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
  }

  // suprime warning de variável não usada se KEEP_RECENT só serve como referência
  void KEEP_RECENT;
}
