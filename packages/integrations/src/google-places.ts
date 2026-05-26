import axios from 'axios';

// Uses the Legacy Places API (Nearby Search) which is enabled on this project.
// Places API (New) requires separate activation at console.developers.google.com.
const NEARBY_SEARCH = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACE_DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

function getKey(): string {
  const k = process.env['GOOGLE_MAPS_API_KEY'];
  if (!k) throw new Error('Missing GOOGLE_MAPS_API_KEY');
  return k;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  phone?: string;
  website?: string;
  rating?: number;
  userRatingCount?: number;
  distanceKm?: number;
  isOpen?: boolean;
}

// Names/types that Google Places Legacy returns as "pharmacy" but aren't real human pharmacies.
// Keep as lowercased substrings; matched against name + types[].
const PHARMACY_NAME_BLOCKLIST = [
  'pet ',
  'pets ',
  'petshop',
  'pet shop',
  'pet-shop',
  'veterinár',
  'veterinari',
  'agropecuár',
  'agropecuari',
  'animal',
  'ração',
  'racao',
  'aquári',
];

const PHARMACY_TYPE_BLOCKLIST = ['pet_store', 'veterinary_care'];

function isLikelyHumanPharmacy(name: string, types: string[]): boolean {
  const n = name.toLowerCase();
  if (PHARMACY_NAME_BLOCKLIST.some((kw) => n.includes(kw))) return false;
  if (types.some((t) => PHARMACY_TYPE_BLOCKLIST.includes(t))) return false;
  // Must include at least one of these types (Google ranks loosely with type=pharmacy)
  const ok = types.some((t) => ['pharmacy', 'drugstore', 'health', 'store'].includes(t));
  return ok || types.length === 0;
}

// ─── Clínicas / Consultórios / Hospitais ────────────────────────────────────
// Para CONSULTA MÉDICA. Diferente de farmácia: filtros por especialidade,
// tipos diferentes (doctor, hospital), e termos de busca em PT-BR.

const CLINIC_NAME_BLOCKLIST = [
  'pet ',
  'pets ',
  'veterinár',
  'animal',
  'farmácia',
  'drograria',
  'drogaria',
];

const CLINIC_TYPE_BLOCKLIST = ['pet_store', 'veterinary_care', 'pharmacy', 'drugstore'];

function isLikelyHumanClinic(name: string, types: string[]): boolean {
  const n = name.toLowerCase();
  if (CLINIC_NAME_BLOCKLIST.some((kw) => n.includes(kw))) return false;
  if (types.some((t) => CLINIC_TYPE_BLOCKLIST.includes(t))) return false;
  return types.some((t) =>
    ['doctor', 'hospital', 'health', 'physiotherapist', 'dentist', 'clinic'].includes(t)
  ) || types.length === 0;
}

/**
 * Busca clínicas/consultórios próximos. `specialty` é usado como `keyword`
 * pra refinar (ex: "cardiologista", "ginecologista", "ortopedista").
 *
 * Retorna no máximo `limit` resultados ordenados pelo score do Google.
 * Cada PlaceResult já vem com lat/lng/address/rating/distância.
 */
