/**
 * O primeiro paciente real na frente de exames (Ciro, 16–18/09/2026): o lembrete que
 * prometia "vou entrar no site do CDI", e o protocolo de retirada gravado como resultado.
 */
import { describe, it, expect } from 'vitest';
import { sanitizarCorpoDeLembrete, prometeAcaoDaXarlote } from '../packages/shared/src/reminder-body';
import { pareceProtocoloDeRetirada } from '../packages/shared/src/protocolo-de-retirada';

describe('lembrete não promete ação da Xarlote', () => {
  it('o body real de 17/09 perde as duas promessas e mantém o fato', () => {
    const r = sanitizarCorpoDeLembrete('Oi Ciro! O resultado do seu EEG prolongado do CDI G já deve estar disponível. Vou entrar no site do CDI com seu protocolo pra buscar o resultado. Já volto com novidades!');
    expect(r.body).toBe('Oi Ciro! O resultado do seu EEG prolongado do CDI G já deve estar disponível.');
    expect(r.removidas).toEqual(['Vou entrar no site do CDI com seu protocolo pra buscar o resultado.', 'Já volto com novidades!']);
  });
  it('o que o PACIENTE faz fica; "te aviso assim que" e "estou entrando" caem', () => {
    expect(prometeAcaoDaXarlote('Toma 1 comprimido agora, depois das 13h30.')).toBe(false);
    expect(prometeAcaoDaXarlote('Leva o exame na consulta de amanhã!')).toBe(false);
    expect(prometeAcaoDaXarlote('Hoje é dia de buscar o resultado no CDI, a partir das 17h30.')).toBe(false);
    expect(prometeAcaoDaXarlote('Te aviso assim que o resultado sair.')).toBe(true);
    expect(prometeAcaoDaXarlote('Estou entrando no site pra pegar o laudo.')).toBe(true);
    expect(prometeAcaoDaXarlote('Vou ligar pra clínica e confirmo.')).toBe(true);
  });
  it('body só de promessa vira null (o chamador usa o título)', () => {
    expect(sanitizarCorpoDeLembrete('Vou buscar seu resultado. Já volto!').body).toBeNull();
  });
});

describe('protocolo de retirada não é resultado', () => {
  it('as duas chamadas reais de 18/09 são protocolo', () => {
    expect(pareceProtocoloDeRetirada({
      title: 'RM Crânio (Encéfalo)',
      summary: 'Exame realizado em 14/09/2026 no laboratório IGR, código 1474509. Prazo de entrega previsto de 2 dias úteis após realização do exame. Resultados disponíveis por 180 dias. Retirada presencial ou acesso pelo site www.igr.com.br.',
      findings: [{ marker: 'Código do procedimento', value: '1474509', unit: '', reference: '' }],
    })).toBe(true);
    expect(pareceProtocoloDeRetirada({
      title: 'RM Crânio (Encéfalo)',
      summary: 'Exame realizado em 14/09/2026 no laboratório IGR, código 1474509. Resultados disponíveis para retirada presencial ou acesso pelo site www.igr.com.br.',
      findings: [],
    })).toBe(true);
  });
  it('laudo de verdade (achado clínico) passa, mesmo citando o site do laboratório', () => {
    expect(pareceProtocoloDeRetirada({
      title: 'Hemograma', summary: 'Hemograma completo colhido no laboratório; resultado disponível no site.',
      findings: [{ marker: 'Hemoglobina', value: '13,2', unit: 'g/dL', reference: '12,0 a 16,0' }],
    })).toBe(false);
    expect(pareceProtocoloDeRetirada({
      title: 'RM de crânio', summary: 'Exame sem alterações significativas. Sem sinais de lesão expansiva.', findings: [],
    })).toBe(false);
  });
});
