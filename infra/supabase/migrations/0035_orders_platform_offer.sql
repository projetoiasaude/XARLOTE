-- 0035 — O pedido lembra o que as grandes redes já responderam.
--
-- Caso Ludmila, 28/09/2026: às 14:48 ela recebeu o link da Pague Menos (R$ 25,59, entrega em
-- 60 min); às 14:58 a Xarlote disse "as farmácias ainda não responderam, te aviso quando a
-- primeira chegar" — o aviso de 10 min e o relatório de 45 min não sabiam da mensagem das redes,
-- porque o pedido não guardava esse fato em lugar nenhum.
--
-- `platform_offer` = o que a mensagem das redes prometeu: { em, redes, melhor: { rede, total,
-- prazo, naHora } }. Escrito por `presentPlatformQuotes`; lido pelo aviso de 10 min (silencia),
-- pelo fechamento sem resposta do bairro (vira handoff, sem "não consegui") e pelo status.
--
-- Aditiva e anulável: pedido antigo fica null e segue o comportamento de antes.

alter table public.orders add column if not exists platform_offer jsonb;

comment on column public.orders.platform_offer is
  'O que a mensagem das grandes redes prometeu ao paciente (rede, total, prazo). null = nenhuma rede apresentada.';

-- ─── ACEITAÇÃO ────────────────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'orders' and column_name = 'platform_offer';
--     → platform_offer | jsonb | YES
-- ─── REVERSÃO ─────────────────────────────────────────────────────────────────
--   alter table public.orders drop column if exists platform_offer;
