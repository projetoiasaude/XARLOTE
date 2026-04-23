import type { ToolDefinition } from '../client.js';

export const agentPharmacyTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'record_supplier_ack',
      description: 'Farmácia confirmou que tem os itens solicitados.',
      parameters: {
        type: 'object',
        properties: {
          items_confirmed: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nomes dos itens confirmados',
          },
        },
        required: ['items_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_supplier_unavailable',
      description: 'Farmácia não tem o item ou não realiza entrega na região.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          partial_items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Itens disponíveis, se parcial',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_quote_price',
      description: 'Registra preço, frete, prazo e forma de pagamento informados pela farmácia.',
      parameters: {
        type: 'object',
        properties: {
          subtotal: { type: 'number' },
          delivery_fee: { type: 'number' },
          total: { type: 'number' },
          eta_minutes: { type: 'number' },
          payment_methods: {
            type: 'array',
            items: { type: 'string', enum: ['pix', 'cartao', 'dinheiro'] },
          },
          pix_key: { type: 'string' },
          payment_link: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['total', 'payment_methods'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: 'Precisa de informação adicional do usuário antes de continuar a negociação.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pergunta para o usuário' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalize_supplier_contact',
      description: 'Encerra a negociação com a farmácia (sucesso, indisponível, timeout ou escalação).',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['quoted', 'unavailable', 'timeout', 'escalate'],
          },
          notes: { type: 'string' },
        },
        required: ['outcome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_order_confirmation',
      description: 'Registra confirmação da farmácia de que o pedido está sendo preparado para entrega.',
      parameters: {
        type: 'object',
        properties: {
          estimated_delivery_minutes: {
            type: 'number',
            description: 'Tempo estimado de entrega em minutos',
          },
          notes: {
            type: 'string',
            description: 'Observações da farmácia sobre o pedido',
          },
        },
        required: [],
      },
    },
  },
];
