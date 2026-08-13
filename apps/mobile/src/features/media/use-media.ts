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
 * ## Base64, e não multipart — uma decisão MEDIDA, não preferência
 *
 * A primeira versão mandava `FormData` com `{uri, name, type}`, que é a receita padrão de
 * upload em React Native. Ela **não funciona** neste app: com RN 0.86 em modo bridgeless,
 * o `fetch` LANÇA antes de chegar à rede — a requisição nunca aparece no log do servidor.
 * Verificado no simulador em 13/08, com instrumentação: o token estava presente e o
 * `fetch` morria sem status.
 *
 * As saídas seriam `expo-file-system` (módulo NATIVO novo → exige build novo do app, e o
 * binário instalado não teria) ou base64. O `expo-image-picker` já devolve base64 de
 * graça, e ele JÁ está no binário. Custa 33% a mais de bytes numa foto de 1-3 MB, e
 * funciona hoje.
 *
 * O servidor aceita as duas formas; o multipart segue valendo pro web e pra curl.
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

/**
 * Sobe o arquivo e devolve o `mediaId`.
 *
 * Faz UMA segunda tentativa após renovar o token, espelhando o que o `apiFetch` faz: um
 * upload de 4 MB que falha por token vencido no meio seria a pior forma de perder um
 * exame que o paciente acabou de fotografar.
 */
async function subir(base64: string): Promise<MidiaEnviada> {
  const enviar = async (token: string | null): Promise<Response> =>
    fetch(`${API_BASE_URL}/app/media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ base64 }),
    });

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
  /** Sobe conteúdo já em base64. */
  subirBase64: (base64: string) => Promise<MidiaEnviada | null>;
  /** Sobe um arquivo local por URI (o áudio do gravador), convertendo pra base64. */
  subirArquivoLocal: (uri: string) => Promise<MidiaEnviada | null>;
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
      base64: true,
      /**
       * Converte HEIC → JPEG no aparelho. Sem isto, o app NÃO funciona pra iPhone.
       *
       * Foto de iPhone é HEIC por padrão, e o modelo de visão só aceita jpeg, png, gif e
       * webp. Medido no simulador em 13/08: a foto subiu (2,8 MB, `image/heic`), a
       * mensagem foi criada, e a Xarlote respondeu "tive um probleminha" — porque o
       * provedor recusou o formato. O caminho do WhatsApp nunca mostrou isso porque o
       * próprio WhatsApp converte antes de entregar.
       *
       * `Compatible` pede a representação compatível do asset; o default `Automatic`
       * devolve a atual, que no iPhone é HEIC.
       */
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (r.canceled || !r.assets[0]?.base64) return null;
    const b64 = r.assets[0].base64;
    return comTratamento(() => subir(b64));
  }, [comTratamento]);

  const escolherDaGaleria = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErro('Preciso do acesso às fotos pra pegar o exame. Você pode liberar nos Ajustes.');
      return null;
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      base64: true,
      /**
       * Converte HEIC → JPEG no aparelho. Sem isto, o app NÃO funciona pra iPhone.
       *
       * Foto de iPhone é HEIC por padrão, e o modelo de visão só aceita jpeg, png, gif e
       * webp. Medido no simulador em 13/08: a foto subiu (2,8 MB, `image/heic`), a
       * mensagem foi criada, e a Xarlote respondeu "tive um probleminha" — porque o
       * provedor recusou o formato. O caminho do WhatsApp nunca mostrou isso porque o
       * próprio WhatsApp converte antes de entregar.
       *
       * `Compatible` pede a representação compatível do asset; o default `Automatic`
       * devolve a atual, que no iPhone é HEIC.
       */
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (r.canceled || !r.assets[0]?.base64) return null;
    const b64 = r.assets[0].base64;
    return comTratamento(() => subir(b64));
  }, [comTratamento]);

  const subirBase64 = useCallback(
    (base64: string) => comTratamento(() => subir(base64)),
    [comTratamento],
  );

  /**
   * Sobe um arquivo local (o áudio do gravador), convertendo pra base64 antes.
   *
   * `expo-audio` devolve uma URI, não base64 — e `expo-file-system` seria um módulo
   * nativo novo. `fetch` sobre `file://` + `FileReader` são polyfills de JS do React
   * Native, então funcionam no binário atual. É um caminho diferente do `FormData`, que
   * é o que falha aqui (ver o cabeçalho).
   */
  const subirArquivoLocal = useCallback(
    (uri: string) =>
      comTratamento(async () => {
        const blob = await (await fetch(uri)).blob();
        const b64 = await new Promise<string>((ok, falhou) => {
          const leitor = new FileReader();
          leitor.onerror = () => falhou(new Error('não consegui ler o áudio gravado'));
          leitor.onload = () => {
            const r = String(leitor.result);
            // `readAsDataURL` devolve `data:audio/...;base64,XXXX` — só o depois da vírgula.
            const virgula = r.indexOf(',');
            ok(virgula >= 0 ? r.slice(virgula + 1) : r);
          };
          leitor.readAsDataURL(blob);
        });
        return subir(b64);
      }),
    [comTratamento],
  );

  return { fase, erro, fotografar, escolherDaGaleria, subirBase64, subirArquivoLocal, limparErro: () => setErro(null) };
}
