-- 0023 — `messages.provider_ticket_id`: o único identificador que o zpro devolve no envio.
--
-- Por que existe: a 0022 criou `delivered_at`/`delivery_status` pra ter VERDADE de entrega,
-- mas na prática "delivered" passou a significar apenas "o POST HTTP pro zpro não lançou".
-- Faltava a outra metade — o veredito do CANAL.
--
-- Em 03/08 instrumentei a resposta de envio do zpro (logando só as CHAVES, nunca valores) e
-- provei que ela é `{ success, data: { message, ticketId } }`: NÃO existe wamid. Por isso
-- `external_id` ficou NULL em 100% dos envios — não era parser errado, o campo não existe.
--
-- O `ticketId` é o identificador real do zpro, e é a MESMA chave que o webhook de entrada
-- carrega (`providerTicketId`, já normalizado e testado com payload real). Guardá-lo aqui
-- serve a dois fins: (1) o suporte do zpro rastreia entrega por ele — é o que o fundador
-- precisa pro chamado da entrega duplicada; (2) abre o caminho pra correlacionar o eco de
-- status COM A MENSAGEM que ele confirma, em vez da atribuição por telefone+recência que
-- usamos hoje.
--
-- Coluna nova em vez de `raw_payload`: aquele jsonb sofre read-modify-write do
-- conversation-compactor e não é indexável pra lookup.

alter table messages add column if not exists provider_ticket_id text;

comment on column messages.provider_ticket_id is
  'Identificador do provedor (zpro ticketId) devolvido no envio. Texto, não bigint: o zpro devolve number mas outros provedores podem devolver string, e o campo é chave de correlação, não número.';

-- Lookup do eco de status: "qual mensagem este ticket confirma?". Parcial — a esmagadora
-- maioria das linhas (todo o histórico, e todo inbound) fica NULL.
create index if not exists messages_provider_ticket_idx
  on messages (provider_ticket_id)
  where provider_ticket_id is not null;
