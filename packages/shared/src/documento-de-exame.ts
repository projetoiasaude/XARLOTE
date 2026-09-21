/**
 * DOCUMENTO DE EXAME — o que é, o que tem dentro, e o que pode ir pro prontuário.
 *
 * ─── O QUE ACONTECEU (Ciro, 18/09/2026) ────────────────────────────────────────
 * Foto do protocolo de retirada → gravada como "resultado de RM Crânio" (2×). PDF do laudo
 * de 12 páginas → "não consegui ler". O modelo decidia sozinho o que era cada coisa e o que
 * guardar, e "Guardei seu resultado" saiu sem laudo nenhum.
 *
 * ─── AS REGRAS ─────────────────────────────────────────────────────────────────
 * 1. A CLASSIFICAÇÃO é determinística, sobre o texto: laudo (tem marcador com valor e
 *    referência, ou conclusão de imagem), protocolo (código/senha/previsão de entrega, sem
 *    achado), receita (posologia), pedido (solicito/pedido de exame), outro.
 * 2. O que o modelo extrai passa por VERIFICAÇÃO: cada valor precisa existir no texto do
 *    documento. Valor que não está no laudo não entra no prontuário — mesmo que o modelo
 *    jure que leu. É o anti-alucinação que não depende de prompt.
 * 3. O bloco que o modelo do turno lê diz o FATO ("guardado como X com N marcadores") ou o
 *    contrário ("é protocolo; resultado previsto em …"). Ele comenta; não decide se guarda.
 *
 * PURO: sem I/O, sem modelo. Quem chama o modelo de extração é `ingestao-de-exame.ts`.
 */

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export type TipoDeDocumento = 'laudo' | 'protocolo' | 'receita' | 'pedido' | 'outro';

export interface ClassificacaoDeDocumento {
  tipo: TipoDeDocumento;
  /** Sinais que decidiram — pra log e pra teste, nunca pro paciente. */
  sinais: string[];
  /** Previsão de liberação lida do protocolo (ISO com fuso de Brasília), quando houver. */
  previsaoLiberacao?: string | null;
  laboratorio?: string | null;
}

const RE_REFERENCIA = /\b(valor(?:es)? de referencia|intervalo de referencia|referencia|ref\.?|vr:?|faixa)\b/;
const RE_UNIDADE = /\b\d+[.,]?\d*\s?(mg\/dl|g\/dl|mmol\/l|ui\/l|u\/l|ng\/ml|pg\/ml|mcg\/dl|µg\/dl|ug\/dl|meq\/l|mui\/ml|%|\/mm3|\/µl|\/ul|x?10\^?\d+\/?(?:µ|u)?l|fl|pg|mm\/h|ml\/min)\b/;
const RE_MARCADOR = /\b(hemoglobina|hematocrito|hemacias|leucocitos|plaquetas|glicose|glicemia|creatinina|ureia|colesterol|triglicerid|tsh|t4|t3|hba1c|hemoglobina glicada|ferritina|vitamina d|vitamina b12|sodio|potassio|calcio|tgo|tgp|ast|alt|ggt|bilirrubina|psa|acido urico|pcr|vhs|hcg|ldl|hdl|vldl|albumina|amilase|lipase|cortisol|prolactina|testosterona|estradiol|fsh|lh|insulina|magnesio|fosforo|zinco|ferro|transferrina|eas|urocultura|hemograma|coagulograma|inr|ttpa|tap)\b/;
const RE_CONCLUSAO_IMAGEM = /\b(conclusao|impressao diagnostica|impressao|opiniao|laudo|achados|nao ha (?:sinais|evidencias)|sem (?:alteracoes|sinais)|ausencia de|presenca de|dimensoes|contornos|ecotextura|sinal|realce|parenquima|derrame|nodulo|cisto|calcificac)\b/;
const RE_EXAME_IMAGEM = /\b(ressonancia|tomografia|ultrassonografia|ultrassom|ecografia|radiografia|raio-?x|mamografia|densitometria|eletrocardiograma|ecocardiograma|eletroencefalograma|eeg|ecg|doppler|endoscopia|colonoscopia)\b/;
const RE_PROTOCOLO = /\b(protocolo|senha de acesso|senha:|login:|previsao de entrega|entrega prevista|previsao de liberacao|data de entrega|resultado(?:s)? (?:disponive\w*|estara|ficara|liberad\w*)|retirada|retirar|acesse (?:o site|www)|resultados? on-?line)\b/;
const RE_RECEITA = /\b(uso oral|uso topico|uso continuo|uso interno|posologia|tomar \d|\d+ ?(?:comprimido|capsula|gota|ml)s? (?:ao dia|por dia|de \d+ em \d+|a cada)|receituario|prescricao|prescrevo|receita medica)\b/;
const RE_PEDIDO = /\b(solicito|solicitacao de exame|pedido de exame|guia de (?:exame|sadt)|hipotese diagnostica|cid ?[a-z]\d{2})\b/;

