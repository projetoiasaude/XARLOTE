/**
 * Memória persistente da Xarlote — leitura e gravação de memory_cards.
 *
 * Fonte canônica: `conversations.memory_cards` (JSONB) — usada pra LGPD/portabilidade.
 * Espelho indexado: `memory_cards_index` (com embedding vector(1536)) — usado pro retrieval.
 *
 * Todas as funções aqui são tolerantes: se a migration ainda não rodou
 * (tabela memory_cards_index inexistente ou função RPC ausente), elas degradam
 * silenciosamente — o app continua funcionando, só sem memória semântica.
 */
import { db } from './client.js';
import type { MemoryCard, MemoryCardIndexed, MemoryKind } from '@iasaude/shared';
import { randomUUID } from 'crypto';

export interface SaveMemoryCardInput {
  userId: string;
  conversationId: string | null;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  confidence?: number;
  source?: 'self_reported' | 'inferred';
  embedding?: number[] | null;
}

/**
 * Insere um card novo (ou faz refresh do `last_seen_at` se já existir um
 * card MUITO parecido — dedup textual simples por enquanto).
 *
 * Persiste tanto no JSONB da conversa (canônico) quanto na tabela indexada.
 */
export async function saveMemoryCard(input: SaveMemoryCardInput): Promise<MemoryCardIndexed | null> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const card: MemoryCardIndexed = {
    id,
    user_id: input.userId,
    conversation_id: input.conversationId,
    kind: input.kind,
    text: input.text,
    tags: input.tags ?? [],
    confidence: input.confidence ?? 0.8,
    source: input.source ?? 'inferred',
    last_seen_at: now,
    created_at: now,
  };

  // 1) Dedup leve: existe card desse user com texto idêntico (case-insensitive)?
  // Se sim, só refresca last_seen_at e bump confidence.
  try {
    const { data: dup } = await db
      .from('memory_cards_index')
      .select('id, confidence, last_seen_at')
      .eq('user_id', input.userId)
      .ilike('text', input.text)
      .limit(1)
      .maybeSingle();
    if (dup?.id) {
      const newConf = Math.min(1, (dup.confidence ?? 0.8) + 0.05);
      await db
        .from('memory_cards_index')
        .update({ last_seen_at: now, confidence: newConf })
        .eq('id', dup.id);
      return { ...card, id: dup.id, confidence: newConf };
    }
  } catch {
    // tabela pode não existir ainda — ignora
  }

  // 1b) Dedup SEMÂNTICO: as janelas de turno do enricher se sobrepõem e o mesmo
  // fato volta PARAFRASEADO ("toma losartana de manhã" vs "usa losartana 50mg
  // pela manhã") — o dedupe textual não pega. Reusa o match_user_memory com
  // similaridade alta: se já existe card quase idêntico, só refresca.
  if (input.embedding && input.embedding.length === 1536) {
    try {
      const { data: similar } = await db.rpc('match_user_memory', {
        p_user_id: input.userId,
        p_query_embedding: `[${input.embedding.join(',')}]`,
        p_k: 1,
        p_min_similarity: 0.92,
      });
      const hit = Array.isArray(similar) ? (similar[0] as MemoryCardIndexed | undefined) : undefined;
      if (hit?.id && hit.kind === input.kind) {
        const newConf = Math.min(1, (hit.confidence ?? 0.8) + 0.05);
        await db
          .from('memory_cards_index')
          .update({ last_seen_at: now, confidence: newConf })
          .eq('id', hit.id);
        return { ...card, id: hit.id, text: hit.text, confidence: newConf };
      }
    } catch {
      // RPC pode não existir — segue pro insert normal
    }
  }

  // 2) Insere indexado (com embedding se houver)
  try {
    const insertPayload: Record<string, unknown> = {
      id, user_id: input.userId, conversation_id: input.conversationId,
      kind: input.kind, text: input.text, tags: input.tags ?? [],
      confidence: card.confidence, source: card.source,
      last_seen_at: now, created_at: now,
    };
    if (input.embedding && input.embedding.length === 1536) {
      // pgvector aceita string '[0.1,0.2,...]'
      insertPayload['embedding'] = `[${input.embedding.join(',')}]`;
    }
    const { error } = await db.from('memory_cards_index').insert(insertPayload);
    if (error) throw error;
  } catch (err) {
    // se tabela não existe ou erro de embedding shape, segue só com JSONB
    console.warn('[memory] memory_cards_index insert falhou:', String(err).slice(0, 200));
  }

  // 3) Append no JSONB canônico
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('memory_cards')
      .eq('id', input.conversationId)
      .maybeSingle();
    const existing: MemoryCard[] = Array.isArray(conv?.memory_cards) ? conv!.memory_cards : [];
    const cardForJsonb: MemoryCard = {
      id, kind: input.kind, text: input.text, tags: input.tags ?? [],
      confidence: card.confidence, source: card.source,
      last_seen_at: now, created_at: now,
    };
    await db
      .from('conversations')
      .update({ memory_cards: [...existing, cardForJsonb].slice(-200) })
      .eq('id', input.conversationId);
  } catch {
    // ignora — conversa pode ser de supplier sem user_id
  }

  return card;
}

