import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../apps/api/src/workers/profile-enricher.worker.js';

/**
 * Blinda a extração de JSON do enricher de memória.
 *
 * 🔴 O QUE OS DADOS DE PRODUÇÃO MOSTRARAM (auditoria 05/08). O log já guardava o preview da
 * resposta, então não houve adivinhação — em 8 falhas registradas:
 *
 *   7×  preview: ''                          ← o modelo devolveu VAZIO, não JSON quebrado
 *   1×  preview: '```json\n{\n  "facts": [], "'   ← cerca markdown + resposta CORTADA
 *
 * O diagnóstico "parser intolerante" estava errado pra maioria dos casos: não havia nada pra
 * parsear. Vazio é falha de GERAÇÃO (mesma do turno vazio do agente-clínica) e se resolve no
 * protocolo (`response_format: json_object`) e com modelo alternativo na 2ª tentativa — não
 * com regex melhor. Este arquivo cobre a minoria que É de parsing, e ela é real: JSON
 * truncado pelo teto de tokens morria no parse com os `facts` já prontos dentro.
 */

describe('extractJsonObject — o que o modelo faz de verdade', () => {
  it('JSON puro', () => {
    expect(extractJsonObject('{"facts":[]}')).toBe('{"facts":[]}');
  });

  it('🔴 cerca markdown (o caso real de 30/07)', () => {
    const out = extractJsonObject('```json\n{"facts":[{"kind":"fact","text":"toma Neblock"}]}\n```');
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).facts).toHaveLength(1);
  });

  it('prosa antes e depois', () => {
    const out = extractJsonObject('Claro! Aqui está:\n{"facts":[]}\nEspero ter ajudado.');
    expect(JSON.parse(out!)).toEqual({ facts: [] });
  });

  it('🔴 JSON TRUNCADO pelo teto de tokens é RECUPERADO, não descartado', () => {
    const cortado = '{"facts":[{"kind":"fact","text":"alergia a dipirona","confidence":0.9},{"kind":"preference","text":"prefere manha"';
    const out = extractJsonObject(cortado);
    expect(out).not.toBeNull();
    const p = JSON.parse(out!);
    expect(p.facts).toHaveLength(2);
    expect(p.facts[0].text).toBe('alergia a dipirona');
  });

  it('truncado no meio de uma STRING também é recuperado', () => {
    const out = extractJsonObject('{"facts":[{"kind":"fact","text":"toma losartana de man');
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).facts).toHaveLength(1);
  });

  it('chave dentro de STRING não confunde o balanceamento', () => {
    const out = extractJsonObject('{"facts":[{"text":"disse: {isso} e {aquilo}"}]}');
    expect(JSON.parse(out!).facts[0].text).toBe('disse: {isso} e {aquilo}');
  });

  it('objeto aninhado fecha no lugar certo, sem levar lixo depois', () => {
    const out = extractJsonObject('{"a":{"b":{"c":1}}} sobrou texto aqui');
    expect(out).toBe('{"a":{"b":{"c":1}}}');
  });

  it('escape de aspas não quebra a varredura', () => {
    const out = extractJsonObject('{"facts":[{"text":"ele disse \\"tomei\\" ontem"}]}');
    expect(JSON.parse(out!).facts[0].text).toBe('ele disse "tomei" ontem');
  });
});

describe('🔴 extractJsonObject — o que NÃO pode virar JSON', () => {
  it.each([
    ['', 'vazio — a falha real em 7 de 8 casos'],
    ['   ', 'só espaço'],
    ['Não encontrei nada relevante nesta conversa.', 'prosa sem JSON'],
    ['```json\n```', 'cerca vazia'],
  ])('%s (%s) → null', (entrada) => {
    expect(extractJsonObject(entrada)).toBeNull();
  });

  it('lixo que não fecha em JSON válido devolve null em vez de inventar', () => {
    expect(extractJsonObject('{{{{{')).toBeNull();
  });
});
