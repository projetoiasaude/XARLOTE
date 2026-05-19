import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROMPTS_FILE = join(__dirname, '../../data/prompts.json');

export interface PromptsConfig {
  sara_suffix: string;
  agent_override: string;
  llm_api_key: string;       // OpenRouter API key (sobrescreve OPENROUTER_API_KEY)
  llm_model: string;         // Ex: "openai/gpt-4.1-mini" — modelo conversacional principal
  /**
   * Modelo usado pra entender IMAGEM (multimodal vision). Precisa ser vision-capable.
   * Default: openai/gpt-4.1-mini.
   */
  vision_model: string;
  /**
   * Modelo usado pra TRANSCREVER ÁUDIO. Aceita tanto modelos OpenRouter
   * (`openai/whisper-1`) quanto Gemini direto (`gemini/gemini-2.0-flash`).
   * Default: openai/whisper-1.
   */
  audio_model: string;
  /**
   * Interruptor mestre da Xarlote. Quando false, o webhook do uazapi descarta
   * mensagens recebidas do usuário sem chamar a IA (a Xarlote fica "desligada"
   * pro WhatsApp). O fluxo agente/farmácia segue funcionando.
   */
  xarlote_enabled: boolean;

  /**
   * TTS — Xarlote responde em ÁUDIO em momentos raros.
   * Hoje: dispara só na primeira saudação chamando o nome do usuário,
   * controlado por `users.metadata.audio_intro_sent`.
   */
  tts_enabled: boolean;
  /** API key do ElevenLabs (https://elevenlabs.io). Pode usar ELEVENLABS_API_KEY como fallback. */
  tts_api_key: string;
  /** voice_id ElevenLabs — premade Sarah por default. */
  tts_voice_id: string;
  /** Modelo TTS — `eleven_flash_v2_5` (recomendado, suporta pt) ou `eleven_multilingual_v2`. */
  tts_model: string;
  /**
   * Velocidade da fala (0.7-1.2). Default 1.10 — 10% mais rápido que o
   * neutro pra Xarlote não soar arrastada. Acima de 1.15 fica robótico.
   */
  tts_speed: number;
}

const defaults: PromptsConfig = {
  sara_suffix: '',
  agent_override: '',
  llm_api_key: '',
  llm_model: 'openai/gpt-4.1-mini',
  vision_model: 'openai/gpt-4.1-mini',
  audio_model: 'elevenlabs/scribe_v1',
  xarlote_enabled: true,
  tts_enabled: false,
  tts_api_key: '',
  // Carla — Inviting, Warm and Helpful (BR-nativa, shared library).
  // Identidade definida da Xarlote. Configurável mas com default forte.
  tts_voice_id: 'm151rjrbWXbBqyq56tly',
  // Multilingual v2 — melhor pronúncia PT-BR, suporta <break/> SSML.
  tts_model: 'eleven_multilingual_v2',
  tts_speed: 1.10,
};

/**
 * Carrega config aplicando esta precedência (do menor pro maior):
 *   1. defaults (hardcoded)
 *   2. env vars (ELEVENLABS_API_KEY, TTS_ENABLED, OPENROUTER_API_KEY etc) —
 *      útil em produção quando o arquivo prompts.json não existe (gitignored).
 *   3. prompts.json (overrides via dashboard)
 *
 * Assim em Railway basta setar `ELEVENLABS_API_KEY` + `TTS_ENABLED=true`
 * e a TTS já funciona sem precisar do dashboard.
 */
export function loadPrompts(): PromptsConfig {
  const envOverrides: Partial<PromptsConfig> = {};
  if (process.env['OPENROUTER_API_KEY']) envOverrides.llm_api_key = process.env['OPENROUTER_API_KEY'];
  if (process.env['ELEVENLABS_API_KEY']) envOverrides.tts_api_key = process.env['ELEVENLABS_API_KEY'];
  if (process.env['TTS_ENABLED']) envOverrides.tts_enabled = process.env['TTS_ENABLED'] === 'true' || process.env['TTS_ENABLED'] === '1';
  if (process.env['TTS_VOICE_ID']) envOverrides.tts_voice_id = process.env['TTS_VOICE_ID']!;
  if (process.env['TTS_MODEL']) envOverrides.tts_model = process.env['TTS_MODEL']!;
  if (process.env['TTS_SPEED']) {
    const n = parseFloat(process.env['TTS_SPEED']!);
    if (!isNaN(n) && n >= 0.7 && n <= 1.2) envOverrides.tts_speed = n;
  }

  let fileOverrides: Partial<PromptsConfig> = {};
  try {
    if (existsSync(PROMPTS_FILE)) {
      fileOverrides = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return { ...defaults, ...envOverrides, ...fileOverrides };
}

export function savePrompts(data: Partial<PromptsConfig>): PromptsConfig {
  const current = loadPrompts();
  const updated = { ...current, ...data };
  writeFileSync(PROMPTS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
