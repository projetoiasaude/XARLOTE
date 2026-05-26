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
import { findNearbyClinics, type PlaceResult } from '@iasaude/integrations';

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
  const { specialty, city, state, lat, lng, traceId } = opts;
  const limit = opts.limit ?? 5;

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

  // 2. Fallback: Google Places (precisa de lat/lng pra buscar por raio)
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    await writeLog('warn', 'clinic-discovery', `sem lat/lng — não dá pra buscar Places, retornando só ${cached.length} do cache`, { traceId });
    return cached;
  }

  let places: PlaceResult[] = [];
  try {
    places = await findNearbyClinics(lat, lng, specialty, 5000, 10);
    if (places.length < 3) {
      places = await findNearbyClinics(lat, lng, specialty, 10000, 10);
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

  // 3. Upsert das clínicas em `clinics` (sem whatsapp_e164 — precisa de captura manual depois)
  const upserted: ClinicCandidate[] = [...cached];
  const cachedIds = new Set(cached.map((c) => c.id));

  for (const p of places) {
    try {
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
      }, { onConflict: 'google_place_id' }).select('id, name, whatsapp_e164, phone_e164, accepts_plans, specialties').single();

      if (!row?.id) continue;
      if (cachedIds.has(row.id)) continue;

      // Só inclui na candidate list se tem whatsapp_e164
      if (!row.whatsapp_e164) continue;

      upserted.push({
        id: row.id,
        name: row.name ?? p.name,
        whatsapp_e164: row.whatsapp_e164,
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