/**
 * Busca top-K cards mais relevantes pro usuário, dado o embedding da query atual.
 * Aplica decay temporal via função SQL `match_user_memory`.
 *
 * Se a função RPC não existir (migration não rodou), faz fallback: retorna
 * os N cards mais recentes do JSONB da conversa.
 */
export async function retrieveRelevantCards(
  userId: string,
  conversationId: string | null,
  queryEmbedding: number[] | null,
  k = 8
): Promise<MemoryCardIndexed[]> {
  if (queryEmbedding && queryEmbedding.length === 1536) {
    try {
      const { data, error } = await db.rpc('match_user_memory', {
        p_user_id: userId,
        p_query_embedding: `[${queryEmbedding.join(',')}]`,
        p_k: k,
        p_min_similarity: 0.55,
      });
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data as MemoryCardIndexed[];
    } catch (err) {
      console.warn('[memory] match_user_memory RPC indisponível, fallback:', String(err).slice(0, 120));
    }
  }

  // Fallback: tabela indexada por last_seen_at (sem embedding)
  try {
    const { data } = await db
      .from('memory_cards_index')
      .select('*')
      .eq('user_id', userId)
      .order('last_seen_at', { ascending: false })
      .limit(k);
    if (Array.isArray(data) && data.length) return data as MemoryCardIndexed[];
  } catch {
    // ignora
  }

  // Último fallback: JSONB da conversa
  if (conversationId) {
    try {
      const { data: conv } = await db
        .from('conversations')
        .select('memory_cards')
        .eq('id', conversationId)
        .maybeSingle();
      const cards: MemoryCard[] = Array.isArray(conv?.memory_cards) ? conv!.memory_cards : [];
      return cards.slice(-k).map((c) => ({
        id: c.id ?? '',
        user_id: userId,
        conversation_id: conversationId,
        kind: c.kind ?? 'episode',
        text: c.text,
        tags: c.tags ?? [],
        confidence: c.confidence ?? 0.7,
        source: c.source ?? 'inferred',
        last_seen_at: c.last_seen_at ?? c.created_at,
        created_at: c.created_at,
      }));
    } catch {
      return [];
    }
  }
  return [];
}

/** Lista todos os cards de um user (pro dashboard). */
export async function listUserCards(userId: string, limit = 100): Promise<MemoryCardIndexed[]> {
  try {
    const { data } = await db
      .from('memory_cards_index')
      .select('*')
      .eq('user_id', userId)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    return (data ?? []) as MemoryCardIndexed[];
  } catch {
    return [];
  }
}

/** Apaga toda a memória indexada de um user (chamada no fluxo de "esquecer dados"). */
export async function deleteUserMemory(userId: string): Promise<void> {
  try {
    await db.from('memory_cards_index').delete().eq('user_id', userId);
  } catch {
    // ignore
  }
}
