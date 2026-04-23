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
      key: getKey(),
      language: 'pt-BR',
    },
    timeout: 10_000,
  });

  if (res.data?.status !== 'OK' && res.data?.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${res.data?.status} — ${res.data?.error_message ?? ''}`);
  }

  const places: unknown[] = res.data?.results ?? [];
  return places.map((p: any) => {
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
 * Geocodifica endereço texto → lat/lng.
 * Usa Nominatim (OpenStreetMap) como primário — gratuito, sem API key.
 * Faz fallback para Google Geocoding API se GOOGLE_MAPS_API_KEY estiver configurada e Nominatim falhar.
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; formattedAddress: string } | null> {
  // 1. Tenta Nominatim (OpenStreetMap)
  try {
    const nominatimRes = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: address, format: 'json', limit: 1, countrycodes: 'br', addressdetails: 0 },
      headers: {
        'User-Agent': 'IA-da-Saude/1.0 (contact@iadasaude.com)',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 8_000,
    });
    const results = nominatimRes.data as Array<{ lat: string; lon: string; display_name: string }>;
    if (results?.length > 0 && results[0]) {
      return {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon),
        formattedAddress: results[0].display_name,
      };
    }
  } catch {
    // Nominatim falhou — tenta Google abaixo
  }

  // 2. Fallback: Google Geocoding API
  const apiKey = process.env['GOOGLE_MAPS_API_KEY'];
  if (!apiKey) return null;

  try {
    const res = await axios.get(GEOCODING_BASE, {
      params: { address, key: apiKey, language: 'pt-BR', region: 'BR' },
      timeout: 8_000,
    });
    if (res.data?.status !== 'OK') return null;
    const result = res.data?.results?.[0];
    if (!result) return null;
    return {
      lat: result.geometry.location.lat as number,
      lng: result.geometry.location.lng as number,
      formattedAddress: result.formatted_address as string,
    };
  } catch {
    return null;
  }
}

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
