-- 0031 — Memória sem meia-vida: preferência e episódio deixam de desbotar.
--
-- ANTES: `match_user_memory` multiplicava a similaridade por um fator de decay
-- exponencial — `episode` com meia-vida de 90 dias, `preference` de 180. Um
-- episódio de 3 meses valia metade; de 6 meses, um quarto. Como o retrieval leva
-- só os 8 melhores, na prática o passado saía de cena mesmo continuando no banco.
--
-- DECISÃO DO FUNDADOR (31/08/2026): preferência e episódio são para SEMPRE. O que
-- a pessoa contou há um ano sobre como ela gosta de ser cuidada não vale menos
-- hoje. O controle de volume passa a ser feito na ESCRITA (o card novo corrige o
-- antigo em vez de acumular) e na CONSOLIDAÇÃO periódica — não pelo esquecimento.
--
-- DEPOIS: ranking = pura similaridade semântica, para os quatro tipos.
-- `decayed_score` é MANTIDO na assinatura (o tipo TS e o fallback consomem) e
-- passa a valer exatamente `similarity` — nome preservado por compatibilidade.
--
-- O `last_seen_at desc` é DESEMPATE DETERMINÍSTICO, não recência disfarçada: só
-- decide entre cards de similaridade idêntica, o que com floats é raro. Sem ele,
-- dois cards empatados sairiam em ordem arbitrária do Postgres e o prompt mudaria
-- entre turnos sem nada ter mudado.

create or replace function public.match_user_memory(
  p_user_id uuid,
  p_query_embedding vector,
  p_k integer default 8,
  p_min_similarity double precision default 0.55
)
returns table(
  id uuid,
  kind text,
  text text,
  tags text[],
  confidence numeric,
  source text,
  last_seen_at timestamp with time zone,
  similarity double precision,
  decayed_score double precision
)
language sql
stable
as $function$
  with scored as (
    select
      m.id, m.kind, m.text, m.tags, m.confidence, m.source, m.last_seen_at,
      1 - (m.embedding <=> p_query_embedding) as similarity
    from memory_cards_index m
    where m.user_id = p_user_id
      and m.embedding is not null
  )
  select
    id, kind, text, tags, confidence, source, last_seen_at, similarity,
    similarity as decayed_score
  from scored
  where similarity >= p_min_similarity
  order by similarity desc, last_seen_at desc
  limit p_k;
$function$;

-- A função é SECURITY INVOKER (default). O REVOKE segue o padrão das demais:
-- só o backend (service_role) chama; o front usa anon + RLS e não tem por que
-- ler memória de ninguém por RPC.
revoke all on function public.match_user_memory(uuid, vector, integer, double precision) from anon;
