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
 *
 * ## O PDF exige build novo — e o preço de errar a ordem é a tela inicial, não o botão
 *
 * `expo-document-picker` é módulo NATIVO, e a frase antiga aqui ("só existe depois de um
 * build novo") subestimava o que acontece num OTA. O que o pacote faz é
 * `export default requireNativeModule('ExpoDocumentPicker')` em escopo de MÓDULO — e
 * `requireNativeModule` LANÇA quando o binário não tem o módulo. Com um `import` estático
 * no topo deste arquivo, a exceção subiria na cadeia `use-media` → `Compositor` →
 * `app/(main)/index.tsx`, que é a ROTA INICIAL: publicar um OTA com este bundle sobre o
 * binário instalado hoje não esconderia um botão, derrubaria o app na abertura.
 *
 * Então **build novo ANTES do update, nunca depois** — e, além do aviso, a rede de
 * proteção: o módulo é resolvido dentro de `escolherDocumento` por
 * `requireOptionalNativeModule`, que devolve `null` em vez de lançar (regra da casa nº47:
 * a guarda certa é PERGUNTAR se o módulo existe; `require` dentro de `try/catch` não
 * guarda módulo nativo em RN — isso já foi tentado e falhou com `ExpoUpdates`). Sem o
 * módulo, o paciente lê uma frase em PT-BR e o resto do app continua de pé. O `import` que
 * sobrou é `import type`, apagado na compilação: ele não avalia nada em tempo de execução.
 *
 * O que o seletor devolve é uma URI — não base64 —, então a conversão passa pelo mesmo
 * `arquivoLocalEmBase64` do áudio: `fetch` + `FileReader`, que são polyfills de JS e
 * funcionam sem módulo nenhum.
 */
import { useCallback, useState } from 'react';
import { requireOptionalNativeModule } from 'expo';
import type { DocumentPickerResult } from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { API_BASE_URL, currentAccessToken, refreshAccessToken } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { falhaDoUpload, MAX_BYTES_ARQUIVO, MSG_MUITO_GRANDE } from './erro-upload';
import { lerDocumentoDaResposta, type DocumentoDoServidor } from './pdf-documento';

/**
 * O contrato mínimo do módulo nativo do seletor de arquivos.
 *
 * Chamar o módulo direto em vez do wrapper de `expo-document-picker` é o que permite que o
 * pacote nunca seja avaliado num binário que não o tem. O wrapper é fino — ele só
 * transforma `type` em array e preenche os defaults — e aqui as quatro opções vão
 * explícitas, então não se perde nada no caminho.
 */
interface SeletorDeArquivosNativo {
  getDocumentAsync(opcoes: {
    type: string[];
    copyToCacheDirectory: boolean;
    multiple: boolean;
    base64: boolean;
  }): Promise<DocumentPickerResult>;
}

export type TipoMidia = 'image' | 'audio' | 'document';

export interface MidiaEnviada {
  mediaId: string;
  tipo: TipoMidia;
  mime: string;
  bytes: number;
  /**
   * Só em PDF: o que o servidor leu (ou não) do arquivo, ainda no upload.
   *
   * O laudo NÃO viaja por aqui pra dentro da mensagem — ele vai pelo `mediaId`, e quem
   * embrulha o texto pro modelo é o servidor (ver pdf-documento.ts). O que o app faz com
   * este campo é a PRÉVIA: dizer quantas páginas entraram, e dizer com todas as letras
   * quando o conteúdo não pôde ser lido. Sem ler este campo, a leitura no upload seria
   * trabalho jogado fora.
   */
  documento?: DocumentoDoServidor;
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
  if (!res.ok) throw new ApiError(falhaDoUpload(res.status, corpo), res.status);

  const documento = lerDocumentoDaResposta(corpo?.['documento']);
  return {
    mediaId: corpo!['mediaId'] as string,
    tipo: corpo!['tipo'] as TipoMidia,
    mime: corpo!['mime'] as string,
    bytes: corpo!['bytes'] as number,
    ...(documento ? { documento } : {}),
  };
}

/**
 * Arquivo local (`file://`, `content://`) → base64.
 *
 * `fetch` sobre a URI + `FileReader` são polyfills de JS do React Native, então funcionam
 * no binário atual. É um caminho diferente do `FormData`, que é justamente o que falha
 * aqui (ver o cabeçalho) — e `expo-file-system` seria um módulo nativo novo.
 */
async function arquivoLocalEmBase64(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  return new Promise<string>((ok, falhou) => {
    const leitor = new FileReader();
    leitor.onerror = () => falhou(new Error('não consegui ler o arquivo escolhido'));
    leitor.onload = () => {
      const r = String(leitor.result);
      // `readAsDataURL` devolve `data:<mime>;base64,XXXX` — só o depois da vírgula.
      const virgula = r.indexOf(',');
      ok(virgula >= 0 ? r.slice(virgula + 1) : r);
    };
    leitor.readAsDataURL(blob);
  });
}

export type FaseEnvio = 'parado' | 'subindo' | 'enviando';

export interface EstadoMidia {
  fase: FaseEnvio;
  erro: string | null;
  /** Abre a câmera. Devolve o mediaId, ou null se o paciente desistiu. */
  fotografar: () => Promise<MidiaEnviada | null>;
  /** Abre a galeria. */
  escolherDaGaleria: () => Promise<MidiaEnviada | null>;
  /** Abre o seletor de arquivos filtrado em PDF — o laudo que o laboratório mandou. */
  escolherDocumento: () => Promise<MidiaEnviada | null>;
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
        // formato eu não leio", "o limite é 10 MB"). Ver lib/api/errors.ts — e
        // erro-upload.ts, que barra a exceção: o 413 do `bodyLimit` é escrito pelo
        // Fastify, em inglês, e esse não pode chegar à tela.
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

  /**
   * PDF — o laudo que o laboratório mandou por e-mail ou WhatsApp.
   *
   * Não pede permissão: o seletor de documentos do sistema é quem abre e quem entrega o
   * arquivo, então o que o app enxerga é só o que a pessoa escolheu. `copyToCacheDirectory`
   * é obrigatório aqui — sem ele a URI pode ser um `content://` de provedor que o `fetch`
   * do RN não abre, e o upload falharia sem motivo visível.
   *
   * O filtro `application/pdf` é conveniência de tela, nunca controle: o veredicto continua
   * vindo dos BYTES no servidor (`sniffMidia`), que responde 415 com a frase certa se vier
   * outra coisa.
   *
   * ## O tamanho é conferido ANTES de virar base64
   *
   * Este é o caminho mais exposto dos três: foto de câmera e de galeria passam pela
   * compressão do picker (`quality: 0.8`), mas o PDF sobe exatamente como o laboratório
   * mandou. Um laudo escaneado de hospital de 25 MB viraria um Blob mais uma string base64
   * de ~33 MB no heap de um Android intermediário — congelamento ou queda, sem uma frase
   * na tela. O `size` que o seletor devolve corta isso antes de qualquer conversão.
   */
  const escolherDocumento = useCallback(async () => {
    // `null` quando o binário não tem o módulo — nenhum throw, nenhum try/catch (regra 47).
    const seletor = requireOptionalNativeModule<SeletorDeArquivosNativo>('ExpoDocumentPicker');
    if (!seletor) {
      setErro(
        'Preciso de uma atualização do app pra abrir arquivos do seu celular. Enquanto isso, dá pra tirar uma foto da folha que eu leio.',
      );
      return null;
    }

    const r = await seletor.getDocumentAsync({
      type: ['application/pdf'],
      copyToCacheDirectory: true,
      multiple: false,
      base64: false,
    });
    const arquivo = r.canceled ? null : (r.assets?.[0] ?? null);
    if (!arquivo) return null;
    const uri = arquivo.uri;
    if (!uri) return null;

    // O seletor nem sempre sabe o tamanho (provedor de conteúdo no Android pode omitir);
    // quando sabe, ele é a única porta ANTES da memória. A do servidor continua valendo.
    if (typeof arquivo.size === 'number' && arquivo.size > MAX_BYTES_ARQUIVO) {
      setErro(MSG_MUITO_GRANDE);
      return null;
    }

    return comTratamento(async () => subir(await arquivoLocalEmBase64(uri)));
  }, [comTratamento]);

  const subirBase64 = useCallback(
    (base64: string) => comTratamento(() => subir(base64)),
    [comTratamento],
  );

  /**
   * Sobe um arquivo local (o áudio do gravador), convertendo pra base64 antes.
   *
   * `expo-audio` devolve uma URI, não base64 — a conversão é a de `arquivoLocalEmBase64`,
   * a mesma que o PDF usa. Um caminho só pros dois é o que impede um deles de ficar pra
   * trás na próxima vez que o RN mudar de ideia sobre `fetch` de arquivo.
   */
  const subirArquivoLocal = useCallback(
    (uri: string) => comTratamento(async () => subir(await arquivoLocalEmBase64(uri))),
    [comTratamento],
  );

  return {
    fase,
    erro,
    fotografar,
    escolherDaGaleria,
    escolherDocumento,
    subirBase64,
    subirArquivoLocal,
    limparErro: () => setErro(null),
  };
}
