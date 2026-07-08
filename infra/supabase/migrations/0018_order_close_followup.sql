-- 0018 — Pós-fechamento vivo (incidente Santa Lúcia 07/07):
-- o pedido fechava e a Xarlote ficava CEGA — a condição do cliente ("entregar antes
-- das 19h") se perdia, a farmácia silenciava e ninguém cobrava. Estas colunas dão
-- memória ao fechamento e alimentam o worker order-followup.
alter table orders add column if not exists closed_at timestamptz;          -- quando virou handed_off
alter table orders add column if not exists close_conditions text;         -- condições ditas no aceite ("antes das 19h, cartão")
alter table orders add column if not exists delivery_deadline timestamptz; -- prazo prometido (parseado do aceite)
alter table orders add column if not exists followup_nudged_at timestamptz;   -- cobrança à farmácia já feita (dedup 1×)
alter table orders add column if not exists deadline_alert_at timestamptz;    -- alerta de prazo ao cliente já feito (dedup 1×)

-- Worker varre handed_off recentes
create index if not exists orders_handed_off_followup_idx
  on orders (status, closed_at) where status = 'handed_off';
