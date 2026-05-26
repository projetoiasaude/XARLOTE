/**
 * Text-to-speech via ElevenLabs.
 *
 * Usado pra que a Xarlote responda em ÁUDIO em momentos pontuais (hoje:
 * só a primeira saudação chamando o nome do usuário). Mantemos o universo
 * de envio bem pequeno por dois motivos:
 *   1. Quota ElevenLabs é finita (~$5/mês no Starter = ~30k chars).
 *   2. Áudio TTS perde a graça se virar default; rareza = surpresa = humanização.
 *
 * Modelo default: `eleven_flash_v2_5` — latência ~75ms first byte, ~70%
 * mais barato que o Multilingual v2, qualidade ótima pra PT-BR.
 *
 * Voice ID default: Xarloteh (`EXAVITQu4vr4xnSDxMaL`) — premade feminina suave,
 * funciona bem com PT via Flash v2.5. Configurável em /prompts.
 *
 * Saída: MP3 44.1kHz 128kbps por padrão (formato bem aceito por uazapi /send/media).
 */
import axios from 'axios';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export interface TtsOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  /** 0-1, default 0.5. Menor = mais expressivo/variável. */
  stability?: number;
  /** 0-1, default 0.75. Maior = mais fiel ao timbre original. */
  similarityBoost?: number;
  /** 0-1, default 0.5. Maior = mais dramático. */
  style?: number;
  /**
   * Velocidade da fala (0.7-1.2, default 1.0).
   * Xarlote usa 1.10 por padrão — soa natural sem virar "leitor de rádio".
   * Acima de 1.15 a prosódia começa a ficar artificial.
   */
  speed?: number;
  /** Boost de clareza/presença. Default true. */
  useSpeakerBoost?: number | boolean;
  /** Código de idioma — só usado por modelos Turbo v2.5/Flash v2.5. */
  languageCode?: string;
  /** mp3 default; pode usar `mp3_22050_32`, `pcm_16000`, `opus_48000_*`. */
  outputFormat?: string;
  timeoutMs?: number;
}

export interface TtsResult {
  buffer: Buffer;
  mime: string;
  model: string;
  voiceId: string;
  charsBilled: number;
}

/**
 * Voz default da Xarlote — identidade própria, BR-nativa.
 *
 * Carla — "Inviting, Warm and Helpful" (ElevenLabs shared library).
 * - Acento: brazilian
 * - Idade: young female
 * - Descritivo: professional, accolhedora
 * - Use case: informative_educational (combina com concierge de saúde)
 * - ~37k clones na library (validação de qualidade pela comunidade)
 *
 * Comparada com vozes premade inglesas (Xarloteh/Jessica/etc) tocadas via
 * `multilingual_v2` → muito menos sotaque, prosódia PT-BR natural,
 * pronúncia correta de nomes ("Hiago" → "Iago" com H mudo), entonação
 * caloriosa nas perguntas.
 */
const DEFAULT_VOICE = 'm151rjrbWXbBqyq56tly'; // Carla — Inviting, Warm and Helpful (BR)
const DEFAULT_MODEL = 'eleven_multilingual_v2'; // Melhor PT-BR; suporta SSML <break>
const DEFAULT_FORMAT = 'mp3_44100_128';

