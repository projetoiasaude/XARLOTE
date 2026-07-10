import { describe, it, expect } from 'vitest';
import {
  CONSENT_ACCEPTED_PATTERNS,
  FORGET_ME_PATTERNS,
  EMERGENCY_KEYWORDS,
} from '../packages/shared/src/constants';
import { isConsentAccepted } from '../packages/core/src/lgpd/index.js';

const matchesAny = (patterns: RegExp[], s: string): boolean =>
  patterns.some((re) => re.test(s.trim()));

describe('consentimento LGPD — detecção de aceite', () => {
  it.each(['aceito', 'sim', 'concordo', 'ok aceito', 'topei', 'pode', 'sim aceito'])(
    'reconhece "%s" como aceite',
    (msg) => {
      expect(matchesAny(CONSENT_ACCEPTED_PATTERNS, msg)).toBe(true);
    },
  );
  // Incidente Elizabet 09/07: o label do BOTÃO ("Aceitar") não estava na lista — o aceite
  // real dela só "funcionou" porque QUALQUER texto valia. Agora o botão e afirmações
  // comuns de idoso ("beleza", "tá bom", "ok") são aceite explícito.
  it.each(['Aceitar', 'aceitar', 'ok', 'OK', 'beleza', 'blz', 'tá bom', 'ta bom', 'pode ser', 'de acordo', 'claro', 'autorizo', '👍', '✅'])(
    'reconhece "%s" como aceite (botão + afirmações claras)',
    (msg) => {
      expect(matchesAny(CONSENT_ACCEPTED_PATTERNS, msg)).toBe(true);
    },
  );
  it.each(['não', 'depois', 'o que é isso?', 'quero dipirona', 'me lembra da quimioterapia amanhã às 7h', 'não aceito', 'ok, mas o que vocês fazem com meus dados?'])(
    'NÃO trata "%s" como aceite (só manifestação inequívoca — LGPD art. 5º XII)',
    (msg) => {
      expect(matchesAny(CONSENT_ACCEPTED_PATTERNS, msg)).toBe(false);
    },
  );
});

describe('esquece-me (LGPD) — detecção de revogação', () => {
  it.each([
    'quero apagar meus dados',
    'esquecer meus dados',
    'revogar consentimento',
    'deletar minha conta',
    'quero sair',
  ])('reconhece "%s" como forget-me', (msg) => {
    expect(matchesAny(FORGET_ME_PATTERNS, msg)).toBe(true);
  });
  it('não dispara em conversa normal', () => {
    expect(matchesAny(FORGET_ME_PATTERNS, 'quero ver meus dados de novo na tela')).toBe(false);
  });
});

describe('red-flag — keywords de emergência presentes', () => {
  it.each(['infarto', 'convulsão', 'hemorragia', 'inconsciente', 'overdose'])(
    'contém "%s"',
    (kw) => {
      expect(EMERGENCY_KEYWORDS).toContain(kw);
    },
  );
});

describe('isConsentAccepted — tolerância a pontuação (review 10/07 #24)', () => {
  it.each(['aceito!', 'Sim.', 'ok 👍', 'aceitei', 'já aceitei', 'Aceito, sim', 'sim, quero', 'Aceitar!', 'beleza!!', '👍'])(
    'aceita "%s" (pontuação/emoji final não quebra o aceite)',
    (msg) => {
      expect(isConsentAccepted(msg)).toBe(true);
    },
  );
  it.each(['ok, mas o que fazem com meus dados?', 'aceito depois', 'não aceito!', 'quero dipirona!'])(
    'continua recusando "%s"',
    (msg) => {
      expect(isConsentAccepted(msg)).toBe(false);
    },
  );
});
