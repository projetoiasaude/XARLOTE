/**
 * clinic-discovery — popula a tabela `clinics` via Google Places, com fallback
 * pra cache caso a chave Places não esteja disponível ou a especialidade já
 * tenha sido buscada recentemente naquela cidade.
 *
 * Diferente do fluxo de farmácia (que descobre cada vez do zero), aqui usamos
 * a tabela `clinics` como cache persistente: clínica + especialidade + cidade
 * raramente mudam, então depois do primeiro hit no Places, vamos direto pelo DB.
 *
 * Filtro essencial: só retornamos clínicas que TÊM `whatsapp_e164` (porque é
 * por WhatsApp que negociamos). Clínicas sem WA ficam no diretório só pra
 * referência, mas não entram na lista de candidatos.
 */
import { db, writeLog } from '@iasaude/db';
import { findNearbyClinics, geocodeAddress, getPlacePhone, type PlaceResult } from '@iasaude/integrations';
import { toE164BR } from '@iasaude/shared';

export interface ClinicCandidate {
  id: string;
  name: string;
  whatsapp_e164: string;
  phone_e164: string | null;
  address: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  distance_km: number | null;
  specialties: string[];
  accepts_plans: string[];
}

/**
 * Busca top-k clínicas pra uma especialidade+cidade.
 *
 *  1. Tenta `find_clinics(specialty, city, state, k)` RPC (cache em DB).
 *  2. Se < 3 resultados, dispara Google Places (`type=doctor`, `keyword=specialty`).
 *     Faz upsert dos resultados em `clinics` (sem whatsapp_e164 ainda — outro
 *     processo manual/scraper pode preencher depois). Retorna só as que JÁ
 *     têm whatsapp_e164.
 *
 * @param lat/lng — opcional; se passado, ordena por distância
 */
