# Visão Xarlote — A Jarvis da Saúde do Brasileiro

> Plano estratégico final. Destilado de 6 análises técnicas e de produto sobre o código real, mais a crítica priorizada de investidor. Honesto, concreto e ordenado por impacto. Escrito para o founder decidir, não para impressionar.

---

## 1. Visão em uma frase

**A Xarlote é o cérebro de saúde longitudinal do brasileiro no WhatsApp: um grafo de saúde por CPF que, quanto mais usado, melhor cuida — entende seus exames, protege contra erro de remédio, age no mundo real (cota, lembra, refila, agenda) e cuida dos 364 dias do ano em que a pessoa não está no consultório.**

A parte vendável da palavra "Jarvis" é **autonomia operacional total** (cotar, lembrar, refilar, agendar, antecipar) somada a **assistência clínica conservadora** (orientar, triar, encaminhar — nunca diagnosticar, nunca prescrever, nunca ajustar dose). O produto que vale bilhões **não é a IA que substitui o médico** (isso é commodity e é ilegal no Brasil). É a camada de orquestração que ocupa o espaço hoje vazio entre as consultas.

---

## 2. A "wedge" — a única coisa para dominar primeiro

> ### "Manda teu exame e teus remédios que eu cuido do resto."

Comece sendo **excepcional em entender exames e proteger contra erro medicamentoso** — para o brasileiro **crônico** (diabético / hipertenso) e para **quem cuida dele** (o filho do idoso).

Por que esta wedge, e não outra:

- **CAC quase zero.** "Manda teu exame que eu te explico" é a frase que se espalha sozinha no WhatsApp. Nenhuma outra feature tem aquisição orgânica tão barata.
- **Constrói o moat desde o primeiro uso.** Cada exame ingerido e cada remédio mapeado vira dado longitudinal proprietário. O concorrente do dia 1 não tem isso. Em 2 anos de histórico, sair = perder a própria saúde digital. Lock-in de verdade.
- **Termina em AÇÃO, não em texto.** Exame fora da faixa → sugere e agenda consulta. Remédio acabando → cota e compra (motor que já existe). Interação detectada → alerta. Cada loop fecha no mundo real.
- **É clinicamente defensável.** Explicar exame e apontar interação não cruza a linha do CFM se calibrado ("quem confirma é o médico"). Não exige autonomia clínica — exige excelência operacional.

**O que a wedge NÃO é:** chatbot de perguntas de saúde (commodity), telemedicina própria (comprável), saúde mental (arriscado demais para começar), wearables (caro e tardio). A wedge é **o prontuário vivo que age.**

---

## 3. As apostas transformadoras

Critério de corte: alto impacto × viável no Brasil × cria moat real (ação no mundo real **ou** grafo longitudinal). Tudo que era "chatbot que sabe mais" ficou de fora.

