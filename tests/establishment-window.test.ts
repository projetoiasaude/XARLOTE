import { describe, it, expect } from 'vitest';
import { chooseEstablishmentChannel } from '../apps/api/src/handlers/outbound-agent.js';

/**
 * Blinda a política de canal na perna do ESTABELECIMENTO (clínica/farmácia).
 *
 * Caso que a criou (Ciro/Rita, 03/08): o último inbound da secretária foi 25/07 16:05.
 * Reabrimos a negociação em 30/07 e cutucamos em 31/07, as duas vezes em TEXTO LIVRE, 5 e
 * 6 dias fora da janela de 24h — que a Meta rejeita. `delivery_status` NULL nas três, então
 * nem soubemos. A leitura fácil era "a clínica não responde"; a provável é que ela nunca
 * recebeu. Isso valia pra TODA farmácia e clínica desde sempre.
 */
describe('chooseEstablishmentChannel — dentro da janela', () => {
  it('janela aberta manda texto livre, independente de template/assunto/cota', () => {
    for (const templatesOn of [true, false]) {
      for (const hasSubject of [true, false]) {
        for (const templateSlotFree of [true, false]) {
          expect(chooseEstablishmentChannel({ windowOpen: true, hasSubject, templatesOn, templateSlotFree })).toBe('text');
        }
      }
    }
  });
});

describe('chooseEstablishmentChannel — janela fechada', () => {
  const fechada = { windowOpen: false as const, hasSubject: true, templatesOn: true, templateSlotFree: true };

  it('com assunto, template ligado e cota livre → TEMPLATE de reabertura (o caso Rita)', () => {
    expect(chooseEstablishmentChannel(fechada)).toBe('template');
  });

  it('🔴 nunca cai pra texto livre fora da janela — o que não pode reabrir, BLOQUEIA', () => {
    // Esta é a regra inteira: fora de 24h, ou é template ou não vai. Cair pra texto livre
    // é o comportamento antigo, que produzia envio "com sucesso" e entrega nenhuma.
    expect(chooseEstablishmentChannel({ ...fechada, templatesOn: false })).toBe('blocked');
    expect(chooseEstablishmentChannel({ ...fechada, hasSubject: false })).toBe('blocked');
    expect(chooseEstablishmentChannel({ ...fechada, templateSlotFree: false })).toBe('blocked');
  });

  it('sem assunto não há template possível (a variável do HSM é obrigatória)', () => {
    expect(chooseEstablishmentChannel({ ...fechada, hasSubject: false, templateSlotFree: true })).toBe('blocked');
  });

  it('cota de 24h gasta → bloqueia (HSM é pago e template demais queima o número)', () => {
    expect(chooseEstablishmentChannel({ ...fechada, templateSlotFree: false })).toBe('blocked');
  });

  it('template desligado pelo kill-switch → bloqueia, nunca degrada pra texto', () => {
    expect(chooseEstablishmentChannel({ ...fechada, templatesOn: false, templateSlotFree: true })).toBe('blocked');
  });
});
