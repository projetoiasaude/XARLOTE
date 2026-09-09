/**
 * foto-recente — a foto de há pouco precisa estar na frente do modelo quando a pergunta
 * é sobre ela.
 *
 * ─── O QUE ACONTECEU (Hiago/Ludmila, 04/09/2026, 16:54–16:55) ──────────────────
 * 16:54:51  foto do exame (doppler venoso) → o modelo de VISÃO vê a imagem e responde
 *           "Vi aqui um exame Doppler venoso… Quer que eu guarde?"
 * 16:55:00  "O que acha desse exame da Lud minha esposa"
 *           → turno de TEXTO: a imagem não vai junto; no histórico a mensagem da foto
 *             nem aparece (sem `content`, sem `transcript`, ela é filtrada);
 *           → a memória traz o card do exame de MAIO ("Anti-TPO, ureia, ácido úrico…");
 *           → o modelo descreve o exame de maio como se fosse o doppler de hoje, e
 *             declara que "já guardou tudo".
 * A foto existia no Storage o tempo todo. Só não estava no turno.
 *
 * ─── A REGRA ────────────────────────────────────────────────────────────────────
 * Turno de texto logo depois de foto(s) recente(s) do paciente = as fotos voltam pro
 * turno, como imagem, com o aviso de que já foram comentadas. Janela curta (20 min) e no
 * máximo 2 fotos: é "esse exame aí", não o álbum inteiro. Documento (PDF) não entra aqui
 * — ele já deixa o texto extraído no `transcript` e não é imagem.
 *
 * PURO: escolhe a partir das linhas do histórico; quem baixa os bytes é o handler.
 */

export interface MensagemComMidia {
  id: string;
  direction: string;
  content_type: string;
  media_storage_path: string | null;
  media_mime: string | null;
  created_at: string;
}

export const JANELA_FOTO_RECENTE_MS = 20 * 60_000;
export const MAX_FOTOS_REANEXADAS = 2;

/** Fotos do PACIENTE, com arquivo guardado, dentro da janela — da mais nova pra mais velha. */
export function selecionarFotosRecentes<T extends MensagemComMidia>(
  mensagens: readonly T[],
  opts: { agora?: Date; janelaMs?: number; max?: number } = {},
): T[] {
  const agora = (opts.agora ?? new Date()).getTime();
  const janela = opts.janelaMs ?? JANELA_FOTO_RECENTE_MS;
  const max = opts.max ?? MAX_FOTOS_REANEXADAS;
  return mensagens
    .filter((m) => m.direction === 'in' && m.content_type === 'image' && !!m.media_storage_path)
    .filter((m) => {
      const mime = (m.media_mime ?? '').toLowerCase();
      // PDF que entrou como 'image' (o app faz isso de propósito) não é foto — o modelo de
      // visão não lê PDF, e o texto dele já está no transcript.
      return !mime.includes('pdf');
    })
    .filter((m) => {
      const t = new Date(m.created_at).getTime();
      return !Number.isNaN(t) && agora - t >= 0 && agora - t <= janela;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, max);
}
