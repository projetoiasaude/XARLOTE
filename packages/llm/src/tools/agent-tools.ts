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
      description:
        'Leva ao PACIENTE uma pergunta que SÓ ELE pode decidir (marca específica, trocar por similar/genérico, plano vs particular, CPF, dado clínico). NUNCA use pra endereço, rua, bairro, frete ou logística de entrega — isso NÃO é dúvida do paciente: você JÁ sabe a região e responde a farmácia direto (Caso D). NUNCA use pra perguntar preço/frete à farmácia — isso é texto normal pra ela (Caso A/B).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pergunta ao PACIENTE (decisão dele), na linguagem que ele entende. Não use pra endereço/frete.' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_referral',
      description:
        'A farmácia INDICOU outro estabelecimento/número pra conseguir o item (ex: "não temos, mas a Farmácia X tem, o WhatsApp deles é (62) 99999-9999" ou "liga na nossa filial do centro"). Registre o telefone indicado — a Xarlote contata o indicado AUTOMATICAMENTE pra cotar. Use SEMPRE que aparecer um telefone/contato de outro lugar na resposta, junto com record_supplier_unavailable se esta farmácia não tem o item.',
      parameters: {
        type: 'object',
        properties: {
          referred_phone: {
            type: 'string',
            description: 'O telefone indicado, como a farmácia escreveu (ex: "(62) 99661-9531", "62 3333-4444").',
          },
          referred_name: {
            type: 'string',
            description: 'Nome do estabelecimento indicado, se falado (ex: "Farmácia Tamandaré", "nossa filial do centro").',
          },
          note: { type: 'string', description: 'Contexto da indicação, se houver.' },
        },
        required: ['referred_phone'],
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
  {
    type: 'function',
    function: {
      name: 'notify_customer',
      description:
        'Envia uma mensagem PRO CLIENTE (NÃO pra farmácia) durante a logística pós-fechamento. Use quando a farmácia der um STATUS de entrega (motoboy a caminho, chegou, está na porta, ninguém atendeu), pedir um dado que só o cliente sabe (nome de quem recebe, complemento do endereço) ou avisar um problema. A mensagem vai no WhatsApp do cliente em nome da Xarlote. Sua resposta de TEXTO normal continua indo pra FARMÁCIA — esta tool é o ÚNICO jeito de falar com o cliente daqui.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Mensagem pro CLIENTE, em 1ª pessoa, tom acolhedor da Xarlote (ex.: "a farmácia falou que o entregador já tá chegando aí, consegue receber?").',
          },
          kind: {
            type: 'string',
            enum: ['delivery_update', 'question', 'problem', 'other'],
            description: 'Tipo do aviso.',
          },
        },
        required: ['message'],
      },
    },
  },
];
