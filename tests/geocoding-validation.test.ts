import { describe, expect, it } from 'vitest';
import { cepSectorMatches, classifyGeocodeHit } from '../packages/integrations/src/geocoding.js';

// Incidente Glauber 12/07: o usuário digitou CEP 74255-240 (Jardim América) e o Nominatim
// devolveu um endereço em 74460-020 (Jardim Petrópolis) rotulado como "preciso". A validação
// de setor postal (3 primeiros dígitos) tem que rejeitar esse match.
describe('cepSectorMatches (validação de endereço geocodado — incidente Glauber)', () => {
  it('CASO GLAUBER: 74255 (digitado) vs 74460 (resultado) → setores diferentes → REJEITA', () => {
    expect(cepSectorMatches('74255240', '74460-020')).toBe(false);
  });

  it('mesmo setor postal (3 primeiros dígitos iguais) → aceita', () => {
    expect(cepSectorMatches('74255240', '74255-240')).toBe(true); // idêntico
    expect(cepSectorMatches('74255240', '74258-100')).toBe(true); // mesma casa/vizinho, mesmo setor 742
    expect(cepSectorMatches('74255240', '74250-000')).toBe(true);
  });

  it('setor diferente (mesmo município) → rejeita', () => {
    expect(cepSectorMatches('74255240', '74460020')).toBe(false); // 742 vs 744
    expect(cepSectorMatches('01310100', '01001000')).toBe(false); // 013 vs 010 (SP)
  });

  it('aceita CEP do resultado com ou sem hífen', () => {
    expect(cepSectorMatches('74255240', '74255-240')).toBe(true);
    expect(cepSectorMatches('74255-240', '74255240')).toBe(true);
  });

  it('sem CEP no resultado (Nominatim não trouxe postcode) → indeterminado (null)', () => {
    expect(cepSectorMatches('74255240', null)).toBe(null);
    expect(cepSectorMatches('74255240', undefined)).toBe(null);
    expect(cepSectorMatches('74255240', '')).toBe(null);
    expect(cepSectorMatches('74255240', 'abc')).toBe(null);
  });

  it('CEP de entrada inválido/curto → indeterminado', () => {
    expect(cepSectorMatches('742', '74255-240')).toBe(null);
    expect(cepSectorMatches('', '74255-240')).toBe(null);
  });

  it('postcode do resultado com texto extra (ex.: "74255-240, Brasil") → usa os dígitos', () => {
    expect(cepSectorMatches('74255240', 'CEP 74255-240')).toBe(true);
    expect(cepSectorMatches('74255240', '74460-020, Goiás')).toBe(false);
  });
});

// classifyGeocodeHit: a decisão texto-do-usuário × CEP (review 12/07 — evita as 2 regressões:
// ViaCEP-first tautológico e nukar rua-correta por typo de CEP).
describe('classifyGeocodeHit (texto do usuário vs CEP)', () => {
  it('CASO GLAUBER: rua mis-resolveu p/ bairro errado, CEP confirmado diverge → CONFLITO (pede pin, não entrega errado)', () => {
    // texto "R. C-131" → Nominatim casou Jardim Petrópolis (744); CEP 74255 confirmado = 742
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: true, cepMatch: false, bairroMatch: false }))
      .toBe('conflict');
  });

  it('rua e CEP CONCORDAM (setor do CEP bate) → preciso', () => {
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: true, cepMatch: true, bairroMatch: null })).toBe('precise');
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: true, cepMatch: null, bairroMatch: true })).toBe('precise');
  });

  it('REGRESSÃO #2: rua correta + CEP typo que o ViaCEP NÃO achou → confia no texto (preciso, não nuka)', () => {
    // cepConfirmed=false porque o typo não resolveu no ViaCEP
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: false, cepMatch: null, bairroMatch: null })).toBe('precise');
    // mesmo que o postcode do hit "divirja" do CEP cru, sem confirmação não rejeita
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: false, cepMatch: false, bairroMatch: null })).toBe('precise');
  });

  it('sem CEP nenhum → confia no texto', () => {
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: false, cepMatch: null, bairroMatch: null })).toBe('precise');
  });

  it('hit genérico (cidade/estado) → low', () => {
    expect(classifyGeocodeHit({ isPreciseType: false, cepConfirmed: true, cepMatch: true, bairroMatch: true })).toBe('low');
  });

  it('CEP confirmado, hit sem postcode nem bairro (indeterminado) → aceita o texto', () => {
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: true, cepMatch: null, bairroMatch: null })).toBe('precise');
  });

  it('bairro confirma mesmo com CEP setor diferente (limite de setor) → preciso (concordância por bairro)', () => {
    expect(classifyGeocodeHit({ isPreciseType: true, cepConfirmed: true, cepMatch: false, bairroMatch: true })).toBe('precise');
  });
});
