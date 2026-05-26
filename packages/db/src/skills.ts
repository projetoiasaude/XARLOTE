/**
 * Helpers pra ler `agent_skills` (padrões aprendidos do paciente) e renderizar
 * num formato consumível pelo system prompt da Xarlote.
 *
 * Como funciona:
 *   - Skills ficam em agent_skills (popula via skill-extractor worker)
 *   - Cada skill tem trigger_pattern (situação) + action_pattern (comportamento)
 *   - confidence implícita: occurrences >= 5 = alta (auto-aplica); 3-4 = média
 *     (Xarlote sugere mas confirma com user); 1-2 = baixa (não mostra ainda)
 *
 * Falha silenciosa: se tabela não existe ainda (migration pendente), retorna [].
 */
import { db } from './client.js';

export interface UserSkill {
  id: string;
  triggerPattern: string;
  actionPattern: string;
  context: Record<string, unknown>;
  occurrences: number;
  lastObservedAt: string | null;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Carrega skills ativas do user + skills globais. Filtra por confidence ≥ medium
 * (occurrences ≥ 3).
 */
export async function loadUserSkills(userId: string): Promise<UserSkill[]> {
  try {
    const { data, error } = await db
      .from('agent_skills')
      .select('id, trigger_pattern, action_pattern, context, occurrences, last_observed_at')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .eq('active', true)
      .gte('occurrences', 3)
      .order('occurrences', { ascending: false })
      .limit(20);

    if (error || !data) return [];

    return data.map((r) => ({
      id: r.id,
      triggerPattern: r.trigger_pattern,
      actionPattern: r.action_pattern,
      context: (r.context as Record<string, unknown>) ?? {},
      occurrences: r.occurrences,
      lastObservedAt: r.last_observed_at,
      confidence:
        r.occurrences >= 5 ? 'high'
        : r.occurrences >= 3 ? 'medium'
        : 'low',
    }));
  } catch {
    return [];
  }
}

/**
 * Marca uma skill como "usada" — quando a Xarlote efetivamente aplica o
 * padrão num turno. Atualiza last_fired_at pra rastrear cobertura.
 */
export async function markSkillFired(skillId: string): Promise<void> {
  try {
    await db.from('agent_skills')
      .update({ last_fired_at: new Date().toISOString() })
      .eq('id', skillId);
  } catch {
    // ignora
  }
}

/**
 * Formata skills pra incluir no system prompt da Xarlote.
 * Tom: pequeno bullet point pro modelo, não verboso.
 */
export function formatSkillsForPrompt(skills: UserSkill[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = ['', '## PADRÕES APRENDIDOS DESSE PACIENTE'];
  lines.push('Use essas tendências como atalho — quando o gatilho bater, já proponha o comportamento sem perguntar (high) ou ofereça e confirme (medium).');
  lines.push('');

  for (const s of skills) {
    const ctxSummary = formatContext(s.context);
    const tag = s.confidence === 'high' ? '[ALTA — aplique direto]' : '[MÉDIA — confirme]';
    lines.push(`• Quando "${s.triggerPattern}" → ${s.actionPattern} ${tag}${ctxSummary ? ` (${ctxSummary})` : ''}`);
  }

  return lines.join('\n');
}

function formatContext(ctx: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (k.startsWith('_')) continue;
    if (k === 'sample_size' || k === 'total_observations' || k === 'total_orders' || k === 'total') continue;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.slice(0, 4).join(', ');
}
