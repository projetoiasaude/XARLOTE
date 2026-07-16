/**
 * Push notifications via Firebase Cloud Messaging (FCM HTTP v1).
 *
 * Um único canal entrega pra Android (FCM nativo) E iOS (FCM → APNs). Usado pra
 * acordar o app nativo (Capacitor) quando a Xarlote fala primeiro — lembrete,
 * resultado de cotação, alerta. Complementa o WhatsApp; não o substitui.
 *
 * Credenciais (service account do Firebase) vêm do ambiente — se ausentes, todo
 * envio é no-op gracioso (mesmo padrão de Sentry/Telegram): o backend nunca quebra
 * por falta de push. Setar em produção:
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY  (do JSON da service account)
 *
 * A legacy FCM API foi desligada (jun/2024) — aqui usamos HTTP v1 com OAuth2
 * (JWT assinado RS256 → access token, cacheado ~50min).
 */
import { createSign } from 'crypto';

interface PushTarget {
  token: string;
  platform: 'ios' | 'android' | 'web';
}

export interface PushMessage {
  title: string;
  body: string;
  /** dados extras entregues ao app (ex: deep-link, reminder_id) */
  data?: Record<string, string>;
}

export interface PushResult {
  sent: number;
  /** tokens que o FCM reportou como mortos → o caller deve deletá-los */
  invalidTokens: string[];
  skipped?: 'no_credentials';
}

function creds(): { projectId: string; clientEmail: string; privateKey: string } | null {
  const projectId = process.env['FCM_PROJECT_ID'];
  const clientEmail = process.env['FCM_CLIENT_EMAIL'];
  // a private key vem com \n escapado quando setada via env de painel
  const privateKey = process.env['FCM_PRIVATE_KEY']?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

export function isPushConfigured(): boolean {
  return creds() !== null;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Troca o JWT da service account por um access token OAuth2 (cacheado). */
async function getAccessToken(clientEmail: string, privateKey: string, nowMs: number): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > nowMs + 60_000) return cachedToken.value;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKey));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    // teto de tempo (review M4): sem isso uma conexão FCM meio-aberta segura o `await` do
    // dispatcher de lembretes. O caller já trata erro (return sent:0) → degrada gracioso.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FCM oauth falhou: ${res.status} ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: nowMs + json.expires_in * 1000 };
  return json.access_token;
}

/**
 * Envia uma notificação pra um ou mais aparelhos. Tolerante a falha: erros de
 * rede não lançam (retornam sent:0); tokens mortos voltam em invalidTokens.
 * `nowMs` é injetável só pra teste — em produção use Date.now().
 */
export async function sendPush(
  targets: PushTarget[],
  msg: PushMessage,
  nowMs: number = Date.now(),
): Promise<PushResult> {
  const c = creds();
  if (!c) return { sent: 0, invalidTokens: [], skipped: 'no_credentials' };
  if (!targets.length) return { sent: 0, invalidTokens: [] };

  let accessToken: string;
  try {
    accessToken = await getAccessToken(c.clientEmail, c.privateKey, nowMs);
  } catch {
    return { sent: 0, invalidTokens: [] };
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`;
  let sent = 0;
  const invalidTokens: string[] = [];

  // FCM v1 envia 1 token por request. Lotes pequenos (lembretes são individuais),
  // então sequencial está OK; paraleliza se virar gargalo.
  await Promise.all(
    targets.map(async (t) => {
      const message = {
        message: {
          token: t.token,
          notification: { title: msg.title, body: msg.body },
          data: msg.data ?? {},
          android: { priority: 'HIGH', notification: { sound: 'default' } },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        },
      };
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(10_000), // teto de tempo (review M4)
        });
        if (res.ok) {
          sent++;
          return;
        }
        // Token morto/desregistrado → caller remove do banco.
        if (res.status === 404 || res.status === 400) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
          const status = errBody.error?.status;
          if (status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') {
            invalidTokens.push(t.token);
          }
        }
      } catch {
        // erro de rede — ignora (não derruba o dispatcher)
      }
    }),
  );

  return { sent, invalidTokens };
}
