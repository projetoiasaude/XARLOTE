/**
 * Config de runtime (prompts, modelos, chaves, kill-switches).
 *
 * ⚠️ POR QUE ISTO NÃO É SÓ UM ARQUIVO JSON (auditoria 22/09, P0-8):
 *
 * `prompts.json` mora no disco do container. Como a API e o worker são SERVIÇOS
 * SEPARADOS no Railway, o que o dashboard gravava nunca chegava ao worker: o freio
 * de emergência de lembretes (`reminders_enabled`) não freava nada, e o modelo/chave
 * do enricher, do compactor e do TTS vinham do env mesmo depois de trocados na tela.
 * Pior: disco de container é efêmero — todo deploy zerava os overrides.
 *
 * O canal de propagação passa a ser o REDIS (infra que os dois processos já
 * compartilham), com o arquivo como persistência local de cortesia:
 *
 *   • `savePrompts` grava no Redis (fonte da verdade) E no arquivo (melhor esforço).
 *   • Cada processo mantém um SNAPSHOT em memória, atualizado por um sync de 5s.
 *   • `loadPrompts()` continua SÍNCRONA (31 call-sites, vários por turno) e agora não
 *     toca o disco a cada chamada — lê o snapshot.
 *
 * Degradação: Redis fora → cada processo segue com o snapshot que tem (nunca pior
 * que o comportamento antigo). Redis vazio → o primeiro processo que sincronizar
 * SEMEIA com o que tiver em disco (SET NX: quem chegar depois não sobrescreve).
 *
 * Precedência (menor → maior): defaults < env < overrides (dashboard).
 * Guardamos no Redis só os OVERRIDES — assim uma env nova continua valendo sem
 * precisar mexer na tela, e nada que o fundador nunca tocou vira "configurado".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getRedisClient } from '../queue-config.js';

const PROMPTS_FILE = join(__dirname, '../../data/prompts.json');

/** Chave compartilhada entre api e worker. Só overrides, nunca a config resolvida. */
const REDIS_KEY = 'runtime:prompts';
const SYNC_INTERVAL_MS = Number(process.env['PROMPTS_SYNC_MS'] ?? 5_000);

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

/** As chaves que nunca podem sair do servidor em claro (ver `mascararSegredos`). */
export const CHAVES_SECRETAS = ['llm_api_key', 'tts_api_key'] as const;

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

function envOverrides(): Partial<PromptsConfig> {
  const env: Partial<PromptsConfig> = {};
  if (process.env['OPENROUTER_API_KEY']) env.llm_api_key = process.env['OPENROUTER_API_KEY'];
  // Permite trocar o modelo conversacional só setando a env no Railway (sem redeploy
  // de código). Precedência: defaults < env < overrides (dashboard).
  if (process.env['OPENROUTER_MODEL']) env.llm_model = process.env['OPENROUTER_MODEL']!;
  if (process.env['ELEVENLABS_API_KEY']) env.tts_api_key = process.env['ELEVENLABS_API_KEY'];
  if (process.env['TTS_ENABLED']) env.tts_enabled = process.env['TTS_ENABLED'] === 'true' || process.env['TTS_ENABLED'] === '1';
  if (process.env['TTS_VOICE_ID']) env.tts_voice_id = process.env['TTS_VOICE_ID']!;
  if (process.env['TTS_MODEL']) env.tts_model = process.env['TTS_MODEL']!;
  if (process.env['TTS_SPEED']) {
    const n = parseFloat(process.env['TTS_SPEED']!);
    if (!isNaN(n) && n >= 0.7 && n <= 1.2) env.tts_speed = n;
  }
  // Kill-switches por fluxo também via env (freio de emergência sem dashboard). Só
  // desligam quando explicitamente "false"/"0"; ausente = mantém o default (ligado).
  // Ex.: PHARMACY_OUTBOUND_ENABLED=false pausa o disparo a farmácias fora de horário.
  for (const [envName, key] of [
    ['REMINDERS_ENABLED', 'reminders_enabled'],
    ['NUDGES_ENABLED', 'nudges_enabled'],
    ['PHARMACY_OUTBOUND_ENABLED', 'pharmacy_outbound_enabled'],
    ['CLINIC_OUTBOUND_ENABLED', 'clinic_outbound_enabled'],
  ] as const) {
    const v = process.env[envName];
    if (v !== undefined) env[key] = !(v === 'false' || v === '0');
  }
  return env;
}

