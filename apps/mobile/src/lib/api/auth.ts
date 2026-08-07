/**
 * Os contratos de /app/auth/* e /app/me, tipados de um lado só.
 *
 * Os tipos são cópias fiéis do que apps/api/src/routes/app/{auth,me}.ts devolve. Se
 * um dia o backend mudar, é AQUI que o typecheck tem que doer — nunca no meio de uma
 * tela.
 */
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { apiFetch } from './client';

export interface AuthUser {
  id: string;
  preferredName: string | null;
  phoneE164: string;
}

export interface OtpRequestResult {
  ok: true;
  expiresInS: number;
  channel: 'whatsapp';
}

export interface VerifyResult {
  accessToken: string;
  accessExpiresInS: number;
  refreshToken: string;
  user: AuthUser;
  consentRequired: boolean;
}

export interface MeResult {
  user: {
    id: string;
    preferredName: string | null;
    fullName: string | null;
    phoneE164: string;
    createdAt: string;
    adherenceScore30d: number | null;
    lgpdConsentAt: string | null;
    lgpdConsentVersion: string | null;
  };
  consentRequired: boolean;
  session: { id: string; deviceName: string | null; platform: string; createdAt: string } | null;
  flags: { xarloteEnabled: boolean; pushConfigured: boolean };
}

function currentPlatform(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/** "iPhone 15 de Ciro" fica na lista de sessões — nome de aparelho ajuda a revogar certo. */
function deviceName(): string | undefined {
  const name = Device.deviceName ?? Device.modelName;
  return name ? name.slice(0, 64) : undefined;
}

export function requestOtp(phoneE164: string): Promise<OtpRequestResult> {
  return apiFetch<OtpRequestResult>('/app/auth/otp/request', {
    method: 'POST',
    body: { phone: phoneE164 },
    anonymous: true,
  });
}

export function verifyOtp(phoneE164: string, code: string): Promise<VerifyResult> {
  return apiFetch<VerifyResult>('/app/auth/otp/verify', {
    method: 'POST',
    body: {
      phone: phoneE164,
      code,
      platform: currentPlatform(),
      ...(deviceName() ? { deviceName: deviceName() } : {}),
    },
    anonymous: true,
  });
}

export function logout(pushToken?: string): Promise<null> {
  return apiFetch<null>('/app/auth/logout', {
    method: 'POST',
    body: pushToken ? { pushToken } : {},
  });
}

export function fetchMe(): Promise<MeResult> {
  return apiFetch<MeResult>('/app/me');
}
