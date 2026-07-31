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
// Na perna oficial, texto livre fora de 24h é rejeitado pela Meta → lembrete a usuário mudo
// nunca chega. Este HSM (patient-facing, no número da XARLOTE) reabre a conversa.
// Ligado por ZPRO_TEMPLATE_REENGAGE_APPROVED=true.
//
// TEMPLATE ATIVO NA META = `lembrete_compromisso` (Utilidade, pt_BR). ⚠️ NÃO é o
// `reengajamento_lembrete` (esse nunca ficou ativo → `ERR_SEND_TEMPLATE` em TODO envio, o que
// deixou reativação e lembrete-fora-de-janela mudos até 21/07). Sobreponível por ZPRO_TEMPLATE_REENGAGE.
// CORPO APROVADO (pt_BR, **2 variáveis**) — cópia EXATA, não alterar sem reaprovar:
//   Oii, {{1}}! Aqui é a Xarlote,
//
//   {{2}}
//
//   Tô por aqui com você pro que precisar, é só me responder nesta conversa. 💜
//
// {{1}} = como chamar a pessoa ("Dona Maria"). {{2}} = o MOTIVO, em 1 frase, que muda por
// situação (medicação, consulta, pós-consulta, renovação, sumiço) — ver reengageReason*().
export function reengageTemplateEnabled(): boolean {
  return process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] === 'true';
}

/**
 * BACK-OFF do template de re-engajamento por tempo de silêncio (auditoria 20/07).
 *
 * O template de re-engajamento é um HSM PAGO e cada disparo é um convite a bloquear o número.
 * Antes o intervalo mínimo era fixo (~1x/dia) — então um paciente mudo há semanas recebia o
 * mesmo "Aqui é a Xarlote… tô por aqui" TODO santo dia, no vazio, custando por envio e sem
 * ninguém pra receber. Caso Antônia (muda 5+ dias, 10 lembretes/dia): template diário perpétuo.
 *
 * Regra: quanto mais tempo mudo, MENOS frequente o toque (a pessoa claramente não está lá):
 *   silêncio  < 3 dias → 20h  (≈ diário — ainda "quente", vale tentar todo dia trazer de volta)
 *   silêncio 3–7 dias  → 48h  (a cada 2 dias)
 *   silêncio 7–14 dias → 72h  (a cada 3 dias)
 *   silêncio > 14 dias → 7 dias (semanal — desengajamento profundo, para de queimar template)
 *
 * NÃO pausa o LEMBRETE em si (remédio de paciente silencioso é o que NÃO se auto-pausa —
 * fail-safe pró-cuidado): o espelho no app/dashboard continua; só o HSM pago recua.
 */
export function reengageIntervalMs(silentMs: number, critical = false): number {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const days = silentMs / DAY;
  const base = days < 3 ? 20 * HOUR
    : days < 7 ? 48 * HOUR
    : days < 14 ? 72 * HOUR
    : 7 * DAY;
  // 💊 TETO PARA MEDICAÇÃO/CONSULTA (auditoria 27/07 — caso Arthur, Neblock 5mg).
  // O recuo por silêncio existe pra não queimar template PAGO com quem claramente sumiu —
  // e faz todo sentido pra hidratação. Mas o Arthur está mudo há semanas E toma
  // anti-hipertensivo: o back-off o jogou em 1 tentativa a cada 7 DIAS, e o template é o
  // ÚNICO canal que resta quando a janela de 24h está fechada. Resultado real: 100% dos
  // lembretes dele bloqueados por 2 dias seguidos. Pra remédio/consulta o custo do template
  // é irrelevante perto do custo de uma dose perdida — segura em 1×/dia, no máximo.
  return critical ? Math.min(base, 24 * HOUR) : base;
}

/**
 * Sanitiza um valor pra variável de template da Meta: sem quebra de linha/tab e sem
 * espaços múltiplos (a API REJEITA o parâmetro com esses caracteres) + teto de tamanho.
 */
