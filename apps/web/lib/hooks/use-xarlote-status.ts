'use client';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/utils';

export interface XarloteStatus {
  enabled: boolean;
  model: string;
  visionModel: string;
  audioModel: string;
  loaded: boolean;
}

const initial: XarloteStatus = {
  enabled: true,
  model: 'openai/gpt-4.1-mini',
  visionModel: '',
  audioModel: '',
  loaded: false,
};

/**
 * Lê config /admin/prompts. Compartilhado por sidebar (badge) e
 * página /prompts (controles). Poll a cada 30s pra detectar mudanças
 * feitas via outra aba.
 */
export function useXarloteStatus() {
  const [status, setStatus] = useState<XarloteStatus>(initial);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const res = await fetch(apiUrl('/admin/prompts'));
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        setStatus({
          enabled: data.xarlote_enabled !== false,
          model: data.llm_model ?? '',
          visionModel: data.vision_model ?? '',
          audioModel: data.audio_model ?? '',
          loaded: true,
        });
      } catch {
        /* silencioso */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  return status;
}