/** "previsão de entrega 21/09/2026 a partir das 17:30" → 2026-09-21T17:30:00-03:00 */
export function previsaoDeLiberacaoDoTexto(texto: string): string | null {
  const f = fold(texto);
  const m = /(?:previsao|entrega|liberac\w+|disponive\w+|resultado)[^.\n]{0,60}?(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^.\n]{0,40}?(\d{1,2})[:h](\d{2}))?/.exec(f);
  if (!m) return null;
  const [, d, mo, a, h, mi] = m;
  const hh = h ? String(+h).padStart(2, '0') : '09';
  const mm = mi ?? '00';
  const iso = `${a}-${String(+mo!).padStart(2, '0')}-${String(+d!).padStart(2, '0')}T${hh}:${mm}:00-03:00`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export function classificarTextoDeDocumento(texto: string | null | undefined): ClassificacaoDeDocumento {
  const f = fold(texto ?? '');
  const sinais: string[] = [];
  if (!f.trim()) return { tipo: 'outro', sinais: ['vazio'] };

  const marcadores = (f.match(RE_MARCADOR) ?? []).length;
  const unidades = (f.match(new RegExp(RE_UNIDADE.source, 'g')) ?? []).length;
  const temReferencia = RE_REFERENCIA.test(f);
  const temConclusao = RE_CONCLUSAO_IMAGEM.test(f) && RE_EXAME_IMAGEM.test(f);
  const temProtocolo = RE_PROTOCOLO.test(f);
  const temReceita = RE_RECEITA.test(f);
  const temPedido = RE_PEDIDO.test(f);

  if (marcadores >= 2 && (unidades >= 2 || temReferencia)) sinais.push(`marcadores=${marcadores}`, `unidades=${unidades}`);
  if (temConclusao) sinais.push('conclusao_de_imagem');
  const laudo = sinais.length > 0;
  if (laudo) return { tipo: 'laudo', sinais };

  if (temReceita && !temProtocolo) return { tipo: 'receita', sinais: ['posologia'] };
  if (temPedido && !temProtocolo) return { tipo: 'pedido', sinais: ['solicitacao'] };
  if (temProtocolo) {
    const previsao = previsaoDeLiberacaoDoTexto(texto ?? '');
    return { tipo: 'protocolo', sinais: ['protocolo'], previsaoLiberacao: previsao };
  }
  return { tipo: 'outro', sinais: [] };
}

export interface AchadoExtraido { marker: string; value: string; unit?: string; reference?: string }

export interface ExameExtraido {
  exam_type: string;
  title: string;
  exam_date: string | null;
  summary: string | null;
  findings: AchadoExtraido[];
  confidence: number;
  laboratorio?: string | null;
}

