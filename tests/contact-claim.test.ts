import { describe, it, expect } from 'vitest';
import { detectContactClaim } from '../apps/api/src/handlers/inbound-user.js';

// Blinda o cérebro do guard anti-mentira de contato (agora PURO e testável).
// Histórico que este teste protege: incidente 07/07 ("já falei com a farmácia" sem envio),
// Pague Menos 09/07 ("Vou falar com a Pague Menos agora!" 2× sem contato), review 10/07 #22
// ("Vou verificar pra você" NÃO pode virar non-sequitur de farmácia) e o caso Ciro 26-30/07
// ("vou perguntar à clínica se quinta dá" dito 3× — a pergunta nunca saiu; a consulta não
// tinha o backstop que a farmácia tem desde 09/07).
describe('detectContactClaim — PASSADO (farmácia/genérico, comportamento preservado)', () => {
  it('claims clássicos de farmácia trip', () => {
    expect(detectContactClaim('Já falei com a farmácia, ela vai te responder!').past).toBe(true);
    expect(detectContactClaim('Mandei uma mensagem pra eles agora 💙').past).toBe(true);
    expect(detectContactClaim('Entrei em contato e já te aviso!').past).toBe(true);
    expect(detectContactClaim('Acabei de falar com a Drogasil!').past).toBe(true);
  });

  it('recap de CONSULTA no passado NÃO trip (contato antigo de clínica costuma ser VERDADE fora do turno)', () => {
    expect(detectContactClaim('Já falei com o consultório mais cedo, tô aguardando 💙').past).toBe(false);
    // fraseado que a observation do cooldown induz — não pode cair no guard:
    expect(detectContactClaim('Já dei um alô no consultório e te aviso assim que responderem!').past).toBe(false);
  });
});

describe('detectContactClaim — FUTURO com alvo de CONSULTA (caso Ciro)', () => {
  it('"vou perguntar à clínica" (o fraseado literal do incidente) trip como clinic', () => {
    const c = detectContactClaim('Vou perguntar à clínica se quinta-feira tem horário e te aviso!');
    expect(c.future).toBe(true);
    expect(c.futureTarget).toBe('clinic');
  });

  it('variações de verbo/preposição/alvo do consultório', () => {
    expect(detectContactClaim('Vou verificar com o consultório do Dr. Rafael sobre quinta 💙').futureTarget).toBe('clinic');
    expect(detectContactClaim('Vou perguntar ao consultório e volto já!').futureTarget).toBe('clinic');
    expect(detectContactClaim('Vou perguntar pro consultório agora!').futureTarget).toBe('clinic');
    expect(detectContactClaim('Vou checar com a secretária o horário de quinta').futureTarget).toBe('clinic');
    expect(detectContactClaim('Vou falar com o médico sobre isso').futureTarget).toBe('clinic');
    expect(detectContactClaim('Vou falar com a recepção').futureTarget).toBe('clinic');
  });
});

describe('detectContactClaim — FUTURO farmácia e alvo AMBÍGUO', () => {
  it('alvo explícito de farmácia → pharmacy', () => {
    expect(detectContactClaim('Vou falar com a Drogasil agora!').futureTarget).toBe('pharmacy');
    expect(detectContactClaim('Vou cotar na farmácia mais perto 💙').futureTarget).toBe('pharmacy');
  });

  it('Nome Próprio ou "eles/elas" → ambiguous (o call-site decide pelo estado do turno)', () => {
    expect(detectContactClaim('Vou falar com a Pague Menos agora! 💙').futureTarget).toBe('ambiguous');
    expect(detectContactClaim('Vou falar com eles de novo!').futureTarget).toBe('ambiguous');
    expect(detectContactClaim('Tô falando com a Rita pra confirmar').futureTarget).toBe('ambiguous');
  });
});

describe('detectContactClaim — NÃO pode regredir os falso-positivos já consertados', () => {
  it('"pra você" e fala dirigida ao paciente nunca trip', () => {
    expect(detectContactClaim('Vou verificar pra você! 💙').future).toBe(false);
    expect(detectContactClaim('Vou falar com você amanhã cedo').future).toBe(false);
  });

  it('verbo sem preposição-alvo ou alvo minúsculo genérico não trip', () => {
    expect(detectContactClaim('Vou verificar seus lembretes agora').future).toBe(false);
    expect(detectContactClaim('Vou perguntar uma coisa: você prefere de manhã?').future).toBe(false);
    expect(detectContactClaim('Vou falar a verdade: esse preço tá alto').future).toBe(false);
    expect(detectContactClaim('Vou checar a disponibilidade e te falo').future).toBe(false);
    expect(detectContactClaim('Vou verificar na minha agenda').future).toBe(false);
  });

  it('capitalizada de início de frase ("Vou") não vira alvo (review 10/07 #22)', () => {
    const c = detectContactClaim('Vou verificar. Você prefere quinta?');
    expect(c.future).toBe(false);
  });
});
