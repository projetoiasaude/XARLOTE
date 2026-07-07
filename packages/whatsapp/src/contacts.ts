import { toE164BR, isPlaceholderPhone } from '@iasaude/shared';

/** Um contato compartilhado já normalizado. */
export interface SharedContact {
  name: string;
  phoneE164: string;
  org?: string;
}

/**
 * Extrai o(s) contato(s) de um payload de mensagem de contato do WhatsApp.
 *
 * Formato real capturado (zpro/WABA, contato compartilhado pelo usuário — payload
 * do Hiago 07/07): `msg.type: "contacts"`, `msg.contacts: [{ name:{first_name,
 * formatted_name}, phones:[{phone, wa_id, type}], org?, vcard }]`. Um único envio
 * pode trazer VÁRIOS cards (o Hiago mandou "Meu Amor" 2×).
 *
 * Tolerante (o shape exato do zpro é NÃO-documentado): tenta o telefone em 3 fontes,
 * na ordem de confiança — `phones[].wa_id` (o id REAL do WhatsApp) → `phones[].phone`
 * (display) → linha `TEL` do `vcard` cru. Ignora cards sem telefone válido. Dedup por
 * telefone (mesmo card 2×).
 */
export function extractSharedContacts(rawMsg: unknown): SharedContact[] {
  const msg = (rawMsg ?? {}) as Record<string, unknown>;
  // aceita tanto o `msg` inteiro quanto já a array de contacts
  const arr: unknown[] = Array.isArray((msg as { contacts?: unknown }).contacts)
    ? ((msg as { contacts: unknown[] }).contacts)
    : Array.isArray(rawMsg)
      ? (rawMsg as unknown[])
      : [];

  const out: SharedContact[] = [];
  const seen = new Set<string>();

  for (const c of arr) {
    const contact = (c ?? {}) as Record<string, any>;
    const name: string =
      (contact.name?.formatted_name as string) ||
      [contact.name?.first_name, contact.name?.last_name].filter(Boolean).join(' ').trim() ||
      (contact.formatted_name as string) ||
      'Contato';
    const org: string | undefined =
      (typeof contact.org === 'string' ? contact.org : undefined) ||
      (contact.org?.company as string | undefined) ||
      undefined;

    const phone = pickContactPhone(contact);
    if (!phone) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push({ name: name.slice(0, 80), phoneE164: phone, ...(org ? { org: String(org).slice(0, 80) } : {}) });
  }
  return out;
}

/**
 * wa_id/waid vêm SEMPRE com código de país (id do WhatsApp). Só aceita BR (começa
 * com 55, 12-13 dígitos). Um wa_id que NÃO começa com 55 é ESTRANGEIRO — rejeita
 * (não fabrica um número BR falso a partir dele — review: senão um contato dos EUA
 * "12025550100" virava "+5512025550100", um número BR válido MAS ERRADO).
 */
function waIdToBrE164(waRaw: unknown): string | null {
  const d = String(waRaw ?? '').replace(/\D/g, '');
  if (!(d.startsWith('55') && (d.length === 12 || d.length === 13))) return null;
  const e164 = toE164BR(d);
  return e164 && !isPlaceholderPhone(e164) ? e164 : null;
}

/** Número de exibição/digitado: rejeita país estrangeiro explícito; senão trata como BR. */
function displayToBrE164(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  // código de país explícito não-BR ("+1 ...", ou 12+ dígitos que não começam com 55)
  if (s.startsWith('+') && !digits.startsWith('55')) return null;
  if (digits.length >= 12 && !digits.startsWith('55')) return null;
  const e164 = toE164BR(s);
  return e164 && !isPlaceholderPhone(e164) ? e164 : null;
}

/** Telefone E.164 (BR) de UM contato (wa_id → phone → TEL do vcard). null se nenhum válido/BR. */
function pickContactPhone(contact: Record<string, any>): string | null {
  const phones: any[] = Array.isArray(contact.phones) ? contact.phones : [];
  // 1. wa_id (id real do WhatsApp — SÓ BR)
  for (const p of phones) {
    const e164 = waIdToBrE164(p?.wa_id ?? p?.waId);
    if (e164) return e164;
  }
  // 2. phone (formato de exibição — rejeita estrangeiro explícito)
  for (const p of phones) {
    const e164 = displayToBrE164(p?.phone ?? p?.number ?? (typeof p === 'string' ? p : null));
    if (e164) return e164;
  }
  // 3. vcard cru: waid (SÓ BR) → linha TEL
  const vcard = contact.vcard;
  if (typeof vcard === 'string' && vcard) {
    const waid = vcard.match(/waid=(\d{10,15})/i)?.[1];
    const e1 = waIdToBrE164(waid);
    if (e1) return e1;
    const tel = vcard.match(/TEL[^:\n]*:([+\d()\s-]{8,})/i)?.[1];
    const e2 = displayToBrE164(tel);
    if (e2) return e2;
  }
  return null;
}