/** O JSON cru do modelo vira um `ExameExtraido` com limites — ou null se não tem o mínimo. */
export function normalizarExtraido(j: unknown): ExameExtraido | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (!o['title'] || !o['exam_type']) return null;
  const findings = Array.isArray(o['findings']) ? (o['findings'] as Array<Record<string, unknown>>).slice(0, 120).map((f) => ({
    marker: String(f?.['marker'] ?? '').trim().slice(0, 120),
    value: String(f?.['value'] ?? '').trim().slice(0, 80),
    ...(f?.['unit'] ? { unit: String(f['unit']).trim().slice(0, 40) } : {}),
    ...(f?.['reference'] ? { reference: String(f['reference']).trim().slice(0, 120) } : {}),
  })).filter((f) => f.marker && f.value) : [];
  const data = typeof o['exam_date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o['exam_date']) ? o['exam_date'] : null;
  return {
    exam_type: String(o['exam_type']).slice(0, 40),
    title: String(o['title']).slice(0, 200),
    exam_date: data,
    summary: o['summary'] ? String(o['summary']).slice(0, 1000) : null,
    findings,
    confidence: typeof o['confidence'] === 'number' ? Math.max(0, Math.min(1, o['confidence'])) : 0.8,
    laboratorio: o['laboratorio'] ? String(o['laboratorio']).slice(0, 120) : null,
  };
}