function templateVar(s: string, max = 300): string {
  return (s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/** Motivo ({{2}}) quando a pessoa some sem contexto específico (reativação pura). */
export const REENGAGE_REASON_SILENT =
  'Faz uns dias que a gente não conversa e você ficou na minha cabeça. Está tudo bem por aí?';

/**
 * A partir de quantos dias de silêncio o motivo passa a PEDIR resposta (decisão do
 * fundador 26/07). Antes de 2 dias a pessoa ainda está "quente" — o lembrete seco basta.
 */
export const SILENT_ASK_DAYS = 2;

/**
 * Prioridade do lembrete na disputa pelo ÚNICO template disponível quando a janela de
 * 24h está fechada (auditoria 26/07). Antes o slot ia pro PRIMEIRO vencido do tick, então
 * "beber água às 8h" consumia o template que o anti-hipertensivo das 7h precisava — o
 * Arthur ficou 2 dias sem NENHUM lembrete do Neblock. Remédio e consulta ganham sempre.
 */
export function reminderTemplatePriority(type?: string | null): number {
  switch (type) {
    case 'medication': return 3;
    case 'appointment': return 2;
    case 'sleep': return 1;
    default: return 0; // hydration, exercise, custom
  }
}

/**
 * Pedido de resposta ({{2}}, sufixo) pra quem está mudo há ≥ SILENT_ASK_DAYS.
 *
 * Por que existe: fora da janela de 24h a Xarlote só entrega UM template por vez — e a
 * janela só REABRE quando o paciente responde (regra da Meta: template do negócio não
 * abre janela). Sem resposta, todos os outros lembretes do dia morrem. Então o template
 * precisa fazer o trabalho de trazer a pessoa de volta, não só avisar.
 *
 * Tom: breve e objetivo, explicando em UMA frase por que responder importa (a Xarlote só
 * consegue acompanhar a adesão se a pessoa confirmar). Nunca culpado, nunca sermão.
 */
function replyAskFor(type?: string | null): string {
  switch (type) {
    case 'medication':
      return ' Me responde aqui quando tomar? É assim que eu consigo acompanhar se o tratamento tá em dia.';
    case 'appointment':
      return ' Me responde aqui pra eu saber que você viu? Assim eu consigo te acompanhar direito.';
    default:
      return ' Me responde aqui, nem que seja um "ok"? Assim eu consigo acompanhar de perto e te ajudar melhor.';
  }
}

/**
 * Tira do TÍTULO a hora que o `whenLabel` já diz — e só ela.
 *
 * Ao vivo 30/07: "Passei pra te lembrar hoje às 16h: Água 16h." O paciente cria o lembrete
 * e nomeia com o horário ("Água 16h", "Remédio 8h30"), o que é natural; o template então
 * repetia a mesma hora duas vezes na mesma frase.
 *
 * Conservador de propósito: só remove quando a hora do título é a MESMA do rótulo e está no
 * fim (onde é sufixo, não conteúdo). "Insulina 30 UI às 8h" com whenLabel "hoje às 20h" fica
 * intacto — hora diferente é informação clínica, não redundância.
 */
export function stripRedundantTime(title: string, whenLabel?: string | null): string {
  const t = (title ?? '').trim();
  if (!t || !whenLabel) return t;
  // 🛑 POSOLOGIA NÃO É SUFIXO DE HORÁRIO. "Dipirona 6/6h" com lembrete às 6h viraria
  // "Dipirona 6/" — texto quebrado, dentro de um template pago, sobre remédio. O intervalo
  // é informação clínica: na presença dele, não se mexe no título.
  if (/(\d+\s*\/\s*\d+\s*h|de\s+\d+\s+em\s+\d+\s*h|a\s+cada\s+\d+\s*h)/i.test(t)) return t;
  const norm = (h: string, m?: string) => `${Number(h)}:${(m ?? '0').padStart(2, '0').slice(0, 2)}`;
  const labelHour = /(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i.exec(whenLabel);
  if (!labelHour) return t;
  const target = norm(labelHour[1]!, labelHour[2]);
  // Hora no FIM do título (com ou sem "às"), possivelmente seguida de pontuação.
  const tail = /\s*(?:[àa]s\s*)?(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*[.,;]?$/i.exec(t);
  if (!tail || norm(tail[1]!, tail[2]) !== target) return t;
  const stripped = t.slice(0, tail.index).replace(/[\s\-–—:,]+$/, '').trim();
  // Se sobrou só a hora (título era "16h"), preserva o original — melhor repetir que ficar vazio.
  return stripped || t;
}

/**
 * Motivo ({{2}}) a partir de um LEMBRETE que não pôde ser entregue. Frase única, sem
 * saudação (a saudação já está no {{1}}) e sem quebra de linha — no estilo aprovado.
 * `whenLabel` ex.: "hoje às 7h", "amanhã às 16h30".
 * `silentDays`: dias sem resposta. A partir de SILENT_ASK_DAYS o motivo PEDE resposta
 * (ver replyAskFor) — sem isso o paciente mudo nunca reabre a janela e perde todo o resto.
 */
export function reengageReasonForReminder(
  reminder: { type?: string | null; title?: string | null },
  whenLabel?: string | null,
  silentDays?: number | null,
): string {
  const titulo = templateVar(stripRedundantTime(reminder.title ?? '', whenLabel), 90) || 'seu lembrete de saúde';
  const quando = whenLabel ? ` ${templateVar(whenLabel, 40)}` : '';
  // Formato de RÓTULO (com dois-pontos), NÃO "tomar o seu {título}": o título pode ser um
  // NOME ("Neblock 5mg") OU uma FRASE DE AÇÃO ("Passar remédio nas sobrancelhas") — e
  // "tomar o seu Passar remédio nas sobrancelhas" soa robótico (visto ao vivo 20/07, Antônia).
  // O dois-pontos funciona pros dois casos.
  let base: string;
  switch (reminder.type) {
    case 'medication':
      base = `Passei pra te lembrar do seu remédio${quando}: ${titulo}. Não vale esquecer, tá?`;
      break;
    case 'appointment':
      base = `Passando pra lembrar do seu compromisso${quando}: ${titulo}.`;
      break;
    default:
      base = `Passei pra te lembrar${quando}: ${titulo}.`;
  }
  // Mudo há ≥2 dias: acrescenta o pedido de resposta (é o que reabre a janela).
  const ask = (silentDays ?? 0) >= SILENT_ASK_DAYS ? replyAskFor(reminder.type) : '';
  // O teto da variável é 300 chars. Se o título for longo, o corte cairia EM CIMA do pedido
  // de resposta ("…se o tratamento tá em d") — justamente a frase que existe pra trazer o
  // paciente de volta. Então encurtamos o TÍTULO e preservamos o pedido inteiro.
  const full = `${base}${ask}`;
  if (ask && full.length > 300) {
    const room = Math.max(20, titulo.length - (full.length - 300) - 1);
    const shortTitle = `${titulo.slice(0, room).trimEnd()}…`;
    return templateVar(`${base.replace(titulo, shortTitle)}${ask}`);
  }
  return templateVar(full);
}

export function buildReengageTemplate(
  firstName: string,
  reason: string,
): { name: string; language: string; variables: string[]; text: string } {
  const nome = templateVar(firstName || 'tudo bem', 60) || 'tudo bem';
  const motivo = templateVar(reason) || REENGAGE_REASON_SILENT;
  // Espelho local (o que fica no app/dashboard) = o corpo aprovado já montado, BYTE-A-BYTE
  // igual ao que a Meta renderiza (senão o dashboard mostra um texto e o paciente lê outro).
  // Template ATIVO na Meta = `lembrete_compromisso` (o `reengajamento_lembrete` nunca esteve
  // ativo → ERR_SEND_TEMPLATE em todo envio, achado 21/07). Corpo aprovado: "Oii," + 💜 no fim.
  const text = `Oii, ${nome}! Aqui é a Xarlote,\n\n${motivo}\n\nTô por aqui com você pro que precisar, é só me responder nesta conversa. 💜`;
  return {
    name: process.env['ZPRO_TEMPLATE_REENGAGE']?.trim() || 'lembrete_compromisso',
    language: templateLanguage(),
    variables: [nome, motivo],
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
