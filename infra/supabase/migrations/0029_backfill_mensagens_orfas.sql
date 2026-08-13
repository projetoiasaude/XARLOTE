-- 0029 — Recupera mensagens de paciente que existiam SÓ no log cru de webhook.
--
-- ## Como isto foi descoberto
--
-- Eu havia agendado uma poda por retenção em `webhook_events` (migration 0028) partindo da
-- premissa de que a tabela era uma SEGUNDA CÓPIA do que já está em `messages`. Nunca testei
-- a premissa. O fundador questionou — *"não é histórico das pessoas? podemos usar de
-- aprendizado"* — e a checagem mostrou que ele estava certo.
--
-- Comparando por **TEXTO** (não por id, que é onde eu errei nas primeiras tentativas):
--
--   · 547 mensagens de entrada JÁ estavam em `messages` — duplicata, como eu supunha.
--   · **187 existiam SÓ no log cru.**
--   · ~2.250 eram ecos das nossas próprias mensagens e avisos de entrega/leitura.
--
-- Das 187, **94 são de 4 pacientes CADASTRADOS**, entre 29/04 e 29/05 — a era do uazapi,
-- quando o leitor de entrada falhava. 185 das 187 seriam apagadas na primeira execução da
-- poda. Esta migration recupera as 94; a 0028 foi corrigida para não agendar nada.
--
-- ## As três tentativas erradas de identificar o remetente (não repetir)
--
-- O payload do uazapi tem ~60 chaves. O telefone está em **`chat.phone`** (ou
-- `message.sender`), NÃO em `chat.id` — esse é um id interno, e extrair dígitos dele dava
-- "telefones" de 8 a 10 dígitos, quando BR tem 12 ou 13. Foi o que fez o casamento por
-- `conversations.whatsapp_jid` devolver zero e quase me convencer de que não havia dono.
--
-- ## O que fica de fora, e por quê
--
-- Os outros ~93 não são recuperáveis com dono: 24 do zpro não têm telefone no payload, e
-- 53 vêm de números que nunca viraram paciente. Criar linha de `messages` para quem não é
-- titular cadastrado seria inventar histórico de alguém — o oposto do que a LGPD pede.
-- Eles continuam onde estão.
--
-- ## Propriedades
--
-- **Aditivo e reversível:** `trace_id = 'backfill-0029'` marca cada linha inserida, então
-- `delete from messages where trace_id = 'backfill-0029'` desfaz exatamente isto.
-- **Idempotente:** as duas cláusulas `not exists` (por id E por texto) fazem reexecutar
-- não duplicar. **Data correta:** usa o `messageTimestamp` do WhatsApp, não `now()` — do
-- contrário 94 mensagens de abril entrariam no fim do histórico, com a data de hoje.

insert into public.messages
  (conversation_id, external_id, direction, sender_role, content_type, content, trace_id, created_at)
select
  c.id,
  w.external_event_id,
  'in',
  'user',
  'text',
  w.raw->'message'->>'text',
  'backfill-0029',
  -- 13 dígitos = milissegundos; 10 = segundos. Os dois formatos aparecem no mesmo campo.
  case
    when (w.raw->'message'->>'messageTimestamp') ~ '^[0-9]+$'
      then to_timestamp((w.raw->'message'->>'messageTimestamp')::bigint
             / case when length(w.raw->'message'->>'messageTimestamp') > 12 then 1000 else 1 end)
    else w.received_at
  end
from public.webhook_events w
join public.users u
  on regexp_replace(u.phone_e164, '\D', '', 'g') in (
       regexp_replace(coalesce(w.raw->'chat'->>'phone', w.raw->'message'->>'sender'), '\D','','g'),
       '55' || regexp_replace(coalesce(w.raw->'chat'->>'phone', w.raw->'message'->>'sender'), '\D','','g')
     )
join public.conversations c
  on c.user_id = u.id and c.party_type = 'user' and c.whatsapp_instance = 'sara'
where w.provider = 'uazapi'
  and coalesce(w.raw->'message'->>'fromMe', 'ausente') <> 'true'
  and coalesce(w.raw->'message'->>'text', '') <> ''
  and w.external_event_id is not null
  and not exists (select 1 from public.messages m where m.external_id = w.external_event_id)
  and not exists (select 1 from public.messages m2
                   where m2.direction = 'in' and m2.content = w.raw->'message'->>'text')
on conflict do nothing;

-- Aplicada em produção em 12/08/2026. Resultado medido: 94 linhas, 4 pacientes,
-- mensagens datadas de 29/04 a 29/05, zero duplicata, zero órfã de paciente restante.