| # | Aposta | O que é | Por que vale ouro | Esforço | Diferencia? |
|---|--------|---------|-------------------|:-------:|:-----------:|
| **①** | **Motor de Exames Laboratoriais** | Foto/PDF do exame → extração **estruturada** de cada analito (valor, faixa, ↑/↓) → explicação em PT-BR simples → **tendência ao longo do tempo** → conexão com ação ("esse TSH alto + o cansaço que você me contou valem um endócrino, acho horário?"). | Todo brasileiro tem exame, ninguém entende, o médico explica em 4 min. Gancho de aquisição mais barato que existe **e** o ativo de dado longitudinal que vira lock-in. Transforma "chatbot" em "prontuário vivo". | **M** | **Sim, alto** |
| **②** | **Loop agêntico (ReAct)** | Substituir o `chat()` single-shot por um loop: modelo chama tool → backend executa → resultado **volta ao modelo** → ele decide o próximo passo ou responde (teto de N rounds). | Multiplicador de tudo. Hoje o resultado da tool nunca volta ao modelo, por isso o prompt tem 353 linhas de árvore-de-decisão em prosa. O loop apaga ~40% do prompt e destrava raciocínio sobre o resultado da ação. Pré-requisito de qualidade de toda feature clínica. | **M** | Indireto (habilita o resto) |
| **③** | **Checagem de alergia / interação medicamentosa** | Todo remédio novo (comprado, contado, ou que saiu num exame/receita) é checado contra a lista completa que a Xarlote já conhece + alergias + condições, sobre uma base curada (não inventada por LLM). "Você toma sertralina; esse anti-inflamatório aumenta risco de sangramento — confirma com seu médico." | Salva vida, mitiga responsabilidade civil **e** é a prova viva de que a memória/grafo vale algo (concorrente do dia 1 não tem o perfil). O bug das "alergias que nunca salvavam" mostra que isso quase causou dano — institucionalizar é defesa e moat. | **M** | **Sim, alto** |
| **④** | **Conta Cuidador / Família** | Um titular (filho, 35-50 anos, que paga) gerencia a saúde do pai/mãe idoso(a). A Xarlote fala com o idoso direto no WhatsApp dele **ou** reporta ao filho. Consolida remédios, consultas, adesão, alertas. | Quem paga ≠ quem usa = receita mais forte que B2C individual. Idoso crônico = maior LTV e menor churn do Brasil. Loop viral embutido (1 cuidador traz 2-4 pacientes). E o WhatsApp por voz é o único canal que o idoso já domina. **Provavelmente o caminho "bilhões" mais plausível.** | **G** | **Sim, enorme** |
| **⑤** | **Briefing diário + Motor de Proatividade** | "Bom dia, Pedro. Hoje: Losartana às 8h (já vi que tomou ✅). Consulta com o Dr. Almeida amanhã 14h — confirmo? E faz 3 dias que você não me conta da pressão." Um único card por manhã, no horário aprendido, **com orçamento de incômodo** (teto rígido por semana, supressão de tipos ignorados). | O hook que cria DAU sem a pessoa estar doente. Transforma N features dispersas em 1 ritual. É o "wow" do produto — mas só funciona com o orçamento de incômodo, senão vira spam e o mute no WhatsApp custa o canal para sempre. | **M** | **Sim** |
| **⑥** | **Renovação contínua de receita + adesão** | A Xarlote "conta os comprimidos" (modelo de estoque do usuário), antecipa o fim ("sua losartana acaba quinta, já cotei"), rastreia adesão com check-in leve, e dispara a renovação da receita **antes** de acabar (via teleconsulta parceira, onde a lei permite). | Parar de tomar remédio é a #1 causa de descontrole de crônico no Brasil. Resolver isso muda desfecho de saúde **e** cria a receita recorrente previsível que faz a empresa valer bilhões (não transação avulsa). Cria contato quase-diário. | **M-G** | **Sim** |
| **⑦** | **RAG clínico citável (BR)** | Base vetorizada de fontes confiáveis e citáveis — bulas ANVISA, interações, Formulário Terapêutico, diretrizes (SBC, SBD). Quando a Xarlote fala de remédio, **recupera da base e cita a fonte**, em vez de gerar de memória. | Corta o maior risco técnico do produto: alucinação no domínio onde alucinação mata. A citação ("segundo a bula ANVISA…") é credibilidade de marca. Reaproveita o pgvector que já existe. É tablestakes de segurança **e** moat de conteúdo. | **M** (eng.) / **G** (curadoria) | **Sim, alto** |
| **⑧** | **Gêmeo digital / Health State consolidado** | Estado de saúde recomputado: por condição, estado atual + tendência + última evidência + confiança. "Diabetes tipo 2 \| controle: piorando \| HbA1c 6.8→7.2→7.5 em 9 meses \| última medição há 40d." Séries temporais de biomarcadores alimentadas pelo motor de exames. | É o moat de longo prazo. Concorrente novo começa do zero; usuário com 2 anos de trajetória não migra. Habilita proatividade boa e raciocínio seguro. É o ativo que justifica valuation de **plataforma de dados de saúde**, não de chatbot. | **M-G** | **Sim, o maior a longo prazo** |

