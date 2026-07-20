-- 0022 — Duas VERDADES que faltavam e causaram os dois incidentes mais graves de 17/07.
--
-- (1) orders.presented_at — CONSENTIMENTO. O backstop de fechamento aceitava um "Ok"
--     genérico como aceite de QUALQUER pedido 'quoted' aberto. Incidente Vadivino 17/07
--     02:48: ele respondeu "Ok" a um "salvei o contato da Célia" e o backstop fechou um
--     pedido apresentado 3,5 DIAS antes (com preço errado e pergunta da farmácia sem
--     resposta) — mandando a farmácia preparar de verdade. Um "ok" é CONTEXTUAL: vale
--     pra última coisa dita. Sem saber QUANDO as opções foram apresentadas, não dá pra
--     saber se o "ok" é sobre elas. Esta coluna marca o instante da apresentação.
--
-- (2) messages.delivered_at / delivery_status — HONESTIDADE DO DASHBOARD. O lembrete é
--     inserido em `messages` ANTES do teste de janela de 24h; quando a Meta bloqueia
--     (paciente mudo), a linha fica lá como se tivesse sido enviada. Em 17–19/07, 30
--     lembretes NÃO entregues (incl. o anti-hipertensivo do Arthur) apareciam como
--     "enviados" — ninguém tinha como ver. Agora cada mensagem carrega o que REALMENTE
--     aconteceu no canal.
alter table orders add column if not exists presented_at timestamptz;

comment on column orders.presented_at is
  'Quando as opções de cotação foram APRESENTADAS ao paciente (consolidateQuotes). Base do consentimento: um aceite genérico ("ok"/"sim") só pode fechar o pedido se for resposta à apresentação — ver backstop 11b em inbound-user.ts.';

alter table messages add column if not exists delivered_at timestamptz;
alter table messages add column if not exists delivery_status text;

comment on column messages.delivered_at is
  'Quando o canal CONFIRMOU o envio (worker da fila outbound). NULL = ainda não confirmado (ver delivery_status). A linha em messages é o espelho/registro; entrega é outra coisa.';
comment on column messages.delivery_status is
  'Ciclo de vida real: queued (na fila, ainda sem confirmação) | delivered | window_blocked (janela 24h WABA fechada) | failed | suppressed (simulador). NULL em linhas antigas (pré-0022).';

-- BACKFILL do consentimento: pedidos que JÁ estão apresentados hoje ficariam com
-- presented_at NULL e o backstop de fechamento pararia de funcionar pra eles no dia 1
-- (o paciente escolhe "a 2" e nada acontece). Usa updated_at como melhor aproximação.
update orders set presented_at = updated_at
  where status = 'quoted' and summary is not null and presented_at is null;

-- Achar "medicação não entregue" sem varrer a tabela. Só linhas COM veredito do canal
-- (delivery_status not null) — senão o índice cobriria todo o histórico pré-0022, que tem
-- delivered_at NULL por não existir a coluna, e não seria seletivo pra nada.
--
-- Sem CONCURRENTLY DE PROPÓSITO: numa tabela grande ele seria obrigatório (o CREATE INDEX
-- comum pega SHARE e bloqueia escrita durante o build), mas `messages` tinha ~2.4k linhas /
-- 2.7 MB quando isto foi aplicado (20/07) → build em milissegundos. E CONCURRENTLY não pode
-- rodar dentro de transação, que é como a migration é aplicada. Se `messages` crescer pra
-- centenas de milhares, um índice novo aqui deve ir de CONCURRENTLY, fora de transação.
create index if not exists messages_undelivered_idx
  on messages (created_at desc)
  where direction = 'out' and delivered_at is null and delivery_status is not null;
