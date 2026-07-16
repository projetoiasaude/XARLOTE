import type { ToolDefinition } from '../client.js';

export const xarloteTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'save_user_profile_fact',
      description: 'Salva ou atualiza um fato do perfil do usuário: condição de saúde, alergia, medicamento em uso, endereço, preferência ou informação de contato.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['condition', 'allergy', 'medication', 'address', 'preference', 'identity', 'other'],
            description: 'Categoria do fato. Use "identity" quando o usuário disser/corrigir o próprio NOME (payload: {preferred_name} e/ou {full_name}).',
          },
          payload: {
            type: 'object',
            description: 'Dados do fato (nome, dosagem, endereço, etc.)',
            properties: {},
          },
          confidence: {
            type: 'number',
            description: 'Confiança na extração, de 0 a 1',
          },
        },
        required: ['category', 'payload'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_user_location',
      description: 'Pede para o usuário compartilhar sua localização ou endereço para encontrar farmácias próximas.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Motivo pelo qual a localização é necessária' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_prescription_image',
      description: 'Processa a imagem de uma receita médica para extrair os medicamentos prescritos.',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'ID da mensagem que contém a imagem da receita' },
        },
        required: ['message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_exam_result',
      description:
        'Guarda no perfil do paciente um resultado de EXAME/LAUDO que ele compartilhou por foto (hemograma, raio-x, ultrassom, teste de covid, etc.). SÓ chame DEPOIS de o paciente CONFIRMAR que quer guardar. Você já viu a imagem pelo seu canal multimodal — preencha com o que LEU, sem interpretar clinicamente (não diga se está normal/alterado). NÃO use pra receita (use parse_prescription_image) nem pra foto comum.',
      parameters: {
        type: 'object',
        properties: {
          exam_type: {
            type: 'string',
            description: 'Tipo do exame: "sangue", "urina", "imagem" (raio-x/ultrassom/tomografia), "cardiologico" (ecg/ecocardio), "covid", "outro".',
          },
          title: { type: 'string', description: 'Nome do exame como aparece no laudo. Ex: "Hemograma completo", "Raio-X de tórax".' },
          summary: {
            type: 'string',
            description: 'Resumo curto e NEUTRO do que está no laudo, sem interpretar (ex: "Hemograma com hemoglobina 13,5; leucócitos 7.200"). NUNCA escreva se está normal ou alterado.',
          },
          findings: {
            type: 'array',
            description: 'Marcadores/valores legíveis no exame. Liste o que conseguir ler.',
            items: {
              type: 'object',
              properties: {
                marker: { type: 'string', description: 'Nome do marcador (ex: "Hemoglobina", "Glicose")' },
                value: { type: 'string', description: 'Valor lido (ex: "13.5", "98")' },
                unit: { type: 'string', description: 'Unidade (ex: "g/dL", "mg/dL")' },
                reference: { type: 'string', description: 'Faixa de referência impressa, se houver (ex: "12-16")' },
              },
              required: ['marker', 'value'],
            },
          },
          exam_date: { type: 'string', description: 'Data do exame em AAAA-MM-DD, se estiver legível no laudo. Omita se não souber.' },
          message_id: { type: 'string', description: 'ID da mensagem que contém a imagem do exame, se você souber.' },
        },
        required: ['exam_type', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_pharmacy_order',
      description: 'Inicia o fluxo de cotação de medicamentos em farmácias próximas ao usuário.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Lista de medicamentos a cotar',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                dosage: { type: 'string' },
                quantity: { type: 'string' },
                substitutes_ok: { type: 'boolean' },
              },
              required: ['name', 'substitutes_ok'],
            },
          },
          saved_address_label: {
            type: 'string',
            description: 'Se o usuário mandou entregar num endereço JÁ SALVO (ex.: disse "manda pra casa", "pro trabalho", ou você perguntou "casa/trabalho/novo?" e ele escolheu um salvo), passe o LABEL do endereço salvo aqui (ex.: "casa", "trabalho") — o backend usa a localização exata já guardada, sem re-geocodificar nem pedir de novo. Veja os "Endereços salvos" no contexto. NÃO use junto com location.',
          },
          location: {
            type: 'object',
            description: 'Localização do usuário quando é um endereço NOVO/atual (lat/lng ou endereço de texto). Use isto OU saved_address_label, não os dois.',
            properties: {
              lat: { type: 'number' },
              lng: { type: 'number' },
              address: { type: 'string' },
            },
          },
          payment_method: {
            type: 'string',
            description: 'Forma de pagamento que o usuário disse preferir (ex.: "pix", "cartão de crédito", "cartão de débito", "dinheiro"). Omitir se o usuário ainda não falou.',
          },
          preferred_pharmacy_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Se o usuário NOMEOU farmácias específicas que ele quer cotar (ex.: "tenta na Drogasil e na Pacheco"), liste os nomes aqui — elas entram na busca com PRIORIDADE, mesmo sendo grandes redes. Use também no expand_pharmacy_search.',
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: 'Consulta o estado atual de uma order de medicamento em andamento.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'UUID da order' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_pharmacy_search',
      description:
        'Amplia a busca do pedido de medicamento ATIVO: procura farmácias num raio MAIOR e contata SÓ as farmácias NOVAS (que ainda não foram cotadas neste pedido), adicionando ao mesmo pedido. Use quando o usuário pedir pra "buscar em mais farmácias", "ampliar o raio", "procurar mais longe", ou quando as cotadas não têm o que ele quer. NÃO reinicia o pedido e NÃO re-contata as mesmas farmácias.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message_supplier',
      description:
        'Manda uma mensagem PERSONALIZADA a UMA farmácia específica de um pedido em andamento OU recente (mesmo que já tenha "falhado" ou a farmácia já tenha respondido), pra RETOMAR/DESTRAVAR aquela conversa. Use quando o usuário pedir algo dirigido a uma farmácia que você já contatou: "volta na São Benedito e diz que topo o Uber", "pergunta pra Drogalobo se tem o genérico", "fala pra farmácia que respondeu que pode ser hoje à tarde". Eu identifico a farmácia pela dica (veja "ESTADO DO PEDIDO" no contexto), mando sua mensagem no WhatsApp dela e reabro a negociação — quando ela responder eu sigo o fluxo normal e você fecha com confirm_order_selection. ✅ TAMBÉM use quando, num pedido ATIVO, o usuário pedir pra cotar numa GRANDE REDE pelo nome ("não dá pra cotar na Drogasil?", "vê o preço na Pacheco/São João/Nissei/Ultrafarma") — passe o supplier_hint com o nome da rede: eu tenho o discernimento de cotar direto no SITE dela (não dependo do WhatsApp dela responder). ⚠️ NÃO use pra COMEÇAR um pedido novo (start_pharmacy_order) nem pra BUSCAR mais farmácias num raio maior (expand_pharmacy_search) nem pra responder uma PERGUNTA PENDENTE (relay_answer_to_establishment).',
      parameters: {
        type: 'object',
        properties: {
          supplier_hint: {
            type: 'string',
            description: 'Nome ou dica da farmácia-alvo, como o usuário se referiu ("São Benedito", "a que tem o remédio", "a que respondeu", "a do Uber"). Eu caso com as farmácias do pedido (ver ESTADO DO PEDIDO).',
          },
          message: {
            type: 'string',
            description: 'A mensagem que vai DIRETO pra farmácia — 1ª pessoa, curta e natural, como se VOCÊ estivesse no WhatsApp (a farmácia não sabe que há um cliente por trás). NÃO escreva "o cliente quer/topa" (3ª pessoa = robô); escreva "topo pedir o Uber sim, quanto fica no total?", "consigo retirar no balcão?", "pode ser hoje à tarde mesmo". Auto-contida.',
          },
        },
        required: ['supplier_hint', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_order_selection',
      description:
        'FECHA o pedido escolhendo UMA das farmácias já cotadas (avisa a farmácia E manda o pagamento pro cliente — é o passo que efetiva a compra). Chame SEMPRE que houver PEDIDO ATIVO com opções cotadas e o usuário aceitar/escolher uma: "aceito", "pode ser", "fechou", "quero a 1", "prefiro a Droga Raia", "a mais barata", "essa mesma". ⚠️ Isso TEM PRIORIDADE sobre relay_answer_to_establishment quando o pedido já está cotado — NÃO use relay pra fechar um pedido.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'order_id da opção escolhida (vem do PEDIDO ATIVO no contexto).' },
          quote_id: { type: 'string', description: 'quote_id da opção que o usuário escolheu (vem de options[] no PEDIDO ATIVO).' },
        },
        required: ['order_id', 'quote_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'relay_answer_to_establishment',
      description: 'Use quando há uma PERGUNTA PENDENTE de uma farmácia/clínica (você verá "PERGUNTA PENDENTE DE UM ESTABELECIMENTO" no contexto) e a mensagem do usuário responde a um DADO que ela pediu (plano vs particular, tem receita?, marca/similar, CPF). Eu devolvo a resposta ao estabelecimento e a negociação continua. ⚠️ NÃO use quando o usuário está ACEITANDO/ESCOLHENDO uma farmácia já cotada (isso é confirm_order_selection, mesmo que exista pergunta pendente). NÃO use se o usuário estiver falando de outra coisa.',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'A resposta que vai DIRETO pra farmácia/clínica — escreva em 1ª pessoa, curta e natural, como se VOCÊ estivesse respondendo no WhatsApp (a farmácia não sabe que existe um cliente por trás). NÃO escreva "o cliente quer/prefere/não quer" (3ª pessoa = cara de robô); escreva "quero…", "pode ser…", "prefiro…". Seja auto-contida (não cite o que outra farmácia falou). Ex.: "Pode ser o genérico sim, quanto fica?" / "Prefiro só a marca mesmo (Pietra 2mg), tem?" / "Meu CPF é 000.000.000-00".' },
        },
        required: ['answer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: 'Cancela uma order de medicamento em andamento.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['order_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_clinic_by_name',
      description: 'Procura um MÉDICO ou CLÍNICA pelo NOME no Google (quando o paciente dá só o nome, ex.: "quero marcar com o Dr. Fulano", "acha a Clínica Vida"). Eu busco na internet, pego o telefone e APRESENTO pro paciente confirmar se é aquele mesmo — só depois que ele confirmar é que eu chamo contact_establishment pra falar com eles. NÃO use pra farmácia (essa é discovery por localização).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome do médico ou da clínica que o paciente falou.' },
          city: { type: 'string', description: 'Cidade pra refinar a busca. Se o paciente não disse, omita (uso a cidade do perfil).' },
          specialty: { type: 'string', description: 'Especialidade, se souber (ex.: "cardiologista"). Opcional.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_establishment',
      description: 'Entra em contato com um número ESPECÍFICO pra resolver algo — use em 2 situações: (1) o paciente CONFIRMOU a clínica/médico que você achou com find_clinic_by_name ("sim, é essa") → chame SEM phone (eu uso o contato pendente); (2) o paciente COMPARTILHOU um contato do WhatsApp ou DIGITOU um número e quer que você fale com ele → passe o phone. Diga o kind (clinic pra marcar consulta, pharmacy pra pedir remédio). Pra pharmacy, passe os items. Eu salvo o contato na memória automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['clinic', 'pharmacy'], description: 'clinic = marcar consulta; pharmacy = pedir/cotar remédio.' },
          phone: { type: 'string', description: 'Telefone/WhatsApp do contato (com DDD), quando o paciente compartilhou/digitou. Omita se for confirmação de um find_clinic_by_name (uso o pendente).' },
          name: { type: 'string', description: 'Nome do contato/estabelecimento, se souber.' },
          specialty: { type: 'string', description: 'Especialidade da consulta (kind=clinic). Opcional.' },
          items: {
            type: 'array', description: 'Medicamentos a cotar (kind=pharmacy).',
            items: { type: 'object', properties: { name: { type: 'string' }, dosage: { type: 'string' }, quantity: { type: 'string' }, substitutes_ok: { type: 'boolean' } }, required: ['name', 'substitutes_ok'] },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description:
        'Cria um lembrete/despertador. Quando chegar a hora, a Xarlote manda mensagem proativa no WhatsApp e no app. Use scheduled_at (único) OU rrule (recorrente) — pelo menos um dos dois. ⚠️ Se o usuário pedir pra MUDAR/REDIVIDIR um plano de lembretes que já existe (os ativos aparecem no seu contexto em LEMBRETES ATIVOS), chame cancel_reminders dos antigos ANTES de criar os novos — senão ele recebe os dois planos duplicados.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['medication', 'appointment', 'exercise', 'hydration', 'sleep', 'custom'],
          },
          title: { type: 'string', description: 'Título curto (aparece na tela de lembretes do app)' },
          body: {
            type: 'string',
            description:
              'A mensagem que a Xarlote vai enviar quando o lembrete disparar, no tom dela (ex: "Oi Pedro! Hora da Losartana 💊 Já tomou?"). ⏰ O body é lido NO MOMENTO DO DISPARO, não agora: escreva da perspectiva desse momento futuro. Se o evento acontece no dia do disparo, é "hoje" — NUNCA copie o "amanhã" da fala do usuário (ex.: pediu "me lembra da quimio amanhã às 7h" → body "Hoje é dia da quimioterapia, 7h!" — o lembrete toca no próprio dia).',
          },
          event_at: {
            type: 'string',
            description:
              'Data/hora do EVENTO em si (ISO -03:00), quando for DIFERENTE do horário do disparo — ex.: aviso de véspera às 20h pra consulta amanhã 16h30 → scheduled_at=hoje 20h, event_at=amanhã 16h30. Permite corrigir "hoje/amanhã" do body automaticamente. Se o lembrete dispara na hora do próprio evento, omita.',
          },
          scheduled_at: {
            type: 'string',
            description: 'Lembrete ÚNICO: ISO datetime com offset de Brasília -03:00 (copie a hora local, sem converter). Ex: "2026-07-04T15:00:00-03:00".',
          },
          rrule: {
            type: 'string',
            description:
              'Lembrete RECORRENTE: RRULE com BYHOUR/BYMINUTE em HORÁRIO DE BRASÍLIA (não converta pra UTC). Ex: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" ou "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30"',
          },
          depends_on_title: {
            type: 'string',
            description:
              'SÓ para lembrete-BACKUP condicional ("me lembra às 9h30 E, SE eu não confirmar, de novo ao meio-dia"): título EXATO do lembrete PRIMÁRIO que este reforça. O backup só dispara se o usuário NÃO tiver confirmado o primário desde o último disparo dele. Crie DOIS lembretes (o primário normal + este backup com depends_on_title). Ex.: backup de creatina ao meio-dia → depends_on_title:"Creatina". NÃO use em lembrete comum.',
          },
        },
        required: ['type', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminders',
      description:
        'Cancela lembretes ATIVOS do usuário. Use quando ele pedir pra parar/cancelar/mudar lembretes ("para de me lembrar da água", "cancela o lembrete do remédio") ou ANTES de criar um plano novo que substitui um antigo (veja LEMBRETES ATIVOS no contexto). title_query busca por parte do título (ex: "água" cancela todos os de água).',
      parameters: {
        type: 'object',
        properties: {
          title_query: {
            type: 'string',
            description: 'Parte do título dos lembretes a cancelar (case-insensitive). Ex: "água", "sobrancelha", "Losartana".',
          },
          all: {
            type: 'boolean',
            description: 'true = cancela TODOS os lembretes ativos do usuário. Só use se ele pedir explicitamente ("cancela todos os meus lembretes").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        'Envia ao usuário a lista dos lembretes ativos dele (título + horário). Use quando ele perguntar "quais lembretes eu tenho?", "o que você me lembra?". NÃO repita a lista no seu texto — a ferramenta já envia formatado.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // NOTA: send_emergency_orientation foi REMOVIDA. Use red_flag_check no lugar
  // (que envia botões + escalonamento automático pro contato de emergência).

  // ─────── Tools de tratamento longitudinal (Xarlote 2.0) ─────────────────
  {
    type: 'function',
    function: {
      name: 'start_treatment_from_order',
      description: 'Após o paciente CONFIRMAR um pedido de medicamento de uso contínuo, registra como tratamento longitudinal: cria a row em treatments, registra inventário inicial e agenda lembretes diários. SÓ chame depois de confirm_order_selection bem-sucedido, e SÓ se o medicamento for de uso contínuo (ex: anti-hipertensivo, antidiabético, antidepressivo) — não pra remédio agudo (antibiótico de 7 dias, analgésico SOS).',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'ID do pedido confirmado' },
          treatment_name: { type: 'string', description: 'Nome do tratamento (ex: "Tratamento de hipertensão")' },
          condition: { type: 'string', description: 'Condição que o tratamento trata (ex: "hipertensão")' },
          daily_consumption: { type: 'number', description: 'Comprimidos por dia (ex: 1, 0.5)' },
          reminder_time: { type: 'string', description: 'Horário do lembrete diário em HH:MM 24h (ex: "08:00"). Pergunte ao paciente.' },
          duration_days: { type: 'integer', description: 'Duração esperada em dias. Omita pra tratamentos indefinidos.' },
        },
        required: ['order_id', 'treatment_name', 'daily_consumption', 'reminder_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_medication_taken',
      description: 'Registra que o paciente tomou (ou pulou) uma dose. Use quando o paciente responder a um lembrete confirmando ("tomei", "ok", "👍") ou negando ("esqueci", "pulei").',
      parameters: {
        type: 'object',
        properties: {
          medication_name: { type: 'string', description: 'Nome do medicamento' },
          status: { type: 'string', enum: ['taken', 'skipped', 'snoozed'], description: 'taken=tomou, skipped=pulou, snoozed=vai tomar mais tarde' },
          notes: { type: 'string', description: 'Notas opcionais (ex: "tomou junto com o almoço")' },
        },
        required: ['medication_name', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_treatment_status',
      description: 'Atualiza o status de um tratamento ativo. Use quando o paciente disser que parou, pausou ou completou o tratamento.',
      parameters: {
        type: 'object',
        properties: {
          treatment_name: { type: 'string', description: 'Nome do tratamento ou medicamento principal' },
          new_status: { type: 'string', enum: ['paused', 'completed', 'interrupted'], description: 'paused=pausa temporária, completed=terminou, interrupted=parou abruptamente (efeito colateral, médico mandou parar)' },
          reason: { type: 'string', description: 'Motivo (importante pra audit)' },
        },
        required: ['treatment_name', 'new_status', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_symptom',
      description: 'Registra um sintoma reportado pelo paciente. Use quando ele se queixar de algo concreto: "dor de cabeça", "febre", "tontura", "náusea". NÃO faça diagnóstico.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome do sintoma em PT-BR (ex: "dor de cabeça")' },
          intensity: { type: 'integer', minimum: 1, maximum: 10, description: 'Intensidade 1-10 se o paciente disser' },
          duration_hours: { type: 'number', description: 'Há quanto tempo tem o sintoma' },
          context: { type: 'string', description: 'Contexto: "depois do almoço", "ao acordar", "após exercício"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_my_addresses',
      description: 'Devolve a lista de endereços do paciente. Use quando ele disser "manda pra casa", "pro trabalho", "pro endereço de sempre" pra resolver qual endereço usar.',
      parameters: {
        type: 'object',
        properties: {
          label_hint: { type: 'string', description: 'Dica sobre qual endereço (ex: "casa", "trabalho", "padrão"). Opcional.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_default_address',
      description: 'Marca um endereço JÁ SALVO como padrão do paciente. Use quando ele explicitamente pedir ("deixa esse como padrão") ou após detectar uso repetido (≥3 vezes mesmo endereço).',
      parameters: {
        type: 'object',
        properties: {
          address_label: { type: 'string', description: 'Label do endereço (ex: "casa", "trabalho")' },
        },
        required: ['address_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_address',
      description: 'SALVA (ou atualiza) um endereço rotulado do paciente pra reusar nas próximas vezes. Use depois que o paciente confirmar um endereço novo e você perguntar de quem é ("é sua casa, trabalho ou outro?") + a quadra/lote (ou complemento). Assim, da próxima vez você só pergunta "casa, trabalho ou novo?" e reusa via start_pharmacy_order(saved_address_label). Se o paciente compartilhou localização 📍, o backend já tem a rua/setor — você só confirma a quadra/lote e o rótulo e salva.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Rótulo do endereço: "casa", "trabalho", ou outro nome curto que o paciente deu ("casa da minha mãe").' },
          full_address: { type: 'string', description: 'Endereço COMPLETO como o paciente confirmou, incluindo quadra/lote/número/complemento se houver (ex.: "Rua Ema 5, Qd 19 Lt 28, Recanto das Emas, Goiânia"). Se o paciente compartilhou localização 📍 e não houver texto, deixe vazio — o backend usa a localização do último pedido/mensagem.' },
          complement: { type: 'string', description: 'Complemento/quadra/lote/ponto de referência, se o paciente informou separado (ex.: "Qd 19 Lt 28", "apto 302", "casa azul do portão branco"). Opcional.' },
          notes: { type: 'string', description: 'Instrução de entrega, se houver (ex.: "deixar com o porteiro"). Opcional.' },
          set_default: { type: 'boolean', description: 'true se esse deve virar o endereço padrão (ex.: é o primeiro, ou o paciente pediu). Opcional.' },
          confirmed_residential: { type: 'boolean', description: 'Passe true SOMENTE quando o endereço parecia de hospital/clínica, você perguntou, e o paciente CONFIRMOU que é a casa/trabalho dele mesmo — aí salva sob o rótulo residencial sem re-perguntar.' },
        },
        required: ['label'],
      },
    },
  },

  // ─────── Tools de consulta médica (Xarlote 2.0) ─────────────────────────
  {
    type: 'function',
    function: {
      name: 'start_consultation_search',
      description: 'Inicia busca por consulta médica: conversa com clínicas via WhatsApp paralelamente (igual cotação de farmácia) e devolve as melhores opções. SÓ chame depois de ter especialidade + urgência + cidade.',
      parameters: {
        type: 'object',
        properties: {
          specialty: { type: 'string', description: 'Especialidade médica (ex: "cardiologia", "endocrinologia", "clínico geral")' },
          urgency: { type: 'string', enum: ['rotina', '72h', '24h', 'urgente'], description: 'Pra rotina pode esperar semanas; urgente é pra hoje/amanhã' },
          modality: { type: 'string', enum: ['presencial', 'telemedicina', 'indiferente'], description: 'Se o paciente quer pessoalmente ou online' },
          city: { type: 'string', description: 'Cidade onde quer marcar — usa default address do user se omitido' },
          plan: { type: 'string', description: 'Plano de saúde do paciente (ex: "Unimed", "Bradesco Saúde"). Omita se for particular.' },
          preferences: { type: 'object', description: 'Preferências extras: { genero_medico: "feminino", horario_pref: "manhã" }', properties: {} },
        },
        required: ['specialty', 'urgency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_consultation_selection',
      description: 'Após o paciente escolher uma das opções de consulta cotadas, confirma com a clínica e agenda. Espelho de confirm_order_selection.',
      parameters: {
        type: 'object',
        properties: {
          consultation_id: { type: 'string' },
          quote_id: { type: 'string' },
        },
        required: ['consultation_id', 'quote_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_consultation',
      description: 'Cancela uma consulta marcada.',
      parameters: {
        type: 'object',
        properties: {
          consultation_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['consultation_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_emergency_contact',
      description:
        'Cadastra o contato de emergência do paciente. Use quando o paciente mencionar quem deve ser avisado em caso de emergência (ex: "minha mãe Maria, número tal", "meu marido João, +55..."). Salva nome + telefone + relação. Em caso futuro de red flag, esse contato será avisado automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome completo ou apelido do contato.' },
          phone_e164: {
            type: 'string',
            description: 'Número em formato E.164 com +. Ex: "+5511999998888". Converta se o paciente passou em outro formato.',
          },
          relation: {
            type: 'string',
            description: 'Relação com o paciente: "mãe", "pai", "cônjuge", "filho(a)", "irmão(ã)", "amigo(a)", "cuidador(a)", "vizinho(a)", "médico(a)".',
          },
        },
        required: ['name', 'phone_e164', 'relation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'red_flag_check',
      description:
        '🚨 OBRIGATÓRIO chamar IMEDIATAMENTE quando paciente mencionar QUALQUER sinal de emergência. Sem essa tool, OS BOTÕES NÃO APARECEM — você NÃO TEM como simular botões via texto. Use SEMPRE que aparecer: "dor no peito" (chest_pain), "falta de ar" grave (breathing_difficulty), "rosto torto/fraqueza num lado/fala arrastada" (stroke_signs), "quero me matar/não quero viver" (suicide_ideation), "tô me machucando/vou me cortar" (self_harm), "tomei muito remédio" (overdose), "sangrando muito" (severe_bleeding), reação alérgica grave (allergic_reaction_severe), criança engasgada/inconsciente (child_emergency). REGRA ABSOLUTA: se você está prestes a ESCREVER algo sobre emergência, dor no peito, SAMU 192, ou botões — VOLTA e chame essa tool ANTES. Após chamar, NÃO escreva mais nada nesse turno; a tool envia automaticamente os 3 botões clicáveis no WhatsApp do paciente.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'self_harm',
              'suicide_ideation',
              'chest_pain',
              'stroke_signs',
              'overdose',
              'severe_bleeding',
              'breathing_difficulty',
              'allergic_reaction_severe',
              'child_emergency',
              'other_critical',
            ],
            description: 'Categoria do sinal detectado.',
          },
          severity: {
            type: 'string',
            enum: ['high', 'critical'],
            description: 'high = risco real mas paciente lúcido; critical = situação ativa e imediata.',
          },
          evidence: {
            type: 'string',
            description: 'Trecho/parafrase da fala do paciente que motivou o alerta (1-2 frases). Sem nome, sem CPF.',
          },
          context: {
            type: 'string',
            description: 'Contexto adicional (sintomas associados, duração, fator de risco conhecido).',
          },
        },
        required: ['category', 'severity', 'evidence'],
      },
    },
  },
];
