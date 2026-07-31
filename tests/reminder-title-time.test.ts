import { describe, it, expect } from 'vitest';
import { stripRedundantTime, reengageReasonForReminder } from '../apps/api/src/config/template-registry.js';

// Ao vivo 30/07 (Hiago): "Passei pra te lembrar hoje às 16h: Água 16h."
// O paciente batiza o lembrete com o horário — natural — e o template repetia a hora.
describe('stripRedundantTime', () => {
  it('remove a hora do fim do título quando é a MESMA do rótulo', () => {
    expect(stripRedundantTime('Água 16h', 'hoje às 16h')).toBe('Água');
    expect(stripRedundantTime('Água às 16h', 'hoje às 16h')).toBe('Água');
    expect(stripRedundantTime('Remédio 8h30', 'amanhã às 8h30')).toBe('Remédio');
    expect(stripRedundantTime('Creatina - 7:20', 'hoje às 7:20')).toBe('Creatina');
  });

  it('🔒 hora DIFERENTE fica intacta (é informação, não redundância)', () => {
    expect(stripRedundantTime('Água 16h', 'hoje às 20h')).toBe('Água 16h');
    expect(stripRedundantTime('Insulina 30 UI às 8h', 'hoje às 20h')).toBe('Insulina 30 UI às 8h');
  });

  it('🔒 número no MEIO do título não é hora de sufixo — dose fica preservada', () => {
    expect(stripRedundantTime('Neblock 5mg de manhã', 'hoje às 5h')).toBe('Neblock 5mg de manhã');
    expect(stripRedundantTime('Tomar 2 comprimidos', 'hoje às 2h')).toBe('Tomar 2 comprimidos');
  });

  it('título que é SÓ a hora é preservado (melhor repetir que ficar vazio)', () => {
    expect(stripRedundantTime('16h', 'hoje às 16h')).toBe('16h');
  });

  it('🔴 POSOLOGIA intacta — "6/6h" não vira "6/" (achado da revisão adversarial)', () => {
    // Sem o guard de intervalo, o corte de sufixo destruía a posologia DENTRO de um
    // template pago, falando de remédio: "Dipirona 6/6h" → "Dipirona 6/".
    expect(stripRedundantTime('Dipirona 6/6h', 'hoje às 6h')).toBe('Dipirona 6/6h');
    expect(stripRedundantTime('Remédio 12/12h', 'hoje às 12h')).toBe('Remédio 12/12h');
    expect(stripRedundantTime('Amoxicilina de 8 em 8h', 'hoje às 8h')).toBe('Amoxicilina de 8 em 8h');
    expect(stripRedundantTime('Colírio a cada 4h', 'hoje às 4h')).toBe('Colírio a cada 4h');
  });

  it('sem rótulo de hora, nada muda', () => {
    expect(stripRedundantTime('Água 16h', null)).toBe('Água 16h');
    expect(stripRedundantTime('Água 16h', 'amanhã')).toBe('Água 16h');
  });
});

describe('reengageReasonForReminder — a frase que o paciente lê', () => {
  it('não repete mais a hora (a linha exata do incidente)', () => {
    const frase = reengageReasonForReminder({ type: 'other', title: 'Água 16h' }, 'hoje às 16h');
    expect(frase).toBe('Passei pra te lembrar hoje às 16h: Água.');
    expect(frase.match(/16h/g)).toHaveLength(1);
  });

  it('medicação com hora diferente mantém as duas (dose ≠ horário do lembrete)', () => {
    const frase = reengageReasonForReminder({ type: 'medication', title: 'Insulina às 8h' }, 'hoje às 20h');
    expect(frase).toContain('às 8h');
    expect(frase).toContain('hoje às 20h');
  });
});