> **A "Jarvis mínima viável e crível" é o trio ① + ③ + ⑥** (exames + interações + renovação/adesão). Esse trio sozinho já é um produto coeso e defensável. Foco mata concorrente; dispersão mata você.

---

## 4. Roadmap em 3 horizontes

### 🟢 AGORA (0–3 meses) — não morrer + provar a wedge

1. **Não morrer (semana 1, tudo P, ROI absurdo):** corrigir os prompts da farmácia (admitir ser IA se perguntada); bloquear fechamento de tarja preta via plataforma; iniciar a burocracia da Meta (Business Manager + BSP); ligar PITR/backup Supabase + 1 restore de teste; webhook secret obrigatório; connection pooler. **Detalhe na §8.**
2. **② Loop agêntico** — destrava a qualidade de todo o resto. Faça antes de empilhar features.
3. **① Motor de Exames** — a wedge. Com parser determinístico para os 3-4 labs grandes (Fleury, Dasa, Hermes Pardini, lab popular) + validação de faixa/unidade. **Nunca** deixe a LLM ler valores numéricos sem validação por regra.
4. **③ Checagem de alergia/interação** sobre uma base curada inicial e estreita (interações + posologia).
5. **Suite de eval de segurança clínica** (~100-300 cenários em CI) — porque vocês trocam o modelo em runtime no `/prompts`, e isso pode degradar a segurança silenciosamente.
6. **North Star instrumentado:** adesão ativa semanal. Retenção D30/D90 medida **por coorte** (crônico vs. não-crônico — são produtos diferentes).

> **Gate honesto:** se a retenção na semana 12 do coorte crônico não for boa, **NÃO escale.** Conserte o produto primeiro.

### 🟡 PRÓXIMO (3–12 meses) — recorrência + o ciclo que vira hábito

1. **⑥ Renovação contínua de receita + adesão** (estoque do usuário → cota → renova) — fecha o loop de receita recorrente previsível.
2. **⑤ Briefing diário + Motor de Proatividade** com orçamento de incômodo. (Tecnicamente: mover lembretes para **BullMQ delayed jobs**; o cron vira só rede de segurança — destrava proatividade pontual e escalável.)
3. **⑧ Gêmeo digital / health state** (séries temporais de biomarcadores vindas do motor de exames).
4. **⑦ RAG clínico citável** (bulas ANVISA primeiro).
5. **Testar o mercado Cuidador/Família (④)** com MVP enxuto, **antes** de construir o schema multi-titular completo.
6. **Fundação técnica e jurídica:** abstrair `MessagingChannel` + migração WhatsApp Cloud API; roteador de modelos por complexidade (margem); fechar Tier 0/1 jurídico (DPO, política, DPA, RIPD, ROPA, seguro E&O).

### 🔵 FUTURO (1–3 anos) — plataforma + B2B2C (onde mora o "bilhões")

1. **④ Conta Cuidador/Família completa** (multi-titular, consentimento bidirecional auditável) como produto de plataforma.
2. **B2B2C:** vender para o pagador — começar por RH de empresas médias (ciclo curto), depois operadoras/autogestões. O salto 10k→100k é em **degraus** (1 contrato = milhares de vidas), não em ads.
3. **Coaching de condição crônica** (diabetes/hipertensão) como caso de venda B2B.
4. **App nativo (Capacitor) + Health Connect** — segundo canal de proatividade (reduz dependência da Meta) + sinal contínuo de wearable para o gêmeo digital.
5. **Interoperabilidade:** APIs de laboratório primeiro (ROI claro); RNDS/Conecte SUS como marco tardio. Desde já, padronize códigos em **CID-10 / ANVISA** para não se pintar num canto.
6. **Saúde mental e emergência** com protocolo clínico revisado por profissional — só agora, e feito direito.

