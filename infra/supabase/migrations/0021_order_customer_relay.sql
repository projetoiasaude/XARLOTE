-- 0021 — Relay farmácia→cliente pós-fechamento (incidente Vadivino 08/07): a farmácia
-- mandou "motoboy na porta / procura quem?" e NADA chegou ao cliente. Esta coluna guarda
-- quando a Xarlote repassou pela última vez um status da farmácia ao cliente — usada como
-- cooldown/anti-spam do relay proativo (notify_customer + backstop determinístico).
alter table orders add column if not exists customer_relayed_at timestamptz;

comment on column orders.customer_relayed_at is
  'Quando a Xarlote repassou pela última vez um status/pergunta da farmácia ao cliente (relay pós-fechamento). Cooldown do backstop de relay.';
