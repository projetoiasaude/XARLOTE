// Documento recebido pelo WhatsApp: onde cada provedor esconde o NOME do arquivo.
//
// Por que isto vive aqui: "em qual chave este provedor põe o nome do arquivo" é
// conhecimento de PROVEDOR, e é este pacote que carrega esse conhecimento (mesmo
// espírito do `zpro-normalize`). O handler não deveria precisar saber que o zpro
// aninha em `msg.document.filename` e a uazapi em `message.content.fileName`.
//
// A dívida que isto cobre: `NormalizedInbound` (packages/shared) não tem campo pra
// nome de arquivo, e o handler chutava UMA chave só (`raw.message.document.filename`)
// — que não é a do zpro real (`msg.document.*`, espelho do `msg.audio` confirmado ao
// vivo em 24/06) nem a da uazapi (Baileys põe em `content.fileName`). Resultado: todo
// PDF de laudo chegava anônimo, e "um documento" sem nome é o que faz a Xarlote não
// saber do que se trata e ter que perguntar o óbvio.
//
// PURO: recebe payload, devolve string. Zero I/O — logo, testável.
//
// ⚠️ NUNCA logue o retorno em nível ≥ info. Nome de arquivo de laudo carrega nome de
// paciente com frequência ("laudo_maria_silva.pdf") e o `maskString` do writeLog
// mascara telefone/CPF, não nome de pessoa (CLAUDE.md #3).

/** Teto do nome. Nome de arquivo longo é o que estoura prompt e log, não informação. */
const MAX_NOME = 80;

/**
 * Caminhos candidatos, na ordem em que vencem. Os `msg.*` vêm primeiro porque são o
 * shape REAL do zpro/WABA; `message.content.*` é a uazapi (Baileys). O resto é rede de
 * segurança pra outras versões — a mesma postura tolerante do parser de entrada do zpro,
 * pelo mesmo motivo: o shape não é documentado e não é nosso pra decidir.
 */
const CAMINHOS_NOME: readonly string[] = [
  // zpro / WhatsApp Business oficial
  'msg.document.filename',
  'msg.document.file_name',
  'msg.document.title',
  'msg.video.filename',
  'msg.image.filename',
  // uazapi (Baileys embrulhado em `message`)
  'message.content.fileName',
  'message.content.filename',
  'message.content.title',
  'message.fileName',
  'message.filename',
  'message.documentMessage.fileName',
  'message.documentMessage.title',
  'message.message.documentMessage.fileName',
  // shapes planos / outros clientes
  'document.filename',
  'document.file_name',
  'fileName',
  'filename',
  'file_name',
  'data.fileName',
  'data.filename',
  'data.document.filename',
  'attachment.filename',
  'attachment.name',
];

function leCaminho(obj: unknown, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((acc, chave) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[chave];
    }
    return undefined;
  }, obj);
}

/**
 * Sanitiza o nome vindo de fora. Três coisas, cada uma por um motivo:
 *
 * 1. **Tira diretório** (`../../etc/passwd`, `C:\laudos\x.pdf`): o nome é usado em
 *    prompt e pode um dia virar nome de arquivo no Storage. Quem manda o nome é o
 *    remetente, então ele nunca decide caminho.
 * 2. **Tira controle/quebra de linha**: `\n` no nome injetaria uma linha falsa dentro
 *    do bloco que a Xarlote lê — um nome pode ser escrito pra parecer instrução.
 * 3. **Corta o comprimento**, preservando a extensão, que é a parte informativa.
 */
export function limpaNomeDeArquivo(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  // Só a última parte do caminho, em qualquer separador.
  const semCaminho = bruto.split(/[/\\]/).pop() ?? '';
  // Controle (inclui \n, \r, \t) fora; espaços colapsados.
  // eslint-disable-next-line no-control-regex
  const limpo = semCaminho.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo || limpo === '.' || limpo === '..') return null;
  if (limpo.length <= MAX_NOME) return limpo;

  // Corta o MEIO, não o fim: a extensão diz o que o arquivo é e é o que mais importa.
  const ponto = limpo.lastIndexOf('.');
  const ext = ponto > 0 && limpo.length - ponto <= 10 ? limpo.slice(ponto) : '';
  return `${limpo.slice(0, MAX_NOME - ext.length - 1)}…${ext}`;
}

/** Nome do arquivo lido do payload CRU de um webhook (zpro, uazapi, ou plano). */
export function nomeArquivoDoPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  for (const caminho of CAMINHOS_NOME) {
    const nome = limpaNomeDeArquivo(leCaminho(payload, caminho));
    if (nome) return nome;
  }
  return null;
}

/**
 * Nome do arquivo de um inbound já normalizado.
 *
 * Olha primeiro um campo `fileName` no próprio inbound (pra quando `NormalizedInbound`
 * ganhar o campo — hoje ele não existe, e o cast morre no dia em que existir) e depois
 * o payload cru guardado em `raw`.
 */
export function nomeArquivoDeInbound(inbound: { raw?: unknown } | null | undefined): string | null {
  if (!inbound) return null;
  const direto = limpaNomeDeArquivo((inbound as { fileName?: unknown }).fileName);
  if (direto) return direto;
  return nomeArquivoDoPayload(inbound.raw);
}

/**
 * Mime provável a partir da extensão — usado SÓ como último recurso, quando o provedor
 * não declara `mimetype` nenhum.
 *
 * O mime que vale é sempre o dos BYTES (`lib/media-sniff.ts`); este aqui existe porque
 * `messages.media_mime` é gravado ANTES do download, e uma linha com mime nulo some do
 * `resolveMediaMessageId` (que filtra `media_mime is not null`) — ou seja, o exame do
 * paciente deixaria de encontrar o próprio arquivo.
 */
export function mimePorExtensao(nome: string | null | undefined): string | null {
  const ext = /\.([a-z0-9]{1,5})$/i.exec((nome ?? '').trim())?.[1]?.toLowerCase();
  if (!ext) return null;
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'heic':
    case 'heif': return 'image/heic';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'ogg':
    case 'opus': return 'audio/ogg';
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'wav': return 'audio/wav';
    default: return null;
  }
}