---

## 5. Modelo de negócio — como vira receita e por que pode valer bilhões

**A tese:** o que vale bilhões não é a IA (commodity). É **o grafo de saúde longitudinal por CPF + a distribuição B2B2C + as integrações** que se acumulam por cima dela. A IA é o motor; o moat é o dado e a distribuição.

### As camadas de receita (em sequência, não tudo de uma vez)

| Camada | Como monetiza | Quando | Observação |
|--------|---------------|:------:|------------|
| **Marketplace de medicamento** | Take-rate sobre a compra (motor já existe). Priorizar **margem alta**: manipulação, OTC, recorrência crônica. | Agora | Genérico tem margem fina — não dependa só dele. Recorrência crônica é o ouro. |
| **Assinatura "Plano Família"** | Mensalidade do cuidador que gerencia 2-4 perfis. | 12-36m | Quem paga ≠ quem usa. Conta que ninguém cancela (desamparar a mãe?). É camada, **não o motor.** |
| **B2B2C (o motor de escala)** | Vender para o pagador: RH de empresas médias → operadoras/autogestões → farmácias (white-label parcial). | 1-3 anos | Um diabético bem acompanhado custa muito menos ao sistema. Isso é **vendável a quem paga a conta.** Salto em degraus. |
| **Encaminhamento qualificado** | Telemedicina parceira, labs, clínicas — com o **dossiê pré-consulta** que só a Xarlote monta. | 12-36m | Seja a camada, não o prestador. |

### Por que pode valer bilhões (referências do mercado BR e comparáveis)

- **Tamanho do mercado:** o **Dr. Consulta** (clínicas populares, classe C/D desatendida) é avaliado na casa do bilhão de reais — prova o tamanho do mercado de saúde acessível no Brasil. A **Conexa Saúde** (telemedicina B2B2C) captou centenas de milhões — prova que **B2B2C é o caminho de receita no BR.**
- **O comparável mais próximo:** **K Health** (EUA, IA de triagem + B2B2C com pagadores) passou de US$ 1 bi — é exatamente o caminho **IA → pagador** que a Xarlote deve trilhar.
- **A lição mais valiosa:** **Memed** (prescrição digital BR) virou **infraestrutura** — o "trilho" que todos usam — e foi adquirida por valor expressivo. **Vocês querem ser o trilho da navegação de saúde do brasileiro.** Virar infraestrutura vale mais que ser app.
- **A lição de fracasso:** **Babylon Health** (UK) prometeu IA mágica, virou operação clínica asset-heavy com economics negativos, e **faliu.** É o seu maior risco existencial de negócio — não vire Babylon.

> **Frase para o pitch deck:** *"A Xarlote é a camada de orquestração de saúde do brasileiro no WhatsApp: um grafo de saúde longitudinal por CPF que, quanto mais usado, melhor cuida — monetizado por quem tem incentivo real em saúde (cuidadores, empresas, operadoras, farmácias), não pelo bolso do paciente."*

---

## 6. Os 3 maiores riscos

### 🔴 RISCO EXISTENCIAL — Confiança/Legalidade (não é técnico, é manchete)

Três coisas se sobrepõem num único eixo, e **qualquer uma sozinha pode matar o produto antes de qualquer feature importar:**

