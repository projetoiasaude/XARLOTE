/**
 * ENDEREÇO DE ENTREGA É DADO DO PEDIDO — e a escolha é da pessoa (caso Ludmila, 10/09/2026).
 *
 * A Ludmila mandou a foto da receita e "consegue cotar?". O modelo escolheu sozinho o endereço
 * salvo "trabalho" (Rua 14, Setor Sul, sem número) — ela nunca disse pra onde. Quando corrigiu
 * ("Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste"), a correção virou mensagem à farmácia e o
 * perfil continuou errado. No caminho, a Xarlote sugeriu entregar no endereço da CLÍNICA
 * impresso na receita. E a abertura pra farmácia dizia "entregar Rua 14, Lt. 20", porque o
 * extrator de setor tratou "Lt. 20" como bairro.
 *
 * Aqui: (1) o extrator de setor que ignora quadra/lote/casa/apto; (2) a checagem de que o
 * paciente MENCIONOU o endereço salvo que o modelo quer usar (consentimento pela fala).
 */

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const IGNORE_LOW = /^(regi[ãa]o|brasil|brazil|regi[ãa]o centro-oeste|mesorregi[ãa]o|microrregi[ãa]o)/i;
const IS_STREET = /^(rua|r\.?|avenida|av\.?|alameda|al\.?|travessa|tv\.?|rodovia|rod\.?|pra[çc]a|p[çc]\.?|estrada|via)\b/i;
// Complemento de endereço: nunca é bairro/setor.
const IS_UNIT = /^(qd|quadra|q\.?|lt|lote|l\.?|casa|cs|apto?|apartamento|ap\.?|bloco|bl\.?|sala|loja|cj|conj|conjunto|andar|fundos|frente|km)\b/i;
const IS_ONLY_NUMBER = /^\d+[a-zA-Z]?$/;
const IS_CEP = /^\d{5}-?\d{3}$/;
const IS_UF = /^([A-Z]{2}|Goi[áa]s|S[ãa]o Paulo|Rio de Janeiro|Minas Gerais|Bahia|Paran[áa]|Pernambuco|Cear[áa]|Par[áa]|Distrito Federal|Mato Grosso|Mato Grosso do Sul|Esp[íi]rito Santo|Santa Catarina|Rio Grande do Sul|Rio Grande do Norte|Alagoas|Sergipe|Para[íi]ba|Piau[íi]|Maranh[ãa]o|Tocantins|Acre|Amap[áa]|Amazonas|Rond[ôo]nia|Roraima)$/i;

/**
 * O BAIRRO/SETOR de um endereço completo, pra abertura com a farmácia ("é pro Setor Sul").
 * Cai pra rua se não houver setor. null pra localização por coordenadas.
 */
export function extractDeliverySector(fullAddress: string | null | undefined): string | null {
  if (!fullAddress) return null;
  if (/Localiza[çc][ãa]o compartilhada|^lat\s|coordenadas?\b/i.test(fullAddress)) return null;
  const parts = fullAddress.split(',').map((s) => s.trim()).filter(Boolean);
  let street: string | null = null;
  let sector: string | null = null;
  for (const p0 of parts) {
    // "Goiânia - Goiás" vem como uma parte só: separa cidade de UF.
    const p = p0.split(/\s+-\s+/)[0]?.trim() ?? p0;
    if (IGNORE_LOW.test(p) || IS_CEP.test(p) || IS_ONLY_NUMBER.test(p) || IS_UF.test(p) || IS_UNIT.test(p)) continue;
    if (IS_STREET.test(p)) { if (!street) street = p; continue; }
    if (!sector) { sector = p; if (street) break; }
  }
  return sector || street || null;
}

/**
 * O paciente MENCIONOU este endereço salvo (rótulo ou rua) em alguma das falas dadas?
 * "manda pra casa", "no trabalho", "mesmo endereço", "de sempre", "Rua 14" → sim.
 * Uma foto com "consegue cotar?" → não: aí a Xarlote pergunta pra onde vai.
 */