function lerOverridesDoArquivo(): Partial<PromptsConfig> {
  try {
    if (existsSync(PROMPTS_FILE)) {
      const lido = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')) as unknown;
      if (lido && typeof lido === 'object' && !Array.isArray(lido)) return lido as Partial<PromptsConfig>;
    }
  } catch {
    // Arquivo corrompido não pode derrubar o boot: seguimos com defaults+env.
  }
  return {};
}

/** Overrides vigentes NESTE processo. Só muda por `savePrompts` ou pelo sync. */
let overrides: Partial<PromptsConfig> = lerOverridesDoArquivo();
let origemDosOverrides: 'arquivo' | 'redis' = 'arquivo';
let ultimoSyncMs = 0;
let timerDeSync: NodeJS.Timeout | null = null;

/**
 * ⚠️ `undefined` EXPLÍCITO APAGA NO SPREAD (o defeito de 22/09).
 *
 * A rota do dashboard monta `{sara_suffix: undefined, llm_model: undefined, …}` pra
 * toda chave ausente do body. `{...atual, ...esseObjeto}` sobrescreve tudo com
 * `undefined` e o `JSON.stringify` descarta — resultado: um clique num toggle deixava
 * o arquivo com UMA chave só, religando a Xarlote e revertendo modelo/chave/prompt
 * em silêncio. Aqui é o funil por onde todo patch passa.
 *
 * O filtro de máscara é o par disso: o GET devolve a chave mascarada (`••••ab12`);
 * se a tela reenviar a máscara sem o fundador ter digitado nada, isso NÃO é uma chave.
 */
export function aplicarPatchDeConfig(
  atuais: Partial<PromptsConfig>,
  patch: Partial<PromptsConfig>,
): Partial<PromptsConfig> {
  const limpo: Record<string, unknown> = {};
  const ehSecreta = (k: string): k is (typeof CHAVES_SECRETAS)[number] =>
    (CHAVES_SECRETAS as readonly string[]).includes(k);

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    /**
     * ⚠️ O filtro de máscara vale SÓ pras chaves de API — e ancorado no começo.
     *
     * A 1ª versão descartava qualquer string com `•` em qualquer campo. `sara_suffix` e
     * `agent_override` são justamente onde bullet é o formato natural: o fundador
     * escrevia "• seja breve\n• nunca diagnostique", clicava Salvar, a API respondia 200
     * com a config e NADA mudava. Campo aceito e descartado em silêncio é a pior API que
     * existe (regra 111) — e eu tinha acabado de reescrever um bug dessa família.
     */
    if (ehSecreta(k) && typeof v === 'string' && /^\s*•{2,}/.test(v)) continue;
    limpo[k] = v;
  }
  return { ...atuais, ...(limpo as Partial<PromptsConfig>) };
}

/**
 * Config resolvida. SÍNCRONA de propósito: é chamada em caminho quente (webhook,
 * turno, workers) e vários call-sites por turno — qualquer I/O aqui vira latência.
 */
export function loadPrompts(): PromptsConfig {
  return { ...defaults, ...envOverrides(), ...overrides };
}

/** O que o dashboard mostra: config resolvida com os segredos mascarados. */
export function mascararSegredos(cfg: PromptsConfig): PromptsConfig {
  const mascarado = { ...cfg };
  for (const chave of CHAVES_SECRETAS) {
    const v = cfg[chave];
    mascarado[chave] = v ? `••••${v.slice(-4)}` : '';
  }
  return mascarado;
}

/** De onde veio cada segredo — a tela precisa distinguir "vem do env" de "não tem". */
export function fontesDosSegredos(): Record<(typeof CHAVES_SECRETAS)[number], 'dashboard' | 'env' | 'nenhuma'> {
  const env = envOverrides();
  const fonte = (chave: (typeof CHAVES_SECRETAS)[number]) =>
    overrides[chave] ? ('dashboard' as const) : env[chave] ? ('env' as const) : ('nenhuma' as const);
  return { llm_api_key: fonte('llm_api_key'), tts_api_key: fonte('tts_api_key') };
}

/** Diagnóstico pro dashboard (`GET /admin/prompts`): este processo está sincronizado? */
export function estadoDaConfig(): { origem: 'arquivo' | 'redis'; ultimo_sync_ms: number | null; sincronizando: boolean } {
  return {
    origem: origemDosOverrides,
    ultimo_sync_ms: ultimoSyncMs ? Date.now() - ultimoSyncMs : null,
    sincronizando: timerDeSync !== null,
  };
}

