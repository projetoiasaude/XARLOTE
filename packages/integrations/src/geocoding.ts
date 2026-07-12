interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  /** 'precise' = casou rua/bairro; 'low' = só município/UF/CEP — provavelmente errado pra busca local */
  confidence: 'precise' | 'low';
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  class?: string;
  type?: string;
  addresstype?: string;
  // addressdetails=1 → estrutura pra VALIDAR o resultado contra o que foi pedido
  // (incidente Glauber 12/07: Nominatim casou "R. C-131, Jardim América, CEP 74255" com
  // "Rua 8-A, Jardim Petrópolis, CEP 74460" e o sistema aceitou como "preciso").
  address?: {
    postcode?: string;
    suburb?: string;
    neighbourhood?: string;
    quarter?: string;
    city_district?: string;
    city?: string;
    town?: string;
    municipality?: string;
    road?: string;
  };
}

const HEADERS = {
  'User-Agent': 'IA-da-Saude/1.0 (contato@iadasaude.com)',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

async function nominatimSearch(query: string, timeoutMs = 8_000): Promise<NominatimHit | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=br&addressdetails=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimHit[];
    return data[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Expande abreviações comuns de endereços brasileiros e remove ruído (quadra/lote/bloco/apto)
// que o Nominatim não consegue resolver.
function normalizeBrazilianAddress(raw: string): string {
  let s = ` ${raw} `;

  // Protege CEP (\d{5}-\d{3}) antes de mexer em hífens
  s = s.replace(/(\d{5})-(\d{3})/g, '$1__CEP__$2');

  // Normaliza outros separadores hífen → vírgula
  s = s.replace(/\s*-\s*/g, ', ');

  // Restaura CEP
  s = s.replace(/(\d{5})__CEP__(\d{3})/g, '$1-$2');

  // Expande logradouros
  s = s.replace(/\bR\./gi, 'Rua');
  s = s.replace(/\bAv\./gi, 'Avenida');
  s = s.replace(/\bAl\./gi, 'Alameda');
  s = s.replace(/\bTv\./gi, 'Travessa');
  s = s.replace(/\bRod\./gi, 'Rodovia');
  s = s.replace(/\bPça\.|\bPca\./gi, 'Praça');
  s = s.replace(/\bEstr\./gi, 'Estrada');

  // Expande setor / bairro
  s = s.replace(/\bSt\./gi, 'Setor');
  s = s.replace(/\bJd\./gi, 'Jardim');
  s = s.replace(/\bCj\./gi, 'Conjunto');
  s = s.replace(/\bV\./gi, 'Vila');

  // Remove quadra/lote/bloco/apartamento (Nominatim quase nunca resolve)
  s = s.replace(/,?\s*(Qd|Quadra|Lt|Lote|Bl|Bloco|Ap|Apt|Apto|Apartamento|Cs|Casa)\.?\s*[A-Z0-9-]+/gi, '');

  // Colapsa espaços e vírgulas duplicadas
  s = s.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();
  return s;
}

function extractCep(raw: string): string | null {
  const m = raw.match(/\b\d{5}-?\d{3}\b/);
  return m ? m[0].replace('-', '') : null;
}

interface ViaCepResult {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean;
}

// ViaCEP é gratuita e bem mais confiável pra CEPs BR do que o Nominatim
// (Nominatim retorna [] pra qualquer CEP brasileiro).
async function viaCepLookup(cep8: string, timeoutMs = 5_000): Promise<ViaCepResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep8}/json/`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as ViaCepResult;
    if (data.erro) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Extrai a primeira ocorrência de logradouro nomeado da string.
// Ex.: "avenida interligação esquina com a rua 5" → "Avenida Interligação"
function extractMainStreet(raw: string): string | null {
  const re = /\b(Avenida|Av\.?|Rua|R\.?|Alameda|Al\.?|Travessa|Tv\.?|Rodovia|Rod\.?|Praça|Pça\.?|Pca\.?|Estrada|Estr\.?)\s+([A-Za-zÀ-ÿ0-9]+(?:\s+[A-Za-zÀ-ÿ0-9]+){0,3})/i;
  const m = raw.match(re);
  if (!m) return null;
  const expand: Record<string, string> = {
    'av': 'Avenida', 'av.': 'Avenida', 'avenida': 'Avenida',
    'r': 'Rua', 'r.': 'Rua', 'rua': 'Rua',
    'al': 'Alameda', 'al.': 'Alameda', 'alameda': 'Alameda',
    'tv': 'Travessa', 'tv.': 'Travessa', 'travessa': 'Travessa',
    'rod': 'Rodovia', 'rod.': 'Rodovia', 'rodovia': 'Rodovia',
    'pça': 'Praça', 'pça.': 'Praça', 'pca': 'Praça', 'pca.': 'Praça', 'praça': 'Praça',
    'estr': 'Estrada', 'estr.': 'Estrada', 'estrada': 'Estrada',
  };
  const prefix = expand[m[1]!.toLowerCase()] ?? m[1]!;
  // Para a primeira palavra de stop comum (esquina, com, qd, lt, etc.) — corta o nome ali.
  const restRaw = m[2]!;
  const stopWords = ['esquina', 'com', 'qd', 'quadra', 'lt', 'lote', 'bl', 'bloco', 'apto', 'apartamento', 'casa', 'cs'];
  const tokens = restRaw.split(/\s+/);
  const cleanTokens: string[] = [];
  for (const t of tokens) {
    if (stopWords.includes(t.toLowerCase())) break;
    cleanTokens.push(t);
  }
  if (cleanTokens.length === 0) return null;
  return `${prefix} ${cleanTokens.join(' ')}`;
}

function extractCityState(raw: string): string | null {
  // Tenta capturar "Cidade, UF" ou "Cidade - UF"
  const m = raw.match(/([A-Za-zÀ-ÿ\s]{3,})[\s,-]+([A-Z]{2})\b/);
  if (m && m[1] && m[2]) return `${m[1].trim()}, ${m[2]}`;
  return null;
}

// Tipos de match que NÃO servem pra busca local de farmácias (genérico demais).
// Quando addresstype = state/country/region/city e o usuário tinha rua/CEP, é fallback ruim.
const LOW_PRECISION_TYPES = new Set([
  'country', 'state', 'region', 'county',
  'municipality', 'city', 'town', 'administrative',
]);

function isPreciseHit(hit: NominatimHit): boolean {
  const t = (hit.addresstype || hit.type || '').toLowerCase();
  if (!t) return true; // sem dado → assume preciso
  if (LOW_PRECISION_TYPES.has(t)) return false;
  return true;
}

/**
 * O CEP do RESULTADO fica no mesmo SETOR postal do CEP DIGITADO? (incidente Glauber
 * 12/07). CEPs BR têm 8 dígitos; os 3 primeiros = região+sub-região+setor. Comparar 3
 * dígitos pega a divergência catastrófica (74255 "Jardim América" vs 74460 "Jardim
 * Petrópolis" → 742≠744 → REJEITA) sem rejeitar uma casa legítima do mesmo setor.
 * Retorna: true = mesmo setor · false = setor DIFERENTE (não confia) · null = sem CEP no
 * resultado (indeterminado → decide pelo tipo).
 */
export function cepSectorMatches(inputCep8: string, hitPostcode: string | null | undefined): boolean | null {
  const hit = (hitPostcode ?? '').replace(/\D/g, '');
  const inp = (inputCep8 ?? '').replace(/\D/g, '');
  if (hit.length < 5 || inp.length < 5) return null;
  return inp.slice(0, 3) === hit.slice(0, 3);
}

/** Bairro do resultado do Nominatim (várias chaves possíveis). */
function hitNeighborhood(hit: NominatimHit): string | null {
  const a = hit.address;
  return (a?.suburb || a?.neighbourhood || a?.quarter || a?.city_district || null) || null;
}

/** Normaliza pra comparar bairros ("Jardim América" ≈ "jardim america"). */
function foldStr(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

interface NominatimReverseHit {
  lat: string;
  lon: string;
  display_name: string;
  address?: {
    road?: string;
    house_number?: string;
    neighbourhood?: string;
    suburb?: string;
    quarter?: string;
    city?: string;
    town?: string;
    municipality?: string;
    state?: string;
    postcode?: string;
    country?: string;
    [k: string]: string | undefined;
  };
}

export interface ReverseGeocodeResult {
  /** display_name completo do Nominatim (ex.: "Rua T-25, 100, Setor Bueno, Goiânia, ..., Goiás, 74230-100, Brasil") */
  formattedAddress: string;
  /** Versão compacta sem país/região metropolitana, ideal pra mostrar à farmácia na confirmação. */
  shortAddress: string;
  road?: string;
  houseNumber?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  postcode?: string;
}

/**
 * Reverse geocode via Nominatim (OpenStreetMap). Retorna o display_name completo
 * + uma versão "shortAddress" compacta + os componentes estruturados.
 *
 * Não usa Google Geocoding porque a API key do projeto tem restrição (só Places liberado).
 */
export async function reverseGeocodeNominatim(lat: number, lng: number, timeoutMs = 8_000): Promise<ReverseGeocodeResult | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=18&addressdetails=1&accept-language=pt-BR`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    const hit = (await res.json()) as NominatimReverseHit;
    if (!hit?.display_name) return null;

    const a = hit.address ?? {};
    const neighborhood = a.neighbourhood || a.suburb || a.quarter;
    const city = a.city || a.town || a.municipality;

    // Versão curta: rua + número + bairro + cidade/UF + CEP. Sem "Brasil", sem "Microrregião de…"
    const parts: string[] = [];
    if (a.road) parts.push(a.house_number ? `${a.road}, ${a.house_number}` : a.road);
    if (neighborhood) parts.push(neighborhood);
    if (city && a.state) parts.push(`${city} - ${a.state}`);
    else if (city) parts.push(city);
    if (a.postcode) parts.push(`CEP ${a.postcode}`);
    const shortAddress = parts.join(', ') || hit.display_name;

    return {
      formattedAddress: hit.display_name,
      shortAddress,
      road: a.road,
      houseNumber: a.house_number,
      neighborhood,
      city,
      state: a.state,
      postcode: a.postcode,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classifica um hit do Nominatim (incidente Glauber 12/07 + review 12/07). Dois sinais
 * confiáveis: (A) o TEXTO que o usuário digitou (rua) e (B) o CEP (→ bairro autoritativo via
 * ViaCEP). Quando A e B CONCORDAM → alta confiança. Quando DISCORDAM → ambíguo (pede pin) —
 * NÃO adivinha qual está certo (podia ser typo na rua OU no CEP). O CEP só é critério de
 * REJEIÇÃO quando o ViaCEP o CONFIRMOU (senão um typo de CEP nukava a rua correta).
 */
export function classifyGeocodeHit(opts: {
  isPreciseType: boolean;       // hit tem tipo de rua/casa (não cidade/estado)
  cepConfirmed: boolean;         // ViaCEP resolveu o CEP digitado (CEP é real)
  cepMatch: boolean | null;      // setor do postcode do hit vs CEP digitado
  bairroMatch: boolean | null;   // bairro do hit vs bairro do ViaCEP
}): 'precise' | 'low' | 'conflict' {
  if (!opts.isPreciseType) return 'low';
  // Sem CEP confirmado (sem CEP, ou CEP typo que o ViaCEP não achou) → confia no TEXTO
  // do usuário (a rua é o que temos; CEP não-confirmado não pode rejeitar nada).
  if (!opts.cepConfirmed) return 'precise';
  // CEP confirmado: rua e CEP têm que CONCORDAR.
  if (opts.cepMatch === true || opts.bairroMatch === true) return 'precise';
  if (opts.cepMatch === false || opts.bairroMatch === false) return 'conflict'; // rua×CEP divergem → pin
  return 'precise'; // indeterminado (hit sem postcode/bairro) → aceita o texto
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const cep = extractCep(address);
  const viaCep: ViaCepResult | null = cep ? await viaCepLookup(cep) : null;
  const cepConfirmed = !!viaCep;
  const viaCepBairro = foldStr(viaCep?.bairro);

  const normalized = normalizeBrazilianAddress(address);
  const mainStreet = extractMainStreet(address);
  const cityState = extractCityState(address) || (viaCep?.localidade && viaCep.uf ? `${viaCep.localidade}, ${viaCep.uf}` : null);

  // ORDEM (review 12/07): o TEXTO do usuário roda ANTES de qualquer query derivada do CEP —
  // senão uma query do ViaCEP validaria contra o próprio CEP (tautológico) e um typo de CEP
  // levaria a entrega pro bairro errado. As queries do ViaCEP só entram se o texto não
  // resolver. `fromViaCep` marca de onde veio (afeta a decisão de conflito).
  type Attempt = { q: string; tier: 'precise' | 'low'; fromViaCep: boolean };
  const attempts: Attempt[] = [];
  attempts.push({ q: address, tier: 'precise', fromViaCep: false });
  if (normalized && normalized !== address) attempts.push({ q: normalized, tier: 'precise', fromViaCep: false });
  if (mainStreet && cityState) attempts.push({ q: `${mainStreet}, ${cityState}`, tier: 'precise', fromViaCep: false });
  if (viaCep) {
    const { logradouro, bairro, localidade, uf } = viaCep;
    if (logradouro && bairro && localidade && uf) attempts.push({ q: `${logradouro}, ${bairro}, ${localidade}, ${uf}`, tier: 'precise', fromViaCep: true });
    if (logradouro && localidade && uf) attempts.push({ q: `${logradouro}, ${localidade}, ${uf}`, tier: 'precise', fromViaCep: true });
    if (bairro && localidade && uf) attempts.push({ q: `${bairro}, ${localidade}, ${uf}`, tier: 'precise', fromViaCep: true });
  }
  if (cityState) attempts.push({ q: cityState, tier: 'low', fromViaCep: false });

  const seen = new Set<string>();
  const ordered = attempts.filter((a) => {
    const k = a.q.toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let fallbackLow: GeocodeResult | null = null;
  // "Conflito grudento" (review r2): se o TEXTO do usuário resolveu num lugar que DISCORDA
  // do CEP digitado (rua×CEP conflitam), NÃO deixamos um attempt derivado do ViaCEP depois
  // "consertar" com um precise — porque não sabemos QUAL está errado (rua ou CEP), e um
  // typo de CEP levaria a query do ViaCEP pro lugar errado. Uma vez em conflito, a resposta
  // honesta é pedir o pin. Só um attempt de TEXTO que CONCORDE reverte isso.
  let sawConflict = false;

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i]!;
    const hit = await nominatimSearch(a.q);
    if (hit) {
      const mkResult = (confidence: 'precise' | 'low'): GeocodeResult => ({
        lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), formattedAddress: hit.display_name, confidence,
      });
      const cepMatch = cepConfirmed ? cepSectorMatches(cep!, hit.address?.postcode) : null;
      const hitBairro = foldStr(hitNeighborhood(hit));
      const bairroMatch = viaCepBairro && hitBairro ? viaCepBairro === hitBairro : null;

      // Uma query DERIVADA do ViaCEP casa o próprio CEP por construção (tautológico) — pra
      // ela decidimos só pelo tipo. MAS se já vimos um conflito rua×CEP, uma query do ViaCEP
      // NÃO pode virar 'precise' (seria confiar cegamente no CEP sobre um conflito real).
      const cls = a.fromViaCep
        ? ((isPreciseHit(hit) && !sawConflict) ? 'precise' : 'low')
        : classifyGeocodeHit({ isPreciseType: isPreciseHit(hit) && a.tier === 'precise', cepConfirmed, cepMatch, bairroMatch });

      if (cls === 'precise') return mkResult('precise');
      if (cls === 'conflict') {
        sawConflict = true; // rua×CEP divergem → pega o pin, não adivinha
        if (!fallbackLow) fallbackLow = mkResult('low');
      } else if (!fallbackLow) {
        fallbackLow = mkResult('low');
      }
    }
    if (i < ordered.length - 1) {
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 req/s anônimo
    }
  }

  return fallbackLow;
}
