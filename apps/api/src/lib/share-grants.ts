/**
 * O link do médico — as decisões, puras e testáveis.
 *
 * ## O que este link é
 *
 * O paciente gera um endereço e manda pro médico dele. O médico abre no navegador e vê o
 * resumo clínico: alergias, medicamentos em uso, condições, exames recentes. Sem app, sem
 * cadastro, sem login. É a superfície da Xarlote para o profissional.
 *
 * ## O que ele NÃO pode ser
 *
 * Um endereço que dá acesso a prontuário, sem autenticação, é um objeto perigoso por
 * construção. As defesas, e o porquê de cada uma:
 *
 * · **Token de 256 bits, e o banco guarda só o hash.** Um vazamento do banco não entrega
 *   links funcionando. Mesmo modelo do refresh token da sessão.
 * · **Validade curta** (72h padrão, 7 dias no máximo). Link de prontuário não é para
 *   durar: o paciente mostra na consulta e ele morre sozinho. Sem validade, um link
 *   compartilhado uma vez fica aberto para sempre.
 * · **PIN opcional de 4 dígitos**, com trava em 5 erros. Protege o caso real de o link
 *   ser encaminhado adiante — o WhatsApp do médico, o grupo da clínica.
 * · **404 indistinguível.** Expirado, revogado, inexistente e PIN errado devolvem a MESMA
 *   forma de resposta. Um 410 "expirado" confirmaria ao atacante que o token existiu, e
 *   transformaria a busca por tokens válidos num jogo com feedback.
 * · **Nada em URL de log.** O token vai no CORPO do POST, nunca na query string — access
 *   log de proxy é o lugar onde credencial some sem ninguém notar.
 *
 * PURO: `nowMs` e o gerador de aleatoriedade são injetados. O I/O fica na rota.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TTL_PADRAO_H = 72;
export const SHARE_TTL_MAX_H = 7 * 24;
export const PIN_MAX_TENTATIVAS = 5;

/** Token opaco em base64url — o que vai na URL que o paciente manda. */
export function novoShareToken(randomBytes: (n: number) => Buffer): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Hash do PIN COM sal por link.
 *
 * O sal existe porque o espaço é ridiculamente pequeno: 10 mil PINs de 4 dígitos. Sem
 * sal, uma tabela pré-computada resolve todos os links de uma vez; com sal por link, cada
 * um precisa ser atacado sozinho — e a trava em 5 tentativas fecha esse caminho.
 */
