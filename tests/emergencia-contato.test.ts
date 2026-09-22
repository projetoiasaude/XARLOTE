/**
 * O aviso ao contato de emergência (auditoria 22/09, P0-4).
 *
 * Dois defeitos, ambos mortais no pior momento: (1) os botões passavam do limite de 20
 * caracteres do WABA e o menu era recusado; (2) o aviso saía como texto livre pra um
 * número que NUNCA falou com a Xarlote — fora da janela de 24h a Meta rejeita — e mesmo
 * assim a Xarlote dizia "✅ Avisei o João".
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  falaSobreOAviso,
  BTN_CALL_EMERGENCY,
  BTN_NOTIFY_CONTACT,
  BTN_MISTAKE,
  LIMITE_TITULO_BOTAO,
  type AvisoAoContato,
} from '../apps/api/src/handlers/red-flag-handler.js';
import { buildEmergencyContactTemplate } from '../apps/api/src/config/template-registry.js';

describe('botões de emergência cabem no WABA', () => {
  for (const rotulo of [BTN_CALL_EMERGENCY, BTN_NOTIFY_CONTACT, BTN_MISTAKE]) {
    it(`"${rotulo}" tem ${[...rotulo].length} caracteres (teto ${LIMITE_TITULO_BOTAO})`, () => {
      expect([...rotulo].length).toBeLessThanOrEqual(LIMITE_TITULO_BOTAO);
      expect(rotulo.trim()).toBe(rotulo);
    });
  }

  it('o matcher de resposta continua reconhecendo os três', () => {
    // Mesmas condições de `handleRedFlagButtonResponse` — mudar o rótulo sem olhar isto
    // faria o clique do paciente virar mensagem comum.
    expect(BTN_CALL_EMERGENCY.includes('Ligar')).toBe(true);
    expect(BTN_NOTIFY_CONTACT.includes('Avisar')).toBe(true);
    expect(BTN_MISTAKE.toLowerCase().includes('engano')).toBe(true);
  });
});

describe('a Xarlote só afirma o que realmente saiu', () => {
  const afirmaQueAvisou = (t: string) => /\bavisei\b/i.test(t) || /estou avisando/i.test(t);

  it('texto (janela aberta) → diz que está avisando, e cita o 192', () => {
    const t = falaSobreOAviso({ via: 'texto', contactName: 'João' });
    expect(t).toContain('João');
    expect(afirmaQueAvisou(t)).toBe(true);
    expect(t).toContain('192');
  });

  it('template (janela fechada, HSM aprovado) → mesma promessa, porque saiu de verdade', () => {
    expect(afirmaQueAvisou(falaSobreOAviso({ via: 'template', contactName: 'Maria' }))).toBe(true);
  });

  it('SEM template e fora da janela → NÃO pode dizer que avisou', () => {
    const t = falaSobreOAviso({ via: 'sem_template', contactName: 'João' });
    expect(afirmaQueAvisou(t)).toBe(false);
    expect(t).toMatch(/não consegui/i);
    expect(t).toContain('192');
    expect(t).toContain('João'); // diz PRA QUEM a pessoa deve ligar
  });

  it('falha de envio → não pode dizer que avisou', () => {
    const t = falaSobreOAviso({ via: 'falhou', contactName: 'Ana' });
    expect(afirmaQueAvisou(t)).toBe(false);
    expect(t).toContain('192');
  });

  it('sem contato cadastrado → pede o contato e dá o caminho urgente', () => {
    const t = falaSobreOAviso({ via: 'sem_contato' });
    expect(afirmaQueAvisou(t)).toBe(false);
    expect(t).toContain('192');
  });

  it('nenhuma fala deixa o paciente sem caminho: todas citam o 192', () => {
    const todos: AvisoAoContato[] = [
      { via: 'texto', contactName: 'X' },
      { via: 'template', contactName: 'X' },
      { via: 'sem_template', contactName: 'X' },
      { via: 'falhou', contactName: 'X' },
      { via: 'sem_contato' },
    ];
    for (const a of todos) expect(falaSobreOAviso(a)).toContain('192');
  });
});

describe('template do contato de emergência — a cadeia', () => {
  const ANTES_DEDICADO = process.env['ZPRO_TEMPLATE_EMERGENCIA'];
  const ANTES_REENGAJA = process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'];

  function repor(chave: string, valor: string | undefined) {
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = valor;
  }
  afterEach(() => {
    repor('ZPRO_TEMPLATE_EMERGENCIA', ANTES_DEDICADO);
    repor('ZPRO_TEMPLATE_REENGAGE_APPROVED', ANTES_REENGAJA);
  });

  it('sem NENHUM template ligado, devolve null — e quem chama diz a verdade', () => {
    delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
    delete process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'];
    expect(buildEmergencyContactTemplate('João', 'Maria')).toBeNull();
  });

  it('PONTE: sem o dedicado, usa o HSM de reengajamento (aprovado no número da Xarlote)', () => {
    delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    const t = buildEmergencyContactTemplate('João', 'Maria')!;
    expect(t.via).toBe('reengajamento');
    expect(t.name).toBe('lembrete_compromisso');
    // {{1}} = quem recebe · {{2}} = o motivo em UMA frase
    expect(t.variables).toHaveLength(2);
    expect(t.variables[0]).toBe('João');
    expect(t.variables[1]).toContain('Maria');
    expect(t.variables[1]).toContain('192');
    // O texto renderizado é o corpo aprovado, com o motivo dentro.
    expect(t.text).toContain('Oii, João!');
    expect(t.text).toContain('contato de emergência');
    expect(t.text).toContain('192');
  });

  it('o dedicado PREFERE sobre a ponte assim que existir', () => {
    process.env['ZPRO_TEMPLATE_EMERGENCIA'] = 'contato_emergencia';
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    const t = buildEmergencyContactTemplate('João', 'Maria')!;
    expect(t.via).toBe('dedicado');
    expect(t.name).toBe('contato_emergencia');
    expect(t.variables).toEqual(['João', 'Maria']);
  });

  it('o MOTIVO é o mesmo nos dois caminhos — não existe "a versão boa" e "a ponte"', () => {
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
    const ponte = buildEmergencyContactTemplate('João', 'Maria')!;
    process.env['ZPRO_TEMPLATE_EMERGENCIA'] = 'contato_emergencia';
    const dedicado = buildEmergencyContactTemplate('João', 'Maria')!;
    for (const trecho of ['contato de emergência', 'o quanto antes', '192 (SAMU)']) {
      expect(ponte.text).toContain(trecho);
      expect(dedicado.text).toContain(trecho);
    }
  });

  it('NENHUM caminho leva categoria clínica pro terceiro', () => {
    for (const cenario of ['dedicado', 'ponte'] as const) {
      if (cenario === 'dedicado') process.env['ZPRO_TEMPLATE_EMERGENCIA'] = 'contato_emergencia';
      else delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
      process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
      const t = buildEmergencyContactTemplate('João', 'Maria')!;
      for (const clinico of ['suicid', 'overdose', 'avc', 'peito', 'sangramento', 'automutil']) {
        expect(t.text.toLowerCase()).not.toContain(clinico);
        expect(t.variables.join(' ').toLowerCase()).not.toContain(clinico);
      }
    }
  });

  it('nome vazio não vira variável em branco (a Meta rejeita slot vazio), nos dois caminhos', () => {
    for (const cenario of ['dedicado', 'ponte'] as const) {
      if (cenario === 'dedicado') process.env['ZPRO_TEMPLATE_EMERGENCIA'] = 'contato_emergencia';
      else delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
      process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
      const t = buildEmergencyContactTemplate('   ', '')!;
      expect(t.variables.every((v) => v.trim().length > 0)).toBe(true);
    }
  });

  it('a variável do motivo cabe no limite de 300 do reengajamento, com nome longo', () => {
    delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    const t = buildEmergencyContactTemplate('João', 'Maria das Graças Aparecida de Souza Albuquerque')!;
    expect(t.variables[1]!.length).toBeLessThanOrEqual(300);
    expect(t.variables[1]).toContain('192');
  });
});

// Impressão do texto REAL que o contato recebe — não é asserção, é a prova visual de
// que a ponte lê bem. Rodar: CI=true npx vitest run tests/emergencia-contato.test.ts
describe('como fica na tela do contato', () => {
  it('imprime os dois caminhos', () => {
    delete process.env['ZPRO_TEMPLATE_EMERGENCIA'];
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    const p = buildEmergencyContactTemplate('João', 'Maria')!;
    console.log(`\n=== PONTE (${p.name}) ===\n${p.text}\n`);
    process.env['ZPRO_TEMPLATE_EMERGENCIA'] = 'contato_emergencia';
    const d = buildEmergencyContactTemplate('João', 'Maria')!;
    console.log(`=== DEDICADO (${d.name}) ===\n${d.text}\n`);
    expect(p.text).toContain('192');
    expect(d.text).toContain('192');
  });
});
