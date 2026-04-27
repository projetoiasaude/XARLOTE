'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Pill, Save, RotateCcw, CheckCircle, AlertCircle, Key, Cpu, Eye, EyeOff, Copy } from 'lucide-react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

const MODELS = [
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenRouter) — rápido e barato' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1 (OpenRouter) — melhor qualidade' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (OpenRouter)' },
  { value: 'anthropic/claude-3-5-haiku', label: 'Claude 3.5 Haiku (OpenRouter)' },
  { value: 'anthropic/claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (OpenRouter)' },
  { value: 'google/gemini-2.5-flash-preview', label: 'Gemini 2.5 Flash Preview (OpenRouter)' },
  { value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash (OpenRouter)' },
  { value: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)' },
];

interface PromptsConfig {
  sara_suffix: string;
  agent_override: string;
  llm_api_key: string;
  llm_model: string;
}

interface BasePrompts {
  sara: string;
  agent_quoting: string;
  agent_confirmation: string;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

export default function PromptsPage() {
  const [config, setConfig] = useState<PromptsConfig>({
    sara_suffix: '', agent_override: '', llm_api_key: '', llm_model: 'openai/gpt-4.1-mini',
  });
  const [original, setOriginal] = useState<PromptsConfig>({
    sara_suffix: '', agent_override: '', llm_api_key: '', llm_model: 'openai/gpt-4.1-mini',
  });
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [base, setBase] = useState<BasePrompts | null>(null);
  const [showSaraBase, setShowSaraBase] = useState(false);
  const [showAgentBase, setShowAgentBase] = useState(false);
  const [agentBaseTab, setAgentBaseTab] = useState<'quoting' | 'confirmation'>('quoting');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`${API}/admin/prompts`)
      .then((r) => r.json())
      .then((data: PromptsConfig) => {
        setConfig(data);
        setOriginal(data);
        // If the model isn't in the preset list, treat as custom
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
    effectiveModel !== original.llm_model;

  async function handleSave() {
    setStatus('saving');
    setErrorMsg('');
    try {
      const payload = { ...config, llm_model: effectiveModel };
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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">Editor de Prompts</h1>
        <p className="text-sm text-gray-400 mt-1">
          Configure a LLM, personalize os prompts dos agentes. Tudo entra em vigor na próxima mensagem sem reiniciar.
        </p>
      </div>

      <div className="space-y-6">

        {/* LLM Config */}
        <div className="bg-wa-panel border border-wa-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Cpu size={18} className="text-purple-400" />
            <h2 className="text-base font-medium text-white">Configuração da LLM</h2>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Escolha o modelo e a API key do OpenRouter. Valores salvos aqui sobrescrevem as variáveis de ambiente.
          </p>

          <div className="grid gap-4">
            {/* API Key */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-300 mb-1.5">
                <Key size={12} />
                API Key (OpenRouter)
              </label>
              <div className="flex gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="flex-1 bg-wa-bg border border-wa-border rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500 font-mono"
                  placeholder="sk-or-v1-..."
                  value={config.llm_api_key}
                  onChange={(e) => setConfig((c) => ({ ...c, llm_api_key: e.target.value }))}
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="px-3 py-2 rounded-lg border border-wa-border text-gray-400 text-xs hover:text-white transition-colors"
                >
                  {showKey ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Obtenha em{' '}
                <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
                  openrouter.ai/keys
                </a>
              </p>
            </div>

            {/* Model selector */}
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1.5">Modelo</label>
              <select
                className="w-full bg-wa-bg border border-wa-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-brand-500"
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
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
                <option value="__custom__">Outro (digitar manualmente)…</option>
              </select>

              {(customModel !== '' || !MODELS.find((m) => m.value === config.llm_model)) && (
                <input
                  type="text"
                  className="mt-2 w-full bg-wa-bg border border-wa-border rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500 font-mono"
                  placeholder="ex: openai/gpt-4o ou anthropic/claude-3-5-haiku"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
              )}
              <p className="text-xs text-gray-500 mt-1">
                Todos os modelos disponíveis em{' '}
                <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
                  openrouter.ai/models
                </a>
              </p>
            </div>
          </div>
        </div>

        {/* Xarlote prompt */}
        <div className="bg-wa-panel border border-wa-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Bot size={18} className="text-brand-400" />
            <h2 className="text-base font-medium text-white">Xarlote — IA do usuário</h2>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Veja abaixo o <strong className="text-gray-300">prompt base</strong> que orienta a Xarlote no WhatsApp,
            e adicione <strong className="text-gray-300">instruções extras</strong> que serão anexadas ao final.
          </p>

          {/* Base prompt — read-only */}
          <div className="mb-4 border border-wa-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-wa-bg border-b border-wa-border">
              <span className="text-xs font-medium text-gray-300">Prompt base (somente leitura)</span>
              <div className="flex items-center gap-1">
                {base?.sara && (
                  <button
                    onClick={() => copyBase(base.sara)}
                    className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-wa-panel transition-colors"
                    title="Copiar prompt base"
                  >
                    <Copy size={13} />
                  </button>
                )}
                <button
                  onClick={() => setShowSaraBase((v) => !v)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-wa-panel transition-colors"
                >
                  {showSaraBase ? <><EyeOff size={12} /> Ocultar</> : <><Eye size={12} /> Mostrar</>}
                </button>
              </div>
            </div>
            {showSaraBase && (
              <pre className="text-xs text-gray-400 p-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono">
                {base?.sara ?? 'Carregando…'}
              </pre>
            )}
          </div>

          <label className="block text-xs font-medium text-gray-300 mb-1.5">Instruções adicionais (anexadas ao final do prompt base)</label>
          <textarea
            className="w-full h-44 bg-wa-bg border border-wa-border rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500 resize-y font-mono"
            placeholder={"Exemplos:\n- Responda sempre em inglês.\n- Seja mais formal e evite emojis.\n- Se o usuário mencionar pressão alta, sempre pergunte se está tomando medicação."}
            value={config.sara_suffix}
            onChange={(e) => setConfig((c) => ({ ...c, sara_suffix: e.target.value }))}
          />
          <p className="text-xs text-gray-500 mt-1">
            {config.sara_suffix.length} caracteres
            {config.sara_suffix.trim() === '' && ' — usando somente o prompt base da Xarlote'}
          </p>
        </div>

        {/* Agent pharmacy prompt */}
        <div className="bg-wa-panel border border-wa-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Pill size={18} className="text-green-400" />
            <h2 className="text-base font-medium text-white">Agente Farmácia — IA das farmácias</h2>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Veja o <strong className="text-gray-300">prompt base</strong> que orienta o agente ao negociar com farmácias.
            Se preencher o campo abaixo, ele <strong className="text-gray-300">substitui</strong> o prompt base.
          </p>

          {/* Base prompt — read-only with tabs */}
          <div className="mb-4 border border-wa-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-wa-bg border-b border-wa-border">
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-gray-300 mr-2">Prompt base:</span>
                <button
                  onClick={() => setAgentBaseTab('quoting')}
                  className={`px-2 py-0.5 rounded text-xs transition-colors ${agentBaseTab === 'quoting' ? 'bg-green-500/20 text-green-300' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Cotação
                </button>
                <button
                  onClick={() => setAgentBaseTab('confirmation')}
                  className={`px-2 py-0.5 rounded text-xs transition-colors ${agentBaseTab === 'confirmation' ? 'bg-green-500/20 text-green-300' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Confirmação
                </button>
              </div>
              <div className="flex items-center gap-1">
                {base && (
                  <button
                    onClick={() => copyBase(agentBaseTab === 'quoting' ? base.agent_quoting : base.agent_confirmation)}
                    className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-wa-panel transition-colors"
                    title="Copiar prompt base"
                  >
                    <Copy size={13} />
                  </button>
                )}
                <button
                  onClick={() => setShowAgentBase((v) => !v)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-wa-panel transition-colors"
                >
                  {showAgentBase ? <><EyeOff size={12} /> Ocultar</> : <><Eye size={12} /> Mostrar</>}
                </button>
              </div>
            </div>
            {showAgentBase && (
              <pre className="text-xs text-gray-400 p-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono">
                {base ? (agentBaseTab === 'quoting' ? base.agent_quoting : base.agent_confirmation) : 'Carregando…'}
              </pre>
            )}
          </div>

          <label className="block text-xs font-medium text-gray-300 mb-1.5">Override do prompt (substitui o base se preenchido)</label>
          <textarea
            className="w-full h-56 bg-wa-bg border border-wa-border rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500 resize-y font-mono"
            placeholder={"Deixe vazio para usar o prompt padrão.\n\nDica: clique em 'Mostrar' acima e copie o base para usar como ponto de partida."}
            value={config.agent_override}
            onChange={(e) => setConfig((c) => ({ ...c, agent_override: e.target.value }))}
          />
          <p className="text-xs text-gray-500 mt-1">
            {config.agent_override.length} caracteres
            {config.agent_override.trim() === '' && ' — usando o prompt padrão do sistema'}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={!isDirty || status === 'saving'}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-brand-500 text-white text-sm font-medium disabled:opacity-40 hover:bg-brand-600 transition-colors"
          >
            <Save size={15} />
            {status === 'saving' ? 'Salvando…' : 'Salvar alterações'}
          </button>

          {isDirty && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-wa-border text-gray-400 text-sm hover:text-white transition-colors"
            >
              <RotateCcw size={14} />
              Descartar
            </button>
          )}

          {status === 'saved' && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle size={15} />
              Salvo — entra em vigor na próxima mensagem
            </span>
          )}

          {status === 'error' && (
            <span className="flex items-center gap-1.5 text-sm text-red-400">
              <AlertCircle size={15} />
              Erro: {errorMsg}
            </span>
          )}
        </div>

        {/* Info box */}
        <div className="bg-wa-bg border border-wa-border rounded-lg p-4 text-xs text-gray-400 space-y-1">
          <p className="text-gray-300 font-medium">Como funciona</p>
          <p>• A API key e o modelo são salvos em <code className="text-gray-200">apps/api/data/prompts.json</code>.</p>
          <p>• A cada mensagem recebida, o handler lê o arquivo — sem precisar reiniciar o servidor.</p>
          <p>• O modelo padrão é <code className="text-gray-200">openai/gpt-4.1-mini</code> via OpenRouter.</p>
          <p>• Para ver o prompt base da Xarlote, veja <code className="text-gray-200">packages/llm/src/prompts/sara.system.ts</code>.</p>
        </div>
      </div>
    </div>
  );
}
