/**
 * Config de runtime — o patch que APAGAVA a configuração (auditoria 22/09, P0-8).
 *
 * A rota do dashboard monta um objeto com TODAS as chaves e `undefined` nas que o
 * body não trouxe. Com `{...atual, ...patch}` + `JSON.stringify`, um clique num
 * toggle deixava o arquivo com uma chave só: a Xarlote voltava a ligar sozinha e
 * modelo/chave/prompt sumiam. Estes testes são o funil.
 */
import { describe, it, expect } from 'vitest';
import {
  aplicarPatchDeConfig,
  mascararSegredos,
  type PromptsConfig,
} from '../apps/api/src/config/prompts.js';

const overridesAtuais: Partial<PromptsConfig> = {
  llm_model: 'z-ai/glm-5.2',
  llm_api_key: 'sk-or-v1-chave-secreta-ab12',
  sara_suffix: 'fale curtinho',
  xarlote_enabled: false,
  pharmacy_outbound_enabled: false,
};

describe('aplicarPatchDeConfig', () => {
  it('um toggle não apaga as outras chaves (o defeito)', () => {
    // Exatamente o que a rota monta: uma chave real, o resto `undefined`.
    const patchDaRota: Partial<PromptsConfig> = {
      reminders_enabled: false,
      llm_model: undefined,
      llm_api_key: undefined,
      sara_suffix: undefined,
      xarlote_enabled: undefined,
      pharmacy_outbound_enabled: undefined,
    };
    const novo = aplicarPatchDeConfig(overridesAtuais, patchDaRota);
    expect(novo.reminders_enabled).toBe(false);
    expect(novo.llm_model).toBe('z-ai/glm-5.2');
    expect(novo.sara_suffix).toBe('fale curtinho');
    expect(novo.llm_api_key).toBe('sk-or-v1-chave-secreta-ab12');
  });

  it('não religa a Xarlote que estava desligada', () => {
    const novo = aplicarPatchDeConfig(overridesAtuais, { tts_enabled: true, xarlote_enabled: undefined });
    expect(novo.xarlote_enabled).toBe(false);
    expect(novo.pharmacy_outbound_enabled).toBe(false);
  });

  it('`false` explícito continua valendo (undefined ≠ false)', () => {
    const novo = aplicarPatchDeConfig({ xarlote_enabled: true }, { xarlote_enabled: false });
    expect(novo.xarlote_enabled).toBe(false);
  });

  it('valor mascarado vindo da tela não vira chave de API', () => {
    const novo = aplicarPatchDeConfig(overridesAtuais, { llm_api_key: '••••ab12' });
    expect(novo.llm_api_key).toBe('sk-or-v1-chave-secreta-ab12');
  });

  it('string vazia LIMPA a chave (intenção explícita de voltar pro env)', () => {
    const novo = aplicarPatchDeConfig(overridesAtuais, { llm_api_key: '' });
    expect(novo.llm_api_key).toBe('');
  });

  it('prompt COM BULLET é salvo — máscara só vale pra chave de API (achado da revisão)', () => {
    // A 1ª versão descartava qualquer string com `•`. O fundador escrevia o prompt em
    // tópicos, salvava, a tela dizia "salvo" e nada mudava.
    const prompt = '• seja breve\n• nunca diagnostique\n• 192 em emergência';
    const novo = aplicarPatchDeConfig(overridesAtuais, { sara_suffix: prompt });
    expect(novo.sara_suffix).toBe(prompt);
  });

  it('bullet NO MEIO de uma chave de API não a descarta (só a máscara, que começa com •)', () => {
    const novo = aplicarPatchDeConfig(overridesAtuais, { llm_api_key: 'sk-or-v1-com•bullet' });
    expect(novo.llm_api_key).toBe('sk-or-v1-com•bullet');
  });

  it('patch vazio é no-op', () => {
    expect(aplicarPatchDeConfig(overridesAtuais, {})).toEqual(overridesAtuais);
  });
});

describe('mascararSegredos', () => {
  const cfg = { llm_api_key: 'sk-or-v1-abcdefgh', tts_api_key: '', llm_model: 'z-ai/glm-5.2' } as PromptsConfig;

  it('nunca devolve a chave inteira, mas deixa o fundador reconhecê-la', () => {
    const m = mascararSegredos(cfg);
    expect(m.llm_api_key).toBe('••••efgh');
    expect(m.llm_api_key).not.toContain('sk-or-v1-abcd');
  });

  it('chave ausente continua vazia (não vira "••••")', () => {
    expect(mascararSegredos(cfg).tts_api_key).toBe('');
  });

  it('o resto da config passa intacto', () => {
    expect(mascararSegredos(cfg).llm_model).toBe('z-ai/glm-5.2');
  });

  it('a máscara é rejeitada pelo patch — round-trip da tela não apaga a chave', () => {
    const daTela = mascararSegredos(cfg);
    const novo = aplicarPatchDeConfig({ llm_api_key: cfg.llm_api_key }, { llm_api_key: daTela.llm_api_key });
    expect(novo.llm_api_key).toBe('sk-or-v1-abcdefgh');
  });
});
