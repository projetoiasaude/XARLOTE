import type { ToolDefinition } from '../client.js';

export const saraTools: ToolDefinition[] = [
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
  {
    type: 'function',
    function: {
      name: 'send_emergency_orientation',
      description: 'Envia orientação de emergência (SAMU 192) quando há suspeita de situação grave.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['moderate', 'high', 'critical'] },
          symptoms_summary: { type: 'string' },
        },
        required: ['severity'],
      },
    },
  },
];
