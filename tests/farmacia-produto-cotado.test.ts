import { describe, it, expect } from 'vitest';
import {
  tokenPrincipal, tokensDeNome, montarProdutoCotado, ehSubstitutoPeloNome,
  detectarSubstitutoOferecido, linhaDoProduto, podeAfirmarQueEh,
  afirmacaoDeProdutoSemProva, consertarAceiteDeSubstituto,
} from '../packages/shared/src/produto-cotado';

describe('tokenPrincipal / tokensDeNome', () => {
  it('pega a marca/princípio, sem dose, forma nem quantidade', () => {
    expect(tokenPrincipal('Daflon Flex 1000')).toBe('daflon');
    expect(tokenPrincipal('Losartana potássica 50mg 30 comprimidos')).toBe('losartana');
    expect(tokenPrincipal('Aflor 1000 Flex')).toBe('aflor');
    expect(tokensDeNome('Daflon Flex 1000mg com 30 envelopes')).toEqual(['daflon', 'flex']);
    expect(tokenPrincipal('')).toBeNull();
  });
});

describe('substituto pelo nome', () => {
  it('Venaflon não é Daflon; Daflon Flex é Daflon', () => {
    expect(ehSubstitutoPeloNome('Daflon Flex 1000', 'Venaflon 900mg+100mg 30 comprimidos')).toBe(true);
    expect(ehSubstitutoPeloNome('Daflon Flex 1000', 'Daflon Flex 1000mg 30 envelopes')).toBe(false);
    expect(ehSubstitutoPeloNome('Dipirona 500mg', 'genérico da dipirona')).toBe(true);
  });
  it('montarProdutoCotado decide substituto pelo nome quando ninguém disse', () => {
    const pc = montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Venaflon 30 cpr', fonte: 'agente', agora: new Date('2026-09-10T15:23:00Z') });
    expect(pc.substituto).toBe(true);
    const sem = montarProdutoCotado({ pedido: 'Daflon Flex 1000', fonte: 'auto_captura' });
    expect(sem.cotado).toBeNull();
    expect(sem.substituto).toBeNull(); // sem nome, não afirma nada
  });
});

describe('detectarSubstitutoOferecido — o texto da Coimbra', () => {
  it('"Só estou tendo o Venaflon concorrente do Daflon" → substituto Venaflon', () => {
    const r = detectarSubstitutoOferecido('Só estou tendo o Venaflon concorrente do Daflon', 'Daflon Flex 1000');
    expect(r).toEqual({ substituto: true, nome: 'Venaflon' });
  });
  it('"tem o genérico" é substituto sem nome; "temos sim" e "tenho o Daflon" não são', () => {
    expect(detectarSubstitutoOferecido('tem o genérico, quer?', 'Dipirona 500mg').substituto).toBe(true);
    expect(detectarSubstitutoOferecido('temos sim, 64,90', 'Daflon Flex 1000').substituto).toBe(false);
    expect(detectarSubstitutoOferecido('só tenho o Daflon de 30', 'Daflon Flex 1000').substituto).toBe(false);
    expect(detectarSubstitutoOferecido('', 'x')).toEqual({ substituto: false, nome: null });
  });
});

