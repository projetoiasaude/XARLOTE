import { describe, it, expect } from 'vitest';
import {
  detectConsultationIntent,
  shouldNudgeIntent,
  INTENT_MAX_NUDGES,
  INTENT_NUDGE_AFTER_MS,
  type OpenConsultationIntent,
} from '../packages/shared/src/consultation-intent.js';

/**
 * Blinda a captura de INTENÇÃO de consulta como ESTADO.
 *
 * 🔴 CASO GLAUBER (auditoria 04/08) — transcrição real de produção:
 *   01/08 "quero marcar uma consulta"  → Xarlote: "qual especialidade?"
 *   01/08 "Cardiologista"              → Xarlote: "Goiânia? plano ou particular?"
 *   02/08 "Não precisa"                → Xarlote: "então deixo pra lá?"
 *
 * `start_consultation_search` nunca foi chamada, então **nunca existiu linha em
 * `consultations`** — e todos os vigilantes do sistema varrem tabela. Aquela intenção era
 * invisível por construção, e morreu sem ninguém poder notar.
 *
 * Assimetria de custo: falso positivo aqui custa uma pergunta ("quer que eu procure?");
 * falso negativo custa o evento mais escasso do produto.
 */

describe('detectConsultationIntent — as duas mensagens REAIS do Glauber', () => {
  it('🔴 "quero marcar uma consulta" → intenção, sem especialidade ainda', () => {
    const hit = detectConsultationIntent('quero marcar uma consulta');
    expect(hit).not.toBeNull();
    expect(hit?.specialty).toBeNull();
  });

  it('🔴 "Cardiologista" (resposta curta à pergunta) → intenção COM especialidade', () => {
    const hit = detectConsultationIntent('Cardiologista');
    expect(hit?.specialty).toBe('cardiologista');
  });
});

describe('detectConsultationIntent — formas que o paciente usa de verdade', () => {
  it.each([
    ['preciso de um cardiologista', 'cardiologista'],
    ['queria marcar com um dermatologista', 'dermatologista'],
    ['tem como marcar uma consulta pra mim?', null],
    ['me ajuda a achar um ortopedista', 'ortopedista'],
    ['gostaria de ver um médico', null],
    ['reumatologia', 'reumatologia'],
    ['psiquiatra', 'psiquiatra'],
    ['clínico geral', 'clinico geral'],
    ['tô procurando um endocrinologista', 'endocrinologista'],
  ])('"%s" → intenção (especialidade: %s)', (texto, esp) => {
    const hit = detectConsultationIntent(texto);
    expect(hit).not.toBeNull();
    expect(hit?.specialty).toBe(esp);
  });

  it('a evidência é o texto REAL, nunca inventada', () => {
    expect(detectConsultationIntent('quero marcar uma consulta')?.evidence).toBe('quero marcar uma consulta');
  });
});

describe('detectConsultationIntent — 🔴 o que NÃO pode virar intenção de consulta', () => {
  it.each([
    'quero comprar dipirona',                       // fluxo de FARMÁCIA
    'preciso de um remédio pra dor',
    'me ajuda a achar o genérico do Neblock',
    'quero cancelar a consulta',                    // o oposto
    'já marquei com o cardiologista, obrigado',
    'preciso fazer um exame de sangue',             // outro fluxo
    'Tomei',
    'Ok',
    'Bom dia xarlote',
    'Bebi foi quase nada hoje',
  ])('"%s" → sem intenção', (texto) => {
    expect(detectConsultationIntent(texto)).toBeNull();
  });

  it('especialidade dentro de frase LONGA é contexto, não pedido', () => {
    expect(detectConsultationIntent(
      'meu cardiologista me falou na última vez que eu tinha que reduzir o sal e caminhar todo dia de manhã',
    )).toBeNull();
  });

  it('texto vazio não é intenção', () => {
    expect(detectConsultationIntent('')).toBeNull();
    expect(detectConsultationIntent('   ')).toBeNull();
  });
});

describe('shouldNudgeIntent — cobra, mas não persegue', () => {
  const AGORA = Date.parse('2026-08-04T15:00:00Z');
  const intent = (over: Partial<OpenConsultationIntent> = {}): OpenConsultationIntent => ({
    specialty: 'cardiologista',
    at: new Date(AGORA - 3 * 24 * 3_600_000).toISOString(), // pedido há 3 dias (o Glauber real)
    nudged: 0,
    ...over,
  });
  const ok = { hasLiveConsultation: false, quietHours: false };

  it('🔴 a intenção do Glauber (3 dias aberta, nunca cobrada) → COBRA', () => {
    expect(shouldNudgeIntent(intent(), AGORA, ok).nudge).toBe(true);
  });

  it('sem intenção não cobra', () => {
    expect(shouldNudgeIntent(null, AGORA, ok).nudge).toBe(false);
    expect(shouldNudgeIntent(undefined, AGORA, ok).nudge).toBe(false);
  });

  it('consulta viva significa que a intenção foi ATENDIDA — não cobra', () => {
    const r = shouldNudgeIntent(intent(), AGORA, { ...ok, hasLiveConsultation: true });
    expect(r.nudge).toBe(false);
    expect(r.reason).toContain('atendida');
  });

  it('quiet hours não cobra (nem intenção justifica acordar o paciente)', () => {
    expect(shouldNudgeIntent(intent(), AGORA, { ...ok, quietHours: true }).nudge).toBe(false);
  });

  it('pedido recente ainda não é cobrado — o paciente pode estar respondendo agora', () => {
    const agoraMesmo = intent({ at: new Date(AGORA - 60_000).toISOString() });
    expect(shouldNudgeIntent(agoraMesmo, AGORA, ok).nudge).toBe(false);
  });

  it('a espera CRESCE: a 2ª cobrança espera o dobro da 1ª', () => {
    const umaCobranca = intent({ nudged: 1, last_nudge_at: new Date(AGORA - INTENT_NUDGE_AFTER_MS - 60_000).toISOString() });
    expect(shouldNudgeIntent(umaCobranca, AGORA, ok).nudge).toBe(false); // 1× a espera não basta
    const dobro = intent({ nudged: 1, last_nudge_at: new Date(AGORA - 2 * INTENT_NUDGE_AFTER_MS - 60_000).toISOString() });
    expect(shouldNudgeIntent(dobro, AGORA, ok).nudge).toBe(true);
  });

  it(`🔴 para no teto de ${INTENT_MAX_NUDGES} cobranças — follow-up não vira perseguição`, () => {
    const noTeto = intent({ nudged: INTENT_MAX_NUDGES, last_nudge_at: new Date(AGORA - 30 * 24 * 3_600_000).toISOString() });
    const r = shouldNudgeIntent(noTeto, AGORA, ok);
    expect(r.nudge).toBe(false);
    expect(r.reason).toContain('para de insistir');
  });

  it('âncora de tempo corrompida não gera cobrança infinita', () => {
    expect(shouldNudgeIntent(intent({ at: 'lixo' }), AGORA, ok).nudge).toBe(false);
  });
});
