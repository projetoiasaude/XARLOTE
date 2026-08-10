import { describe, it, expect } from 'vitest';
import {
  APP_EXTERNAL_PREFIX,
  appExternalId,
  buildAppInbound,
  extractAppClientId,
  isValidClientId,
} from '../apps/api/src/lib/app-inbound.js';

/**
 * A idempotência do envio pelo app.
 *
 * Três coisas dependem do MESMO `clientId`, e é por isso que este arquivo existe:
 *   • o `jobId` da fila (toque duplo não vira dois turnos de LLM),
 *   • o índice único parcial `messages(external_id) where external_id like 'app-%'`
 *     da migration 0025 (reprocessar a fila não duplica a linha),
 *   • o eco do envio otimista (a bolha "enviando…" virar definitiva).
 *
 * Se o prefixo mudar aqui e não no índice do banco, NADA quebra visivelmente — só
 * volta a duplicar mensagem em silêncio. Daí o teste de casamento explícito.
 */

const CLIENT = '3f6b1c2e-9d84-4a1f-8b77-2e5c9a0d4471';

describe('formato da chave', () => {
  it('o prefixo é exatamente o que o índice único da 0025 vigia', () => {
    // O índice é `where external_id like 'app-%'`. Este teste é o casamento.
    expect(APP_EXTERNAL_PREFIX).toBe('app-');
    expect(appExternalId(CLIENT)).toBe(`app-${CLIENT}`);
    expect(appExternalId(CLIENT).startsWith('app-')).toBe(true);
  });

  it('ida e volta é fiel', () => {
    expect(extractAppClientId(appExternalId(CLIENT))).toBe(CLIENT);
  });
});

describe('isValidClientId — a chave é do CLIENTE, então é território hostil', () => {
  it('aceita uuid', () => {
    expect(isValidClientId(CLIENT)).toBe(true);
    expect(isValidClientId(CLIENT.toUpperCase())).toBe(true);
  });

  it('recusa texto livre — ele entra em índice de banco e em chave de Redis', () => {
    // Sem esta guarda, um cliente escolheria a chave de dedup de propósito: mandar
    // com o clientId de outra pessoa colidiria com a mensagem dela.
    expect(isValidClientId('oi')).toBe(false);
    expect(isValidClientId('')).toBe(false);
    expect(isValidClientId('../../etc/passwd')).toBe(false);
    expect(isValidClientId('app-' + CLIENT)).toBe(false);
    expect(isValidClientId(`${CLIENT} `)).toBe(false);
    expect(isValidClientId(`${CLIENT}${CLIENT}`)).toBe(false);
  });

  it('recusa uuid malformado (grupo com tamanho errado)', () => {
    expect(isValidClientId('3f6b1c2e-9d84-4a1f-8b77-2e5c9a0d447')).toBe(false);
    expect(isValidClientId('3f6b1c2e9d844a1f8b772e5c9a0d4471')).toBe(false);
  });
});

describe('extractAppClientId — só reconhece o que É do app', () => {
  it('devolve null pro que veio do WhatsApp de verdade', () => {
    expect(extractAppClientId('3EB0C431C26A1D4F')).toBeNull();
    expect(extractAppClientId('wamid.HBgMNTU2Mjk4MzQ1MDI0')).toBeNull();
  });

  it('devolve null pro simulador — senão o eco vazaria pro canal errado', () => {
    expect(extractAppClientId('sim-1754500000000-abc123')).toBeNull();
  });

  it('devolve null pra ausente/vazio (inbound do WhatsApp pode não ter id)', () => {
    expect(extractAppClientId(null)).toBeNull();
    expect(extractAppClientId(undefined)).toBeNull();
    expect(extractAppClientId('')).toBeNull();
  });

  it('devolve null pro prefixo certo com miolo inválido', () => {
    // Alguém forjando `app-qualquercoisa` não deve virar um clientId aceito.
    expect(extractAppClientId('app-')).toBeNull();
    expect(extractAppClientId('app-nao-e-uuid')).toBeNull();
  });
});

describe('buildAppInbound', () => {
  const base = { phoneE164: '+5562983450244', clientId: CLIENT, text: 'oi', sentAtMs: 1_800_000_000_000 };

  it('carrega o external_id que dá a idempotência', () => {
    expect(buildAppInbound(base).externalId).toBe(`app-${CLIENT}`);
  });

  it('deriva o jid do telefone CANÔNICO recebido, sem inventar variante', () => {
    // A rota já resolveu o 9º dígito contra o usuário existente. Se aqui mexêssemos
    // no número, uma variante criaria conversa PARALELA e partiria o histórico em
    // dois — o bug do 9º dígito de 01/07 com outra roupa.
    expect(buildAppInbound(base).from.jid).toBe('5562983450244@s.whatsapp.net');
    expect(buildAppInbound({ ...base, phoneE164: '+556283450244' }).from.jid)
      .toBe('556283450244@s.whatsapp.net');
  });

  it('usa o carimbo do APARELHO, não o do servidor', () => {
    // Numa fila com atraso, `now()` do worker embaralharia a ordem das bolhas que o
    // paciente já viu na tela.
    expect(buildAppInbound(base).timestamp.getTime()).toBe(base.sentAtMs);
  });

  it('NÃO manda pushName — nome de usuário existente não pode ser sobrescrito', () => {
    // O pushName só é usado na CRIAÇÃO do usuário. Mandar daqui renomearia quem já
    // tem nome (o legado fazia `delete normalized.from.pushName` justamente por isso).
    expect(buildAppInbound(base).from.pushName).toBeUndefined();
  });

  it('marca o canal no raw, sem PII', () => {
    const raw = buildAppInbound(base).raw as Record<string, unknown>;
    expect(raw['channel']).toBe('xarlote_app');
    expect(raw['clientId']).toBe(CLIENT);
    // O telefone NÃO entra no raw_payload (ele é persistido e lido por humanos).
    expect(JSON.stringify(raw)).not.toContain('5562983450244');
  });

  it('é sempre da leg sara e nunca fromMe', () => {
    const i = buildAppInbound(base);
    expect(i.instance).toBe('sara');
    expect(i.fromMe).toBe(false);
    expect(i.contentType).toBe('text');
  });

  it('duas chamadas com o mesmo clientId produzem o MESMO external_id', () => {
    // É o coração da idempotência: reprocessar a fila tem que colidir no índice.
    expect(buildAppInbound(base).externalId).toBe(buildAppInbound({ ...base, text: 'outro' }).externalId);
  });
});
