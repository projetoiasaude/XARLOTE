import { describe, it, expect } from 'vitest';
import { CONSENT_ACCEPTED_PATTERNS } from '../packages/shared/src/constants';
import { categoriaDeEmergenciaNaFala } from '../packages/shared/src/emergencia-determinista.js';
import { isConsentAccepted, isForgetMeRequest } from '../packages/core/src/lgpd/index.js';

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
    // 22/09: era só "quero sair", e essa linha FOSSILIZAVA o defeito — sair sem objeto
    // casava com "quero sair de casa às 8h". O objeto passou a ser obrigatório.
    'quero sair do app',
  ])('reconhece "%s" como forget-me', (msg) => {
    expect(isForgetMeRequest(msg)).toBe(true);
  });
  it('não dispara em conversa normal', () => {
    expect(isForgetMeRequest('quero ver meus dados de novo na tela')).toBe(false);
    expect(isForgetMeRequest('quero sair de casa às 8h, me lembra?')).toBe(false);
  });
});

describe('red-flag — a fala vira emergência (antes o teste só conferia a lista em si)', () => {
  // A versão anterior fazia `expect(EMERGENCY_KEYWORDS).toContain('infarto')`: uma
  // constante afirmando conter o que ela mesma declara. Passava sempre, inclusive quando
  // NADA no código usava a lista — que era exatamente o caso. Agora testa COMPORTAMENTO.
  it.each([
    ['acho que meu pai teve um infarto agora', 'other_critical'],
    ['ele está tendo uma convulsão', 'other_critical'],
    ['começou uma hemorragia', 'other_critical'],
    ['ela está inconsciente', 'other_critical'],
    ['tomei a cartela inteira', 'overdose'],
  ])('"%s" → %s', (fala, categoria) => {
    expect(categoriaDeEmergenciaNaFala(fala)).toBe(categoria);
  });
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
