// ─── Enums ──────────────────────────────────────────────────────────────────

export type MessageDirection = 'in' | 'out';
export type MessageContentType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'sticker' | 'system';
export type ConversationParty = 'user' | 'supplier';
export type OrderStatus = 'drafting' | 'quoting' | 'quoted' | 'confirming' | 'handed_off' | 'cancelled' | 'failed';
export type QuoteStatus = 'pending' | 'contacting' | 'negotiating' | 'quoted' | 'unavailable' | 'timeout' | 'refused';
export type ReminderType = 'medication' | 'appointment' | 'exercise' | 'hydration' | 'sleep' | 'custom';
export type ReminderStatus = 'pending' | 'sent' | 'acknowledged' | 'snoozed' | 'cancelled';
export type SupplierType = 'pharmacy' | 'clinic' | 'lab' | 'therapist' | 'hospital';
export type OnboardingStatus = 'not_started' | 'consent_pending' | 'profiling' | 'active';
export type WhatsAppMode = 'simulator' | 'uazapi';

// ─── Core domain ────────────────────────────────────────────────────────────

export interface User {
  id: string;
  phone_e164: string;
  full_name: string | null;
  preferred_name: string | null;
  birth_date: string | null;
  timezone: string;
  onboarding_status: OnboardingStatus;
  lgpd_consent_at: string | null;
  lgpd_consent_version: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UserAddress {
  id: string;
  user_id: string;
  label: string;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
  latitude: number | null;
  longitude: number | null;
  is_default: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  party_type: ConversationParty;
  user_id: string | null;
  supplier_id: string | null;
  whatsapp_instance: string;
  whatsapp_jid: string;
  status: string;
  last_message_at: string | null;
  summary: string | null;
  memory_cards: MemoryCard[];
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  external_id: string | null;
  direction: MessageDirection;
  sender_role: 'user' | 'assistant' | 'supplier' | 'system';
  content_type: MessageContentType;
  content: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_duration_ms: number | null;
  location_lat: number | null;
  location_lng: number | null;
  raw_payload: unknown | null;
  llm_model: string | null;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_latency_ms: number | null;
  trace_id: string | null;
  created_at: string;
}

export interface Supplier {
  id: string;
  type: SupplierType;
  name: string;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  whatsapp_verified_at: string | null;
  google_place_id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  status: string;
  tags: string[];
  last_contacted_at: string | null;
  created_at: string;
}

export interface OrderItem {
  name: string;
  dosage?: string;
  quantity?: string;
  substitutes_ok: boolean;
}

export interface Order {
  id: string;
  user_id: string;
  conversation_id: string | null;
  origin: string;
  status: OrderStatus;
  items: OrderItem[];
  user_address_id: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  selected_quote_id: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteItem {
  name: string;
  price: number;
  available: boolean;
}

export interface Quote {
  id: string;
  order_id: string;
  supplier_id: string;
  conversation_id: string | null;
  status: QuoteStatus;
  distance_km: number | null;
  items_available: QuoteItem[] | null;
  subtotal: number | null;
  delivery_fee: number | null;
  total: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  payment_link: string | null;
  notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Reminder {
  id: string;
  user_id: string;
  type: ReminderType;
  title: string;
  body: string | null;
  scheduled_at: string | null;
  rrule: string | null;
  next_run_at: string | null;
  status: ReminderStatus;
  payload: Record<string, unknown>;
  medication_id: string | null;
  created_at: string;
}

export interface MemoryCard {
  created_at: string;
  text: string;
  tags: string[];
}

export interface SystemLog {
  id: number;
  level: string;
  category: string;
  trace_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
  order_id: string | null;
  quote_id: string | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ─── Inbound/Queue types ─────────────────────────────────────────────────────

export interface NormalizedInbound {
  instance: string;
  externalId: string;
  from: {
    jid: string;
    pushName?: string;
    phoneE164: string;
  };
  fromMe: boolean;
  timestamp: Date;
  contentType: MessageContentType;
  text?: string;
  mediaUrl?: string;
  mediaBase64?: string;
  mediaMime?: string;
  mediaDurationMs?: number;
  location?: { lat: number; lng: number; name?: string; address?: string };
  raw: unknown;
}

export interface InboundUserJob {
  conversationId: string;
  messageId: string;
  traceId: string;
}

export interface InboundSupplierJob {
  conversationId: string;
  messageId: string;
  quoteId: string;
  traceId: string;
}

export interface OutboundJob {
  instance: string;
  targetPhoneE164: string;
  kind: MessageContentType;
  content: string;
  mediaUrl?: string;
  conversationId: string;
  echoMessageId?: string;
  traceId: string;
}

export interface PharmacyDiscoveryJob {
  orderId: string;
  traceId: string;
}

export interface PharmacyNegotiationJob {
  quoteId: string;
  trigger: 'initiate' | 'inbound_reply';
  traceId: string;
}

export interface QuoteConsolidationJob {
  orderId: string;
  reason: 'quote_completed' | 'timeout' | 'manual';
  traceId: string;
}

export interface ProfileEnricherJob {
  conversationId: string;
  messageIds: string[];
  traceId: string;
}

// ─── Simulate ───────────────────────────────────────────────────────────────

export interface SimulateInboundPayload {
  phone: string;
  name?: string;
  contentType: MessageContentType;
  text?: string;
  imageBase64?: string;
  imageMime?: string;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
}
