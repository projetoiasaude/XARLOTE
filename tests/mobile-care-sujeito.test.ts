import { describe, it, expect } from 'vitest';
import { comSujeito } from '../apps/mobile/src/lib/care/rotas.js';
import { decidirFalarComXarlote } from '../apps/mobile/src/features/care/escrita.js';

/**
 * 🤝 As duas decisões do modo cuidador que a auditoria de 22/09 pegou como P0.
 *
 * Nenhuma das duas é sobre desenho: as duas decidem EM QUAL PRONTUÁRIO um toque cai.
 *   • `comSujeito` — a escrita de lembrete saía sem `?subject=`, tomava 403, e o cliente
 *     terminava deslogando quem cuida (o sufixo estava calculado e nunca usado).
 *   • `decidirFalarComXarlote` — "Cotar" na Saúde da mãe mandava "Minha Losartana está
 *     acabando" pro chat da FILHA, e o enricher podia anotar o remédio no nome errado.
 *
 * Por isso elas são funções puras e estão aqui: a prova não pode depender de alguém
 * repetir o passo a passo no aparelho.
 */

const MAE = '9f3c1b28-0f5d-4a2e-9c11-7d6e52a1b400';

describe('comSujeito — a rota que carrega de quem é o dado', () => {
  it('sem sujeito devolve a rota INTACTA, byte a byte', () => {
    // Quem não cuida de ninguém — a esmagadora maioria — tem que bater na mesma URL de
    // sempre. Um `?subject=` vazio ou um `?` sobrando já seria mudança de contrato.
    expect(comSujeito('/app/overview', null)).toBe('/app/overview');
    expect(comSujeito('/app/reminders?scope=active', null)).toBe('/app/reminders?scope=active');
  });

  it('rota sem query ganha `?`, rota com query ganha `&`', () => {
    // O defeito original nasceu exatamente aqui: existia um sufixo pronto (`?subject=…`)
    // e cada chamada escolhia à mão entre usá-lo cru ou trocar o `?` por `&`. Quem
    // esqueceu foi a ÚNICA escrita da tela.
    expect(comSujeito('/app/overview', MAE)).toBe(`/app/overview?subject=${MAE}`);
    expect(comSujeito('/app/reminders?scope=active', MAE)).toBe(
      `/app/reminders?scope=active&subject=${MAE}`,
    );
  });

  it('a AÇÃO de lembrete leva o sujeito — era o 403 que deslogava o cuidador', () => {
    const id = 'b0b1c2d3-4444-5555-6666-777788889999';
    expect(comSujeito(`/app/reminders/${id}/action`, MAE)).toBe(
      `/app/reminders/${id}/action?subject=${MAE}`,
    );
    // E continua sem parâmetro nenhum quando o lembrete é do próprio.
    expect(comSujeito(`/app/reminders/${id}/action`, null)).toBe(`/app/reminders/${id}/action`);
  });

  it('criar lembrete e paginar o histórico usam o MESMO caminho', () => {
    expect(comSujeito('/app/reminders', MAE)).toBe(`/app/reminders?subject=${MAE}`);
    expect(comSujeito('/app/reminders?scope=history&limit=12&cursor=abc', MAE)).toBe(
      `/app/reminders?scope=history&limit=12&cursor=abc&subject=${MAE}`,
    );
  });

  it('o id vai escapado — ele entra numa query string', () => {
    expect(comSujeito('/app/overview', 'a b&c=d')).toBe('/app/overview?subject=a%20b%26c%3Dd');
  });
});

describe('decidirFalarComXarlote — em qual conversa a mensagem cai', () => {
  it('no próprio registro, manda: é o prontuário de quem está logado', () => {
    const d = decidirFalarComXarlote({ cuidandoDeOutro: false, nome: null });
    expect(d.pode).toBe(true);
    // `null` e não string vazia: nenhuma tela decide se mostra algo lendo `''`.
    expect(d.aviso).toBeNull();
  });

  it('cuidando de outra pessoa, NÃO manda — e diz onde o pedido vale', () => {
    const d = decidirFalarComXarlote({ cuidandoDeOutro: true, nome: 'Maria' });
    expect(d.pode).toBe(false);
    expect(d.aviso).toContain('Maria');
    // As duas metades: onde vale, e de quem é a conversa que o app abriria.
    expect(d.aviso).toMatch(/WhatsApp/i);
    expect(d.aviso).toMatch(/a conversa é a sua/i);
  });

  it('sem nome, a frase continua verdadeira em vez de inventar um', () => {
    // Nome errado na frase é pior que nenhum: a pessoa acredita nele.
    for (const nome of [null, '', '   ']) {
      const d = decidirFalarComXarlote({ cuidandoDeOutro: true, nome });
      expect(d.pode).toBe(false);
      expect(d.aviso).toContain('da própria pessoa');
    }
  });

  it('o nome vai sem espaço sobrando — ele veio do cadastro, não de um literal', () => {
    expect(decidirFalarComXarlote({ cuidandoDeOutro: true, nome: '  Dona Cida ' }).aviso).toContain(
      'de Dona Cida',
    );
  });

  it('a decisão não depende de ter nome: quem manda é o modo', () => {
    // Uma pessoa cuidada sem nome cadastrado NÃO pode virar brecha de escrita.
    expect(decidirFalarComXarlote({ cuidandoDeOutro: true, nome: null }).pode).toBe(false);
    expect(decidirFalarComXarlote({ cuidandoDeOutro: false, nome: 'Maria' }).pode).toBe(true);
  });
});
