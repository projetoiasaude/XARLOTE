/**
 * O link de consentimento LGPD apontava pra `iadasaude.com/privacidade`, que em 08/09/2026
 * servia a política de OUTRA empresa ("Radar Materno"). 32 pacientes receberam esse link.
 * Estes testes travam o padrão na página nossa e provam que a sonda distingue as duas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LGPD_POLICY_URL, politicaDePrivacidadeEhNossa, PRIVACY_POLICY_SENTINELS } from '../packages/shared/src/constants.js';

describe('a URL padrão da política', () => {
  it('é a página da Xarlote no xarlote.com.br — nunca mais iadasaude.com', () => {
    if (!process.env['PRIVACY_POLICY_URL']) expect(LGPD_POLICY_URL).toBe('https://xarlote.com.br/privacidade');
    expect(LGPD_POLICY_URL).not.toContain('iadasaude');
  });
  it('a página publicada em apps/web/public/privacidade.html passa na sonda', () => {
    const html = readFileSync(new URL('../apps/web/public/privacidade.html', import.meta.url), 'utf8');
    expect(politicaDePrivacidadeEhNossa(html)).toBe(true);
  });
});

describe('a sonda distingue a nossa política de qualquer outra', () => {
  it('o HTML que estava no ar em iadasaude.com (Radar Materno) é reprovado', () => {
    const radar = '<!DOCTYPE html><html lang="pt-BR"><head><title data-rh="true">Política de Privacidade - Radar Materno</title><meta name="google-adsense-account" content="ca-pub-9120502827623005"></head><body>Política de Privacidade - Radar Materno, portal editorial sobre gravidez.</body></html>';
    expect(politicaDePrivacidadeEhNossa(radar)).toBe(false);
  });
  it('exige TODAS as sentinelas (nome do produto e CNPJ da CRIATE)', () => {
    expect(PRIVACY_POLICY_SENTINELS).toContain('54.236.008/0001-80');
    expect(politicaDePrivacidadeEhNossa('<h1>Xarlote</h1>')).toBe(false);
    expect(politicaDePrivacidadeEhNossa('<h1>Xarlote</h1> CNPJ 54.236.008/0001-80')).toBe(true);
    expect(politicaDePrivacidadeEhNossa('')).toBe(false);
    expect(politicaDePrivacidadeEhNossa(null)).toBe(false);
  });
});