1. **A Xarlote mente que é IA para a farmácia, por design.** O prompt da farmácia (`agent-pharmacy.system.ts:21,54`) manda **nunca** se identificar como IA. Isso **viola a regra inegociável nº 2 de vocês** e é prática enganosa (CDC). Um print de farmacêutico irritado no Twitter = "app de saúde usa IA que mente". **Correção: P (2 strings).** Não há desculpa para continuar uma hora a mais. A solução é transparência ("sou a assistente virtual, sim, sem drama"), não esconder melhor.
2. **uazapi é teto absoluto.** Um ban da Meta = produto inteiro fica mudo, sem aviso. Lembrete de insulina não chega; red-flag de emergência não dispara. Para app de saúde, isso é dano real ao usuário + morte do negócio + reprovação em due diligence. **Mitigação:** migrar para WhatsApp Cloud API oficial via BSP (360dialog/Blip/Zenvia) é **pré-requisito de tudo, não item paralelo.** A burocracia da Meta leva semanas — começa JÁ. Rodar dual-channel atrás de uma interface `MessagingChannel` durante a migração.
3. **Vender controlado (tarja preta) por chat sem receita validada** é o vetor de shutdown mais rápido da ANVISA. **Mitigação:** bloquear o fechamento de controlado via plataforma até ter receita digital validada (Memed/ICP-Brasil). Cotação e redirecionamento, ok; fechamento, não.

**Em paralelo (jurídico, M):** DPO nomeado + Política de Privacidade versionada e hospedada + DPA com farmácias + RIPD/ROPA. **Sem isso, não levantem rodada** — reprova na due diligence na hora.

### 🟠 RISCO 2 — A linha clínica (responsabilidade civil)

Um único episódio de "a IA mandou tomar o dobro do remédio" mata a empresa (mídia + CFM/ANVISA + processo). **O prompt não é controle** — ele persuade, não garante. **Mitigação:** um **guardrail de saída** determinístico (classificador que checa cada mensagem antes do envio: contém diagnóstico afirmativo? ajuste de dose? prescrição? → reescreve ou escala). Mais: human-in-the-loop em ações de alto risco; seguro E&O com cobertura de saúde antes de escalar; trilha clínica auditável retida por mais tempo que os logs de debug. **Explicar ≠ diagnosticar. Apontar interação ≠ mandar parar. Sugerir médico ≠ prescrever.**

### 🟠 RISCO 3 — Confundir engajamento com receita / proatividade vira spam

O brasileiro vai **adorar** conversar com a Xarlote de graça e não pagar nada. Engajamento alto + monetização zero mata healthtechs. E cada empurrão proativo tem custo de LLM, custo de conversa Meta e **custo de confiança** — um dia de over-notification e a pessoa muta o canal para sempre, silenciosamente. **Mitigação:** atrele monetização a transação real e a pagador empresarial (não à generosidade do consumidor); orçamento de incômodo rígido com opt-in granular; North Star = **adesão ativa semanal**, nunca DAU bruto.

---

## 7. O que NÃO fazer agora

- ❌ **Wearables-dashboard e telemedicina própria.** Dois buracos de esforço G com baixo diferencial. Integre/faça parceria. O wearable só importa pelo que a proatividade faz com o sinal, não pelo gráfico de passos.
- ❌ **Saúde mental como feature inicial.** Demanda gigante, mas é o maior risco de produto da lista. Detecção de suicídio que falha não é bug, é manchete. Faça depois, com protocolo clínico revisado.
- ❌ **Self-hosting de LLM e fine-tuning clínico.** Prematuro e perigoso (alucinação fine-tunada é indistinguível de fato). O roteador de modelos por complexidade captura ~80% da economia com 5% do esforço. Fique no OpenRouter.
- ❌ **ISO 27001 / SOC 2 / FHIR-RNDS completo agora.** Queima caixa, prematuro. Arquitete pensando neles (CID-10/ANVISA nos códigos desde já), certifique depois.
- ❌ **Swarm de 8 agentes antes do loop agêntico básico + eval.** Multi-agente sem avaliação vira não-determinismo impossível de debugar em produção de saúde.
- ❌ **Perseguir DAU bruto e tempo-no-app.** Em saúde, menos tempo resolvendo é melhor. Otimizar isso constrói um produto adversário ao usuário.
- ❌ **Streaks que punem.** Adesão que "quebra" e some quando a pessoa esquece uma dose induz vergonha — e vergonha leva ao abandono do app E do tratamento. Recaída deve ser recebida com acolhimento, nunca com perda de progresso.
- ❌ **Sair do Supabase por medo de escala.** Postgres gerenciado + pooler + partições escala para dezenas de milhões. Trocar de banco agora é otimização prematura cara.
- ❌ **Espalhar em 10 features meia-boca.** O trio exames + interações + renovação já É a Jarvis mínima crível.

