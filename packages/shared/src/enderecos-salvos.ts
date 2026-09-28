/**
 * ENDEREÇO SALVO ANOTADO DE MAIS DE UM JEITO: a Xarlote percebe, pergunta e arruma.
 *
 * Caso Ludmila, 28/09/2026: "Entregar aqui na rua 14, setor oeste". O rótulo "casa" tinha TRÊS
 * linhas — Setor Oeste com CEP e coordenada mas sem o número; Setor Oeste com o "201" enfiado
 * no campo da rua e sem coordenada; e Setor SUL, com outro CEP (resíduo do geocoder de 14/09).
 * O pedido pegou a primeira que o banco devolveu (acertou por sorte) e saiu sem o número. O
 * "trabalho" ainda tinha uma linha cujo "rua" era "CEP 74085130".
 *
 * Aqui ficam as decisões PURAS:
 *  • quais linhas são o MESMO LUGAR (mesma rua, sem divergir em número, quadra/lote, setor ou
 *    CEP) — essas se fundem numa só, completa, sem perguntar nada;
 *  • quando há LUGARES DIFERENTES pro mesmo rótulo (ou a mesma rua/quadra/lote em outro setor
 *    noutro rótulo — a assinatura do geocoder errando o bairro), a Xarlote pergunta antes de
 *    usar: com um só candidato quando a fala do paciente já aponta um, ou com as opções;
 *  • reconhecer a resposta à pergunta, pra na volta usar o escolhido e arrumar o cadastro.
 * Quem lê e escreve no banco é o handler.
 */

import { parseEnderecoDigitado, montarEnderecoHumano, type EnderecoDigitado } from './endereco-entrega.js';

export interface EnderecoSalvo {
  id: string;
  label: string | null;
  street: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  cep?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  usage_count?: number | null;
  is_default?: boolean | null;
}

/** Um lugar de verdade, com as linhas que o representam fundidas numa só. */
export interface Lugar {
  /** Linhas (ids) que são este lugar. */
  ids: string[];
  /** A linha que fica (a que tem coordenada e mais uso). */
  manter: string;
  partes: EnderecoDigitado;
  /** Pra falar com o paciente: rua, número, quadra/lote, setor. */
  texto: string;
  /** Completo, pro pedido e pra farmácia (com cidade/UF/CEP). */
  textoCompleto: string;
  coord: { lat: number; lng: number } | null;
  usos: number;
  /** Rótulos em que este lugar aparece. */
  rotulos: string[];
}

export type DiagnosticoDeEndereco =
  | { tipo: 'nenhum' }
  | { tipo: 'unico'; lugar: Lugar; /** linhas do rótulo que somem na fusão (duplicadas ou lixo) */ remover: string[] }
  | { tipo: 'conflito'; variantes: Lugar[]; /** a que a fala do paciente aponta, se só uma */ apontada: Lugar | null };

