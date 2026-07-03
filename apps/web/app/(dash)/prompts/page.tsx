'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, Pill, Save, RotateCcw, CheckCircle, AlertCircle, Key,
  Cpu, Eye, EyeOff, Copy, Power, Image as ImageIcon, Mic, SlidersHorizontal,
  Volume2, RefreshCw, Play,
} from 'lucide-react';
import {
  GlassCard, GlassButton, GlassInput, GlassTextarea, GlassBadge,
  SectionHeader, StatusPing,
} from '@/components/ui';
import { cn } from '@/lib/utils';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

const MODELS = [
  { value: 'z-ai/glm-5.2', label: 'GLM-5.2 — inteligente + cache (atual)' },
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini — rápido e barato' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1 — melhor qualidade' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'anthropic/claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
  { value: 'anthropic/claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  { value: 'google/gemini-2.5-flash-preview', label: 'Gemini 2.5 Flash Preview' },
  { value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { value: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
];

const VISION_MODELS = [
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini — recomendado' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'anthropic/claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  { value: 'anthropic/claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
  { value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { value: 'google/gemini-2.5-flash-preview', label: 'Gemini 2.5 Flash Preview' },
];

const AUDIO_MODELS = [
  { value: 'elevenlabs/scribe_v1', label: 'ElevenLabs Scribe v1 — recomendado (PT-BR excelente)' },
  { value: 'openai/gpt-4o-audio-preview', label: 'GPT-4o Audio (OpenRouter — instável)' },
  { value: 'whisper/whisper-1', label: 'Whisper-1 (OpenAI direta, precisa OPENAI_API_KEY)' },
  { value: 'gemini/gemini-2.0-flash', label: 'Gemini 2.0 Flash (Google direto)' },
  { value: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google direto)' },
];

const TTS_MODELS = [
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 — melhor PT-BR (padrão Xarlote)' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 — rápido e barato' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — meio termo' },
];

// voice_id da identidade Xarlote — destaque no UI
const XARLOTE_VOICE_ID = 'm151rjrbWXbBqyq56tly';

interface PromptsConfig {
  sara_suffix: string;
  agent_override: string;
  llm_api_key: string;
  llm_model: string;
  vision_model: string;
  audio_model: string;
  xarlote_enabled: boolean;
  reminders_enabled: boolean;
  nudges_enabled: boolean;
  pharmacy_outbound_enabled: boolean;
  clinic_outbound_enabled: boolean;
  tts_enabled: boolean;
  tts_api_key: string;
  tts_voice_id: string;
  tts_model: string;
  tts_speed: number;
}

interface ElVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

interface BasePrompts {
  sara: string;
  agent_quoting: string;
  agent_confirmation: string;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

const DEFAULT_CFG: PromptsConfig = {
  sara_suffix: '', agent_override: '', llm_api_key: '',
  llm_model: 'openai/gpt-4.1-mini', vision_model: 'openai/gpt-4.1-mini',
  audio_model: 'openai/gpt-4o-audio-preview', xarlote_enabled: true,
  reminders_enabled: true, nudges_enabled: true,
  pharmacy_outbound_enabled: true, clinic_outbound_enabled: true,
  tts_enabled: false, tts_api_key: '',
  tts_voice_id: XARLOTE_VOICE_ID, tts_model: 'eleven_multilingual_v2',
  tts_speed: 1.10,
};

// Interruptores de fluxo (kill-switches por fluxo) — salvam na hora, como o mestre.
const FLOW_SWITCHES: { key: keyof PromptsConfig; label: string; desc: string }[] = [
  { key: 'reminders_enabled', label: 'Lembretes', desc: 'Disparo de lembretes/despertadores proativos.' },
  { key: 'nudges_enabled', label: 'Follow-ups (nudges)', desc: 'Re-engaja fluxos que o usuário deixou parados.' },
  { key: 'pharmacy_outbound_enabled', label: 'Disparo a farmácias', desc: 'Contatar farmácias pra cotar pedidos.' },
  { key: 'clinic_outbound_enabled', label: 'Disparo a clínicas', desc: 'Contatar clínicas pra buscar consultas.' },
];

export default function PromptsPage() {
  const [config, setConfig] = useState<PromptsConfig>(DEFAULT_CFG);
  const [original, setOriginal] = useState<PromptsConfig>(DEFAULT_CFG);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [base, setBase] = useState<BasePrompts | null>(null);
  const [showSaraBase, setShowSaraBase] = useState(false);
  const [showAgentBase, setShowAgentBase] = useState(false);
  const [agentBaseTab, setAgentBaseTab] = useState<'quoting' | 'confirmation'>('quoting');
  const [showTtsKey, setShowTtsKey] = useState(false);
  const [voices, setVoices] = useState<ElVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`${API}/admin/prompts`)
      .then((r) => r.json())
      .then((data: PromptsConfig) => {
        setConfig(data);
        setOriginal(data);
        if (data.llm_model && !MODELS.find((m) => m.value === data.llm_model)) {
          setCustomModel(data.llm_model);
        }
      })
      .catch(() => {});
    fetch(`${API}/admin/prompts/base`)
      .then((r) => r.json())
      .then((data: BasePrompts) => setBase(data))
      .catch(() => {});
  }, []);

  function copyBase(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  const effectiveModel = customModel || config.llm_model;
  const isDirty =
    config.sara_suffix !== original.sara_suffix ||
    config.agent_override !== original.agent_override ||
    config.llm_api_key !== original.llm_api_key ||
    effectiveModel !== original.llm_model ||
    config.vision_model !== original.vision_model ||
    config.audio_model !== original.audio_model ||
    config.xarlote_enabled !== original.xarlote_enabled ||
    config.tts_enabled !== original.tts_enabled ||
    config.tts_api_key !== original.tts_api_key ||
    config.tts_voice_id !== original.tts_voice_id ||
    config.tts_model !== original.tts_model ||
    config.tts_speed !== original.tts_speed;

  async function loadVoices() {
    setLoadingVoices(true);
    try {
      const res = await fetch(`${API}/admin/tts/voices`);
      const data = await res.json();
      setVoices(Array.isArray(data?.voices) ? data.voices : []);
    } catch {
      setVoices([]);
    } finally {
      setLoadingVoices(false);
    }
  }

  useEffect(() => {
    if (config.tts_api_key && voices.length === 0 && !loadingVoices) {
      void loadVoices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tts_api_key]);

  function previewVoice(url: string) {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
    }
    const audio = new Audio(url);
    previewAudioRef.current = audio;
    void audio.play().catch(() => {});
  }

  const [testingTts, setTestingTts] = useState(false);
  const [ttsTestError, setTtsTestError] = useState<string | null>(null);
  async function testTts() {
    setTtsTestError(null);
    setTestingTts(true);
    try {
      // Salva config primeiro pra garantir que o backend usa o estado atual
      if (isDirty) await handleSave();
      const res = await fetch(`${API}/admin/tts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId: config.tts_voice_id,
          modelId: config.tts_model,
          name: 'Hiago',
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewAudioRef.current) previewAudioRef.current.pause();
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      await audio.play();
    } catch (err) {
      setTtsTestError(String(err).slice(0, 200));
    } finally {
      setTestingTts(false);
    }
  }

  const [toggleBusy, setToggleBusy] = useState(false);
  async function handleToggleEnabled() {
    if (toggleBusy) return;
    const next = !config.xarlote_enabled;
    setToggleBusy(true);
    setConfig((c) => ({ ...c, xarlote_enabled: next }));
    try {
      const res = await fetch(`${API}/admin/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xarlote_enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved: PromptsConfig = await res.json();
      setOriginal((o) => ({ ...o, xarlote_enabled: saved.xarlote_enabled }));
      setConfig((c) => ({ ...c, xarlote_enabled: saved.xarlote_enabled }));
    } catch (err) {
      setConfig((c) => ({ ...c, xarlote_enabled: !next }));
      setErrorMsg(`Falha ao alternar interruptor: ${String(err)}`);
      setStatus('error');
    } finally {
      setToggleBusy(false);
    }
  }

  const [flowBusy, setFlowBusy] = useState<string | null>(null);
  async function handleFlowToggle(key: keyof PromptsConfig) {
    if (flowBusy) return;
    const next = !config[key];
    setFlowBusy(key);
    setConfig((c) => ({ ...c, [key]: next }));
    try {
      const res = await fetch(`${API}/admin/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved: PromptsConfig = await res.json();
      setOriginal((o) => ({ ...o, [key]: saved[key] }));
      setConfig((c) => ({ ...c, [key]: saved[key] }));
    } catch (err) {
      setConfig((c) => ({ ...c, [key]: !next })); // rollback
      setErrorMsg(`Falha ao alternar ${key}: ${String(err)}`);
      setStatus('error');
    } finally {
      setFlowBusy(null);
    }
  }

  async function handleSave() {
    setStatus('saving');
    setErrorMsg('');
    try {
      const payload = {
        ...config,
        llm_model: effectiveModel,
        vision_model: config.vision_model,
        audio_model: config.audio_model,
        tts_enabled: config.tts_enabled,
        tts_api_key: config.tts_api_key,
        tts_voice_id: config.tts_voice_id,
        tts_model: config.tts_model,
        tts_speed: config.tts_speed,
      };
      const res = await fetch(`${API}/admin/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved: PromptsConfig = await res.json();
      setConfig(saved);
      setOriginal(saved);
      setCustomModel('');
      setStatus('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      setErrorMsg(String(err));
      setStatus('error');
    }
  }

  function handleReset() {
    setConfig(original);
    setCustomModel('');
    setStatus('idle');
    setErrorMsg('');
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={SlidersHorizontal}
        title="Configuração"
        subtitle="Tudo entra em vigor na próxima mensagem, sem reiniciar"
        size="lg"
      />

      {/* Master switch — hero card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <GlassCard
          variant={config.xarlote_enabled ? 'hi' : 'default'}
          className={cn(
            'relative overflow-hidden p-5',
            config.xarlote_enabled
              ? 'border-emerald-400/30 shadow-glow-success'
              : 'border-rose-400/30',
          )}
        >
          {config.xarlote_enabled && (
            <div
              aria-hidden
              className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-gradient-to-br from-emerald-400/30 via-accent/20 to-transparent blur-2xl"
            />
          )}
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-2xl border',
                  config.xarlote_enabled
                    ? 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30'
                    : 'bg-rose-400/15 text-rose-300 border-rose-400/30',
                )}
              >
                <Power size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  Xarlote
                  <GlassBadge tone={config.xarlote_enabled ? 'live' : 'danger'} dot>
                    {config.xarlote_enabled ? 'Conectada' : 'Desligada'}
                  </GlassBadge>
                </h2>
                <p className="text-xs text-white/55 mt-0.5">
                  {config.xarlote_enabled
                    ? 'Recebendo mensagens do WhatsApp e respondendo normalmente.'
                    : 'Mensagens do WhatsApp são descartadas até o interruptor voltar.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={config.xarlote_enabled}
              disabled={toggleBusy}
              onClick={handleToggleEnabled}
              className={cn(
                'relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-base',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                config.xarlote_enabled
                  ? 'bg-emerald-500 shadow-glow-success'
                  : 'bg-white/10 border border-white/15',
              )}
            >
              <motion.span
                aria-hidden
                animate={{ x: config.xarlote_enabled ? 24 : 4 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="absolute top-1 inline-block h-6 w-6 rounded-full bg-white shadow-lg"
              />
            </button>
          </div>
        </GlassCard>
      </motion.div>

      {/* Interruptores de fluxo (kill-switches) */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={Power}
          title="Interruptores de fluxo"
          subtitle="Freio de emergência por função — sem desligar a Xarlote inteira. Entra em vigor na hora."
        />
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {FLOW_SWITCHES.map((sw) => {
            const on = Boolean(config[sw.key]);
            return (
              <div
                key={sw.key}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                  on ? 'border-emerald-400/25 bg-emerald-400/[0.04]' : 'border-rose-400/25 bg-rose-400/[0.04]',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{sw.label}</span>
                    <GlassBadge tone={on ? 'live' : 'danger'} dot>{on ? 'Ligado' : 'Desligado'}</GlassBadge>
                  </div>
                  <p className="text-[11px] text-white/50 mt-0.5">{sw.desc}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={sw.label}
                  disabled={flowBusy === sw.key}
                  onClick={() => handleFlowToggle(sw.key)}
                  className={cn(
                    'relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    on ? 'bg-emerald-500 shadow-glow-success' : 'bg-white/10 border border-white/15',
                  )}
                >
                  <motion.span
                    aria-hidden
                    animate={{ x: on ? 22 : 4 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className="absolute top-1 inline-block h-5 w-5 rounded-full bg-white shadow-lg"
                  />
                </button>
              </div>
            );
          })}
        </div>
      </GlassCard>

      {/* LLM config */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={Cpu}
          title="Configuração da LLM"
          subtitle="Modelo conversacional principal + chave OpenRouter"
        />

        <div className="mt-5 grid gap-4">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-white/70 mb-1.5">
              <Key size={12} />
              API Key (OpenRouter)
            </label>
            <div className="flex gap-2">
              <GlassInput
                type={showKey ? 'text' : 'password'}
                placeholder="sk-or-v1-…"
                value={config.llm_api_key}
                onChange={(e) => setConfig((c) => ({ ...c, llm_api_key: e.target.value }))}
                className="flex-1 font-mono"
              />
              <GlassButton variant="secondary" size="md" onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                {showKey ? 'Ocultar' : 'Mostrar'}
              </GlassButton>
            </div>
            <p className="text-xs text-white/40 mt-1.5">
              Pegue em{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent-hi hover:underline"
              >
                openrouter.ai/keys
              </a>
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5">Modelo</label>
            <select
              className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              value={customModel ? '__custom__' : (config.llm_model || 'openai/gpt-4.1-mini')}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setCustomModel(config.llm_model);
                } else {
                  setCustomModel('');
                  setConfig((c) => ({ ...c, llm_model: e.target.value }));
                }
              }}
            >
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              <option value="__custom__">Outro (digitar manualmente)…</option>
            </select>
            {(customModel !== '' || !MODELS.find((m) => m.value === config.llm_model)) && (
              <GlassInput
                type="text"
                className="mt-2 font-mono"
                placeholder="ex: openai/gpt-4o"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
              />
            )}
            <p className="text-xs text-white/40 mt-1.5">
              Catálogo em{' '}
              <a
                href="https://openrouter.ai/models"
                target="_blank"
                rel="noreferrer"
                className="text-accent-hi hover:underline"
              >
                openrouter.ai/models
              </a>
            </p>
          </div>
        </div>
      </GlassCard>

      {/* Multimodal */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={ImageIcon}
          title="Visão & Áudio"
          subtitle="Modelos pra entender imagem e transcrever áudio"
        />

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-white/70 mb-1.5">
              <ImageIcon size={12} />
              Modelo de visão
            </label>
            <select
              className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              value={
                VISION_MODELS.find((m) => m.value === config.vision_model)
                  ? config.vision_model
                  : '__custom_vision__'
              }
              onChange={(e) => {
                if (e.target.value === '__custom_vision__') return;
                setConfig((c) => ({ ...c, vision_model: e.target.value }));
              }}
            >
              {VISION_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              <option value="__custom_vision__">Outro (manual)…</option>
            </select>
            <GlassInput
              type="text"
              className="mt-2 font-mono"
              placeholder="openai/gpt-4o, anthropic/claude-3-5-sonnet…"
              value={config.vision_model}
              onChange={(e) => setConfig((c) => ({ ...c, vision_model: e.target.value }))}
            />
            <p className="text-xs text-white/40 mt-1.5">Precisa ser vision-capable.</p>
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-white/70 mb-1.5">
              <Mic size={12} />
              Modelo de áudio
            </label>
            <select
              className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              value={
                AUDIO_MODELS.find((m) => m.value === config.audio_model)
                  ? config.audio_model
                  : '__custom_audio__'
              }
              onChange={(e) => {
                if (e.target.value === '__custom_audio__') return;
                setConfig((c) => ({ ...c, audio_model: e.target.value }));
              }}
            >
              {AUDIO_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              <option value="__custom_audio__">Outro (manual)…</option>
            </select>
            <GlassInput
              type="text"
              className="mt-2 font-mono"
              placeholder="openai/whisper-1, gemini/gemini-2.0-flash…"
              value={config.audio_model}
              onChange={(e) => setConfig((c) => ({ ...c, audio_model: e.target.value }))}
            />
            <p className="text-xs text-white/40 mt-1.5">
              <code>openai/</code> = OpenRouter · <code>gemini/</code> = Google direto
            </p>
          </div>
        </div>
      </GlassCard>

      {/* Voz da Xarlote (TTS via ElevenLabs) */}
      <GlassCard className="p-5">
        <div className="flex items-start justify-between gap-3">
          <SectionHeader
            icon={Volume2}
            title="Voz da Xarlote (ElevenLabs)"
            subtitle="Áudio humanizado em momentos raros — hoje: primeira saudação chamando o nome"
          />
          <button
            type="button"
            role="switch"
            aria-checked={config.tts_enabled}
            onClick={() => setConfig((c) => ({ ...c, tts_enabled: !c.tts_enabled }))}
            className={cn(
              'relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors mt-1',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              config.tts_enabled
                ? 'bg-accent shadow-glow-accent'
                : 'bg-white/10 border border-white/15',
            )}
          >
            <motion.span
              aria-hidden
              animate={{ x: config.tts_enabled ? 22 : 4 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className="absolute top-1 inline-block h-5 w-5 rounded-full bg-white shadow-lg"
            />
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-white/70 mb-1.5">
              <Key size={12} />
              API Key (ElevenLabs)
            </label>
            <div className="flex gap-2">
              <GlassInput
                type={showTtsKey ? 'text' : 'password'}
                placeholder="sk_…"
                value={config.tts_api_key}
                onChange={(e) => setConfig((c) => ({ ...c, tts_api_key: e.target.value }))}
                className="flex-1 font-mono"
              />
              <GlassButton variant="secondary" size="md" onClick={() => setShowTtsKey((v) => !v)}>
                {showTtsKey ? <EyeOff size={14} /> : <Eye size={14} />}
                {showTtsKey ? 'Ocultar' : 'Mostrar'}
              </GlassButton>
            </div>
            <p className="text-xs text-white/40 mt-1.5">
              Pegue em{' '}
              <a
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent-hi hover:underline"
              >
                elevenlabs.io/settings/api-keys
              </a>
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-white/70">Voz</label>
              <button
                type="button"
                onClick={loadVoices}
                disabled={loadingVoices || !config.tts_api_key}
                className="flex items-center gap-1 text-xs text-white/55 hover:text-white disabled:opacity-50"
              >
                <RefreshCw size={11} className={loadingVoices ? 'animate-spin' : ''} />
                {loadingVoices ? 'Carregando…' : voices.length > 0 ? `${voices.length} vozes` : 'Listar'}
              </button>
            </div>
            {voices.length > 0 ? (
              <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
                {voices.map((v) => {
                  const isSelected = v.voice_id === config.tts_voice_id;
                  return (
                    <button
                      key={v.voice_id}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, tts_voice_id: v.voice_id }))}
                      className={cn(
                        'group flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                        isSelected
                          ? 'border-accent/60 bg-accent/10'
                          : 'border-white/8 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
                      )}
                    >
                      <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', isSelected ? 'bg-accent/25 text-accent-hi' : 'bg-white/8 text-white/60')}>
                        <Volume2 size={14} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-medium truncate">{v.name}</div>
                        <div className="text-[11px] text-white/45 truncate font-mono">{v.voice_id}</div>
                      </div>
                      {v.labels && (
                        <div className="hidden md:flex gap-1">
                          {v.labels['gender'] && <GlassBadge tone="neutral">{v.labels['gender']}</GlassBadge>}
                          {v.labels['language'] && <GlassBadge tone="info">{v.labels['language']}</GlassBadge>}
                        </div>
                      )}
                      {v.preview_url && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); previewVoice(v.preview_url!); }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white/85 transition-colors"
                          title="Ouvir prévia"
                        >
                          <Play size={11} />
                        </button>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <GlassInput
                type="text"
                className="font-mono"
                placeholder="EXAVITQu4vr4xnSDxMaL"
                value={config.tts_voice_id}
                onChange={(e) => setConfig((c) => ({ ...c, tts_voice_id: e.target.value }))}
              />
            )}
            <p className="text-xs text-white/40 mt-1.5">
              Default: <code>Sarah</code> (feminina suave, multilíngue).
              {voices.length === 0 && config.tts_api_key && ' Clique em "Listar" pra escolher visualmente.'}
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5">Modelo TTS</label>
            <select
              className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              value={config.tts_model || 'eleven_flash_v2_5'}
              onChange={(e) => setConfig((c) => ({ ...c, tts_model: e.target.value }))}
            >
              {TTS_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <p className="text-xs text-white/40 mt-1.5">
              Flash v2.5 ≈ $0.10/1k chars, latência ~75ms. Multilingual v2 ≈ $0.30/1k chars, qualidade superior.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-white/70">
                Velocidade da fala
              </label>
              <span className="text-xs font-mono tabular-nums text-accent-hi">
                {(config.tts_speed ?? 1.10).toFixed(2)}x
              </span>
            </div>
            <input
              type="range"
              min={0.7}
              max={1.2}
              step={0.01}
              value={config.tts_speed ?? 1.10}
              onChange={(e) => setConfig((c) => ({ ...c, tts_speed: parseFloat(e.target.value) }))}
              className="w-full h-2 bg-white/[0.06] rounded-full appearance-none cursor-pointer accent-accent"
              style={{
                background: `linear-gradient(to right, rgb(124 135 255) 0%, rgb(124 135 255) ${((config.tts_speed - 0.7) / 0.5) * 100}%, rgba(255,255,255,0.06) ${((config.tts_speed - 0.7) / 0.5) * 100}%, rgba(255,255,255,0.06) 100%)`,
              }}
            />
            <div className="flex justify-between text-[10px] text-white/35 mt-1 font-mono">
              <span>0.70 lento</span>
              <span>1.00 neutro</span>
              <span>1.10 padrão</span>
              <span>1.20 rápido</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <GlassButton
              variant="primary"
              size="sm"
              onClick={testTts}
              disabled={testingTts || !config.tts_api_key}
            >
              <Play size={13} />
              {testingTts ? 'Sintetizando…' : 'Testar voz com "Prazer, Hiago!…"'}
            </GlassButton>
            {ttsTestError && (
              <span className="text-xs text-rose-300 flex items-center gap-1">
                <AlertCircle size={11} /> {ttsTestError}
              </span>
            )}
          </div>

          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2.5">
            <p className="text-xs text-amber-200/80 leading-relaxed">
              <strong>Critério de uso:</strong> hoje só dispara áudio na <em>primeira saudação chamando o nome</em> do usuário
              (logo após ele aceitar a LGPD e responder o nome). Marca <code>users.metadata.audio_intro_sent=true</code> e nunca repete.
            </p>
          </div>

          <div className="rounded-xl border border-accent/25 bg-accent/[0.05] px-3 py-2.5">
            <p className="text-xs text-white/75 leading-relaxed">
              <strong className="text-accent-hi">Identidade Xarlote:</strong> voz <em>Carla — Inviting, Warm and Helpful</em> (BR nativa, ElevenLabs library) + modelo <em>Multilingual v2</em>.
              Texto vai por um <strong>humanizador</strong> antes do TTS: corrige pronúncia de nomes ("HIAGO" → <code>iago</code> com H mudo, "JP" → <code>jota pê</code>) e insere micro-pausas SSML pra dar respiração natural. Voz só, texto preservado.
            </p>
          </div>
        </div>
      </GlassCard>

      {/* Xarlote prompt */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={Bot}
          title="Xarlote — IA do usuário"
          subtitle="Prompt base + instruções adicionais"
        />

        <div className="mt-4 rounded-xl border border-white/8 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-white/[0.04] border-b border-white/8">
            <span className="text-xs font-medium text-white/65">Prompt base (somente leitura)</span>
            <div className="flex items-center gap-1">
              {base?.sara && (
                <button
                  onClick={() => copyBase(base.sara)}
                  className="p-1.5 rounded text-white/45 hover:text-white hover:bg-white/8 transition-colors"
                  title="Copiar"
                >
                  <Copy size={13} />
                </button>
              )}
              <button
                onClick={() => setShowSaraBase((v) => !v)}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-white/55 hover:text-white hover:bg-white/8 transition-colors"
              >
                {showSaraBase ? <><EyeOff size={12} /> Ocultar</> : <><Eye size={12} /> Mostrar</>}
              </button>
            </div>
          </div>
          <AnimatePresence>
            {showSaraBase && (
              <motion.pre
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="text-xs text-white/55 p-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono"
              >
                {base?.sara ?? 'Carregando…'}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>

        <label className="block text-xs font-medium text-white/70 mt-4 mb-1.5">
          Instruções adicionais (anexadas ao final do prompt base)
        </label>
        <GlassTextarea
          className="h-44"
          placeholder={'Exemplos:\n- Responda sempre em inglês.\n- Seja mais formal e evite emojis.'}
          value={config.sara_suffix}
          onChange={(e) => setConfig((c) => ({ ...c, sara_suffix: e.target.value }))}
        />
        <p className="text-xs text-white/35 mt-1.5">
          {config.sara_suffix.length} caracteres
          {config.sara_suffix.trim() === '' && ' · usando apenas o prompt base'}
        </p>
      </GlassCard>

      {/* Agent pharmacy */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={Pill}
          title="Agente Farmácia"
          subtitle="Prompt que negocia com as farmácias"
        />

        <div className="mt-4 rounded-xl border border-white/8 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-white/[0.04] border-b border-white/8">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-white/65 mr-2">Base:</span>
              <button
                onClick={() => setAgentBaseTab('quoting')}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  agentBaseTab === 'quoting'
                    ? 'bg-accent/20 text-accent-hi'
                    : 'text-white/45 hover:text-white/75',
                )}
              >
                Cotação
              </button>
              <button
                onClick={() => setAgentBaseTab('confirmation')}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  agentBaseTab === 'confirmation'
                    ? 'bg-accent/20 text-accent-hi'
                    : 'text-white/45 hover:text-white/75',
                )}
              >
                Confirmação
              </button>
            </div>
            <div className="flex items-center gap-1">
              {base && (
                <button
                  onClick={() => copyBase(agentBaseTab === 'quoting' ? base.agent_quoting : base.agent_confirmation)}
                  className="p-1.5 rounded text-white/45 hover:text-white hover:bg-white/8 transition-colors"
                  title="Copiar"
                >
                  <Copy size={13} />
                </button>
              )}
              <button
                onClick={() => setShowAgentBase((v) => !v)}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-white/55 hover:text-white hover:bg-white/8 transition-colors"
              >
                {showAgentBase ? <><EyeOff size={12} /> Ocultar</> : <><Eye size={12} /> Mostrar</>}
              </button>
            </div>
          </div>
          <AnimatePresence>
            {showAgentBase && (
              <motion.pre
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="text-xs text-white/55 p-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono"
              >
                {base ? (agentBaseTab === 'quoting' ? base.agent_quoting : base.agent_confirmation) : 'Carregando…'}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>

        <label className="block text-xs font-medium text-white/70 mt-4 mb-1.5">
          Override do prompt (substitui o base quando preenchido)
        </label>
        <GlassTextarea
          className="h-56"
          placeholder="Deixe vazio pra usar o prompt padrão."
          value={config.agent_override}
          onChange={(e) => setConfig((c) => ({ ...c, agent_override: e.target.value }))}
        />
        <p className="text-xs text-white/35 mt-1.5">
          {config.agent_override.length} caracteres
          {config.agent_override.trim() === '' && ' · usando o prompt padrão'}
        </p>
      </GlassCard>

      {/* Sticky save bar */}
      <AnimatePresence>
        {isDirty && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26 }}
            className="fixed bottom-6 right-6 z-30"
          >
            <GlassCard className="px-4 py-3 flex items-center gap-3 shadow-glass-lg">
              <StatusPing tone="warn" />
              <span className="text-sm text-white/75">Mudanças não salvas</span>
              <GlassButton variant="ghost" size="sm" onClick={handleReset}>
                <RotateCcw size={13} /> Descartar
              </GlassButton>
              <GlassButton variant="primary" size="sm" onClick={handleSave} disabled={status === 'saving'}>
                <Save size={13} />
                {status === 'saving' ? 'Salvando…' : 'Salvar'}
              </GlassButton>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Status messages */}
      <AnimatePresence>
        {status === 'saved' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-sm text-emerald-300"
          >
            <CheckCircle size={14} /> Salvo · entra em vigor na próxima mensagem
          </motion.div>
        )}
        {status === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-sm text-rose-300"
          >
            <AlertCircle size={14} /> Erro: {errorMsg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