/** Normaliza um valor pra comparar: "13,2" ≡ "13.2" ≡ "13, 2"; "4.80" ≡ "4,80". */
function chaveDeValor(v: string): string {
  return fold(v).replace(/\s+/g, '').replace(/,/g, '.').replace(/[^a-z0-9.<>=+-]/g, '');
}
/** O texto inteiro, na mesma normalização — mas com um espaço entre o que era símbolo, pra "40,1 %" não colar em "36,0". */
function chaveDoTexto(t: string): string {
  return fold(t).replace(/,/g, '.').replace(/[^a-z0-9.<>=+-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Cada achado precisa EXISTIR no texto do documento. Compara o valor normalizado; se o
 * valor é só número, exige que o número apareça (com vírgula ou ponto). Um achado que o
 * modelo "leu" e o texto não tem é descartado — e a lista dos descartados vai pro log.
 */
export function verificarAchadosNoTexto(achados: AchadoExtraido[], texto: string): { mantidos: AchadoExtraido[]; descartados: AchadoExtraido[] } {
  const corpo = chaveDoTexto(texto);
  const mantidos: AchadoExtraido[] = [];
  const descartados: AchadoExtraido[] = [];
  // "6.500" (milhar) e "6500" são o mesmo número; "13.2" não é milhar. Só o ponto seguido
  // de exatamente 3 dígitos finais é separador de milhar.
  const semMilhar = (x: string) => x.replace(/\.(\d{3})(?!\d)/g, '$1');
  const corpoSemMilhar = semMilhar(corpo);
  for (const a of achados) {
    const v = chaveDeValor(a.value);
    if (!v) { descartados.push(a); continue; }
    const numero = /^[<>=]?\d+(?:\.\d+)?$/.test(v);
    const casaNumero = (val: string, txt: string) => new RegExp(`(^|[^0-9.])${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9.])`).test(txt);
    const achou = numero
      ? casaNumero(v, corpo) || casaNumero(semMilhar(v), corpoSemMilhar)
      : corpo.includes(v) || corpo.replace(/\s+/g, '').includes(v);
    (achou ? mantidos : descartados).push(a);
  }
  return { mantidos, descartados };
}

export interface ResultadoDaIngestao {
  tipo: TipoDeDocumento;
  /** Só quando guardou um resultado. */
  examId?: string | null;
  titulo?: string | null;
  examDate?: string | null;
  laboratorio?: string | null;
  achados?: AchadoExtraido[];
  descartados?: number;
  /** Só pra protocolo. */
  previsaoLiberacao?: string | null;
  /** O arquivo ficou guardado no prontuário? */
  arquivoGuardado: boolean;
  /** Texto legível pro modelo (laudo) — já cortado. */
  texto?: string | null;
  /** Do PDF: páginas, caracteres antes do corte, e se cortou. */
  paginas?: number | null;
  caracteres?: number | null;
  truncado?: boolean;
  /** Quando não deu pra ler: o motivo técnico (pra decidir o que dizer). */
  motivoIlegivel?: string | null;
  motivoNaoLido?: string | null;
}

function dataPorExtenso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  const temHora = iso.length > 10;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', ...(temHora ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(d);
}

/**
 * O que o modelo do turno lê sobre o documento. Fato, não pedido: o servidor já decidiu e
 * já gravou (ou não). O modelo interpreta e conversa.
 */
export function blocoDeIngestaoParaModelo(r: ResultadoDaIngestao, origem: 'pdf' | 'foto'): string {
  const arq = r.arquivoGuardado ? 'O arquivo está guardado no prontuário dele.' : 'ATENÇÃO: o arquivo NÃO ficou guardado (falha ao salvar) — não diga que guardou.';
  if (r.tipo === 'laudo' && r.examId) {
    const lista = (r.achados ?? []).slice(0, 60).map((a) => `${a.marker}: ${a.value}${a.unit ? ` ${a.unit}` : ''}${a.reference ? ` (ref. ${a.reference})` : ''}`).join('; ');
    return [
      `[SISTEMA — ${origem === 'pdf' ? 'PDF' : 'foto'} de EXAME já processado. GUARDADO no prontuário como "${r.titulo}"${r.examDate ? ` (exame de ${dataPorExtenso(r.examDate)})` : ''}${r.laboratorio ? `, ${r.laboratorio}` : ''}, com ${(r.achados ?? []).length} marcador(es)${r.descartados ? ` (${r.descartados} valor(es) que o leitor não confirmou no texto ficaram de fora)` : ''}. ${arq}`,
      lista ? `Marcadores gravados: ${lista}.` : '',
      'Você NÃO precisa chamar save_exam_result nem perguntar se ele quer guardar: já está guardado. Diga isso em uma linha e faça o que a seção EXAMES manda: leia, explique o que está fora da referência, dê sua leitura honesta e o próximo passo.]',
    ].filter(Boolean).join('\n');
  }
  if (r.tipo === 'laudo') {
    return `[SISTEMA — ${origem === 'pdf' ? 'PDF' : 'foto'} de EXAME lido, mas NÃO consegui gravar o resultado no prontuário agora${r.motivoNaoLido ? ` (${r.motivoNaoLido})` : ''}. ${arq} NÃO diga que guardou. Interprete o que está no texto abaixo e diga que vai tentar guardar de novo depois.]`;
  }
  if (r.tipo === 'protocolo') {
    return [
      `[SISTEMA — isto é um PROTOCOLO DE RETIRADA de exame${r.laboratorio ? ` do ${r.laboratorio}` : ''}, NÃO um resultado. Não existe achado clínico aqui e NADA foi gravado como resultado.${r.previsaoLiberacao ? ` Previsão de liberação lida no papel: ${dataPorExtenso(r.previsaoLiberacao)}.` : ''} ${arq}`,
      'O que você pode oferecer: (a) buscar o resultado no site do laboratório com o login/senha do protocolo — na data prevista, se ela é futura (fetch_lab_results com `quando` = a data lida) — SEMPRE perguntando antes; (b) ele te mandar o PDF/foto do laudo quando sair, que você lê e guarda. NUNCA diga que guardou o resultado, e NUNCA prometa que a busca vai dar certo: o servidor confere o site e confirma sozinho.]',
    ].join('\n');
  }
  if (r.tipo === 'receita') return `[SISTEMA — o documento é uma RECEITA/prescrição, não um exame. ${arq} Nada foi gravado como resultado de exame.]`;
  if (r.tipo === 'pedido') return `[SISTEMA — o documento é um PEDIDO/solicitação de exame, não um resultado. ${arq} Nada foi gravado como resultado.]`;
  return `[SISTEMA — o documento não parece laudo de exame (nem protocolo, receita ou pedido). ${arq} Nada foi gravado como resultado de exame.]`;
}
