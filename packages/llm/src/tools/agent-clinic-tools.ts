import type { ToolDefinition } from '../client.js';

/**
 * Tools que o agente de CLÍNICA usa pra registrar cotações de consulta médica.
 *
 * Diferenças em relação a `agentPharmacyTools`:
 *  - Cotação = horário+preço+plano (não só preço)
 *  - Modalidade: presencial vs telemedicina
 *  - Plano de saúde aceito (Unimed, Amil, etc) é parte central
 *  - Múltiplas datas/horários alternativos (a clínica pode oferecer várias opções)
 */
export const agentClinicTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'record_clinic_ack',
      description: 'Clínica confirmou atender a especialidade solicitada (mas ainda não passou horário/preço).',
      parameters: {
        type: 'object',
        properties: {
          specialty_confirmed: { type: 'string', description: 'Especialidade que a clínica confirmou atender' },
          doctor_name: { type: 'string', description: 'Nome do médico, se mencionado' },
        },
        required: ['specialty_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_clinic_unavailable',
      description: 'Clínica não atende a especialidade, não tem agenda na urgência pedida, ou não aceita o plano.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Motivo: "sem agenda", "não atende plano", "especialidade não disponível", "fora de horário", etc.',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_consultation_quote',
      description:
        'Registra a oferta da clínica: horário(s), preço, plano aceito, modalidade. Use IMEDIATAMENTE que tiver pelo menos um horário + um preço (ou aceitação de plano).',
      parameters: {
        type: 'object',
        properties: {
          proposed_datetime: {
            type: 'string',
            description: 'Data+hora ISO 8601 do horário principal oferecido. Ex: "2026-06-02T14:30:00-03:00".',
          },
          alternative_datetimes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Outras datas/horários que a clínica mencionou (ISO 8601). Opcional.',
          },
          price_brl: {
            type: 'number',
            description: 'Preço da consulta em BRL. Se o paciente vai usar plano (não particular), pode ser 0.',
          },
          plan_accepted: {
            type: 'string',
            description: 'Nome do plano que a clínica aceita pro paciente, ou "particular" se não usa plano. Ex: "Unimed", "Amil", "Bradesco Saúde", "particular".',
          },
          modality: {
            type: 'string',
            enum: ['presencial', 'telemedicina'],
            description: 'Modalidade confirmada da consulta.',
          },
          payment_methods: {
            type: 'array',
            items: { type: 'string', enum: ['pix', 'cartao', 'dinheiro', 'plano'] },
            description: 'Formas de pagamento aceitas.',
          },
          doctor_name: { type: 'string', description: 'Nome do médico que vai atender, se a clínica informou.' },
          crm: { type: 'string', description: 'CRM do médico, se informado.' },
          address: { type: 'string', description: 'Endereço completo da consulta (presencial).' },
          notes: { type: 'string', description: 'Observações da clínica: levar exames, jejum, etc.' },
        },
        required: ['proposed_datetime', 'modality'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: 'Precisa de informação adicional do paciente antes de continuar (idade, sintomas, retorno ou primeira vez, etc.).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pergunta a fazer ao paciente.' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalize_clinic_contact',
      description: 'Encerra a negociação com a clínica (cotação dada, indisponível, timeout ou escalação).',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['offered', 'unavailable', 'timeout', 'escalate'],
            description: 'offered = horário oferecido com sucesso; unavailable = não atende; timeout = não respondeu; escalate = caso complexo.',
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
      name: 'record_appointment_confirmation',
      description: 'Após o paciente escolher essa clínica, ela confirma a reserva do horário. Registra confirmação final.',
      parameters: {
        type: 'object',
        properties: {
          confirmed_datetime: {
            type: 'string',
            description: 'Data+hora ISO 8601 confirmados pela clínica.',
          },
          confirmation_code: {
            type: 'string',
            description: 'Código de protocolo, se a clínica passar (opcional).',
          },
          arrival_instructions: {
            type: 'string',
            description: 'Instruções de chegada (chegar 15min antes, levar RG, jejum, etc.).',
          },
          notes: { type: 'string' },
        },
        required: ['confirmed_datetime'],
      },
    },
  },
];
