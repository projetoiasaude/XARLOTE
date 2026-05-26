/**
 * query_user_360 — perfil rico do paciente em UM round-trip ao banco.
 *
 * Substitui N queries individuais (conditions/allergies/meds/addresses/orders/
 * memory/reminders) por uma única chamada que devolve JSON estruturado.
 * Usado pelo system prompt da Xarlote pra ter contexto sem latência.
 *
 * Fallback: se a RPC `query_user_360` ainda não existir no banco (deploy
 * intermediário), devolve null e o caller deve cair na rota legada (N queries
 * individuais).
 */
import { db } from './client.js';

export interface User360Snapshot {
  user: {
    id: string;
    phone_e164: string;
    preferred_name: string | null;
    full_name: string | null;
    onboarding_status: string;
    lgpd_consent_at: string | null;
    health_summary?: string | null;
    adherence_score_30d?: number | null;
    last_active_at?: string | null;
    [k: string]: unknown;
  };
  preferences: Record<string, unknown>;
  conditions: Array<{ id: string; name: string; severity?: string; since?: string; source?: string }>;
  allergies: Array<{ id: string; substance: string; severity?: string; reaction?: string; source?: string }>;
  active_treatments: Array<{
    id: string;
    name: string;
    status: string;
    started_at: string;
    medications: Array<{
      id: string;
      name: string;
      dosage: string | null;
      frequency: string | null;
      daily_consumption: number | null;
      tablets_remaining: number | null;
      days_remaining: number | null;
      last_taken_at: string | null;
    }>;
  }>;
  addresses: Array<{
    id: string;
    label: string;
    street?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    is_default: boolean;
    usage_count: number;
    last_used_at?: string;
    notes?: string;
  }>;
  recent_symptoms: Array<{
    name: string;
    intensity?: number;
    duration_hours?: number;
    context?: string;
    created_at: string;
  }>;
  upcoming_consultations: Array<{
    id: string;
    specialty: string;
    scheduled_at: string;
    modality?: string;
    clinic_name?: string;
    prescriber_name?: string;
  }>;
  favorite_pharmacies: Array<{ id: string; name: string; orders: number; last_order_at: string }>;
  active_order_id: string | null;
  adherence_score_30d: number | null;
  skills: Array<{ trigger: string; action: string; context: Record<string, unknown>; occurrences: number }>;
}

/**
 * Tenta usar a RPC `query_user_360`. Retorna null se a função não existe
 * (deploy intermediário — caller usa fallback de queries individuais).
 */
export async function queryUser360(userId: string): Promise<User360Snapshot | null> {
  try {
    const { data, error } = await db.rpc('query_user_360', { p_user_id: userId });
    if (error) {
      // Função pode não existir ainda (migration pendente)
      if (error.message?.includes('does not exist') || error.code === '42883') {
        return null;
      }
      return null;
    }
    return (data as User360Snapshot) ?? null;
  } catch {
    return null;
  }
}

/**
 * Formata snapshot pro system prompt em texto compacto e estruturado.
 * Otimizado pra LLM ler — usa marcadores claros, agrupa por seção.
 */
export function formatUser360ForPrompt(snap: User360Snapshot): string {
  const parts: string[] = [];

  // Identidade básica
  const name = snap.user.preferred_name ?? snap.user.full_name ?? 'paciente';
  parts.push(`## PACIENTE\nNome: ${name}`);
  if (snap.user.health_summary) parts.push(`Resumo: ${snap.user.health_summary}`);
  if (snap.adherence_score_30d != null) {
    parts.push(`Adesão últimos 30 dias: ${Math.round(snap.adherence_score_30d * 100)}%`);
  }

  // Condições e alergias (curtos, importante manter)
  if (snap.conditions.length > 0) {
    parts.push(`\n## CONDIÇÕES ATIVAS\n${snap.conditions.map((c) => `- ${c.name}${c.severity ? ` (${c.severity})` : ''}`).join('\n')}`);
  }
  if (snap.allergies.length > 0) {
    parts.push(`\n## ALERGIAS\n${snap.allergies.map((a) => `- ${a.substance}${a.severity ? ` (${a.severity})` : ''}${a.reaction ? ` — ${a.reaction}` : ''}`).join('\n')}`);
  }

  // Tratamentos ativos com inventário/adesão
  if (snap.active_treatments.length > 0) {
    parts.push(`\n## TRATAMENTOS ATIVOS`);
    for (const t of snap.active_treatments) {
      parts.push(`### ${t.name} (desde ${t.started_at})`);
      for (const m of t.medications) {
        const dose = m.dosage ?? '?';
        const freq = m.daily_consumption != null ? `${m.daily_consumption}/dia` : (m.frequency ?? '?');
        const stock = m.tablets_remaining != null
          ? ` · ${m.tablets_remaining} cp restantes (${m.days_remaining}d)`
          : '';
        parts.push(`- ${m.name} ${dose} ${freq}${stock}`);
      }
    }
  }

  // Endereços (priorizado pelo default)
  if (snap.addresses.length > 0) {
    parts.push(`\n## ENDEREÇOS`);
    for (const a of snap.addresses) {
      const marker = a.is_default ? ' [padrão]' : '';
      const stats = a.usage_count > 0 ? ` (usado ${a.usage_count}×)` : '';
      const loc = [a.street, a.neighborhood, a.city, a.state].filter(Boolean).join(', ');
      parts.push(`- ${a.label}${marker}: ${loc}${stats}${a.notes ? ` — ${a.notes}` : ''}`);
    }
  }

  // Consultas marcadas
  if (snap.upcoming_consultations.length > 0) {
    parts.push(`\n## CONSULTAS MARCADAS`);
    for (const c of snap.upcoming_consultations) {
      const when = new Date(c.scheduled_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
      parts.push(`- ${c.specialty} em ${when}${c.prescriber_name ? ` com ${c.prescriber_name}` : ''}${c.clinic_name ? ` na ${c.clinic_name}` : ''}`);
    }
  }

  // Sintomas recentes
  if (snap.recent_symptoms.length > 0) {
    parts.push(`\n## SINTOMAS RECENTES`);
    for (const s of snap.recent_symptoms) {
      const when = new Date(s.created_at).toLocaleDateString('pt-BR');
      parts.push(`- ${s.name}${s.intensity ? ` (intensidade ${s.intensity}/10)` : ''} em ${when}${s.context ? ` — ${s.context}` : ''}`);
    }
  }

  // Farmácias preferidas
  if (snap.favorite_pharmacies.length > 0) {
    const top = snap.favorite_pharmacies.slice(0, 3).map((p) => `${p.name} (${p.orders}×)`).join(', ');
    parts.push(`\n## FARMÁCIAS PREFERIDAS\n${top}`);
  }

  // Skills aprendidas (procedural memory)
  if (snap.skills.length > 0) {
    parts.push(`\n## PADRÕES APRENDIDOS DO PACIENTE`);
    for (const sk of snap.skills.slice(0, 6)) {
      parts.push(`- Quando ${sk.trigger} → ${sk.action} (observado ${sk.occurrences}×)`);
    }
  }

  // Pedido ativo (importante pra Xarlote saber)
  if (snap.active_order_id) {
    parts.push(`\n## PEDIDO EM ANDAMENTO\nID: ${snap.active_order_id} — consulta com get_order_status antes de iniciar novo pedido`);
  }

  return parts.join('\n');
}
