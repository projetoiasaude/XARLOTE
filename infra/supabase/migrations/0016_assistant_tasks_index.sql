-- 0016 — Índice para a consulta de "ações recentes" (Fix #5) no hot path do inbound.
-- inbound-user.ts busca as últimas assistant_tasks da conversa (status success/error,
-- completed_at recente) a CADA mensagem, ANTES da chamada ao LLM. Sem índice isso é
-- seq-scan e piora o p95 conforme a tabela cresce (append-only, sem prune). Índice
-- parcial (só linhas concluídas) mantém enxuto.
create index if not exists assistant_tasks_conv_completed_idx
  on public.assistant_tasks (conversation_id, completed_at desc)
  where completed_at is not null;