---

## 8. Primeiros passos concretos (próximas 2 semanas)

Tudo aqui é **alto ROI, baixo esforço, e fecha o risco existencial.** Faça nesta ordem.

### Semana 1 — fechar o flanco que vira manchete (tudo P)

- [ ] **Corrigir os 2 prompts da farmácia** (`packages/llm/src/prompts/agent-pharmacy.system.ts:21,54`): a Xarlote admite ser assistente de IA se perguntada diretamente, com naturalidade. *(P — 2 strings, risco evitado: existencial)*
- [ ] **Bloquear o fechamento de tarja preta** via plataforma (só cotação + redirecionamento até ter receita digital validada). *(P no código)*
- [ ] **Iniciar a burocracia da Meta** — verificação de Business Manager (CNPJ) + onboarding de um BSP (360dialog/Blip). Leva semanas; cada dia conta. *(P para iniciar)*
- [ ] **Ligar PITR/backup Supabase + fazer 1 restore de teste documentado.** Backup que você nunca restaurou não é backup. *(P)*
- [ ] **Tornar o webhook secret obrigatório** (hoje é opcional). *(P)*
- [ ] **Ligar o connection pooler** do Supabase (Supavisor/PgBouncer em transaction mode). *(P, ganho imediato)*
- [ ] **Fechar as pendências grátis de observabilidade** já mapeadas (Sentry/Telegram/UptimeRobot). *(P)*
- [ ] **Adicionar campos clínicos ao redact** (`condition|allergy|alergia|diagnos|medication|clinical` em `SENSITIVE_KEY` — achado real em `packages/db/src/redact.ts`). *(P)*
- [ ] **Nomear DPO** (pode ser terceirizado) e **começar a Política de Privacidade** versionada. *(jurídico, iniciar já)*

### Semana 2 — começar a wedge e a fundação que a sustenta

- [ ] **Começar o ② loop agêntico** (ReAct) sobre o `inbound-user.ts:461` — é o multiplicador; faça antes de empilhar features.
- [ ] **Abstrair `MessagingChannel`** (interface sendText/sendMedia/sendTemplate) no ponto de estrangulamento `dispatchOutbound`, para rodar dual-channel uazapi/CloudAPI sem tocar nos 13 workers.
- [ ] **Esboçar o ① Motor de Exames:** tabela `lab_results` com unidades normalizadas + parser determinístico para 1 lab grande como prova de conceito + validação de faixa. (LLM só como fallback e tradução, nunca lendo número livremente.)
- [ ] **Instrumentar o North Star** (adesão ativa semanal) e a retenção por coorte crônico vs. não-crônico — você precisa do gate da semana 12.
- [ ] **Rascunhar a suite de eval de segurança clínica** (comece com 30-50 cenários: red flags, tentativas de extrair diagnóstico, pedidos de ajuste de dose) e rode em CI a cada mudança de prompt/modelo.

---

## Bottom line

Vocês têm uma **engenharia mais madura que a tese de negócio** — split api/worker, circuit breaker, prompt caching, RLS, consent_events. A fundação está certa. O que separa vocês de "milhões" é **binário e não-incremental:** canal oficial + linha clínica/legal sagrada. Resolva isso primeiro.

O produto de bilhões não é a IA que substitui o médico. É **o grafo de saúde longitudinal por CPF que, quanto mais usado, melhor cuida — começando por entender exames e proteger contra erro medicamentoso — sobre um canal oficial que não pode ser banido.** Esse espaço (os 364 dias do ano fora do consultório) está vazio, é defensável por dados, e vocês já têm a fundação para ocupá-lo.

Comece estreito. Domine a wedge. Não vire Babylon.