describe('linhaDoProduto — honesta sobre o que sabe', () => {
  it('substituto nomeado, substituto sem nome, produto confirmado, produto desconhecido', () => {
    expect(linhaDoProduto(montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Venaflon', apresentacao: '30 comprimidos', fonte: 'agente' })))
      .toBe('⚠️ Venaflon (30 comprimidos) — similar, não é o Daflon Flex 1000');
    expect(linhaDoProduto(montarProdutoCotado({ pedido: 'Daflon Flex 1000', substituto: true, fonte: 'texto_da_farmacia' })))
      .toBe('⚠️ um similar (a farmácia não tem o Daflon Flex 1000)');
    expect(linhaDoProduto(montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Daflon Flex 1000mg 30 envelopes', fonte: 'agente' })))
      .toBe('Daflon Flex 1000mg 30 envelopes');
    expect(linhaDoProduto(null)).toBe('(a farmácia não confirmou o produto)');
    expect(linhaDoProduto(montarProdutoCotado({ pedido: 'X', fonte: 'auto_captura' }))).toBe('(a farmácia não confirmou o produto)');
  });
});

describe('podeAfirmarQueEh — a pergunta da Ludmila', () => {
  it('"é o daflon flex 1000mg com 30 envelopes?" com Venaflon cotado → nao; sem produto → nao_sei; com Daflon → sim', () => {
    const venaflon = montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Venaflon 30 cpr', fonte: 'agente' });
    expect(podeAfirmarQueEh('daflon flex 1000mg com 30 envelopes', venaflon)).toBe('nao');
    expect(podeAfirmarQueEh('daflon flex 1000mg com 30 envelopes', null)).toBe('nao_sei');
    expect(podeAfirmarQueEh('daflon flex', montarProdutoCotado({ pedido: 'Daflon Flex 1000', fonte: 'auto_captura' }))).toBe('nao_sei');
    expect(podeAfirmarQueEh('daflon flex', montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Daflon Flex 1000mg 30 envelopes', fonte: 'agente' }))).toBe('sim');
  });
});

describe('afirmacaoDeProdutoSemProva — a resposta "Sim, é o Daflon Flex…" cai', () => {
  const coimbraVenaflon = [{ supplierName: 'Drogaria Coimbra', produto: montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Venaflon', apresentacao: '30 comprimidos', fonte: 'agente' }) }];
  it('afirmação sobre substituto vira correção honesta', () => {
    const r = afirmacaoDeProdutoSemProva('Sim, é o Daflon Flex 1000mg com 30 envelopes pelo valor de R$64,90 na Drogaria Coimbra. Quer fechar?', coimbraVenaflon);
    expect(r).not.toBeNull();
    expect(r!.corrigido).toContain('Não é o Daflon Flex 1000');
    expect(r!.corrigido).toContain('Venaflon');
  });
  it('afirmação sem produto conhecido vira "não posso garantir"', () => {
    const r = afirmacaoDeProdutoSemProva('É o Daflon Flex mesmo, 64,90!', [{ supplierName: 'Drogaria Coimbra', produto: montarProdutoCotado({ pedido: 'Daflon Flex 1000', fonte: 'auto_captura' }) }]);
    expect(r).not.toBeNull();
    expect(r!.corrigido).toContain('não confirmou o produto');
  });
  it('afirmação COM prova passa; frases que não afirmam produto passam', () => {
    const ok = [{ supplierName: 'Drogaria Coimbra', produto: montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Daflon Flex 1000mg 30 envelopes', fonte: 'agente' }) }];
    expect(afirmacaoDeProdutoSemProva('Sim, é o Daflon Flex 1000mg com 30 envelopes!', ok)).toBeNull();
    expect(afirmacaoDeProdutoSemProva('O valor é o total com entrega, tá?', coimbraVenaflon)).toBeNull();
    expect(afirmacaoDeProdutoSemProva('Já cotei com eles 💙', coimbraVenaflon)).toBeNull();
  });
});

describe('consertarAceiteDeSubstituto — "Venaflon serve sim" sem consentimento', () => {
  it('sem substitutes_ok=true, o aceite vira "vou confirmar"', () => {
    const r = consertarAceiteDeSubstituto('Ah, entendi! Venaflon serve sim. Consegue me passar o valor e o prazo?', [{ substitutes_ok: null }]);
    expect(r.corrigiu).toBe(true);
    expect(r.texto).toContain('confirmar se pode ser o similar');
  });
  it('com substitutes_ok=true o aceite é legítimo; frases sem aceite passam', () => {
    expect(consertarAceiteDeSubstituto('pode ser o genérico sim', [{ substitutes_ok: true }]).corrigiu).toBe(false);
    expect(consertarAceiteDeSubstituto('Deixa eu confirmar isso aqui rapidinho', [{ substitutes_ok: null }]).corrigiu).toBe(false);
    expect(consertarAceiteDeSubstituto('pode ser hoje à tarde?', [{ substitutes_ok: false }]).corrigiu).toBe(false);
  });
});

describe('pacienteFalouDeSubstituto — o booleano só vale com fala', () => {
  it('foto + "consegue cotar?" → não falou; "pode ser genérico" / "só o original" → falou', async () => {
    const { pacienteFalouDeSubstituto } = await import('../packages/shared/src/produto-cotado');
    expect(pacienteFalouDeSubstituto(['Consegue cotar esse medicamento por favor'])).toBe(false);
    expect(pacienteFalouDeSubstituto(['pode ser genérico'])).toBe(true);
    expect(pacienteFalouDeSubstituto(['quero dipirona', 'tem que ser a marca'])).toBe(true);
    expect(pacienteFalouDeSubstituto(['não aceito similar'])).toBe(true);
    expect(pacienteFalouDeSubstituto([null, undefined, ''])).toBe(false);
  });
});