export function hashPin(pin: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

/** Comparação em tempo constante — evita descobrir o PIN medindo o tempo da resposta. */
export function pinConfere(pin: string, salt: string, hashEsperado: string): boolean {
  const a = Buffer.from(hashPin(pin, salt), 'hex');
  const b = Buffer.from(hashEsperado, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Validade pedida → instante de expiração, clampada no teto. */
export function expiraEm(horasPedidas: number | undefined, nowMs: number): Date {
  const h = Math.min(Math.max(horasPedidas ?? SHARE_TTL_PADRAO_H, 1), SHARE_TTL_MAX_H);
  return new Date(nowMs + h * 3_600_000);
}

export interface ShareGrantRow {
  expires_at: string;
  revoked_at: string | null;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_attempts: number;
}

export type VeredictoShare =
  /** libera o resumo */
  | { kind: 'ok' }
  /** precisa de PIN e não veio (ou veio errado) — a tela pede/repete */
  | { kind: 'pin_necessario'; tentativasRestantes: number }
  /**
   * Não existe, expirou, foi revogado, ou o PIN travou. **Um só desfecho de propósito**:
   * quem chama devolve sempre a mesma resposta, para não confirmar a existência do token.
   */
  | { kind: 'indisponivel' };

/**
 * O link pode abrir?
 *
 * A ordem das checagens importa: revogado e expirado vêm ANTES do PIN, senão um link
 * morto ainda aceitaria tentativas de PIN — e cada tentativa é um sinal de que o token
 * existe.
 */
export function avaliarShare(
  grant: ShareGrantRow,
  pinFornecido: string | undefined,
  nowMs: number,
): VeredictoShare {
  if (grant.revoked_at) return { kind: 'indisponivel' };

  const expira = Date.parse(grant.expires_at);
  if (!Number.isFinite(expira) || nowMs > expira) return { kind: 'indisponivel' };

  // Sem PIN configurado: o token sozinho basta.
  if (!grant.pin_hash || !grant.pin_salt) return { kind: 'ok' };

  // Travado por tentativas: indistinguível de inexistente, para não virar oráculo.
  if (grant.pin_attempts >= PIN_MAX_TENTATIVAS) return { kind: 'indisponivel' };

  const restantes = PIN_MAX_TENTATIVAS - grant.pin_attempts;
  if (!pinFornecido) return { kind: 'pin_necessario', tentativasRestantes: restantes };

  if (!pinConfere(pinFornecido, grant.pin_salt, grant.pin_hash)) {
    // `- 1` porque ESTA tentativa acabou de ser gasta: quem chama incrementa no banco.
    const sobrando = restantes - 1;
    return sobrando <= 0
      ? { kind: 'indisponivel' }
      : { kind: 'pin_necessario', tentativasRestantes: sobrando };
  }

  return { kind: 'ok' };
}

/** PIN válido: exatamente 4 dígitos. Vazio/ausente = link sem PIN. */
export function pinValido(pin: string | undefined | null): boolean {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

// ─── O resumo que o médico vê ──────────────────────────────────────────────────

/**
 * Versão do formato congelado.
 *
 * O resumo é gravado em `summary_cache` no momento da criação e nunca reescrito — então
 * links criados ANTES desta versão continuam vivos com o formato antigo. A página do
 * médico é obrigada a ler os dois; o número existe para que ela saiba disso de forma
 * explícita, em vez de descobrir por um `undefined.map` no navegador do consultório.
 *
 * v1 → v2: cada exame ganhou `valores` (os marcadores lidos do laudo). Nada foi removido
 * nem renomeado: v2 é v1 mais campos.
 *
 * **O formato só anuncia o que alguém preenche.** Houve aqui um `documentos` — os anexos
 * que o paciente mandou — com tipo, normalizador e uma seção na página do médico. Nenhuma
 * rota jamais o preencheu, e uma URL de leitura exigiria assinar o caminho no acesso, o
 * que também nunca foi escrito. O efeito era pior que um campo morto: a página afirmava
 * "nenhum documento anexado a este resumo" para um paciente que tinha anexado. Quando o
 * acervo for ligado de ponta a ponta (select dos anexos na criação + assinatura curta na
 * rota pública), o campo volta — junto com o que o preenche, não antes.
 */
export const RESUMO_VERSAO = 2;

/**
 * Um marcador lido do laudo, como TEXTO.
 *
 * Nada aqui é número, e isso é deliberado. `value` vem de um modelo de visão lendo a foto
 * de um laudo: chega `"13,5"`, `"7.200"`, `"<0,01"`, `"13.5 g/dL"`. Converter para número
 * aqui congelaria a interpretação de hoje dentro de um link que dura 7 dias — e o parser
 * de decimal brasileiro é justamente a parte que mais tende a melhorar. Então o link
 * congela o FATO (o que estava escrito) e a página calcula a VISTA (número, tendência,
 * comparação com a faixa). Parser melhor amanhã vale para os links de ontem.
 */
export interface ValorExame {
  marcador: string;
  valor: string;
  unidade: string | null;
  /** Faixa de referência **impressa no laudo**, se havia. Nunca uma faixa nossa. */
  referencia: string | null;
}

export interface ExameResumo {
  tipo: string;
  data: string | null;
  resumo: string | null;
  /** v2. Ausente nos links criados antes — a página trata como lista vazia. */
  valores?: ValorExame[];
  /** Quantos marcadores ficaram fora do teto. A página diz o número; não engole a lacuna. */
  valores_omitidos?: number;
}

export interface ResumoClinico {
  /** Ausente em links v1. Quem lê assume 1. */
  versao?: number;
  gerado_em: string;
  paciente: { nome: string | null; idade: number | null };
  alergias: Array<{ substancia: string; reacao: string | null; gravidade: string | null }>;
  medicamentos: Array<{ nome: string; dosagem: string | null; frequencia: string | null }>;
  condicoes: Array<{ nome: string; desde: string | null }>;
  exames: ExameResumo[];
  adesao_30d: number | null;
}

/**
 * Teto de marcadores por exame.
 *
 * Um hemograma completo tem ~25 linhas; um perfil metabólico ampliado passa de 40. O teto
 * existe contra saída patológica do modelo (uma lista de 900 itens que estouraria o JSONB
 * e a rede do consultório), não contra o laudo real — por isso é generoso, e por isso o
 * que sobra é CONTADO em `valores_omitidos` em vez de desaparecer.
 */
export const MAX_VALORES_POR_EXAME = 60;

/** Texto que serve como rótulo/valor: string não-vazia, ou número. */
function textoDe(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * `findings` (JSONB livre) → lista de marcadores.
 *
 * A coluna é `jsonb` e quem escreve é um LLM: o contrato da tool pede
 * `[{marker, value, unit, reference}]`, mas o que chega já veio como objeto solto
 * (`{Hemoglobina: "13,5"}`), como lista de strings, e com as chaves em português. Leitor
 * tolerante, como o `zpro-normalize`: reconhece as variantes conhecidas e **ignora o que
 * não entende** em vez de inventar um marcador. Marcador sem valor não é dado clínico —
 * é ruído, e ruído numa página que um médico lê às pressas é pior que uma linha a menos.
 */
export function normalizarValores(findings: unknown): { valores: ValorExame[]; omitidos: number } {
  const brutos: ValorExame[] = [];

  const doObjeto = (o: Record<string, unknown>): ValorExame | null => {
    const marcador =
      textoDe(o['marker']) ?? textoDe(o['marcador']) ?? textoDe(o['name']) ??
      textoDe(o['nome']) ?? textoDe(o['label']) ?? textoDe(o['exam']) ?? textoDe(o['key']);
    const valor = textoDe(o['value']) ?? textoDe(o['valor']) ?? textoDe(o['result']) ?? textoDe(o['resultado']);
    if (!marcador || !valor) return null;
    return {
      marcador,
      valor,
      unidade: textoDe(o['unit']) ?? textoDe(o['unidade']) ?? null,
      referencia:
        textoDe(o['reference']) ?? textoDe(o['referencia']) ?? textoDe(o['ref']) ??
        textoDe(o['reference_range']) ?? textoDe(o['faixa']) ?? null,
    };
  };

  if (Array.isArray(findings)) {
    for (const item of findings) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const p = doObjeto(item as Record<string, unknown>);
        if (p) brutos.push(p);
      }
      // String solta na lista não vira marcador: sem nome, não há o que comparar nem
      // plotar. Ela já está no `summary` do exame, que a página mostra por inteiro.
    }
  } else if (findings && typeof findings === 'object') {
    for (const [k, v] of Object.entries(findings as Record<string, unknown>)) {
      const marcador = k.replace(/_/g, ' ').trim();
      if (!marcador) continue;
      // `{Hemoglobina: {value: '13,5', unit: 'g/dL'}}` — o aninhado também é reconhecido.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const p = doObjeto({ marker: marcador, ...(v as Record<string, unknown>) });
        if (p) brutos.push(p);
        continue;
      }
      const valor = textoDe(v);
      if (valor) brutos.push({ marcador, valor, unidade: null, referencia: null });
    }
  }

  return {
    valores: brutos.slice(0, MAX_VALORES_POR_EXAME),
    omitidos: Math.max(0, brutos.length - MAX_VALORES_POR_EXAME),
  };
}

/**
 * Idade a partir da data de nascimento.
 *
 * O resumo mostra IDADE e não a data: é o que o médico usa para decidir, e é menos
 * identificante que a data exata numa página que pode ser encaminhada adiante.
 */
export function idadeEm(birthDate: string | null | undefined, nowMs: number): number | null {
  if (!birthDate) return null;
  const nasc = Date.parse(birthDate);
  if (!Number.isFinite(nasc)) return null;
  const anos = (nowMs - nasc) / (365.2425 * 86_400_000);
  return anos >= 0 && anos < 130 ? Math.floor(anos) : null;
}

/**
 * As colunas de `user_exam_results` que o resumo precisa — **em um lugar só**.
 *
 * `findings` está aqui porque ele é o exame: sem ele, `normalizarValores` recebe `undefined`
 * e todo link congela `valores: []`, o que apaga em silêncio a tabela de marcadores, os
 * gráficos, a faixa de referência e os selos "↑ acima da faixa" na página do médico. Um
 * select escrito à mão em cada chamador é exatamente como essa coluna sumiu de um deles sem
 * ninguém notar: quem monta resumo importa esta constante em vez de listar colunas.
 *
 * Chamadores: `routes/app/shares.ts` (criação do link) e `scripts/verify-share-link.ts`.
 */
export const COLUNAS_EXAME_RESUMO = 'exam_type, title, exam_date, summary, findings';

/**
 * O que entra no resumo — e o que fica de fora.
 *
 * Fica de fora, de propósito: telefone, CPF, endereço, o histórico de conversas e a
 * memória. O médico precisa do quadro clínico, não da vida do paciente; e esta página
 * pode acabar encaminhada. Menos dado exposto, menos dano se o link circular.
 */
export function montarResumo(
  dados: {
    user: { preferred_name?: string | null; full_name?: string | null; birth_date?: string | null; adherence_score_30d?: number | null };
    alergias: Array<{ substance: string; reaction?: string | null; severity?: string | null }>;
    medicamentos: Array<{ medication_name: string; dosage?: string | null; frequency?: string | null }>;
    condicoes: Array<{ name: string; onset_date?: string | null }>;
    /**
     * `findings` é opcional só para não quebrar links de formatos antigos relidos daqui —
     * **não é permissão para o chamador deixar de trazer a coluna**. Ausente vira lista
     * vazia, e lista vazia é um resumo sem nenhum marcador: nada de tabela, nada de
     * gráfico, nada de faixa de referência. Selecione com `COLUNAS_EXAME_RESUMO`.
     */
    exames: Array<{ exam_type: string; title?: string | null; exam_date?: string | null; summary?: string | null; findings?: unknown }>;
  },
  nowMs: number,
): ResumoClinico {
  return {
    versao: RESUMO_VERSAO,
    gerado_em: new Date(nowMs).toISOString(),
    paciente: {
      nome: dados.user.preferred_name ?? dados.user.full_name ?? null,
      idade: idadeEm(dados.user.birth_date, nowMs),
    },
    alergias: dados.alergias.map((a) => ({
      substancia: a.substance,
      reacao: a.reaction ?? null,
      gravidade: a.severity ?? null,
    })),
    medicamentos: dados.medicamentos.map((m) => ({
      nome: m.medication_name,
      dosagem: m.dosage ?? null,
      frequencia: m.frequency ?? null,
    })),
    condicoes: dados.condicoes.map((c) => ({ nome: c.name, desde: c.onset_date ?? null })),
    exames: dados.exames.slice(0, 10).map((e) => {
      const { valores, omitidos } = normalizarValores(e.findings);
      return {
        tipo: e.title?.trim() || e.exam_type,
        data: e.exam_date ?? null,
        resumo: e.summary ?? null,
        valores,
        valores_omitidos: omitidos,
      };
    }),
    adesao_30d: dados.user.adherence_score_30d ?? null,
  };
}
