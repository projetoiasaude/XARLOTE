# Migração WhatsApp: uazapi → API Oficial (zpro / WABA)

Status: **código pronto e verificado** (typecheck/build/67 testes). Falta: setar env no
Railway, fiar o webhook no painel zpro, deployar e validar ao vivo no número novo.

## O que mudou (arquitetura DUAL-PROVIDER)

A Xarlote (leg `sara`) passa a falar pela **API Business oficial via zpro**. O bot das
farmácias (leg `agent`) **continua no uazapi**. A escolha é por instância, via env — o
`packages/whatsapp/src/client.ts` é a fachada única que despacha pro provider certo, então
nenhum código de fluxo precisou mudar.

| Operação | zpro (sara, oficial) — CONFIRMADO | uazapi (agent) |
|---|---|---|
| Auth | `Authorization: Bearer <token>` | header `token` |
| Texto | `POST {ext}` `{number, body}` | `POST /send/text` |
| Imagem | `POST {ext}/url` `{mediaUrl, body, number}` | `POST /send/media` |
| Áudio/voz | `POST {ext}/voice` `{audio:URL}` (Buffer→`/base64`) | `POST /send/media` ptt |
| Botões | `POST {ext}/sendButtonWABA` `{message, button1..3, ticketId}` | `POST /send/menu` |
| Mídia recebida | `inbound.mediaUrl` (GET + Bearer se 401) | `/message/download` (id longo) |

`{ext}` = `${ZPRO_BASE_URL}/v2/api/external/${ZPRO_SARA_API_ID}`.

> ⚠️ **Entrada (webhook) do zpro NÃO é documentada.** O parser `zpro-normalize.ts` é
> tolerante/provisório. A rota captura o payload **redatado** em `webhook_events` e
> `system_logs` (categoria `webhook`, "aprendizado de shape") — finalize o parser contra
> o 1º payload real. **Não invente o shape.**

## Variáveis de ambiente (Railway: api + worker)

```
WHATSAPP_PROVIDER_SARA=zpro
WHATSAPP_PROVIDER_AGENT=uazapi
ZPRO_BASE_URL=https://backhub.criate.online
ZPRO_SARA_API_ID=<UUID da conexão>          # parte final da URL externa
ZPRO_SARA_TOKEN=<token Bearer>              # SEGREDO — nunca commitar
ZPRO_WEBHOOK_SECRET=<random forte>          # vai na URL do webhook (?key=)
```

Ambos os services precisam: a API recebe o webhook e responde direto (consent/mídia) +
faz fallback de envio; o worker consome a fila outbound e envia.

## Fiação do webhook no painel zpro (passo do founder)

No painel zpro: **API → Webhooks → webhook de _mensagens_** da conexão da Xarlote, cole:

```
https://<API_PUBLICA>/webhook/zpro/sara?key=<ZPRO_WEBHOOK_SECRET>
```

(O painel do zpro normalmente só deixa colar uma URL — por isso o segredo vai na query
`?key=`, validado pela rota. Também aceita o header `x-zpro-secret` se houver como setar.)

## Plano de cutover (baixo risco — número novo é aditivo)

1. Setar as envs acima no Railway (api + worker), `--skip-deploys`.
2. `railway up` (api + worker) — avisar antes (regra do projeto).
3. Founder cola a URL do webhook no painel zpro.
4. Testar no **número novo**: mandar "oi" (consent + botões), clicar "Aceitar", mandar
   um **áudio** falando o nome, mandar uma imagem.
5. Ler o 1º payload capturado (`webhook_events` provider='zpro' / system_logs) e **apertar
   `zpro-normalize.ts`** se algum campo não bateu. Redeploy. Repetir até 100%.
6. Quando perfeito: aposentar o número antigo (uazapi) — desconectar a instância e/ou
   parar de apontar o webhook antigo. O leg `agent` (farmácias) segue no uazapi.

## Pontos a confirmar ao vivo (não documentados pelo zpro)

- Nomes de campo do payload de entrada (remetente, corpo, tipo).
- Como vêm **áudio/imagem** (URL pública? precisa Bearer? base64?).
- O **`ticketId`** vem no inbound? (necessário pros botões `/sendButtonWABA`.) Se vier,
  os botões de consentimento funcionam de primeira; se não, caem pra texto (fallback já
  existe) até descobrirmos como obter/abrir o ticket.
- Resposta de **botão clicado**: vem `id`, título, ou os dois? (o título costuma vir em
  `body` → o fluxo de consent já trata como texto.)