export function enderecoFoiMencionado(
  falas: Array<string | null | undefined>,
  salvo: { label: string; street?: string | null },
  opts: { propostaDaXarlote?: string | null; respostaAtual?: string | null } = {},
): boolean {
  const texto = falas.map((f) => fold(f ?? '')).join(' \n ');
  if (!texto.trim()) return false;
  const label = fold(salvo.label).trim();
  const labelRe = label ? new RegExp(`(^|[^a-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`) : null;
  if (labelRe && labelRe.test(texto)) return true;
  // sinônimos de "o de sempre"
  if (/\b(mesmo\s+endereco|endereco\s+(de\s+sempre|salvo|de\s+antes|anterior|cadastrado)|de\s+sempre|ai\s+mesmo|o\s+mesmo\s+de\s+sempre|onde\s+sempre)\b/.test(texto)) return true;
  // a rua do endereço salvo, como palavra inteira ("rua 14"). Só a RUA (até a primeira vírgula):
  // um `street` gravado com número/quadra/lote inteiro ("Rua 14, 201, Qd. B8, Lt. 20") nunca
  // apareceria literalmente na fala — e era assim que "entrega na rua 14" não contava (14/09).
  const rua = fold((salvo.street ?? '').split(',')[0] ?? '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (rua.length >= 5 && texto.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').includes(rua)) return true;
  // A Xarlote PROPÔS este endereço ("Confirmo o pedido pro trabalho, no cartão?") e o paciente
  // disse que sim ("Isso", "pode ser") — consentimento pela resposta à proposta. Só vale quando a
  // proposta cita UM rótulo (o dele), senão "isso" não escolhe nada.
  const proposta = fold(opts.propostaDaXarlote ?? '');
  const resposta = fold(opts.respostaAtual ?? '').trim();
  if (labelRe && proposta && labelRe.test(proposta) && /^(isso|sim|pode ser|pode|ok|beleza|claro|uhum|aham|confirmo|confirmado|certo|perfeito|exato|isso mesmo)[.!\s]*(?:,?\s*(xarlote|obrigad[ao]|por favor|pfv))?[.!\s]*$/.test(resposta)) {
    const outros = (proposta.match(/\b(casa|trabalho|home|work|escritorio|consultorio|faculdade|academia)\b/g) ?? []).filter((r) => r !== label);
    if (!outros.length) return true;
  }
  return false;
}

/**
 * O ENDEREÇO COMO A PESSOA DIGITOU, separado em partes — pra guardar o que ela disse, não o que
 * o mapa devolveu (caso Ludmila: "Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste" virou "Rua 14,
 * Setor Sul" sem número depois do reverse-geocode, e foi isso que ela chamou de "esse endereço
 * não está certo"). O mapa dá a coordenada; o texto dá o endereço.
 */
export interface EnderecoDigitado {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
}

const IS_SETOR = /^(setor|st\.?|bairro|jardim|jd\.?|vila|vl\.?|parque|pq\.?|residencial|res\.?|conjunto|cj\.?|condominio|cond\.?|centro|chacaras?|loteamento|nucleo|cidade|distrito)\b/i;
const STREET_WORD_ONLY = /^(rua|r\.?|avenida|av\.?|alameda|al\.?|travessa|tv\.?|rodovia|rod\.?|praca|pc\.?|estrada|via)$/;

export function parseEnderecoDigitado(texto: string | null | undefined): EnderecoDigitado {
  const out: EnderecoDigitado = { street: null, number: null, complement: null, neighborhood: null, city: null, state: null, cep: null };
  const raw = (texto ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return out;
  const cepM = /\b(\d{5})-?(\d{3})\b/.exec(raw);
  if (cepM) out.cep = `${cepM[1]}-${cepM[2]}`;
  const parts = raw.replace(/\b\d{5}-?\d{3}\b/g, '').split(/,|\s+-\s+|\n/).map((p) => p.trim()).filter(Boolean);
  const compl: string[] = [];
  for (const p0 of parts) {
    const p = p0.replace(/^(n[ºo°.]?\s*)(?=\d)/i, '').trim();
    if (!p || IGNORE_LOW.test(p)) continue;
    if (IS_UF.test(p) && p.length <= 20) { if (!out.state) out.state = p; continue; }
    if (IS_STREET.test(p) && !out.street) {
      // "Rua 14 201" / "Av. X 1000" — número colado no fim da rua
      const m = /^(.*?\S)\s+(\d+[a-zA-Z]?)$/.exec(p);
      if (m && !STREET_WORD_ONLY.test(fold(m[1] ?? '').trim())) {
        out.street = (m[1] ?? '').trim(); out.number = m[2] ?? null;
      } else out.street = p;
      continue;
    }
    if (IS_ONLY_NUMBER.test(p)) { if (!out.number && out.street) out.number = p; else compl.push(p); continue; }
    if (IS_UNIT.test(p)) { compl.push(p); continue; }
    if (IS_SETOR.test(p)) { if (!out.neighborhood) out.neighborhood = p; else if (!out.city) out.city = p; continue; }
    if (!out.street) { out.street = p; continue; }
    if (!out.neighborhood) { out.neighborhood = p; continue; }
    if (!out.city) { out.city = p; continue; }
  }
  if (compl.length) out.complement = compl.join(', ');
  return out;
}

/** Monta o endereço humano a partir das partes (pra pedido e pra farmácia). */
export function montarEnderecoHumano(e: Partial<EnderecoDigitado>): string {
  return [
    [e.street, e.number].filter(Boolean).join(', '),
    e.complement || null,
    e.neighborhood || null,
    [e.city, e.state].filter(Boolean).join(' - ') || null,
    e.cep || null,
  ].filter((p) => p && String(p).trim()).join(', ');
}

/** Endereço impresso em receita/laudo/pedido médico é da CLÍNICA — nunca vira entrega. */
export function pareceEnderecoDeClinica(texto: string | null | undefined): boolean {
  const f = fold(texto ?? '');
  return /\b(clinica|consultorio|hospital|laboratorio|receitu[aá]rio|crm|croq|cirurgia|medic[oa]|dr\.?|dra\.?)\b/.test(f);
}