export async function findNearbyClinics(
  lat: number,
  lng: number,
  specialty: string,
  radiusMeters = 5000,
  limit = 8
): Promise<PlaceResult[]> {
  const res = await axios.get(NEARBY_SEARCH, {
    params: {
      location: `${lat},${lng}`,
      radius: radiusMeters,
      type: 'doctor', // Google trata "doctor" e "hospital" como categoria de saúde
      keyword: specialty,
      key: getKey(),
      language: 'pt-BR',
    },
    timeout: 10_000,
  });

  if (res.data?.status !== 'OK' && res.data?.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error (clinics): ${res.data?.status} — ${res.data?.error_message ?? ''}`);
  }

  const places: unknown[] = res.data?.results ?? [];
  const filtered = places.filter((p: any) => {
    const name = (p.name ?? '') as string;
    const types = (p.types ?? []) as string[];
    return isLikelyHumanClinic(name, types);
  });

  return filtered.slice(0, limit).map((p: any) => {
    const vicinity: string = p.vicinity ?? '';
    const parts = vicinity.split(',').map((s: string) => s.trim());
    const city = parts.at(-1) ?? '';
    const distKm = haversineKm(lat, lng, p.geometry?.location?.lat, p.geometry?.location?.lng);

    return {
      placeId: p.place_id as string,
      name: (p.name ?? 'Clínica') as string,
      address: vicinity,
      city,
      state: '',
      lat: p.geometry?.location?.lat as number,
      lng: p.geometry?.location?.lng as number,
      phone: undefined,
      website: undefined,
      rating: p.rating as number | undefined,
      userRatingCount: (p.user_ratings_total as number) ?? undefined,
      distanceKm: distKm,
      isOpen: p.opening_hours?.open_now as boolean | undefined,
    };
  });
}

export async function findNearbyPharmacies(
  lat: number,
  lng: number,
  radiusMeters = 3000
): Promise<PlaceResult[]> {
  const res = await axios.get(NEARBY_SEARCH, {
    params: {
      location: `${lat},${lng}`,
      radius: radiusMeters,
      type: 'pharmacy',
      keyword: 'farmácia',
      key: getKey(),
      language: 'pt-BR',
    },
    timeout: 10_000,
  });

  if (res.data?.status !== 'OK' && res.data?.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${res.data?.status} — ${res.data?.error_message ?? ''}`);
  }

  const places: unknown[] = res.data?.results ?? [];
  const filtered = places.filter((p: any) => {
    const name = (p.name ?? '') as string;
    const types = (p.types ?? []) as string[];
    return isLikelyHumanPharmacy(name, types);
  });

  return filtered.map((p: any) => {
    const vicinity: string = p.vicinity ?? '';
    // vicinity is like "Av Paulista, 1000 - Jardins, São Paulo"
    // Try to parse city from the last segment after the last dash
    const parts = vicinity.split(',').map((s: string) => s.trim());
    const city = parts.at(-1) ?? '';
    const state = '';           // Nearby Search doesn't return state directly
    const distKm = haversineKm(lat, lng, p.geometry?.location?.lat, p.geometry?.location?.lng);

    return {
      placeId: p.place_id as string,
      name: (p.name ?? 'Farmácia') as string,
      address: vicinity,
      city,
      state,
      lat: p.geometry?.location?.lat as number,
      lng: p.geometry?.location?.lng as number,
      phone: undefined,           // Requires Place Details call
      website: undefined,
      rating: p.rating as number | undefined,
      userRatingCount: (p.user_ratings_total as number) ?? undefined,
      distanceKm: distKm,
      isOpen: p.opening_hours?.open_now as boolean | undefined,
    };
  });
}

/**
 * geocodeAddress foi movida para ./geocoding.ts (Nominatim com normalização BR + fallbacks).
 */

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const res = await axios.get(GEOCODING_BASE, {
    params: { latlng: `${lat},${lng}`, key: getKey(), language: 'pt-BR' },
    timeout: 8_000,
  });
  return res.data?.results?.[0]?.formatted_address ?? null;
}

/** Fetch phone number for a place (requires an extra Detail call). */
export async function getPlacePhone(placeId: string): Promise<string | null> {
  try {
    const res = await axios.get(PLACE_DETAILS, {
      params: {
        place_id: placeId,
        fields: 'formatted_phone_number,international_phone_number',
        key: getKey(),
        language: 'pt-BR',
      },
      timeout: 5_000,
    });
    return (res.data?.result?.international_phone_number as string) ?? null;
  } catch {
    return null;
  }
}

export function haversineKm(lat1: number, lng1: number, lat2?: number, lng2?: number): number {
  if (!lat2 || !lng2) return 0;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
