-- Memória evolutiva da Xarlote — pgvector + memory_cards_index + transcript
-- Aplicar via SQL Editor do Supabase ou scripts/apply-migration-file.ts.

-- 1. Habilitar pgvector
create extension if not exists vector;

-- 2. Coluna de transcrição em messages (pra áudio transcrito)
alter table messages add column if not exists transcript text;

-- 3. Tabela indexada de memory cards (espelho denormalizado pra retrieval rápido)
-- O JSONB conversations.memory_cards continua sendo a fonte canônica (pra LGPD/portabilidade).
-- Essa tabela é só pra fazer kNN com embeddings.
create table if not exists memory_cards_index (
  id              uuid primary key,
  user_id         uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  kind            text not null check (kind in ('fact', 'episode', 'preference', 'affect')),
  text            text not null,
  tags            text[] default '{}',
  confidence      numeric not null default 0.8,
  source          text not null default 'inferred' check (source in ('self_reported', 'inferred')),
  embedding       vector(1536),
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists memory_cards_user_idx on memory_cards_index(user_id);
create index if not exists memory_cards_kind_idx on memory_cards_index(user_id, kind);
create index if not exists memory_cards_last_seen_idx on memory_cards_index(user_id, last_seen_at desc);

-- ivfflat exige ANALYZE antes de virar útil; com poucos rows o seqscan basta.
-- Quando tiver volume, rodar: create index ... using ivfflat (embedding vector_cosine_ops) with (lists=100);
create index if not exists memory_cards_embedding_idx
  on memory_cards_index
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- 4. Função utilitária pra similarity search com decay temporal
-- Retorna top-K cards do usuário, ordenados por (similarity * decay_factor).
-- Decay: fact/affect nunca decai; episode 90d half-life; preference 180d half-life.
create or replace function match_user_memory(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_k int default 8,
  p_min_similarity float default 0.55
) returns table (
  id uuid,
  kind text,
  text text,
  tags text[],
  confidence numeric,
  source text,
  last_seen_at timestamptz,
  similarity float,
  decayed_score float
) language sql stable as $$
  with scored as (
    select
      m.id, m.kind, m.text, m.tags, m.confidence, m.source, m.last_seen_at,
      1 - (m.embedding <=> p_query_embedding) as similarity,
      case
        when m.kind in ('fact', 'affect') then 1.0
        when m.kind = 'episode' then exp(-extract(epoch from (now() - m.last_seen_at)) / (90.0 * 86400))
        when m.kind = 'preference' then exp(-extract(epoch from (now() - m.last_seen_at)) / (180.0 * 86400))
        else 0.5
      end as decay
    from memory_cards_index m
    where m.user_id = p_user_id
      and m.embedding is not null
  )
  select
    id, kind, text, tags, confidence, source, last_seen_at, similarity,
    similarity * decay as decayed_score
  from scored
  where similarity >= p_min_similarity
  order by decayed_score desc
  limit p_k;
$$;

-- 5. Cleanup do esquecimento — direito ao apagar deve cascatear via FK on delete cascade.
-- Já tá coberto pelo `references users(id) on delete cascade` acima.
