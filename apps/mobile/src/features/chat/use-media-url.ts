/**
 * A URL assinada de uma mídia — a peça que faltava pra foto do exame APARECER.
 *
 * O bucket `xarlote-app-media` é privado (e tem que ser: nome de arquivo adivinhável
 * seria prontuário aberto por enumeração). Cada visualização passa por
 * `GET /app/media/:id/url`, que confere o dono e emite uma URL de 10 minutos.
 *
 * ## Os prazos aqui são derivados do TTL, não escolhidos
 *
 * `URL_TTL_S = 600` no servidor. `staleTime` de 8 min garante que o app pede uma URL
 * nova ANTES de a atual vencer; `gcTime` de 9 min garante que uma URL vencida não fica
 * no cache esperando pra falhar depois. Se algum dia o servidor mudar o TTL, estes dois
 * números mudam junto — e é por isso que a conta está escrita e não só o resultado.
 *
 * ## Áudio é `sobDemanda`
 *
 * Foto tem que aparecer sem toque: é o exame que a pessoa quer conferir. Áudio, não —
 * uma tela com seis mensagens de voz visíveis dispararia seis requisições de URL que
 * ninguém vai usar. `sobDemanda` mantém a query desligada até o primeiro toque no play.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';

/** Espelha o TTL de `routes/app/media.ts`. */
const URL_TTL_MS = 600_000;
const MARGEM_MS = 120_000;

export interface MidiaAssinada {
  url: string;
  mime: string;
  expiraEmSegundos: number;
}

export function useMediaUrl(mediaId: string | null, sobDemanda = false) {
  return useQuery<MidiaAssinada>({
    queryKey: ['media-url', mediaId],
    enabled: mediaId !== null && !sobDemanda,
    queryFn: () => apiFetch<MidiaAssinada>(`/app/media/${mediaId!}/url`),
    staleTime: URL_TTL_MS - MARGEM_MS,
    gcTime: URL_TTL_MS - MARGEM_MS / 2,
    // Uma segunda chance só. Rede ruim é o normal aqui; martelar o servidor de storage
    // por uma miniatura não é.
    retry: 1,
  });
}

/** `image/jpeg` → imagem; `audio/m4a` → áudio. O mime vem do servidor, que sniffa BYTES. */
export function tipoDoMime(mime: string | null | undefined): 'image' | 'audio' | 'outro' {
  if (!mime) return 'outro';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'outro';
}
