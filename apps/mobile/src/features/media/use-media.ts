/**
 * Mandar foto, PDF e áudio — o wedge do produto ("manda teu exame").
 *
 * ## Duas etapas, e a razão de a tela ver isso
 *
 * O arquivo sobe primeiro (`POST /app/media` → `mediaId`), e só então vira mensagem
 * (`POST /app/messages {mediaId}`). Numa rede móvel, isso é o que impede um upload de
 * 4 MB de ser jogado fora porque a segunda chamada falhou — o app repete só a parte
 * barata. A tela mostra o progresso das duas fases como uma coisa só.
 *
 * ## O upload NÃO passa por `apiFetch`
 *
 * `apiFetch` serializa o corpo em JSON. Aqui o corpo é `FormData` com bytes, e deixar o
 * `content-type` ser definido pelo runtime é obrigatório (o boundary do multipart é
 * gerado por ele). Definir o header à mão quebra o parse do lado do servidor — é o erro
 * clássico de upload em RN. Por isso o `fetch` cru, com o token pego do mesmo lugar.
 */
import { useCallback, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { API_BASE_URL, currentAccessToken, refreshAccessToken } from '@/lib/api/client';
import { ApiError, classifyApiError } from '@/lib/api/errors';

export type TipoMidia = 'image' | 'audio' | 'document';

export interface MidiaEnviada {
  mediaId: string;
  tipo: TipoMidia;
  mime: string;
  bytes: number;
}

/** Nome do arquivo no multipart. O servidor ignora — ele lê os BYTES. */
function nomeDoArquivo(uri: string, fallback: string): string {
  const ultimo = uri.split('/').pop();
  return ultimo && ultimo.includes('.') ? ultimo : fallback;
}

/**
 * Sobe o arquivo e devolve o `mediaId`.
 *
 * Faz UMA segunda tentativa após renovar o token, espelhando o que o `apiFetch` faz: um
 * upload de 4 MB que falha por token vencido no meio seria a pior forma de perder um
 * exame que o paciente acabou de fotografar.
 */
async function subir(uri: string, mimeSugerido: string, nome: string): Promise<MidiaEnviada> {
  const enviar = async (token: string | null): Promise<Response> => {
    const form = new FormData();
    // O cast é a forma que o RN espera pra arquivo local em FormData.
    form.append('file', { uri, name: nome, type: mimeSugerido } as unknown as Blob);
    return fetch(`${API_BASE_URL}/app/media`, {
      method: 'POST',
      // SEM `content-type`: o runtime precisa gerar o boundary do multipart.
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
  };

  let res = await enviar(currentAccessToken());
  if (res.status === 401) {
    const novo = await refreshAccessToken();
    if (novo) res = await enviar(novo);
  }

  const corpo = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new ApiError(classifyApiError(res.status, corpo), res.status);

  return {
    mediaId: corpo!['mediaId'] as string,
    tipo: corpo!['tipo'] as TipoMidia,
    mime: corpo!['mime'] as string,
    bytes: corpo!['bytes'] as number,
  };
}

export type FaseEnvio = 'parado' | 'subindo' | 'enviando';

export interface EstadoMidia {
  fase: FaseEnvio;
  erro: string | null;
  /** Abre a câmera. Devolve o mediaId, ou null se o paciente desistiu. */
  fotografar: () => Promise<MidiaEnviada | null>;
  /** Abre a galeria. */
  escolherDaGaleria: () => Promise<MidiaEnviada | null>;
  /** Sobe um arquivo já gravado no aparelho (usado pelo gravador de voz). */
  subirArquivo: (uri: string, mime: string, nome: string) => Promise<MidiaEnviada | null>;
  limparErro: () => void;
}

export function useMedia(): EstadoMidia {
  const [fase, setFase] = useState<FaseEnvio>('parado');
  const [erro, setErro] = useState<string | null>(null);

  const comTratamento = useCallback(
    async (fn: () => Promise<MidiaEnviada | null>): Promise<MidiaEnviada | null> => {
      setErro(null);
      setFase('subindo');
      try {
        return await fn();
      } catch (e) {
        // A mensagem do SERVIDOR ganha: ele sabe coisas que o app não sabe ("esse
        // formato eu não leio", "o limite é 10 MB"). Ver lib/api/errors.ts.
        setErro(e instanceof ApiError ? e.failure.message : 'Não consegui enviar. Tenta de novo?');
        return null;
      } finally {
        setFase('parado');
      }
    },
    [],
  );

  const fotografar = useCallback(async () => {
    // A permissão é pedida no momento do uso, não no arranque: um app de saúde pedindo
    // câmera na primeira tela parece invasivo, e a Apple recomenda o contrário.
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setErro('Preciso da câmera pra fotografar seu exame. Você pode liberar nos Ajustes.');
      return null;
    }
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      // Sem edição: recortar um laudo é o caminho mais fácil pra cortar justamente o
      // valor que importa.
      allowsEditing: false,
      quality: 0.8,
    });
    if (r.canceled || !r.assets[0]) return null;
    const a = r.assets[0];
    return comTratamento(() => subir(a.uri, a.mimeType ?? 'image/jpeg', nomeDoArquivo(a.uri, 'exame.jpg')));
  }, [comTratamento]);

  const escolherDaGaleria = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErro('Preciso do acesso às fotos pra pegar o exame. Você pode liberar nos Ajustes.');
      return null;
    }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (r.canceled || !r.assets[0]) return null;
    const a = r.assets[0];
    return comTratamento(() => subir(a.uri, a.mimeType ?? 'image/jpeg', nomeDoArquivo(a.uri, 'exame.jpg')));
  }, [comTratamento]);

  const subirArquivo = useCallback(
    (uri: string, mime: string, nome: string) => comTratamento(() => subir(uri, mime, nome)),
    [comTratamento],
  );

  return { fase, erro, fotografar, escolherDaGaleria, subirArquivo, limparErro: () => setErro(null) };
}