export async function discoverClinics(opts: {
  specialty: string;
  city: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
  limit?: number;
  traceId: string;
}): Promise<ClinicCandidate[]> {
  const { specialty, city, state, traceId } = opts;
  const limit = opts.limit ?? 5;
  // lat/lng mutáveis — podem ser preenchidos via geocode da cidade abaixo
  let lat: number | null | undefined = opts.lat;
  let lng: number | null | undefined = opts.lng;

  // 1. Cache via find_clinics RPC (se já existe na tabela)
  let cached: ClinicCandidate[] = [];
  try {
    const { data, error } = await db.rpc('find_clinics', {
      p_specialty: specialty,
      p_city: city,
      p_state: state ?? null,
      p_k: limit * 2, // pede 2x pra filtrar por whatsapp
    });
    if (!error && Array.isArray(data)) {
      cached = (data as any[])
        .filter((c) => c.whatsapp_e164)
        .map((c) => ({
          id: c.id,
          name: c.name,
          whatsapp_e164: c.whatsapp_e164,
          phone_e164: c.phone_e164 ?? null,
          address: c.address ?? '',
          city: c.city ?? city ?? '',
          state: c.state ?? state ?? '',
          lat: c.lat ?? null,
          lng: c.lng ?? null,
          rating: c.rating ?? null,
          distance_km: lat && lng && c.lat && c.lng ? haversine(lat, lng, c.lat, c.lng) : null,
          specialties: c.specialties ?? [],
          accepts_plans: c.accepts_plans ?? [],
        }));
    }
  } catch (err) {
    await writeLog('warn', 'clinic-discovery', `find_clinics RPC indisponível: ${String(err).slice(0, 120)}`, { traceId });
  }

  // Se cache já tem o suficiente, retorna
  if (cached.length >= limit) {
    cached.sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
    return cached.slice(0, limit);
  }

  // 2. Fallback: Google Places (precisa de lat/lng pra buscar por raio).
  //    Se não temos lat/lng mas temos a CIDADE, geocodamos o centro da cidade.
  //    Isso resolve o caso comum: paciente só disse "Goiânia" sem compartilhar localização.
  if ((typeof lat !== 'number' || typeof lng !== 'number') && city) {
    try {
      const geo = await geocodeAddress(`${city}${state ? `, ${state}` : ''}, Brasil`);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
        await writeLog('info', 'clinic-discovery', `Cidade "${city}" geocodada → ${lat?.toFixed(4)},${lng?.toFixed(4)}`, { traceId });
      }
    } catch (err) {
      await writeLog('warn', 'clinic-discovery', `geocode da cidade "${city}" falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
  }

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    await writeLog('warn', 'clinic-discovery', `sem lat/lng e sem cidade geocodável — retornando só ${cached.length} do cache`, { traceId });
    return cached;
  }

  // Raio maior quando buscamos pelo centro da cidade (vs localização exata do user)
  const baseRadius = 8000;

  let places: PlaceResult[] = [];
  try {
    places = await findNearbyClinics(lat, lng, specialty, baseRadius, 12);
    if (places.length < 3) {
      places = await findNearbyClinics(lat, lng, specialty, baseRadius * 2, 12);
    }
    await writeLog('info', 'clinic-discovery', `Google Places retornou ${places.length} clínica(s) pra "${specialty}"`, {
      traceId,
      preview: places.slice(0, 5).map((p) => ({ nome: p.name, dist: `${p.distanceKm?.toFixed(1)}km`, rating: p.rating })),
    });
  } catch (err) {
    await writeLog('error', 'clinic-discovery', `Places API falhou: ${String(err).slice(0, 200)}`, { traceId });
    return cached;
  }

  if (places.length === 0) return cached;

  // 3. Upsert das clínicas + captura de telefone como CANAL DE CONTATO.
  //    O Places não retorna WhatsApp, mas retorna o telefone comercial (via Place Details).
  //    No Brasil, a esmagadora maioria das clínicas atende WhatsApp no mesmo número fixo/celular.
  //    Então tratamos o telefone do Places como whatsapp_e164 (canal de cotação) — igual
  //    o fluxo de farmácia faz com supplier.phone_e164.
  const upserted: ClinicCandidate[] = [...cached];
  const cachedIds = new Set(cached.map((c) => c.id));

  // Busca telefone só das top-N (Place Details custa 1 request cada) — limita a 8 pra controlar custo.
  const topPlaces = places.slice(0, 8);

  for (const p of topPlaces) {
    try {
      // Puxa telefone via Place Details (só se ainda não temos)
      let phoneE164: string | null = null;
      try {
        const phone = await getPlacePhone(p.placeId);
        phoneE164 = toE164BR(phone);
      } catch { /* telefone opcional — sem ele, clínica fica no diretório mas não vira candidata */ }

      const { data: row } = await db.from('clinics').upsert({
        type: 'clinic',
        name: p.name,
        google_place_id: p.placeId,
        address: p.address,
        city: p.city || city || '',
        state: p.state || state || '',
        lat: p.lat,
        lng: p.lng,
        rating: p.rating ?? null,
        specialties: [specialty],
        phone_e164: phoneE164,
        // Usa o telefone como canal WhatsApp (assumido). Captura manual pode refinar depois.
        whatsapp_e164: phoneE164,
      }, { onConflict: 'google_place_id' }).select('id, name, whatsapp_e164, phone_e164, accepts_plans, specialties').single();

      if (!row?.id) continue;
      if (cachedIds.has(row.id)) continue;

      // Canal de contato: whatsapp_e164 (= telefone) OU phone_e164. Sem nenhum, pula.
      const channel = row.whatsapp_e164 || row.phone_e164;
      if (!channel) continue;

      upserted.push({
        id: row.id,
        name: row.name ?? p.name,
        whatsapp_e164: channel,
        phone_e164: row.phone_e164 ?? null,
        address: p.address,
        city: p.city || city || '',
        state: p.state || state || '',
        lat: p.lat,
        lng: p.lng,
        rating: p.rating ?? null,
        distance_km: p.distanceKm ?? null,
        specialties: row.specialties ?? [specialty],
        accepts_plans: row.accepts_plans ?? [],
      });
    } catch (err) {
      await writeLog('warn', 'clinic-discovery', `upsert falhou pra ${p.name}: ${String(err).slice(0, 120)}`, { traceId });
    }
  }

  upserted.sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
  await writeLog('info', 'clinic-discovery', `${upserted.length} clínica(s) com canal de contato pra "${specialty}"`, { traceId });
  return upserted.slice(0, limit);
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
