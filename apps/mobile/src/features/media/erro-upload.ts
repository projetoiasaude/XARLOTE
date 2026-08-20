/**
 * O que o paciente lê quando o arquivo NÃO sobe — e o teto que evita a maior parte disso.
 *
 * Mora fora de `use-media.ts` por um motivo só: aquele arquivo importa `expo` e
 * `expo-image-picker`, que não carregam fora do aparelho. Aqui não há import de módulo
 * nativo nenhum, então esta decisão — qual frase a pessoa lê — é EXECUTÁVEL num teste, em
 * vez de ser afirmada num comentário.
 */
import { classifyApiError, type ApiFailure } from '@/lib/api/errors';

/**
 * O mesmo teto do servidor — `MAX_BYTES` em `apps/api/src/lib/media-sniff.ts`.
 *
 * Repetido aqui de propósito, e com a fonte da verdade nomeada: o app não importa código da
 * API. Esta checagem NÃO é o controle (o controle é o do servidor, que decide pelos bytes);
 * ela existe pra que um arquivo grande demais nem chegue a virar base64 na memória do
 * aparelho. Um laudo escaneado de 25 MB vira uma string de ~33 MB no heap de um Android
 * intermediário, o que é congelamento ou queda — sem nenhuma frase na tela.
 *
 * Se o número mudar lá, muda aqui: `tests/erro-upload.test.ts` compara os dois e quebra
 * alto se divergirem.
 */
export const MAX_BYTES_ARQUIVO = 10 * 1024 * 1024;

/**
 * Copiada LITERALMENTE de `mensagemDeRecusa('muito_grande')` no servidor.
 *
 * Duas portas podem recusar o mesmo arquivo — a daqui, antes do base64, e a do servidor — e
 * a pessoa tem que ler a MESMA frase nas duas. Frase diferente pro mesmo motivo ensina que
 * são problemas diferentes. O teste compara as duas strings.
 */
export const MSG_MUITO_GRANDE =
  'Esse arquivo é grande demais (o limite é 10 MB). Se for foto, tenta tirar de novo com menos zoom.';

/**
 * O corpo do erro é NOSSO, ou é o envelope que o Fastify gera sozinho?
 *
 * Importa porque `classifyApiError` prefere a `message` do servidor — e essa preferência só
 * faz sentido quando a mensagem foi escrita PRA PACIENTE, em PT-BR. O 413 do `bodyLimit` da
 * rota `POST /app/media` é respondido ANTES do handler (não existe `setErrorHandler` na
 * API), com `{statusCode:413, error:'Payload Too Large', message:'Request body is too
 * large'}`. É mensagem de servidor, sim, mas em inglês e sobre HTTP: a paciente de 55 anos
 * leria "Request body is too large" na tela, e o `mensagemDeRecusa('muito_grande')` em PT-BR
 * que o handler prepararia nunca chegaria a rodar.
 *
 * O que separa os dois é o formato: o `error` nosso é um slug (`muito_grande`,
 * `formato_nao_suportado`, `arquivo_ausente`); o do Fastify é a frase de status em inglês,
 * com maiúscula e espaço. O `statusCode` numérico, que só o envelope automático carrega,
 * confirma. A regra é conservadora de propósito — só descarta com evidência POSITIVA de que
 * o corpo veio do Fastify, nunca por ausência de campo, porque o erro caro é jogar fora uma
 * orientação que a casa escreveu.
 */
export function envelopeDoFastify(corpo: Record<string, unknown> | null | undefined): boolean {
  if (!corpo) return false;
  if (typeof corpo['statusCode'] === 'number') return true;
  const cod = corpo['error'];
  return typeof cod === 'string' && /[A-Z\s]/.test(cod);
}

/**
 * A falha do upload, já em PT-BR.
 *
 * Vale só pra `POST /app/media`, onde 413 tem um significado só: o arquivo não coube.
 */
export function falhaDoUpload(
  status: number,
  corpo: Record<string, unknown> | null | undefined,
): ApiFailure {
  if (!envelopeDoFastify(corpo)) return classifyApiError(status, corpo);
  if (status === 413) return { kind: 'unknown', message: MSG_MUITO_GRANDE, retryable: false };
  // Outro envelope automático (400 de JSON malformado, por exemplo): joga fora o texto em
  // inglês e deixa o `kind` do status escolher a frase que a casa escreveu.
  return classifyApiError(status, null);
}
