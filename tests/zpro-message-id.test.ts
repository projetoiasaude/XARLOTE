import { describe, it, expect } from 'vitest';
import { pickMessageId, describeShape } from '../packages/whatsapp/src/zpro-client.js';

// Blinda a extração do providerMessageId da resposta de ENVIO do zpro (não documentada).
// Prod 27/07: id vazio em 100% dos envios; o log raso revelou o envelope { success, data }
// com o id em algum lugar DENTRO de data. Sem esse id o fundador não abre o chamado da
// entrega duplicada (provado: 1 envio nosso → paciente recebe 2).
describe('pickMessageId', () => {
  it('candidatos na RAIZ seguem funcionando (compat com o parser antigo)', () => {
    expect(pickMessageId({ messageId: 'abc' })).toBe('abc');
    expect(pickMessageId({ id: 42 })).toBe('42');
    expect(pickMessageId({ wamid: 'wamid.X' })).toBe('wamid.X');
    expect(pickMessageId({ message: { id: 'm1' } })).toBe('m1');
    expect(pickMessageId({ messages: [{ id: 'first' }] })).toBe('first');
  });

  it('acha o id DENTRO de data (envelope real { success, data } do zpro)', () => {
    expect(pickMessageId({ success: true, data: { messageId: 'zpro-1' } })).toBe('zpro-1');
    expect(pickMessageId({ success: true, data: { id: 7 } })).toBe('7');
    expect(pickMessageId({ success: true, data: { wamid: 'wamid.Y' } })).toBe('wamid.Y');
    // vocabulário do webhook de entrada (msg.id / message.id) aplicado à resposta de envio
    expect(pickMessageId({ success: true, data: { msg: { id: '556298:3A0' } } })).toBe('556298:3A0');
    expect(pickMessageId({ success: true, data: { message: { id: 'm2' } } })).toBe('m2');
    expect(pickMessageId({ success: true, data: { messages: [{ id: 'arr' }] } })).toBe('arr');
  });

  it('sem id em lugar nenhum → string vazia (nunca lança)', () => {
    expect(pickMessageId({ success: true, data: { ticket: { status: 'open' } } })).toBe('');
    expect(pickMessageId(null)).toBe('');
    expect(pickMessageId('ok')).toBe('');
    expect(pickMessageId({ id: '' })).toBe('');
  });

  it('raiz tem precedência sobre data (não troca um id certo por outro)', () => {
    expect(pickMessageId({ messageId: 'root', data: { messageId: 'inner' } })).toBe('root');
  });
});

describe('describeShape', () => {
  it('revela chaves e tipos em profundidade — NUNCA os valores (PII)', () => {
    const shape = describeShape({
      success: true,
      data: { msg: { id: 'SEGREDO-556299999', body: 'texto do paciente' }, ticketId: 9 },
    });
    expect(shape).toBe('{ success:boolean, data:{ msg:{ id:string, body:string }, ticketId:number } }');
    expect(shape).not.toContain('SEGREDO');
    expect(shape).not.toContain('paciente');
  });

  it('array descreve o 1º elemento; profundidade esgotada degrada pra object/array', () => {
    expect(describeShape({ messages: [{ id: 'x' }] })).toBe('{ messages:array<{ id:string }> }');
    expect(describeShape({ a: { b: { c: { d: 1 } } } })).toBe('{ a:{ b:{ c:object } } }');
    expect(describeShape([])).toBe('array');
    expect(describeShape(null)).toBe('null');
  });
});