export async function synthesizeSpeech(
  text: string,
  opts: TtsOptions
): Promise<TtsResult> {
  if (!opts.apiKey) {
    throw new Error('ElevenLabs apiKey ausente');
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Texto vazio pra TTS');

  const voiceId = opts.voiceId || DEFAULT_VOICE;
  const modelId = opts.modelId || DEFAULT_MODEL;
  const outputFormat = opts.outputFormat || DEFAULT_FORMAT;

  const body: Record<string, unknown> = {
    text: trimmed,
    model_id: modelId,
    voice_settings: {
      // Stability baixa (0.30-0.40) → mais variação emocional, soa menos
      // robótico. Pra conversational/warm, ElevenLabs recomenda <0.5.
      stability: opts.stability ?? 0.35,
      // Similarity alto → consistência do timbre próprio da voz Carla.
      similarity_boost: opts.similarityBoost ?? 0.85,
      // Style alto → mais dramatismo/entonação no momento de saudação.
      style: opts.style ?? 0.55,
      // Speed 1.10 → 10% mais rápido que o default neutro (1.0), soa natural.
      speed: opts.speed ?? 1.10,
      use_speaker_boost:
        typeof opts.useSpeakerBoost === 'boolean'
          ? opts.useSpeakerBoost
          : (opts.useSpeakerBoost ?? 1) > 0,
    },
  };
  // Flash/Turbo v2.5 aceita language_code; Multilingual v2 não.
  if (opts.languageCode || modelId.includes('flash') || modelId.includes('turbo')) {
    body['language_code'] = opts.languageCode || 'pt';
  }

  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=${encodeURIComponent(outputFormat)}`;

  const res = await axios.post<ArrayBuffer>(url, body, {
    headers: {
      'xi-api-key': opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    responseType: 'arraybuffer',
    timeout: opts.timeoutMs ?? 30_000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    // ElevenLabs devolve JSON de erro com a mesma key — tenta parse
    let errText: string;
    try {
      errText = Buffer.from(res.data).toString('utf-8');
    } catch {
      errText = `status ${res.status}`;
    }
    throw new Error(`ElevenLabs ${res.status}: ${errText.slice(0, 240)}`);
  }

  const buffer = Buffer.from(res.data);
  const mime = outputFormat.startsWith('mp3')
    ? 'audio/mpeg'
    : outputFormat.startsWith('opus')
      ? 'audio/ogg'
      : outputFormat.startsWith('pcm')
        ? 'audio/wav'
        : 'audio/mpeg';

  return {
    buffer,
    mime,
    model: modelId,
    voiceId,
    charsBilled: trimmed.length,
  };
}

/**
 * Lista vozes disponíveis na conta — útil pro dashboard montar dropdown.
 * Retorna `[]` em falha (não bloqueia UI).
 */
export interface VoiceSummary {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Humanizer — transforma o texto que a Xarlote escreveu em "voice script"
// otimizado pro ElevenLabs entregar áudio NATURAL em PT-BR.
//
// Princípios:
//   1. Não muda o texto exibido no dashboard/messages — opera SÓ na hora de
//      sintetizar. O usuário vê "Oi Hiago" no log; ouve "Oi Iago" no áudio.
//   2. Corrige pronúncia de nomes que o TTS erra:
//      - H mudo: "Hiago" → "Iago", "Hugo" → "Ugo", "Heitor" → "Eitor"
//      - Iniciais soletradas: "JP" → "jota pê", "AC" → "a cê", "TC" → "tê cê"
//   3. Insere pausa SSML (<break time="0.3s"/>) após primeira vírgula da
//      saudação — cria aquele micro-respiro de sorriso ("Oi Iago, [pausa] prazer!").
//   4. Substitui reticências "…" e "..." por <break time="0.4s"/> pra
//      pausas mais limpas que o "...uhh..." que o TTS faz sozinho.
//   5. Mantém pontuação restante intacta — vírgulas e exclamações já dão
//      entonação suficiente quando combinadas com voice_settings calibrados.
// ─────────────────────────────────────────────────────────────────────────────

/** Fonema brasileiro de cada letra do alfabeto (pra soletrar iniciais). */
const PT_LETTER: Record<string, string> = {
  A: 'a', B: 'bê', C: 'cê', D: 'dê', E: 'é', F: 'éfe',
  G: 'gê', H: 'agá', I: 'i', J: 'jota', K: 'cá', L: 'éle',
  M: 'ême', N: 'êne', O: 'ó', P: 'pê', Q: 'quê', R: 'erre',
  S: 'ésse', T: 'tê', U: 'u', V: 'vê', W: 'dáblio', X: 'chis',
  Y: 'ípsilon', Z: 'zê',
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detecta se a string é iniciais (2-5 letras maiúsculas seguidas) e devolve
 * versão soletrada em PT-BR. "JP" → "jota pê", "AC" → "a cê", "BC" → "bê cê".
 * Retorna null se não for iniciais.
 */
function spellInitialsIfApplicable(name: string): string | null {
  // 2-3 letras maiúsculas = quase sempre iniciais (JP, AC, RG, USP).
  // 4+ letras = quase sempre nome em caixa alta (HIAGO, MARIA) — não soletra.
  if (!/^[A-Z]{2,3}$/.test(name)) return null;
  return name.split('').map((c) => PT_LETTER[c] ?? c).join(' ');
}

/**
 * Normaliza nome em caixa alta pra capitalização normal antes de aplicar
 * outras regras: "HIAGO" → "Hiago", "MARIA" → "Maria".
 * Mantém nomes compostos com hífen/espaço.
 */
function normalizeCaps(name: string): string {
  if (!/^[A-ZÁÉÍÓÚÂÊÔÃÕ]+(?:[\s-][A-ZÁÉÍÓÚÂÊÔÃÕ]+)*$/.test(name)) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Aplica fonética PT-BR num nome único:
 *   - Inicial H + vogal → remove o H (H mudo): "Hiago" → "Iago"
 *   - Iniciais all-caps → soletra: "JP" → "Jota Pê"
 * Não toca nomes "normais" tipo "Maria", "Lucas".
 */
export function nameForVoice(name: string): string {
  if (!name) return name;
  const trimmed = name.trim();
  // 1. Iniciais (JP, AC, RG) → soletra
  const initials = spellInitialsIfApplicable(trimmed);
  if (initials) return initials;
  // 2. Normaliza caixa alta pra title case (HIAGO → Hiago) antes do H mudo
  const normalized = normalizeCaps(trimmed);
  // 3. H mudo em início de nome BR (Hiago, Hugo, Helena, Heitor)
  return normalized.replace(/^H([aeiouáéíóúâêîôûãõAEIOUÁÉÍÓÚÂÊÎÔÛÃÕ])/, '$1');
}

export interface HumanizeOptions {
  /** Nome preferido do usuário (vai ter pronúncia corrigida no texto inteiro). */
  preferredName?: string | null;
  /** Insere <break/> SSML após a primeira vírgula da saudação. Default true. */
  addBreaks?: boolean;
}

export function humanizeForVoice(text: string, opts: HumanizeOptions = {}): string {
  let out = text;

  // 1. Corrige pronúncia do nome do usuário em todo o texto
  if (opts.preferredName) {
    const orig = opts.preferredName.trim();
    const fixed = nameForVoice(orig);
    if (fixed && fixed.toLowerCase() !== orig.toLowerCase()) {
      // Match whole-word, case-insensitive — pega "HIAGO", "Hiago", "hiago"
      const re = new RegExp(`\\b${escapeRegex(orig)}\\b`, 'gi');
      out = out.replace(re, fixed);
    }
  }

  // 2. Reticências → break SSML mais limpo
  //    "…" (U+2026), "...", "...."
  out = out.replace(/…|\.{3,}/g, ' <break time="0.35s"/> ');

  // 3. Remove vírgula entre saudação e nome — fluência natural
  //    "Prazer, Hiago!" → "Prazer Hiago!"
  //    "Oi, Maria!" → "Oi Maria!"
  //    Sem vírgula o TTS não força pausa estranha entre saudação+nome.
  out = out.replace(
    /^(Oi|Olá|Ola|Prazer|Opa|Ei|E aí|Eai|Bom dia|Boa tarde|Boa noite),\s+([A-ZÁÉÍÓÚÂÊÎÔÛÃÕ])/i,
    '$1 $2',
  );

  // NOTA: removemos o <break time="0.3s"/> que era injetado após a saudação —
  // ficava marcadamente artificial. O TTS já modula naturalmente.

  return out.trim();
}

export async function listVoices(apiKey: string, timeoutMs = 8_000): Promise<VoiceSummary[]> {
  if (!apiKey) return [];
  try {
    const res = await axios.get<{ voices: VoiceSummary[] }>(`${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
      timeout: timeoutMs,
    });
    return Array.isArray(res.data?.voices) ? res.data.voices : [];
  } catch {
    return [];
  }
}
