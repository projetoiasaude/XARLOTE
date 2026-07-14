/**
 * Registro dos TEMPLATES (HSM) do WhatsApp oficial — Fase 6.
 *
 * O 2º número (Xarlote → farmácia/clínica via zpro/WABA) faz DISPARO ATIVO: a
 * PRIMEIRA mensagem abre uma nova janela de conversa, e a Meta SÓ permite abrir
 * janela com um TEMPLATE pré-aprovado (texto livre proativo = rejeitado/ban).
 * Depois que o estabelecimento responde, a janela de 24h abre e a Xarlote volta a
 * mandar texto livre normalmente. Por isso: **template só na abertura fria**.
 *
 * ⚠️ ORDEM DAS VARIÁVEIS É SAGRADA: a Meta aprova o template com slots fixos
 * ({{1}}, {{2}}, …). Trocar a ordem aqui = mensagem entregue errada (ou rejeitada).
 * NUNCA reordene sem reaprovar na Meta.
 *
 * ⚠️ NOMES x AMBIENTE: o `name` é o nome aprovado na Meta. Como os nomes/idioma
 * exatos podem variar do que está aqui, são sobreponíveis por env
 * (`ZPRO_TEMPLATE_<KEY>` e `ZPRO_TEMPLATE_LANG`) — assim o fundador ajusta sem
 * mexer no código. `humanize()` gera o texto legível usado como (a) conteúdo
 * persistido no histórico/dashboard e (b) fallback de TEXTO quando o envio do
 * template falha.
 *
 * Gate de segurança: nada disso dispara enquanto `WHATSAPP_TEMPLATES_ENABLED`
 * !== 'true' (ver `templatesEnabled()`). Default = OFF.
 */

export type TemplateKey = 'pharmacy_quote' | 'clinic_outreach' | 'general';

export interface TemplatePayload {
  /** nome aprovado na Meta */
  name: string;
  /** código de idioma WABA (ex.: "pt_BR") */
  language: string;
  /** variáveis do corpo na ORDEM dos slots {{1}}, {{2}}, … */
  variables: string[];
}

interface TemplateDef {
  /** nome default aprovado na Meta — sobreponível por env ZPRO_TEMPLATE_<KEY> */
  defaultName: string;
  /** quantas variáveis o corpo aprovado tem */
  varCount: number;
  /** monta o texto humano (fallback de texto + conteúdo persistido) a partir das vars */
  humanize: (vars: string[]) => string;
}

// ⚠️ Os textos de humanize() abaixo são CÓPIA EXATA do corpo aprovado na Meta
// (idioma pt_BR). Precisam bater porque: (a) é o texto que o WhatsApp renderiza ao
// disparar o template (Meta preenche {{n}}); (b) humanize() é o que persistimos no
// histórico e usamos como fallback de texto. NÃO altere sem reaprovar na Meta.
const REGISTRY: Record<TemplateKey, TemplateDef> = {
  // cotacao_medicamento_2 · {{1}} = item(ns)+qtd · {{2}} = região/entrega
  // Template HUMANIZADO (08/07): SEM auto-apresentação ("aqui é a Xarlote") — objetivo é a
  // farmácia quase não perceber que fala com uma IA. Corpo Meta byte-a-byte igual ao humanize.
  pharmacy_quote: {
    defaultName: 'cotacao_medicamento_2',
    varCount: 2,
    humanize: ([item, region]) =>
      `Oi, tudo bem? Você tem ${item ?? ''} disponível? É para entregar ${region ?? ''}. Consegue me passar o preço e o prazo de entrega, por favor?`,
  },
  // atendimento_clinica · {{1}} = a necessidade INTEIRA (frase): "uma consulta de
  // cardiologia", "um exame de sangue (hemograma completo)", "uma sessão de fisioterapia".
  // ✅ APROVADO. Cobre consulta/exame/procedimento.
  clinic_outreach: {
    defaultName: 'atendimento_clinica',
    varCount: 1,
    humanize: ([necessidade]) =>
      `Oi, tudo bem? Aqui é a Xarlote, assistente de saúde. Estou ajudando um paciente que precisa de ${necessidade ?? ''} e gostaria de saber o valor e a disponibilidade de horário. Vocês conseguem me ajudar, por favor?`,
  },
  // contato_geral · {{1}} = o assunto (frase livre) · ✅ APROVADO · coringa "resolve tudo"
  general: {
    defaultName: 'contato_geral',
    varCount: 1,
    humanize: ([assunto]) =>
      `Oi, tudo bem? Aqui é a Xarlote, assistente de saúde. Estou ajudando um cliente e preciso falar com vocês sobre ${assunto ?? ''}. Vocês conseguem me ajudar com isso? Fico no aguardo, obrigada!`,
  },
};

