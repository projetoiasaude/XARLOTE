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
}

const HEADERS = {
  'User-Agent': 'IA-da-Saude/1.0 (contato@iadasaude.com)',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

async function nominatimSearch(query: string, timeoutMs = 8_000): Promise<NominatimHit | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=br&addressdetails=0`;
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

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  type Attempt = { q: string; tier: 'precise' | 'low' };
  const attempts: Attempt[] = [];

  // 1. Endereço cru
  attempts.push({ q: address, tier: 'precise' });

  // 2. Endereço normalizado
  const normalized = normalizeBrazilianAddress(address);
  if (normalized && normalized !== address) attempts.push({ q: normalized, tier: 'precise' });

  // 3. ViaCEP → constrói consultas estruturadas pro Nominatim
  // Nominatim NÃO indexa CEPs BR — então busca o CEP no ViaCEP e usa o logradouro/bairro/cidade.
  const cep = extractCep(address);
  let viaCep: ViaCepResult | null = null;
  if (cep) {
    viaCep = await viaCepLookup(cep);
    if (viaCep) {
      const { logradouro, bairro, localidade, uf } = viaCep;
      if (logradouro && localidade && uf) {
        attempts.push({ q: `${logradouro}, ${localidade}, ${uf}`, tier: 'precise' });
      }
      if (logradouro && bairro && localidade && uf) {
        attempts.push({ q: `${logradouro}, ${bairro}, ${localidade}, ${uf}`, tier: 'precise' });
      }
      if (bairro && localidade && uf) {
        attempts.push({ q: `${bairro}, ${localidade}, ${uf}`, tier: 'precise' });
      }
    }
  }

  // 4. Logradouro principal extraído do texto cru (ex.: "Avenida Interligação")
  // + cidade/UF detectados — funciona quando o usuário digitou expressões como
  // "esquina com a rua X" que confundem o Nominatim com a query inteira.
  const mainStreet = extractMainStreet(address);
  const cityState = extractCityState(address);
  if (mainStreet && cityState) {
    attempts.push({ q: `${mainStreet}, ${cityState}`, tier: 'precise' });
  } else if (mainStreet && viaCep?.localidade && viaCep.uf) {
    attempts.push({ q: `${mainStreet}, ${viaCep.localidade}, ${viaCep.uf}`, tier: 'precise' });
  }

  // 5. Último recurso: cidade + UF (low confidence — vai pro centro da cidade)
  if (cityState) attempts.push({ q: cityState, tier: 'low' });

  // Dedup mantendo ordem
  const seen = new Set<string>();
  const ordered = attempts.filter((a) => {
    const k = a.q.toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i]!;
    const hit = await nominatimSearch(a.q);
    if (hit) {
      const precise = a.tier === 'precise' && isPreciseHit(hit);
      return {
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
        formattedAddress: hit.display_name,
        confidence: precise ? 'precise' : 'low',
      };
    }
    if (i < ordered.length - 1) {
      // Nominatim pede no máx 1 req/s para uso anônimo
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  return null;
}
