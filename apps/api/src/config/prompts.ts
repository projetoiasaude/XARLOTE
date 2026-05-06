import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROMPTS_FILE = join(__dirname, '../../data/prompts.json');

export interface PromptsConfig {
  sara_suffix: string;
  agent_override: string;
  llm_api_key: string;       // OpenRouter API key (sobrescreve OPENROUTER_API_KEY)
  llm_model: string;         // Ex: "openai/gpt-4.1-mini"
  /**
   * Interruptor mestre da Xarlote. Quando false, o webhook do uazapi descarta
   * mensagens recebidas do usuário sem chamar a IA (a Xarlote fica "desligada"
   * pro WhatsApp). O fluxo agente/farmácia segue funcionando.
   */
  xarlote_enabled: boolean;
}

const defaults: PromptsConfig = {
  sara_suffix: '',
  agent_override: '',
  llm_api_key: '',
  llm_model: 'openai/gpt-4.1-mini',
  xarlote_enabled: true,
};

export function loadPrompts(): PromptsConfig {
  try {
    if (existsSync(PROMPTS_FILE)) {
      return { ...defaults, ...JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')) };
    }
  } catch {
    // ignore
  }
  return { ...defaults };
}

export function savePrompts(data: Partial<PromptsConfig>): PromptsConfig {
  const current = loadPrompts();
  const updated = { ...current, ...data };
  writeFileSync(PROMPTS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
