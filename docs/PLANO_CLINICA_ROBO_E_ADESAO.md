# Plano — robô de menu na clínica (caso Duda) e a adesão que não registra (caso Glauber)

> Escrito em 14/09/2026, mesmo método de `PLANO_FARMACIA_PEDIDO_FLUIDO.md`: cada defeito
> rastreado até a decisão que o permitiu; a correção troca a decisão, não o sintoma.
> Nenhuma mensagem proativa a paciente faz parte deste plano.

## 1. Duda, 10/09 11:06–11:07 — a GastroEla atende por robô

### O que aconteceu, minuto a minuto
1. O robô saudou ("Bem-vindo(a) ao atendimento") e pediu **nome completo**. A Xarlote respondeu
   cortesia ("Fico no aguardo") e mandou a abertura de cotação. O robô repetiu o pedido de nome
   **8 vezes**; a cada eco a Xarlote respondia cortesia ("deixa eu confirmar rapidinho") — e o robô
   ecoava de novo.
2. Cada eco virou um `request_clarification` → **6 mensagens quase iguais à Duda em 37 s**
   (o dedupe compara texto exato; o modelo parafraseia).
3. Duas mensagens de **narração interna** foram parar na clínica: *"A clínica está pedindo o nome
   completo do paciente… Vou precisar perguntar ao paciente"*.
4. Quando o robô mostrou o menu numerado, o agente **acertou** ("3" = Agendamento de consultas) —
   três vezes — e a **nossa auto-verificação de saída bloqueou** ("texto curto demais").
5. Sem resposta válida, o robô repetiu "informe apenas o número"; o backstop "nada foi repassado
   → repassa" mandou esse prompt **cru** pra Duda.
6. 25 mensagens em 1 minuto → **limite de turnos** → cotação encerrada como indisponível.
7. Nome completo e nascimento que a Duda deu ficaram só na cotação; o perfil dela segue sem
   `full_name` — a próxima clínica pergunta tudo de novo.

### As decisões por trás
| Sintoma | Decisão que o permitiu | O que muda |
|---|---|---|
| Cortesia pra robô, 8 ecos | O agente trata toda mensagem como humano | **Modo robô determinístico** antes do modelo: menu/“informe o número”/pedido de dado formulaico é reconhecido (`analisarMensagemDeRobo`) e respondido sem LLM — número da opção de agendamento, dado do perfil se conhecido, ou UMA pergunta ao paciente. Saudação automática = silêncio. |
| "3" bloqueado | Sanidade trata "curto" como degenerado | Resposta numérica de 1–2 dígitos é válida (é a resposta certa a um menu). |
| 6 paráfrases | Dedupe por texto exato | Dedupe por **assunto** (`assuntoDaPergunta`: nome_completo, nascimento, cpf, convênio…) com a cotação já `awaiting_user` há <30 min → não re-pergunta. Vale pra clínica e farmácia. |
| Menu cru pra Duda | Backstop repassa o que não reconhece | Prompt de robô é reconhecido como **operacional** (`motivo: 'robo'`) — nunca vai ao paciente. |
| Narração pra clínica | O texto do turno vai pra clínica sem reler | `pareceNarracaoInterna` ("o paciente", "vou precisar perguntar") → substituído por cortesia neutra (humano) ou silêncio (robô). Mesma guarda na farmácia. |
| Limite de turnos queimado | Loop robô×robô conta como conversa | `roboEmLoop` (mesmo prompt ≥3× nas últimas 8 entradas) → encerra a cotação como indisponível com motivo honesto ("atendimento automático sem opção de agendamento"), sem mais mensagens ao robô. |
| Dados perdidos | Reuso só cobria CPF/nascimento/convênio | **Nome completo** dado a uma clínica vai pra `users.full_name` (se vazio). |

## 2. Glauber, 11–12/09 — "Anotado ✅" sem registro; dois lembretes, um confirmado

| Sintoma | Decisão que o permitiu | O que muda |
|---|---|---|
| "Simmmmm" → nada registrado, "Anotado ✅" dito | Backstop casa `^sim$` literal; o modelo não chamou a tool; nenhuma guarda relê "anotado" | `normalizarAck` colapsa letra esticada e emoji/pontuação final antes de casar. E **honestidade de dose**: se nem a tool nem o backstop registraram e o texto anuncia "anotado/marcado/registrei", a frase vira "Só pra eu registrar certinho: você tomou o X das 7h? Responde *tomei* que eu marco 💙". |
| 20:00 tocam Domperidona e Nimesulida; "Tomei" confirma uma | `limit(1)` no lembrete mais recente | `lembretesQueTocaramJuntos`: todos os que dispararam na mesma janela de 3 min são confirmados (regra 113: confirmação nua confirma o que TOCOU — tudo que tocou). |
| Domperidona/Esomeprazol confirmados e a adesão não move | Lembrete criado sem `medication_id` → só carimba `last_confirmed_at` | Fallback por nome: título do lembrete × `user_medications` do paciente (token principal); achou → liga o lembrete ao remédio e grava `medication_log`. Sem match → só carimba, como hoje (nunca inventa remédio). |

## 3. Prova
- Unitário: robô (menus reais da GastroEla e da clínica da Duda de 24/08), assunto, loop,
  narração, sanidade de dígitos, acks esticados, lembretes juntos.
- Replay: as 12 mensagens reais do robô da GastroEla passam pelo analisador → cada uma com a
  ação determinística esperada (número "3", nome, nascimento, silêncio, loop).
- Deploy api+worker; logs 30 min.
- Reparo de dados auditado (sem contato com paciente): doses do Glauber que ele confirmou e
  não foram gravadas; lembretes ligados aos remédios do perfil; nome completo da Duda.

## 4. Fora deste plano
- Clínicas que não respondem (4 de 5 na busca da Duda) — tipo de número/abertura fria, em
  `PLANO_FARMACIA_VIDA_REAL.md`.
- O rescue repetir a mesma pergunta de 26/08 ("outra região, telemedicina ou aguardar?") depois
  de ela já ter dito "telemedicina"/"Ipasgo": registrado; depende da busca respeitar a
  modalidade, que é a próxima leva.