/**
 * Grava o patch. Redis é a fonte da verdade (é quem o worker lê); o arquivo é
 * persistência local de cortesia e NUNCA pode derrubar o save — em container com
 * disco somente-leitura o write falha, e isso não é motivo pra recusar a mudança.
 *
 * Devolve `propagado: false` quando o Redis não aceitou: aí a mudança vale só
 * neste processo, e a tela precisa dizer isso em vez de fingir que pegou.
 */
export async function savePrompts(
  data: Partial<PromptsConfig>,
): Promise<{ config: PromptsConfig; propagado: boolean }> {
  const novos = aplicarPatchDeConfig(overrides, data);
  overrides = novos;

  let propagado = false;
  try {
    await getRedisClient().set(REDIS_KEY, JSON.stringify(novos));
    origemDosOverrides = 'redis';
    ultimoSyncMs = Date.now();
    propagado = true;
  } catch {
    // Sem Redis a mudança não chega no worker — quem chamou decide o que dizer.
  }

  try {
    mkdirSync(dirname(PROMPTS_FILE), { recursive: true });
    writeFileSync(PROMPTS_FILE, JSON.stringify(novos, null, 2), 'utf-8');
  } catch {
    // Disco somente-leitura/efêmero: o Redis já carrega a verdade.
  }

  return { config: loadPrompts(), propagado };
}

/**
 * Puxa os overrides compartilhados. Idempotente e barata (um GET); erro não
 * propaga — config velha em memória é melhor que processo derrubado.
 */
async function sincronizarUmaVez(aoSemear?: (chaves: string[]) => void): Promise<void> {
  const redis = getRedisClient();
  const cru = await redis.get(REDIS_KEY);
  if (cru === null) {
    // Redis limpo (primeira subida, ou flush): semeia com o que este processo tem em
    // disco. `NX` porque dois processos sobem juntos — o segundo não pode sobrescrever.
    if (Object.keys(overrides).length > 0) {
      // `NX`: quem chegar depois não sobrescreve. Ainda assim é uma SEMEADURA a partir do
      // disco local — se este container tiver um arquivo velho, ele vira a config de todo
      // mundo em ≤5s. Por isso o aviso: é o único momento em que o disco manda no Redis.
      const semeou = await redis.set(REDIS_KEY, JSON.stringify(overrides), 'NX');
      if (semeou !== null) {
        aoSemear?.(Object.keys(overrides));
      }
    }
    ultimoSyncMs = Date.now();
    return;
  }
  const lido = JSON.parse(cru) as unknown;
  if (lido && typeof lido === 'object' && !Array.isArray(lido)) {
    overrides = lido as Partial<PromptsConfig>;
    origemDosOverrides = 'redis';
  }
  ultimoSyncMs = Date.now();
}

/**
 * Liga a sincronização periódica. Chamada no boot (api e worker). O `unref` impede
 * que o timer segure o processo vivo no shutdown.
 */
export function iniciarSincronizacaoDeConfig(aoFalhar?: (err: unknown) => void): void {
  if (timerDeSync) return;
  // Só avisa na MUDANÇA de estado: com o Redis fora, um tick de 5s viraria 720 linhas por
  // hora e afogaria o log justamente quando alguém precisa lê-lo.
  let falhando = false;
  const tick = () => {
    sincronizarUmaVez((chaves) =>
      aoFalhar?.(new Error(`config do Redis estava VAZIA — semeada com o arquivo local (${chaves.join(', ')})`)),
    )
      .then(() => {
        if (falhando) {
          falhando = false;
          aoFalhar?.(new Error('sync de config VOLTOU a funcionar'));
        }
      })
      .catch((err) => {
        if (!falhando) {
          falhando = true;
          aoFalhar?.(err);
        }
      });
  };
  tick();
  timerDeSync = setInterval(tick, SYNC_INTERVAL_MS);
  timerDeSync.unref();
}

export function pararSincronizacaoDeConfig(): void {
  if (timerDeSync) {
    clearInterval(timerDeSync);
    timerDeSync = null;
  }
}

/** Só pra teste: repõe o estado do módulo sem depender de arquivo/Redis. */
export function __definirOverridesParaTeste(novos: Partial<PromptsConfig>): void {
  overrides = { ...novos };
  origemDosOverrides = 'arquivo';
}
