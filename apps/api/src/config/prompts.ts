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
   * Kill-switches POR FLUXO (hot-reload via /prompts, sem redeploy). Cada um
   * desliga só o seu fluxo — diferente de xarlote_enabled, que muda TUDO. Servem
   * de freio de emergência (ex: rajada de lembretes, disparo indevido a farmácia).
   */
  reminders_enabled: boolean;
  nudges_enabled: boolean;
  pharmacy_outbound_enabled: boolean;
  clinic_outbound_enabled: boolean;

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
  // Modelo conversacional/agêntico principal. z-ai/glm-5.2 (OpenRouter): mais
  // inteligente que gpt-4.1-mini em raciocínio + uso de ferramentas, 1M de
  // contexto, e faz PROMPT CACHING automático do prefixo (system prompt grande
  // da Xarlote cacheia ~99% dos tokens de input a partir do 2º turno → paga
  // menos). tools:true confirmado ao vivo. Trocável via env OPENROUTER_MODEL.
  llm_model: 'z-ai/glm-5.2',
  // Visão continua no gpt-4.1-mini (comprovado lendo receita/exame). glm-5.2
  // não é vision-capable; os modelos glm-*v seriam o caminho se quisermos trocar.
  vision_model: 'openai/gpt-4.1-mini',
  audio_model: 'elevenlabs/scribe_v1',
  xarlote_enabled: true,
  reminders_enabled: true,
  nudges_enabled: true,
  pharmacy_outbound_enabled: true,
  clinic_outbound_enabled: true,
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
  // Permite trocar o modelo conversacional só setando a env no Railway (sem redeploy
  // de código). Precedência: defaults < env < prompts.json (dashboard).
  if (process.env['OPENROUTER_MODEL']) envOverrides.llm_model = process.env['OPENROUTER_MODEL']!;
  if (process.env['ELEVENLABS_API_KEY']) envOverrides.tts_api_key = process.env['ELEVENLABS_API_KEY'];
  if (process.env['TTS_ENABLED']) envOverrides.tts_enabled = process.env['TTS_ENABLED'] === 'true' || process.env['TTS_ENABLED'] === '1';
  if (process.env['TTS_VOICE_ID']) envOverrides.tts_voice_id = process.env['TTS_VOICE_ID']!;
  if (process.env['TTS_MODEL']) envOverrides.tts_model = process.env['TTS_MODEL']!;
  if (process.env['TTS_SPEED']) {
    const n = parseFloat(process.env['TTS_SPEED']!);
    if (!isNaN(n) && n >= 0.7 && n <= 1.2) envOverrides.tts_speed = n;
  }
  // Kill-switches por fluxo também via env (freio de emergência sem dashboard). Só
  // desligam quando explicitamente "false"/"0"; ausente = mantém o default (ligado).
  // Ex.: PHARMACY_OUTBOUND_ENABLED=false pausa o disparo a farmácias fora de horário.
  // Precedência: default < env < prompts.json (dashboard tem a palavra final).
  for (const [envName, key] of [
    ['REMINDERS_ENABLED', 'reminders_enabled'],
    ['NUDGES_ENABLED', 'nudges_enabled'],
    ['PHARMACY_OUTBOUND_ENABLED', 'pharmacy_outbound_enabled'],
    ['CLINIC_OUTBOUND_ENABLED', 'clinic_outbound_enabled'],
  ] as const) {
    const v = process.env[envName];
    if (v !== undefined) envOverrides[key] = !(v === 'false' || v === '0');
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
