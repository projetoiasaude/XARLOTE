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
            enum: ['condition', 'allergy', 'medication', 'address', 'preference', 'other'],
            description: 'Categoria do fato',
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
          location: {
            type: 'object',
            description: 'Localização do usuário (lat/lng ou endereço)',
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
      name: 'confirm_order_selection',
      description: 'Registra a escolha do usuário por uma das farmácias cotadas.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          quote_id: { type: 'string' },
        },
        required: ['order_id', 'quote_id'],
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
      name: 'create_reminder',
      description: 'Cria um lembrete para medicação, consulta, exercício ou outro hábito de saúde.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['medication', 'appointment', 'exercise', 'hydration', 'sleep', 'custom'],
          },
          title: { type: 'string' },
          scheduled_at: { type: 'string', description: 'ISO datetime para lembretes únicos' },
          rrule: { type: 'string', description: 'RRULE para lembretes recorrentes' },
        },
        required: ['type', 'title'],
      },
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
      description: 'Marca um endereço como padrão do paciente. Use quando ele explicitamente pedir ("deixa esse como padrão") ou após detectar uso repetido (≥3 vezes mesmo endereço).',
      parameters: {
        type: 'object',
        properties: {
          address_label: { type: 'string', description: 'Label do endereço (ex: "casa", "trabalho")' },
        },
        required: ['address_label'],
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
        'USE IMEDIATAMENTE quando perceber sinal sério de emergência ou risco. Não é pra alarme falso — só dispare quando tem indício forte. Exemplos: paciente fala em "me machucar", "suicídio", "não quero viver"; descreve dor no peito + falta de ar; descreve sintomas de AVC (rosto torto, fraqueza num lado, fala arrastada súbita); criança engoliu medicamento; overdose intencional; sangramento intenso. A tool registra o caso, dispara alerta interno e te dá orientação imediata pra você passar pro paciente.',
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
