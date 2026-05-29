import { describe, it, expect } from 'vitest';
import {
  CONSENT_ACCEPTED_PATTERNS,
  FORGET_ME_PATTERNS,
  EMERGENCY_KEYWORDS,
} from '../packages/shared/src/constants';

const matchesAny = (patterns: RegExp[], s: string): boolean =>
  patterns.some((re) => re.test(s.trim()));

describe('consentimento LGPD — detecção de aceite', () => {
  it.each(['aceito', 'sim', 'concordo', 'ok aceito', 'topei', 'pode', 'sim aceito'])(
    'reconhece "%s" como aceite',
    (msg) => {
      expect(matchesAny(CONSENT_ACCEPTED_PATTERNS, msg)).toBe(true);
    },
  );
  it.each(['não', 'depois', 'o que é isso?', 'quero dipirona'])(
    'NÃO trata "%s" como aceite',
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
