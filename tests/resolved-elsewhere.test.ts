import { describe, it, expect } from 'vitest';
import { resolvedElsewhere, isOrderAcceptance } from '../packages/shared/src/pharmacy.js';

/**
 * Blinda o encerramento por RESOLUÇÃO POR FORA.
 *
 * 🔴 CASO LUDMILA (auditoria 05/08), cronologia real de produção:
 *   13:20  ela pede a Pietra → contatamos 5 farmácias, 5 templates HSM gastos
 *   13:27  "Casa. **Eu fiz o pedido na pacheco**, Xarlote. Obrigada"
 *   13:27  Xarlote: "Que bom que fechou na Pacheco, Lud!" — e NÃO cancela nada
 *   13:30  "As farmácias ainda não responderam, **sigo insistindo** aqui"
 *   13:35  "**Consegui cotações pra você!** 🎉 DROGALOBO R$63,99" — de algo já comprado
 *   18:58  o pedido seguia `quoted`, aberto, 5h30 depois
 *
 * O detector de cancelamento que existia cobria "cancela", "desisti", "deixa pra lá" e "não
 * quero mais o pedido". Nenhum casa "fiz o pedido na pacheco" — é uma forma DIFERENTE de
 * encerrar: não é desistência, é resolução. E é a mais comum, porque o paciente está
 * agradecendo enquanto avisa.
 *
 * Direção do cuidado: encerrar um pedido que ele AINDA quer é pior que manter um que ele não
 * quer — ele ficaria esperando uma entrega que ninguém vai fazer.
 */

describe('🔴 a frase REAL da Ludmila', () => {
  it('"Casa. Eu fiz o pedido na pacheco, Xarlote. Obrigada" encerra o pedido', () => {
    expect(resolvedElsewhere('Casa. Eu fiz o pedido na pacheco, Xarlote. Obrigada')).toBe(true);
  });

  it('e NÃO é lida como aceite de cotação (não fecharia com uma farmácia nossa)', () => {
    expect(isOrderAcceptance('Casa. Eu fiz o pedido na pacheco, Xarlote. Obrigada')).toBe(false);
  });
});

describe('resolvedElsewhere — formas que o paciente usa de verdade', () => {
  it.each([
    'já comprei na Pacheco',
    'comprei na drogasil, obrigada',
    'fiz o pedido na pacheco',
    'já fiz o pedido, obrigado',
    'pedi na farmácia aqui perto',
    'consegui o remédio na drogaria da esquina',
    'peguei na farmácia do lado de casa',
    'já resolvi, obrigada',
    'já está comprado',
    'já tenho o medicamento',
    'encomendei no site da pacheco',
  ])('"%s" → encerra', (t) => expect(resolvedElsewhere(t)).toBe(true));
});

describe('🔴 resolvedElsewhere — o que NÃO pode encerrar um pedido vivo', () => {
  it.each([
    // O pedido COMEÇANDO — o oposto de resolver
    'quero comprar o pietra',
    'preciso comprar dipirona',
    'vou comprar amanhã',
    'queria pedir um remédio pra você',
    'pode pedir pra mim?',
    // Histórico, não este pedido
    'já comprei aí antes',
    'comprei na pacheco outras vezes',
    'da última vez eu comprei na drogasil',
    'sempre compro na indiana',
    // Pergunta
    'já comprei o suficiente?',
    // Verbo solto sem objeto de compra
    'consegui dormir melhor hoje',
    'consegui falar com o médico',
    'peguei o resultado do exame',
    // Aceite de cotação — outro fluxo, NÃO encerramento
    'pode fechar com a São Benedito',
    'quero a 1',
    'ok',
    // Vazio
    '',
  ])('"%s" → NÃO encerra', (t) => expect(resolvedElsewhere(t)).toBe(false));
});

describe('não colide com o aceite de cotação', () => {
  it('aceite de cotação continua sendo aceite', () => {
    expect(isOrderAcceptance('pode fechar com a São Benedito')).toBe(true);
    expect(resolvedElsewhere('pode fechar com a São Benedito')).toBe(false);
  });

  it('resolução por fora não é aceite', () => {
    expect(resolvedElsewhere('já comprei na Pacheco')).toBe(true);
    expect(isOrderAcceptance('já comprei na Pacheco')).toBe(false);
  });
});
