-- Guarda o candidato de "busca por nome" (médico/clínica achado no Google via
-- Places Text Search) aguardando o usuário CONFIRMAR a identidade antes da Xarlote
-- entrar em contato (Feature 2 — busca por nome + confirmação).
alter table conversations
  add column if not exists pending_lookup jsonb;
