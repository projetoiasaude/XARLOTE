-- 0014 — Resultados de exames no perfil (Fase 5).
--
-- Quando o paciente compartilha um exame/laudo (foto), a Xarlote LÊ pelo canal
-- multimodal (vision), NÃO interpreta clinicamente, e — se o paciente confirmar —
-- guarda o resultado aqui pra consultar depois ("você fez hemograma dia 10, os
-- valores foram X"). É dado clínico sensível (LGPD): RLS ligada SEM policy pública
-- (só o service role do backend acessa, igual device_tokens), cascata no delete do
-- usuário (forget-me), e nada de valores em log ≥ info.
create table if not exists user_exam_results (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  message_id      uuid references messages(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  exam_type       text not null,             -- 'sangue' | 'imagem' | 'urina' | 'cardiologico' | 'covid' | 'outro' ...
  title           text,                       -- ex.: "Hemograma completo", "Raio-X tórax"
  summary         text,                       -- resumo textual curto (SEM interpretação clínica)
  findings        jsonb not null default '[]'::jsonb,  -- [{ marker, value, unit, reference }]
  exam_date       date,                       -- data do exame, se legível na imagem
  source          text not null default 'vision',      -- 'vision' (lido da foto) | 'self_reported'
  confidence      numeric,                    -- confiança da leitura (0-1)
  created_at      timestamptz not null default now()
);

create index if not exists user_exam_results_user_idx on user_exam_results(user_id, created_at desc);

-- RLS ligada, SEM policy pública: exame é dado clínico sensível, só o service role
-- (backend / admin via API) acessa. O anon/cliente nunca lê isto direto.
alter table user_exam_results enable row level security;
