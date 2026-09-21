/**
 * Frente de exames v2 (21/09/2026) — as decisões puras, contra os textos reais do caso Ciro.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  interpretarQuando, autorizouBuscaNoPortal, dataDeNascimentoDaFala, quandoPorExtenso,
  mensagemAgendamentoConfirmado, mensagemAgendamentoImpossivel, corpoDoLembreteDeResultado,
} from '../packages/shared/src/busca-agendada';
import {
  classificarTextoDeDocumento, previsaoDeLiberacaoDoTexto, verificarAchadosNoTexto, normalizarExtraido, blocoDeIngestaoParaModelo,
} from '../packages/shared/src/documento-de-exame';
import { prometeAcaoDaXarlote } from '../packages/shared/src/reminder-body';
import { lerPdfCompleto } from '../packages/integrations/src/pdf-leitor';

const AGORA = new Date('2026-09-16T10:25:00Z'); // 16/09 07:25 BRT — a hora em que o Ciro pediu

describe('quando buscar', () => {
  it('a previsão do protocolo (21/09 17:30) vira busca AGENDADA; sem quando é agora', () => {
    const r = interpretarQuando('2026-09-21T17:30:00-03:00', AGORA);
    expect(r.tipo).toBe('agendada');
    if (r.tipo === 'agendada') expect(quandoPorExtenso(r.em)).toBe('21/09 a partir das 17h30');
    expect(interpretarQuando(undefined, AGORA).tipo).toBe('agora');
    expect(interpretarQuando('agora', AGORA).tipo).toBe('agora');
  });
  it('data-só vale às 9h; daqui a 5 min é agora; passou há 3h é agora; passou há 3 dias é inválida; 90 dias é longe demais', () => {
    const r = interpretarQuando('2026-09-21', AGORA);
    expect(r.tipo).toBe('agendada');
    if (r.tipo === 'agendada') expect(r.em.toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(interpretarQuando('2026-09-16T07:30:00-03:00', AGORA).tipo).toBe('agora');
    expect(interpretarQuando('2026-09-16T04:00:00-03:00', AGORA).tipo).toBe('agora');
    expect(interpretarQuando('2026-09-13T09:00:00-03:00', AGORA)).toEqual({ tipo: 'invalida', motivo: 'passado' });
    expect(interpretarQuando('2026-12-30T09:00:00-03:00', AGORA)).toEqual({ tipo: 'invalida', motivo: 'longe_demais' });
    expect(interpretarQuando('quinta que vem', AGORA)).toEqual({ tipo: 'invalida', motivo: 'formato' });
  });
});

describe('autorização pela fala', () => {
  it('sim / pode / "15/03/1990, sim" / "sim, 15031990" autorizam; negações e datas soltas não', () => {
    for (const t of ['Sim', 'pode', 'Sim, pode buscar', '15/03/1990, sim', 'sim, 15031990', 'Ok! 15/03/1990', 'isso, pode']) expect(autorizouBuscaNoPortal(t), t).toBe(true);
    for (const t of ['não', 'sim, mas não agora', 'deixa pra depois', '15/03/1990', 'ainda não', 'cancela', 'pode deixar', '']) expect(autorizouBuscaNoPortal(t), t).toBe(false);
  });
  it('data de nascimento em vários formatos; implausível não', () => {
    expect(dataDeNascimentoDaFala('15/03/1990, sim', AGORA)).toBe('1990-03-15');
    expect(dataDeNascimentoDaFala('sim 15031990', AGORA)).toBe('1990-03-15');
    expect(dataDeNascimentoDaFala('1990-03-15', AGORA)).toBe('1990-03-15');
    expect(dataDeNascimentoDaFala('31/02/1990', AGORA)).toBeNull();
    expect(dataDeNascimentoDaFala('15/03/1850', AGORA)).toBeNull();
    expect(dataDeNascimentoDaFala('sim', AGORA)).toBeNull();
  });
});

describe('as frases', () => {
  const em = new Date('2026-09-21T20:30:00Z');
  it('confirmação só diz a data depois da prova, e diz o que acontece com o acesso', () => {
    const m = mensagemAgendamentoConfirmado('CDI', em);
    expect(m).toContain('21/09 a partir das 17h30');
    expect(m).toContain('cifrado');
    expect(m).toContain('apago');
  });
  it('impossível: a verdade e o caminho que funciona; o lembrete de fallback não promete ação', () => {
    const m = mensagemAgendamentoImpossivel('CDI', em, 'portal_desconhecido');
    expect(m).toContain('ainda não conheço o site do CDI');
    expect(m).toContain('21/09');
    expect(m).toContain('PDF');
    const corpo = corpoDoLembreteDeResultado('CDI', '6160668');
    expect(corpo).toContain('protocolo 6160668');
    expect(corpo.split(/(?<=[.!?])\s+/).some((o) => prometeAcaoDaXarlote(o))).toBe(false);
  });
});

describe('classificação do documento', () => {
  const PROTOCOLO_CDI = 'CDI G — Protocolo de entrega de resultados. Paciente: Ciro Souza Costa. Exame: EEG prolongado. Médico: Dra. Mayara. Protocolo 6160668 Senha 6127976. Previsão de entrega do resultado: 21/09/2026 a partir das 17:30. Atendimento de segunda a sexta das 07:00 às 18:00. Acesse resultados online em cdig.com.br';
  it('protocolo do CDI é protocolo, com a previsão lida', () => {
    const c = classificarTextoDeDocumento(PROTOCOLO_CDI);
    expect(c.tipo).toBe('protocolo');
    expect(c.previsaoLiberacao).toBe('2026-09-21T17:30:00-03:00');
    expect(previsaoDeLiberacaoDoTexto('Resultado disponível a partir de 02/10/2026')).toBe('2026-10-02T09:00:00-03:00');
  });
  it('protocolo do IGR (código, prazo, site) é protocolo; receita é receita; pedido é pedido', () => {
    expect(classificarTextoDeDocumento('IGR - Instituto Goiano de Radiologia. Protocolo de atendimento. Código do procedimento: 1474509. RM Crânio (Encéfalo). Prazo de entrega: 2 dias úteis. Resultados disponíveis por 180 dias. Retirada presencial ou acesso pelo site www.igr.com.br').tipo).toBe('protocolo');
    expect(classificarTextoDeDocumento('Receituário. Uso oral. Espironolactona 50mg — tomar 1 comprimido ao dia, uso contínuo. Dra. Roberta CRM GO 23287').tipo).toBe('receita');
    expect(classificarTextoDeDocumento('Solicito: hemograma completo, glicemia de jejum, TSH. Hipótese diagnóstica: CID E03').tipo).toBe('pedido');
    expect(classificarTextoDeDocumento('oi tudo bem').tipo).toBe('outro');
  });
  it('os dois PDFs sintéticos/reais são laudos', async () => {
    const fixture = await lerPdfCompleto(readFileSync(new URL('./fixtures/laudo-type0.pdf', import.meta.url)));
    expect(fixture.ok).toBe(true);
    if (fixture.ok) expect(classificarTextoDeDocumento(fixture.texto).tipo).toBe('laudo');
    expect(classificarTextoDeDocumento('RESSONÂNCIA MAGNÉTICA DO CRÂNIO. Técnica: sequências multiplanares. Achados: parênquima encefálico com sinal preservado. Não há sinais de lesão expansiva. Conclusão: exame dentro dos limites da normalidade.').tipo).toBe('laudo');
  });
});

describe('verificação dos achados contra o texto', () => {
  const TEXTO = 'Hemograma. Hemoglobina 13,2 g/dL 12,0 a 16,0 g/dL. Hematócrito 40,1 % 36,0 a 48,0 %. Leucócitos 6.500 /µL. Glicose 92 mg/dL';
  it('valor que está no texto fica (vírgula/ponto tanto faz); valor inventado cai', () => {
    const r = verificarAchadosNoTexto([
      { marker: 'Hemoglobina', value: '13.2', unit: 'g/dL' },
      { marker: 'Hematócrito', value: '40,1', unit: '%' },
      { marker: 'Leucócitos', value: '6.500' },
      { marker: 'Glicose', value: '92', unit: 'mg/dL' },
      { marker: 'Creatinina', value: '0,9', unit: 'mg/dL' },   // não existe no texto
      { marker: 'Plaquetas', value: '245000' },                 // não existe
    ], TEXTO);
    expect(r.mantidos.map((a) => a.marker)).toEqual(['Hemoglobina', 'Hematócrito', 'Leucócitos', 'Glicose']);
    expect(r.descartados.map((a) => a.marker)).toEqual(['Creatinina', 'Plaquetas']);
  });
  it('"92" não casa dentro de "1992" nem "920"; "6500" casa "6.500" (milhar); "13.2" não vira milhar', () => {
    expect(verificarAchadosNoTexto([{ marker: 'x', value: '92' }], 'nascido em 1992, peso 920 g').mantidos).toEqual([]);
    expect(verificarAchadosNoTexto([{ marker: 'Leucócitos', value: '6500' }], 'Leucócitos 6.500 /µL').mantidos.length).toBe(1);
    expect(verificarAchadosNoTexto([{ marker: 'Plaquetas', value: '245.000' }], 'Plaquetas 245000 /µL').mantidos.length).toBe(1);
    expect(verificarAchadosNoTexto([{ marker: 'Hb', value: '132' }], 'Hemoglobina 13,2 g/dL').mantidos).toEqual([]);
  });
  it('normalizarExtraido exige título e tipo, limita e filtra achados vazios', () => {
    expect(normalizarExtraido({ exam_type: 'sangue' })).toBeNull();
    const e = normalizarExtraido({ exam_type: 'sangue', title: 'Hemograma', exam_date: '2026-09-14', findings: [{ marker: 'Hb', value: '13,2', unit: 'g/dL' }, { marker: '', value: '1' }], confidence: 1.7 });
    expect(e?.findings.length).toBe(1);
    expect(e?.confidence).toBe(1);
    expect(e?.exam_date).toBe('2026-09-14');
  });
});

describe('o bloco que o modelo lê', () => {
  it('laudo guardado: diz o fato e proíbe re-perguntar; protocolo: proíbe "guardei" e ensina a oferecer', () => {
    const b = blocoDeIngestaoParaModelo({ tipo: 'laudo', examId: 'e1', titulo: 'Hemograma', examDate: '2026-09-14', laboratorio: 'Dasa', achados: [{ marker: 'Hemoglobina', value: '13,2', unit: 'g/dL', reference: '12,0 a 16,0' }], descartados: 1, arquivoGuardado: true }, 'pdf');
    expect(b).toContain('GUARDADO no prontuário como "Hemograma"');
    expect(b).toContain('Hemoglobina: 13,2 g/dL (ref. 12,0 a 16,0)');
    expect(b).toContain('NÃO precisa chamar save_exam_result');
    const p = blocoDeIngestaoParaModelo({ tipo: 'protocolo', laboratorio: 'CDI', previsaoLiberacao: '2026-09-21T17:30:00-03:00', arquivoGuardado: true }, 'foto');
    expect(p).toContain('PROTOCOLO DE RETIRADA');
    expect(p).toContain('21/09/2026');
    expect(p).toContain('NUNCA diga que guardou o resultado');
    const f = blocoDeIngestaoParaModelo({ tipo: 'laudo', examId: null, arquivoGuardado: false, motivoNaoLido: 'falha ao gravar' }, 'pdf');
    expect(f).toContain('NÃO diga que guardou');
  });
});
