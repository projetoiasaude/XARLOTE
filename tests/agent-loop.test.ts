/**
 * Loop agêntico (ReAct) — contrato com a API OpenAI/OpenRouter.
 *
 * Estes testes protegem a peça mais frágil da mudança de 26/07: se o transcript do loop
 * violar o contrato (tool_call sem resultado correspondente, id vazio, ordem errada), a API
 * devolve 400 e o TURNO INTEIRO falha — o paciente recebe mensagem de erro em vez de resposta.
 * Sem cobertura aqui, essa quebra só apareceria em produção.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { chat, type ChatMessage } from '../packages/llm/src/client.js';

interface CapturedBody {
  messages: ChatMessage[];
  tools?: unknown[];
  model: string;
}

/** Mocka o fetch e devolve o body enviado ao provider + a resposta que ele simulou. */
function mockProvider(response: {
  content?: string | null;
  toolCalls?: Array<{ id?: string | null; name: string; args: unknown }>;
}) {
  const captured: CapturedBody[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    captured.push(JSON.parse(init.body) as CapturedBody);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: response.content ?? '',
            tool_calls: (response.toolCalls ?? []).map((t) => ({
              id: t.id,
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

afterEach(() => vi.unstubAllGlobals());

describe('client — round-trip de tool result (role:"tool")', () => {
  it('rawToolCalls e toolCalls saem 1:1 com o MESMO id', async () => {
    mockProvider({
      toolCalls: [
        { id: 'call_abc', name: 'create_reminder', args: { title: 'Neblock' } },
        { id: 'call_def', name: 'list_reminders', args: {} },
      ],
    });
    const res = await chat('oi', { apiKey: 'k' });

    expect(res.toolCalls).toHaveLength(2);
    expect(res.rawToolCalls).toHaveLength(2);
    // O contrato: pra CADA tool_call ecoada tem que existir um id casável.
    expect(res.rawToolCalls.map((t) => t.id)).toEqual(res.toolCalls.map((t) => t.id));
    expect(res.toolCalls[0]!.id).toBe('call_abc');
    expect(res.rawToolCalls[0]!.type).toBe('function');
  });

  it('id VAZIO do provider é substituído (senão 2 tools com tool_call_id "" → 400)', async () => {
    mockProvider({
      toolCalls: [
        { id: '', name: 'create_reminder', args: {} },
        { id: '   ', name: 'list_reminders', args: {} },
      ],
    });
    const res = await chat('oi', { apiKey: 'k' });

    const ids = res.toolCalls.map((t) => t.id);
    expect(ids.every((id) => typeof id === 'string' && id.trim().length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2); // únicos entre si
  });

  it('id AUSENTE (provider omite) também é sintetizado', async () => {
    mockProvider({ toolCalls: [{ name: 'get_order_status', args: {} }] });
    const res = await chat('oi', { apiKey: 'k' });
    expect(res.toolCalls[0]!.id).toBeTruthy();
  });

  it('ecoa o nome CORRIGIDO da tool (typo do modelo não volta no histórico)', async () => {
    mockProvider({ toolCalls: [{ id: 'c1', name: 'request_cllarification', args: {} }] });
    const res = await chat('oi', {
      apiKey: 'k',
      tools: [{ type: 'function', function: { name: 'request_clarification', description: '', parameters: {} } }],
    });
    expect(res.toolCalls[0]!.name).toBe('request_clarification');
    // Se o rawToolCall levasse o typo de volta, o modelo repetiria o erro na rodada seguinte.
    expect(res.rawToolCalls[0]!.function.name).toBe('request_clarification');
  });
});

describe('client — priorMessages (transcript do loop)', () => {
  it('vão DEPOIS da mensagem do usuário, na ordem system→history→user→assistant→tool', async () => {
    const captured = mockProvider({ content: 'pronto' });
    const prior: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_reminder', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ];

    await chat('me lembra às 7h', {
      apiKey: 'k',
      systemInstruction: 'você é a Xarlote',
      history: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'oi!' }],
      priorMessages: prior,
    });

    const msgs = captured[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    // a mensagem do turno atual vem ANTES do transcript do loop
    expect(msgs[3]!.content).toBe('me lembra às 7h');
    expect(msgs[5]!.tool_call_id).toBe('c1');
  });

  it('toda tool_call ecoada tem uma mensagem role:"tool" com o mesmo id', async () => {
    const captured = mockProvider({ content: 'ok' });
    const prior: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', content: '{"ok":false,"error":"x"}' },
    ];
    await chat('oi', { apiKey: 'k', priorMessages: prior });

    const msgs = captured[0]!.messages;
    const echoedIds = msgs.flatMap((m) => m.tool_calls?.map((t) => t.id) ?? []);
    const resultIds = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    // Invariante da API: os dois conjuntos têm que casar exatamente.
    expect(new Set(resultIds)).toEqual(new Set(echoedIds));
  });

  it('sem priorMessages o payload é idêntico ao de antes do loop (nada regride)', async () => {
    const captured = mockProvider({ content: 'oi' });
    await chat('tudo bem?', { apiKey: 'k', systemInstruction: 'sys' });
    const msgs = captured[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs.some((m) => m.tool_calls || m.tool_call_id)).toBe(false);
  });
});