/** Feature flag global — disparo de template só acontece quando explicitamente ligado. */
export function templatesEnabled(): boolean {
  return process.env['WHATSAPP_TEMPLATES_ENABLED'] === 'true';
}

// ─── Re-engajamento do USUÁRIO fora da janela 24h (incidente Elizabet 13/07) ──
// Na perna oficial, texto livre fora de 24h é rejeitado pela Meta → lembrete a usuário
// mudo nunca chega. Este HSM (patient-facing) reabre a conversa. ⚠️ PRECISA SER APROVADO
// NA META e ligado via ZPRO_TEMPLATE_REENGAGE_APPROVED=true. Corpo a submeter (pt_BR, 1 var):
//   "Oi {{1}}! Aqui é a Xarlote, sua assistente de saúde. Tenho um lembrete de saúde
//    importante pra te passar. É só me responder por aqui que eu te envio na hora. Cuida bem! 💙"
export function reengageTemplateEnabled(): boolean {
  return process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] === 'true';
}

export function buildReengageTemplate(firstName: string): { name: string; language: string; variables: string[]; text: string } {
  const nome = (firstName || 'tudo bem').replace(/\s+/g, ' ').trim().slice(0, 60) || 'tudo bem';
  const text = `Oi ${nome}! Aqui é a Xarlote, sua assistente de saúde. Tenho um lembrete de saúde importante pra te passar. É só me responder por aqui que eu te envio na hora. Cuida bem! 💙`;
  return {
    name: process.env['ZPRO_TEMPLATE_REENGAGE']?.trim() || 'reengajamento_lembrete',
    language: templateLanguage(),
    variables: [nome],
    text,
  };
}

/** cotacao_medicamento já foi aprovado na Meta? (até lá, farmácia usa o coringa). */
export function pharmacyTemplateApproved(): boolean {
  return process.env['ZPRO_TEMPLATE_COTACAO_APPROVED'] === 'true';
}

/**
 * Escolhe o template da ABERTURA FRIA de farmácia. cotacao_medicamento (dedicado,
 * 2 vars) ainda está EM APROVAÇÃO na Meta — então, por padrão, a farmácia usa o
 * coringa contato_geral (aprovado, 1 var: assunto), montando o assunto no formato
 * que o fundador validou ("um orçamento de X para entrega na região Y"). Assim o
 * fluxo de farmácia JÁ funciona hoje. Quando o dedicado for aprovado, é só setar
 * ZPRO_TEMPLATE_COTACAO_APPROVED=true e ele passa a usar cotacao_medicamento.
 */
export function pharmacyColdOpen(item: string, region: string): { key: TemplateKey; variables: string[] } {
  if (pharmacyTemplateApproved()) {
    return { key: 'pharmacy_quote', variables: [item, region] };
  }
  return { key: 'general', variables: [`um orçamento de ${item} para entrega na região ${region}`] };
}

function templateName(key: TemplateKey): string {
  const envKey = `ZPRO_TEMPLATE_${key.toUpperCase()}`;
  return process.env[envKey]?.trim() || REGISTRY[key].defaultName;
}

function templateLanguage(): string {
  return process.env['ZPRO_TEMPLATE_LANG']?.trim() || 'pt_BR';
}

/** Texto humano do template (fallback de texto + conteúdo persistido no histórico). */
export function humanizeTemplate(key: TemplateKey, variables: string[]): string {
  return REGISTRY[key].humanize(variables).replace(/\s+/g, ' ').trim();
}

/**
 * Monta o payload pronto pra envio. LANÇA se a contagem de variáveis não bate com
 * o template aprovado — proteção contra mandar slot a mais/menos (a Meta rejeita).
 */
export function buildTemplatePayload(key: TemplateKey, variables: string[]): TemplatePayload {
  const def = REGISTRY[key];
  if (variables.length !== def.varCount) {
    throw new Error(
      `template "${key}" espera ${def.varCount} variável(is), recebeu ${variables.length} — ordem/contagem dos slots {{n}} precisa bater com a Meta`,
    );
  }
  // LIMPA cada variável ANTES de validar/enviar: a Meta rejeita parâmetro em branco,
  // com quebra de linha, ou > ~1024 chars. Colapsa espaços/newlines, trima e limita a
  // 900. Validamos o valor JÁ LIMPO (um " " vira "" e é barrado) e enviamos o limpo.
  const cleaned = variables.map((v) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 900) : '',
  );
  if (cleaned.some((v) => v === '')) {
    throw new Error(`template "${key}": variável vazia — a Meta rejeita parâmetro em branco`);
  }
  return { name: templateName(key), language: templateLanguage(), variables: cleaned };
}
