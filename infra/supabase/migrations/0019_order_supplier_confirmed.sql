-- 0019 — Sinal REAL de confirmação da farmácia (review 08/07).
-- O order-followup suprimia o alerta de prazo ao CLIENTE quando havia QUALQUER inbound
-- da farmácia após o fechamento (ackAt). Um "blz" jogado desarmava o aviso e mascarava
-- o próprio incidente Santa Lúcia (pedido fechou, farmácia silenciou de verdade, ninguém
-- avisou). Esta coluna separa "a farmácia mandou algo" de "a farmácia CONFIRMOU o preparo":
-- só é preenchida por record_order_confirmation (a tool que o agente chama quando a
-- farmácia confirma preparo/saída), e passa a ser o único gate do alerta de prazo.
alter table orders add column if not exists supplier_confirmed_at timestamptz;

comment on column orders.supplier_confirmed_at is
  'Quando a farmácia confirmou preparo/saída via record_order_confirmation (sinal real, não chit-chat). Usado pelo order-followup pra suprimir o alerta de prazo ao cliente sem ser enganado por uma resposta qualquer.';