function fold(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function chaveDeRua(street: string | null | undefined): string {
  return fold(street)
    .replace(/^r\.?\s+/, 'rua ')
    .replace(/^av\.?\s+/, 'avenida ')
    .replace(/^al\.?\s+/, 'alameda ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chaveDeBairro(n: string | null | undefined): string {
  return fold(n)
    .replace(/^st\.?\s+/, 'setor ')
    .replace(/^jd\.?\s+/, 'jardim ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chaveDeComplemento(c: string | null | undefined): string {
  return fold(c)
    .replace(/\bquadra\b/g, 'qd')
    .replace(/\blote\b/g, 'lt')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function soDigitos(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/**
 * As partes de uma linha salva. As COLUNAS valem como estão — re-ler o endereço inteiro pelo
 * parser perdia informação ("S/N" virava bairro, "Portão azul" virava setor, "Rua RE 3" virava
 * rua "RE" número 3; revisão de 28/09). O parser só entra na rua que traz vírgula ("Rua 14,
 * 201, Qd. B8, Lt. 20" gravado inteiro no campo da rua), e só pra preencher coluna vazia.
 */
export function partesDoSalvo(e: EnderecoSalvo): EnderecoDigitado {
  const base: EnderecoDigitado = {
    street: e.street || null, number: e.number || null, complement: e.complement || null,
    neighborhood: e.neighborhood || null, city: e.city || null, state: e.state || null, cep: e.cep || null,
  };
  if (!e.street || !e.street.includes(',')) return base;
  const p = parseEnderecoDigitado(e.street);
  return {
    ...base,
    street: p.street ?? base.street,
    number: base.number ?? p.number,
    complement: base.complement ?? p.complement,
    neighborhood: base.neighborhood ?? p.neighborhood,
    city: base.city ?? p.city,
    state: base.state ?? p.state,
    cep: base.cep ?? p.cep,
  };
}

/** Mesma rua e mesma quadra/lote (o setor pode divergir — é o que a pergunta resolve). */
export function mesmaRuaEComplemento(a: EnderecoDigitado, b: EnderecoDigitado): boolean {
  const ca = chaveDeComplemento(a.complement);
  return chaveDeRua(a.street) === chaveDeRua(b.street) && !!ca && ca === chaveDeComplemento(b.complement);
}

/**
 * A linha serve de endereço? Com coordenada, sempre (é o pin que o pedido usa). Sem ela, precisa
 * de rua: "CEP 74085130" no campo da rua não serve; "Rua 14", "T-63" e "C-149" servem.
 */
export function enderecoValido(p: EnderecoDigitado, temCoord = false): boolean {
  if (temCoord) return true;
  const rua = chaveDeRua(p.street);
  if (!rua || /^cep(\s|$)/.test(rua)) return false;
  return /[a-z]{2,}/.test(rua) || /^[a-z]{1,3}\s?\d+/.test(rua);
}

/** Duas leituras são o MESMO LUGAR? Mesma rua e nada divergente (um campo vazio não diverge). */
export function mesmoLugar(a: EnderecoDigitado, b: EnderecoDigitado): boolean {
  if (chaveDeRua(a.street) !== chaveDeRua(b.street)) return false;
  const diverge = (x: string, y: string) => !!x && !!y && x !== y;
  if (diverge(chaveDeBairro(a.neighborhood), chaveDeBairro(b.neighborhood))) return false;
  if (diverge(chaveDeComplemento(a.complement), chaveDeComplemento(b.complement))) return false;
  if (diverge((a.number ?? '').trim().toLowerCase(), (b.number ?? '').trim().toLowerCase())) return false;
  if (diverge(soDigitos(a.cep), soDigitos(b.cep))) return false;
  return true;
}

function fundir(linhas: Array<{ e: EnderecoSalvo; p: EnderecoDigitado }>): Lugar {
  const comCoord = linhas.filter((l) => l.e.latitude != null && l.e.longitude != null);
  const porUso = (x: { e: EnderecoSalvo }, y: { e: EnderecoSalvo }) => (y.e.usage_count ?? 0) - (x.e.usage_count ?? 0);
  const base = [...comCoord].sort(porUso)[0] ?? [...linhas].sort(porUso)[0]!;
  // A linha que fica MANDA: cada coluna dela vale como está; as outras só preenchem o vazio.
  const ordem = [base, ...linhas.filter((l) => l !== base).sort(porUso)];
  const primeiro = (k: keyof EnderecoDigitado) => ordem.map((l) => l.p[k]).find((v) => !!v) ?? null;
  const partes: EnderecoDigitado = {
    street: primeiro('street'),
    number: primeiro('number'),
    complement: primeiro('complement'),
    neighborhood: primeiro('neighborhood'),
    city: primeiro('city'),
    state: primeiro('state'),
    cep: primeiro('cep'),
  };
  return {
    ids: linhas.map((l) => l.e.id),
    manter: base.e.id,
    partes,
    texto: montarEnderecoHumano({ street: partes.street, number: partes.number, complement: partes.complement, neighborhood: partes.neighborhood }),
    textoCompleto: montarEnderecoHumano(partes),
    coord: base.e.latitude != null && base.e.longitude != null ? { lat: base.e.latitude, lng: base.e.longitude } : null,
    usos: linhas.reduce((soma, l) => soma + (l.e.usage_count ?? 0), 0),
    rotulos: [...new Set(linhas.map((l) => fold(l.e.label).trim()).filter(Boolean))],
  };
}

function agrupar(linhas: Array<{ e: EnderecoSalvo; p: EnderecoDigitado }>): Lugar[] {
  const grupos: Array<Array<{ e: EnderecoSalvo; p: EnderecoDigitado }>> = [];
  for (const l of linhas) {
    const g = grupos.find((gr) => gr.every((x) => mesmoLugar(x.p, l.p)));
    if (g) g.push(l);
    else grupos.push([l]);
  }
  return grupos.map(fundir);
}

/** A fala do paciente aponta este lugar? (o setor dele, ou rua + número) */
function falaApontaPara(lugar: Lugar, falas: Array<string | null | undefined>): boolean {
  const texto = ` ${fold(falas.join(' \n ')).replace(/[^a-z0-9]+/g, ' ')} `;
  const bairro = chaveDeBairro(lugar.partes.neighborhood);
  if (bairro.length >= 4 && texto.includes(` ${bairro} `)) return true;
  const num = (lugar.partes.number ?? '').trim();
  const rua = chaveDeRua(lugar.partes.street);
  return !!num && rua.length >= 3 && texto.includes(` ${rua} `) && texto.includes(` ${num} `);
}

/**
 * O que fazer com o rótulo pedido ("casa"):
 *  • nenhum  → não há linha válida com esse rótulo;
 *  • unico   → um lugar só (talvez em várias linhas iguais, ou com lixo junto): usa fundido;
 *  • conflito → lugares diferentes pro rótulo, OU o mesmo endereço (rua + quadra/lote) salvo
 *    noutro rótulo com outro setor — pergunta antes de usar.
 */
export function diagnosticarEnderecoSalvo(
  todos: readonly EnderecoSalvo[],
  rotulo: string,
  falasDoPaciente: Array<string | null | undefined> = [],
): DiagnosticoDeEndereco {
  const r = fold(rotulo).trim();
  const lidas = todos.map((e) => ({ e, p: partesDoSalvo(e) }));
  const doRotulo = lidas.filter((l) => fold(l.e.label).trim() === r);
  const temCoord = (e: EnderecoSalvo) => e.latitude != null && e.longitude != null;
  const validas = doRotulo.filter((l) => enderecoValido(l.p, temCoord(l.e)));
  if (!validas.length) return { tipo: 'nenhum' };
  const invalidas = doRotulo.filter((l) => !enderecoValido(l.p, temCoord(l.e))).map((l) => l.e.id);

  let variantes = agrupar(validas);
  // Mesma rua + mesma quadra/lote noutro rótulo, com OUTRO setor: é o geocoder trocando o bairro
  // (Ludmila: "Rua 14, Qd. B8, Lt. 20" em Setor Oeste e em Setor Sul). Entra como variante.
  const outros = lidas.filter((l) => fold(l.e.label).trim() !== r && enderecoValido(l.p, temCoord(l.e)));
  for (const o of outros) {
    const parecida = variantes.some((v) =>
      chaveDeRua(v.partes.street) === chaveDeRua(o.p.street)
      && !!chaveDeComplemento(v.partes.complement) && chaveDeComplemento(v.partes.complement) === chaveDeComplemento(o.p.complement)
      && !!chaveDeBairro(o.p.neighborhood) && !!chaveDeBairro(v.partes.neighborhood)
      && chaveDeBairro(v.partes.neighborhood) !== chaveDeBairro(o.p.neighborhood));
    const jaCoberta = variantes.some((v) => mesmoLugar(v.partes, o.p));
    if (parecida && !jaCoberta) variantes = [...variantes, fundir([o])];
  }

  // Duas opções que só diferem no CEP apareceriam iguais na pergunta: o CEP entra no texto.
  const vistos = new Map<string, number>();
  for (const v of variantes) vistos.set(v.texto, (vistos.get(v.texto) ?? 0) + 1);
  variantes = variantes.map((v) => ((vistos.get(v.texto) ?? 0) > 1 && v.partes.cep ? { ...v, texto: `${v.texto}, CEP ${v.partes.cep}` } : v));

  if (variantes.length === 1) {
    const lugar = variantes[0]!;
    // Sem coordenada, a linha pode ter vindo do enricher (texto inferido, nunca mostrado): antes
    // de achar no mapa e usar, a pessoa confirma o texto (revisão de 28/09).
    if (!lugar.coord) return { tipo: 'conflito', variantes: [lugar], apontada: lugar };
    const remover = [...lugar.ids.filter((id) => id !== lugar.manter), ...invalidas];
    return { tipo: 'unico', lugar, remover };
  }
  // A mais usada primeiro (é a que o paciente mais viu), depois a que tem coordenada.
  variantes.sort((a, b) => b.usos - a.usos || Number(!!b.coord) - Number(!!a.coord));
  const apontadas = variantes.filter((v) => falaApontaPara(v, falasDoPaciente));
  return { tipo: 'conflito', variantes: variantes.slice(0, 3), apontada: apontadas.length === 1 ? apontadas[0]! : null };
}

/** Prefixo fixo da pergunta — é por ele que a conversa "lembra" que perguntou. */
export const MARCA_CONFIRMACAO_ENDERECO = 'Só pra confirmar o endereço da entrega';

export function perguntaDeConfirmacaoDeEndereco(d: Extract<DiagnosticoDeEndereco, { tipo: 'conflito' }>): string {
  if (d.apontada) {
    const porque = d.variantes.length > 1 ? ' Tenho ele anotado de mais de um jeito aqui e quero deixar certinho 💙' : ' 💙';
    return `${MARCA_CONFIRMACAO_ENDERECO}: *${d.apontada.texto}*, é isso?${porque}`;
  }
  const opcoes = d.variantes.map((v, i) => `${i + 1}) *${v.texto}*`).join('\n');
  return `${MARCA_CONFIRMACAO_ENDERECO}: tenho ele anotado de ${d.variantes.length} jeitos aqui. Qual é o certo?\n${opcoes}\nMe diz o número (ou o endereço certo) que eu já arrumo 💙`;
}

const SIM = /^(sim|isso|isso mesmo|isso ai|e isso|e esse|esse mesmo|e esse mesmo|esse|correto|certo|certinho|exato|exatamente|pode|pode ser|ok|okay|beleza|confirmo|confirmado|perfeito|aham|uhum|e sim|isso msm|sim sim|👍|✅)(?![a-z])/;
const NAO = /(^|[^a-z])(nao|nenhum|nenhuma|nem|errado|errada|mudei|mudou|outro|outra)([^a-z]|$)/;
const ORDINAIS: Record<string, number> = { primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3 };

const ENCHIMENTO = /(^|\s)(sim|isso|mesmo|mesma|pode|ser|por|favor|pfv|ok|esse|essa|e|eh|o|a|opcao|numero|n|entao|beleza|certo|ai|aqui|la)(?=\s|$)/g;

/** A resposta é SÓ a escolha ("1", "o 2", "é a opção 3", "a segunda", "o 1 sim", "pode ser o 1")? */
function soAEscolha(r: string): number | null {
  const limpo = r.replace(/[^a-z0-9]+/g, ' ').replace(ENCHIMENTO, ' ').replace(/\s+/g, ' ').trim();
  if (/^[1-3]$/.test(limpo)) return Number(limpo);
  const n = /^\W*(?:e\s+)?(?:o|a)?\s*(?:opcao|numero|n)?\s*([1-3])\W*$/.exec(r);
  if (n) return Number(n[1]);
  const o = /^\W*(?:e\s+)?(?:o|a)?\s*(primeir[oa]|segund[oa]|terceir[oa])(?:\s+(?:opcao|endereco|mesmo|mesma))?\W*$/.exec(r);
  return o ? ORDINAIS[o[1]!] ?? null : null;
}

/** A resposta traz rua ou número que o lugar não tem? Então é endereço novo, não escolha. */
function trazOutroEndereco(r: string, v: Lugar): boolean {
  const p = parseEnderecoDigitado(r);
  const rua = chaveDeRua(p.street);
  if (/^(rua|avenida|alameda|travessa|rodovia|estrada|praca)\s/.test(rua) && rua !== chaveDeRua(v.partes.street)) return true;
  const doLugar = new Set(fold(v.textoCompleto).match(/\b\d{1,5}\b/g) ?? []);
  return (r.match(/\b\d{1,5}\b/g) ?? []).some((n) => !doLugar.has(n));
}

/** A única variante que a resposta aponta pelo que SÓ ela tem ("oeste", "sul", "201"). */
function unicaApontada(r: string, variantes: Lugar[]): Lugar | null {
  const tokens = variantes.map((v) => new Set(fold(v.texto).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((x) => x.length >= 3 || /^\d+$/.test(x))));
  const palavras = new Set(r.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
  const casam = tokens
    .map((set, i) => ({ i, so: [...set].filter((t) => palavras.has(t) && tokens.every((o, j) => j === i || !o.has(t))).length }))
    .filter((x) => x.so > 0);
  return casam.length === 1 ? variantes[casam[0]!.i]! : null;
}

/**
 * O paciente respondeu à pergunta de confirmação? Devolve a variante escolhida (recalculada do
 * banco agora — casada pelo TEXTO que foi mostrado) ou null: não era resposta, negou, trouxe
 * endereço novo, ou ficou ambíguo — aí o modelo pede o endereço. Errar aqui manda o remédio
 * pro setor errado E apaga o cadastro certo, então na dúvida é null (revisão de 28/09).
 */
export function respostaDeConfirmacaoDeEndereco(
  ultimaFalaDaXarlote: string | null | undefined,
  resposta: string | null | undefined,
  d: Extract<DiagnosticoDeEndereco, { tipo: 'conflito' }>,
): Lugar | null {
  const pergunta = ultimaFalaDaXarlote ?? '';
  if (!pergunta.startsWith(MARCA_CONFIRMACAO_ENDERECO)) return null;
  const mostrados = [...pergunta.matchAll(/\*([^*]+)\*/g)]
    .map((m) => d.variantes.find((v) => v.texto === (m[1] ?? '').trim()) ?? null);
  if (!mostrados.length || mostrados.some((v) => !v)) return null;   // a pergunta não bate com o cadastro de agora
  const r = fold(resposta).trim();
  if (!r) return null;
  const negou = NAO.test(r);

  if (mostrados.length > 1) {
    if (negou) return null;                                 // "não é o 1, é o 2": na dúvida, o modelo pergunta
    const n = soAEscolha(r);
    if (n) return mostrados[n - 1] ?? null;
    // Um "1".."N" solto numa frase maior é número de OPÇÃO, não pedaço de endereço ("o 1 sim"
    // casaria "Rua 1" da opção 2): na dúvida, nada.
    const opcoes = new RegExp(`(^|[^0-9])[1-${mostrados.length}]([^0-9]|$)`);
    if (opcoes.test(r)) return null;
    const v = unicaApontada(r, mostrados as Lugar[]);
    return v && !trazOutroEndereco(r, v) ? v : null;
  }

  const mostrado = mostrados[0]!;
  if (negou) {
    // "não, é o do setor sul": aponta OUTRA variante conhecida (nunca a negada)
    const v = unicaApontada(r, d.variantes);
    return v && v !== mostrado && !trazOutroEndereco(r, v) ? v : null;
  }
  if (trazOutroEndereco(r, mostrado)) return null;            // "sim, mas é o 210"
  if (SIM.test(r)) return mostrado;
  const v = unicaApontada(r, d.variantes);                    // "o do setor oeste" / "é o do sul"
  return v && !trazOutroEndereco(r, v) ? v : null;
}
