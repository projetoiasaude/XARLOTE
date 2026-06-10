// Tipos do Xarlote App — espelham a resposta de GET /app/overview/:phone
// (apps/api/src/routes/app.ts). Mantidos à mão: o contrato é nosso.

export interface XarUser {
  id: string;
  phone_e164: string;
  preferred_name: string | null;
  full_name: string | null;
  birth_date: string | null;
  onboarding_status: string;
  lgpd_consent_at: string | null;
  adherence_score_30d: number | null;
  home_city: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone_e164: string | null;
  emergency_contact_relation: string | null;
  created_at: string;
}

export interface XarCondition {
  id: string;
  name: string;
  status?: string | null;
  diagnosed_at?: string | null;
  created_at: string;
}

export interface XarAllergy {
  id: string;
  /** nome da substância (coluna real: substance) */
  substance: string;
  severity: string | null;
  reaction: string | null;
}

export interface XarMedication {
  id: string;
  medication_name: string;
  dosage: string | null;
  frequency: string | null;
  notes: string | null;
  active: boolean;
  treatment_id: string | null;
  tablets_per_box: number | null;
  daily_consumption: number | null;
  expected_end_date: string | null;
  created_at: string;
}

export interface XarInventory {
  id: string;
  medication_id: string | null;
  tablets_remaining: number | null;
  tablets_per_box: number | null;
  box_count: number | null;
  purchased_at: string | null;
  expected_depletion_at: string | null;
}

export interface XarTreatment {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'interrupted' | string;
  started_at: string | null;
  ended_at: string | null;
  notes: string | null;
}

export interface XarPrescriber {
  id: string;
  name: string;
  crm: string | null;
  crm_state: string | null;
  specialty: string | null;
}

export type ReminderStatus = 'pending' | 'sent' | 'acknowledged' | 'snoozed' | 'cancelled';

export interface XarReminder {
  id: string;
  type: 'medication' | 'appointment' | 'exercise' | 'hydration' | 'sleep' | 'custom' | string;
  title: string;
  body: string | null;
  scheduled_at: string | null;
  rrule: string | null;
  next_run_at: string | null;
  status: ReminderStatus;
  payload: Record<string, unknown> | null;
  medication_id: string | null;
  created_at: string;
}

export interface XarSupplier {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
}

export type QuoteStatus =
  | 'pending'
  | 'contacting'
  | 'negotiating'
  | 'quoted'
  | 'unavailable'
  | 'timeout'
  | 'refused';

export interface XarQuote {
  id: string;
  status: QuoteStatus | string;
  total: number | null;
  subtotal: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  payment_link: string | null;
  notes: string | null;
  distance_km: number | null;
  conversation_id: string | null;
  created_at: string;
  suppliers: XarSupplier | null;
}

export type OrderStatus =
  | 'drafting'
  | 'quoting'
  | 'quoted'
  | 'confirming'
  | 'handed_off'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface XarOrder {
  id: string;
  status: OrderStatus | string;
  items: Array<{ name?: string; qty?: number; presentation?: string }> | null;
  payment_method: string | null;
  delivery_address: string | null;
  selected_quote_id: string | null;
  created_at: string;
  updated_at: string | null;
  quotes: XarQuote[];
}

export interface XarConsultationQuote {
  id: string;
  status: string;
  proposed_datetime: string | null;
  price_brl: number | null;
  modality: string | null;
  notes: string | null;
  created_at: string;
  clinics: { id: string; name: string; city: string | null; rating: number | null } | null;
}

export interface XarConsultation {
  id: string;
  status: string;
  specialty: string | null;
  urgency: string | null;
  modality: string | null;
  city: string | null;
  scheduled_at: string | null;
  created_at: string;
  consultation_quotes: XarConsultationQuote[];
}

export type MemoryKind = 'fact' | 'episode' | 'preference' | 'affect';

export interface XarMemoryCard {
  id: string;
  kind: MemoryKind | string;
  text: string;
  tags: string[] | null;
  confidence: number | null;
  source: 'self_reported' | 'inferred' | string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface XarSymptom {
  id: string;
  name: string;
  intensity: number | null;
  duration_hours: number | null;
  context: string | null;
  red_flag_triggered: boolean | null;
  created_at: string;
}

export interface XarMedicationLog {
  id: string;
  status: 'taken' | 'skipped' | 'snoozed' | 'no_response' | string;
  scheduled_at: string | null;
  responded_at: string | null;
  medication_id: string | null;
  created_at: string;
}

export interface XarOverview {
  user: XarUser;
  conversationId: string | null;
  conditions: XarCondition[];
  allergies: XarAllergy[];
  medications: XarMedication[];
  inventory: XarInventory[];
  treatments: XarTreatment[];
  prescribers: XarPrescriber[];
  reminders: XarReminder[];
  orders: XarOrder[];
  consultations: XarConsultation[];
  memoryCards: XarMemoryCard[];
  symptoms: XarSymptom[];
  medicationLog: XarMedicationLog[];
}

export interface XarMessage {
  id: string;
  conversation_id?: string;
  direction: 'in' | 'out';
  sender_role: string;
  content_type: string;
  content: string | null;
  transcript?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  created_at: string;
  /** Só no client: bolha otimista aguardando eco do realtime */
  pending?: boolean;
  /** Só no client: envio falhou */
  failed?: boolean;
}
