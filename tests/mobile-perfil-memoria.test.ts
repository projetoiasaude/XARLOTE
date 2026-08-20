import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  APAGAR_CARD_DISPONIVEL,
  XARLOTE_SABE_ESQUECER,
  chaveDeCorrecao,
  chaveDeSecao,
  DICA_MEMORIA,
  EXPLICACAO_CONTESTADA,
  filtrarMemoria,
  fraseDeCorrecao,
  idDaCorrecao,
  LIMIAR_BUSCA,
  duvidaDoCard,
  origemDoCard,
  recorte,
  resumoDeMemoria,
  secoesDeMemoria,
  TETO_ABERTO,
} from '../apps/mobile/src/features/profile/memoria.js';
import { dobrar, limitar } from '../apps/mobile/src/features/profile/texto.js';
import type { MemoryCard } from '../apps/mobile/src/features/health/overview.js';

/**
 * A memória da Xarlote na tela do paciente.
 *
 * Cada teste aqui corresponde a uma forma de a tela MENTIR sobre o que a Xarlote sabe:
 * afirmar que deduziu algo que ninguém registrou como dedução, tratar confiança ausente
 * como certeza, sumir com uma seção inteira porque ela está vazia, cortar a lista sem
 * dizer quantas ficaram fora, ou mandar pra conversa uma correção que não cita o que
 * está errado. Nenhuma é hipotética: as quatro primeiras estavam na tela em produção.
 */

const T = Date.parse('2026-08-18T14:00:00.000Z'); // 11h BRT

function card(over: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: 'c1',
    kind: 'fact',
    text: 'toma losartana de manhã',
    tags: null,
    confidence: 0.9,
    source: 'inferred',
    last_seen_at: '2026-08-17T12:00:00.000Z',
    ...over,
  };
}

describe('secoesDeMemoria', () => {
  it('devolve os QUATRO tipos conhecidos mesmo sem nenhum card — seção não some', () => {
    const s = secoesDeMemoria([]);

    expect(s.map((x) => x.kind)).toEqual(['fact', 'affect', 'preference', 'episode']);
    // Contador zero sem explicação é o mesmo vazio mudo com número: cada seção carrega
    // a frase que ensina como aquele dado entra.
    for (const secao of s) {
      expect(secao.cards).toHaveLength(0);
      expect(secao.dica.length).toBeGreaterThan(20);
      expect(secao.dica).toBe(DICA_MEMORIA[secao.kind]);
    }
  });

  it('kind DESCONHECIDO vai pro fim e nunca é descartado', () => {
    const s = secoesDeMemoria([card({ id: 'x', kind: 'humor_novo' })]);

    expect(s).toHaveLength(5);
    expect(s[4]?.kind).toBe('humor_novo');
    expect(s[4]?.cards.map((c) => c.id)).toEqual(['x']);
    // O enricher é a única via que escreve memória e pode gravar um tipo que este app
    // não conhece. Memória invisível é memória inauditável.
    expect(s[4]?.rotulo).toBe('Outras anotações');
  });

  it('ordena por recência, e card SEM data vai pro fim (não pro topo)', () => {
    const s = secoesDeMemoria([
      card({ id: 'antigo', last_seen_at: '2026-01-01T00:00:00.000Z' }),
      card({ id: 'sem-data', last_seen_at: null }),
      card({ id: 'novo', last_seen_at: '2026-08-17T00:00:00.000Z' }),
    ]);

    // A tela promete "as 5 mais recentes" ao abrir; sem data no fim é o que impede
    // uma linha antiga sem carimbo de ocupar a vaga de uma recente.
    expect(s[0]?.cards.map((c) => c.id)).toEqual(['novo', 'antigo', 'sem-data']);
  });

  it('data ilegível é tratada como ausente, não como ano zero', () => {
    const s = secoesDeMemoria([
      card({ id: 'quebrado', last_seen_at: 'ontem' }),
      card({ id: 'bom', last_seen_at: '2026-08-01T00:00:00.000Z' }),
    ]);
    expect(s[0]?.cards.map((c) => c.id)).toEqual(['bom', 'quebrado']);
  });
});

describe('origemDoCard', () => {
  it('são TRÊS estados — e origem ausente NÃO vira "eu deduzi"', () => {
    expect(origemDoCard(card({ source: 'self_reported' })).origem).toBe('contou');
    expect(origemDoCard(card({ source: 'inferred' })).origem).toBe('deduzi');

    // Este é o teste que importa: a tela antiga fazia
    // `source === 'self_reported' ? 'você me disse' : 'eu percebi'`, e assim afirmava
    // dedução sobre uma linha em que ninguém gravou procedência.
    expect(origemDoCard(card({ source: null })).origem).toBe('desconhecida');
    expect(origemDoCard(card({ source: '' })).origem).toBe('desconhecida');
    expect(origemDoCard(card({ source: 'importado_2024' })).origem).toBe('desconhecida');
  });

  it('tolera caixa e espaço na coluna, que vem de fora', () => {
    expect(origemDoCard(card({ source: '  Self_Reported ' })).origem).toBe('contou');
    expect(origemDoCard(card({ source: 'INFERRED' })).origem).toBe('deduzi');
  });

  it('cada estado explica o que fazer, e o desconhecido pede conferência', () => {
    for (const fonte of ['self_reported', 'inferred', null]) {
      const r = origemDoCard(card({ source: fonte }));
      expect(r.rotulo.length).toBeGreaterThan(0);
      expect(r.explicacao.length).toBeGreaterThan(30);
    }
    expect(origemDoCard(card({ source: null })).tom).toBe('warn');
  });
});

describe('duvidaDoCard', () => {
  it('dedução com confiança baixa DIZ a dúvida', () => {
    expect(duvidaDoCard(card({ source: 'inferred', confidence: 0.72 }))).toBe(
      'não tenho certeza desta',
    );
  });

  it('dedução com confiança alta não polui o cartão', () => {
    expect(duvidaDoCard(card({ source: 'inferred', confidence: 0.95 }))).toBeNull();
  });

  it('confiança AUSENTE não vira certeza nem vira dúvida — não se afirma nada', () => {
    expect(duvidaDoCard(card({ source: 'inferred', confidence: null }))).toBeNull();
    expect(duvidaDoCard(card({ source: 'inferred', confidence: Number.NaN }))).toBeNull();
  });

  it('o que o paciente CONTOU não recebe rótulo de dúvida, qualquer que seja o número', () => {
    // A confiança mede a extração, não a palavra da pessoa. Duvidar do que ela disse
    // na cara dela seria o oposto do que a persona faz.
    expect(duvidaDoCard(card({ source: 'self_reported', confidence: 0.1 }))).toBeNull();
    expect(duvidaDoCard(card({ source: null, confidence: 0.1 }))).toBeNull();
  });
});

describe('filtrarMemoria', () => {
  const acervo = [
    card({ id: '1', text: 'tem pavor de injeção' }),
    card({ id: '2', text: 'prefere áudio a texto' }),
    card({ id: '3', text: 'mora sozinha', tags: ['MORADIA', 'Família'] }),
  ];

  it('acha sem acento e sem caixa, nas duas direções', () => {
    expect(filtrarMemoria(acervo, 'AUDIO').map((c) => c.id)).toEqual(['2']);
    expect(filtrarMemoria(acervo, 'áudio').map((c) => c.id)).toEqual(['2']);
    expect(filtrarMemoria(acervo, 'injecao').map((c) => c.id)).toEqual(['1']);
  });

  it('acha por tag também — a tag é o que o enricher usa pra agrupar assunto', () => {
    expect(filtrarMemoria(acervo, 'familia').map((c) => c.id)).toEqual(['3']);
  });

  it('termo vazio devolve o MESMO array (não invalida memo de lista à toa)', () => {
    expect(filtrarMemoria(acervo, '')).toBe(acervo);
    expect(filtrarMemoria(acervo, '   ')).toBe(acervo);
  });

  it('sem casamento devolve lista vazia — e a tela distingue isso de "não tenho nada"', () => {
    expect(filtrarMemoria(acervo, 'dipirona')).toHaveLength(0);
  });
});

describe('recorte', () => {
  const dez = Array.from({ length: 10 }, (_, i) => `c${i}`);

  it('corta no teto e DIZ quantos ficaram fora', () => {
    const r = recorte(dez, false);
    expect(r.visiveis).toHaveLength(TETO_ABERTO);
    expect(r.escondidos).toBe(10 - TETO_ABERTO);
  });

  it('"ver todas" mostra tudo e zera o contador de escondidos', () => {
    const r = recorte(dez, true);
    expect(r.visiveis).toHaveLength(10);
    expect(r.escondidos).toBe(0);
  });

  it('lista curta não anuncia corte nenhum', () => {
    const r = recorte(['a', 'b'], false);
    expect(r.visiveis).toEqual(['a', 'b']);
    expect(r.escondidos).toBe(0);
  });

  it('exatamente no teto não esconde nada (fronteira conta pelo que é CONTADO)', () => {
    expect(recorte(dez.slice(0, TETO_ABERTO), false).escondidos).toBe(0);
  });
});

describe('chaveDeSecao — o "ver todas" da busca não pode ligar a lista inteira', () => {
  const quarenta = Array.from({ length: 40 }, (_, i) => `f${i}`);
  const sete = quarenta.slice(0, 7);

  it('a lista FILTRADA e a lista COMPLETA são duas seções, com chaves diferentes', () => {
    expect(chaveDeSecao('fact', true)).not.toBe(chaveDeSecao('fact', false));
    expect(chaveDeSecao('fact', false)).not.toBe(chaveDeSecao('affect', false));
  });

  it('expandir os 7 achados não devolve os 40 inteiros quando a busca é apagada', () => {
    // O toque em "ver todas (7)" dentro da busca: o estado nasce indexado pela chave da
    // seção FILTRADA — que é a seção que a pessoa está vendo.
    const tudoAberto: Record<string, boolean> = { [chaveDeSecao('fact', true)]: true };

    expect(recorte(sete, tudoAberto[chaveDeSecao('fact', true)] === true).visiveis).toHaveLength(7);

    // Apagou a busca. Com a chave indexada só pelo `kind`, aqui vinham os 40 cartões de
    // vidro de uma vez, num ScrollView sem virtualização e sem nenhum "ver todas" à
    // vista pra desfazer — a rolagem de dezenas de cartões que este bloco existe pra
    // matar, reintroduzida por um toque numa lista de 7.
    const completa = recorte(quarenta, tudoAberto[chaveDeSecao('fact', false)] === true);
    expect(completa.visiveis).toHaveLength(TETO_ABERTO);
    expect(completa.escondidos).toBe(40 - TETO_ABERTO);
  });
});

describe('a chave do pedido em voo (é ela que marca o cartão como contestado)', () => {
  it('vai e volta, inclusive com id que tem dois-pontos', () => {
    expect(idDaCorrecao(chaveDeCorrecao('c1'))).toBe('c1');
    expect(idDaCorrecao(chaveDeCorrecao('a:b'))).toBe('a:b');
  });

  it('o que não é correção de memória não marca cartão nenhum', () => {
    // O mesmo hook de envio serve à Saúde 360 (`exame:…`, `remedio:…`). Um pedido de lá
    // em voo não pode carimbar "você me corrigiu" numa anotação.
    expect(idDaCorrecao('exame:42')).toBeNull();
    expect(idDaCorrecao(null)).toBeNull();
    expect(idDaCorrecao(undefined)).toBeNull();
    expect(idDaCorrecao('memoria:')).toBeNull();
  });
});

describe('resumoDeMemoria', () => {
  it('vazio FALA, em vez de devolver "0 anotações"', () => {
    expect(resumoDeMemoria([]).frase).toBe('ainda não guardei nada sobre você');
  });

  it('singular e plural, e a proporção de dedução', () => {
    expect(resumoDeMemoria([card({ source: 'self_reported' })]).frase).toBe(
      '1 anotação · todas vindas de você',
    );
    expect(resumoDeMemoria([card({ id: 'a' }), card({ id: 'b' })]).frase).toBe(
      '2 anotações · 2 são dedução minha',
    );
    expect(
      resumoDeMemoria([card({ id: 'a' }), card({ id: 'b', source: 'self_reported' })]).frase,
    ).toBe('2 anotações · 1 é dedução minha');
  });

  it('conta as três origens separadamente', () => {
    const r = resumoDeMemoria([
      card({ id: 'a', source: 'self_reported' }),
      card({ id: 'b', source: 'inferred' }),
      card({ id: 'c', source: null }),
    ]);
    expect(r).toMatchObject({ total: 3, contados: 1, deduzidos: 1, semOrigem: 1 });
  });

  it('o limiar de busca é um número usável (a tela decide o campo por ele)', () => {
    expect(LIMIAR_BUSCA).toBeGreaterThan(TETO_ABERTO);
  });

  it('`origens` diz só a procedência — o total já está no contador do cabeçalho', () => {
    // O bloco de memória inteiro vive dentro de uma CollapsibleSection, que mostra
    // "· 23" no título. Repetir "23 anotações" na linha de baixo é dizer o mesmo dado
    // duas vezes a 20px de distância.
    expect(resumoDeMemoria([]).origens).toBe('');
    expect(resumoDeMemoria([card({ source: 'self_reported' })]).origens).toBe(
      'todas vindas de você',
    );
    const dois = resumoDeMemoria([card({ id: 'a' }), card({ id: 'b' })]);
    expect(dois.origens).toBe('2 são dedução minha');
    expect(dois.origens).not.toContain('anotaç');
    // E a linha inteira continua existindo pra quem não tem contador ao lado.
    expect(dois.frase).toContain('2 anotações');
  });
});

describe('fraseDeCorrecao', () => {
  it('CITA a anotação errada — sem a citação, a Xarlote não sabe o que corrigir', () => {
    const f = fraseDeCorrecao(card({ text: 'é alérgica a dipirona' }), 'nunca tive alergia a dipirona');
    expect(f).toContain('"é alérgica a dipirona"');
    expect(f).toContain('O certo é: nunca tive alergia a dipirona');
  });

  it('sem correção escrita, NÃO pede pra apagar — apagar é o que ela não sabe fazer', () => {
    const f = fraseDeCorrecao(card({ text: 'mora sozinha' }), '   ');
    expect(f).toContain('"mora sozinha"');
    // O fecho antigo era "Isso não vale mais — pode tirar.", e não havia nada atrás:
    // sem `DELETE /app/memory/:id`, sem tool de esquecer em `xarlote-tools.ts`, e
    // `save_user_profile_fact` nunca toca em `memory_cards_index`. Uma LLM sem a
    // ferramenta responde "pronto, tirei" — confirmação falsa sobre memória clínica, e
    // contradizendo o rodapé da própria tela.
    // O botão da tela JÁ apaga (DELETE /app/memory/:id existe). Mas a frase acima é lida
    // pela LLM, e ela continua sem tool de esquecer — por isso o interruptor conferido
    // aqui é o da LLM, não o do botão. Confundir os dois traz de volta o "pronto, tirei"
    // que nunca aconteceu.
    expect(XARLOTE_SABE_ESQUECER).toBe(false);
    expect(f).not.toMatch(/pode tirar|apag|remov|esquec/i);
    expect(f).toContain('anota que eu te corrigi');
  });

  it('quebra de linha do campo não vira mensagem de várias linhas', () => {
    const f = fraseDeCorrecao(card({ text: 'a\n\nb' }), 'x\ny');
    expect(f).not.toContain('\n');
  });

  it('nunca estoura o corpo aceito pelo POST /app/messages, nem com entrada patológica', () => {
    const enorme = 'losartana '.repeat(2000);
    const f = fraseDeCorrecao(card({ text: enorme }), enorme);
    // O servidor recusa acima de 4000 e o 400 apareceria como "não consegui mandar"
    // depois de a pessoa já ter confirmado o envio.
    expect(f.length).toBeLessThan(1000);
    expect(f).toContain('…');
  });
});

describe('o laço da correção, dito na tela porque não fecha no banco', () => {
  it('nenhuma explicação de origem promete que a correção acontece sozinha', () => {
    // Nada no caminho da correção escreve em `memory_cards_index`: a mensagem vai pro
    // chat e o card errado continua onde estava. "Me avisa que eu corrijo" fazia a
    // pessoa voltar ao Perfil esperando encontrar a frase consertada.
    for (const fonte of ['self_reported', 'inferred', null]) {
      expect(origemDoCard(card({ source: fonte })).explicacao).not.toMatch(
        /eu corrijo|já corrigi|eu apago/i,
      );
    }
  });

  it('contestado DIZ que a anotação velha continua ali — não anuncia reparo', () => {
    expect(EXPLICACAO_CONTESTADA).toMatch(/continua aqui/i);
    expect(EXPLICACAO_CONTESTADA).not.toMatch(/apaguei|removi|tirei|já corrigi/i);
  });

  it('e não promete reparo FUTURO tampouco — ninguém no sistema reescreve um card', () => {
    /*
      A frase anterior era "esta anotação antiga continua aqui até eu reescrever". Não
      anunciava um reparo que não houve; anunciava um que não vem, que é o mesmo defeito
      uma casa adiante.

      Nenhum caminho reescreve: `packages/db/src/memory.ts` sabe inserir, refrescar
      (`last_seen_at` + confiança) e apagar tudo — só isso; `save_user_profile_fact`
      escreve em `users`/`user_allergies`/`user_health_conditions`/`user_medications` e
      nunca toca em `memory_cards_index`; e `xarlote-tools.ts` não tem tool de editar nem
      de esquecer.

      E o desfecho pode ser o INVERSO do prometido: o enricher grava a correção com
      embedding, e o dedup semântico a 0.85 põe "é alérgica a dipirona" e "não é alérgica
      a dipirona" quase no mesmo ponto. Quando bate acima do limiar, a correção não é
      inserida — o card ERRADO é refrescado (`last_seen_at` novo, confiança +0.05), o que
      o deixa mais recente na lista da pessoa e no retrieval, e ainda apaga o badge "não
      tenho certeza desta", que é `confidence < 0.8`.
    */
    expect(EXPLICACAO_CONTESTADA).not.toMatch(/reescrev|até eu|vou corrigir|vou apagar/i);
  });

  it('e a mesma régua vale pro que está escrito NA TELA, não só na constante', () => {
    // A promessa de reescrita aparecia duas vezes: na constante acima e na ajuda do
    // formulário de correção, dentro do TSX ("assim eu passo a considerar o certo …
    // ela fica aqui até eu reescrever"). Testar só a constante deixaria metade da
    // mentira de pé — e é a metade que a pessoa lê no instante em que digita a correção.
    const dir = fileURLToPath(new URL('../apps/mobile/src/features/profile/', import.meta.url));
    const infratores: string[] = [];

    for (const arquivo of ['CardMemoria.tsx', 'BlocoMemoria.tsx']) {
      // Comentário é onde o histórico do defeito fica registrado de propósito (inclusive
      // a frase antiga, citada). O que vale é o que chega na tela: some com os blocos
      // `/* … */` (docblock e comentário JSX) e com as linhas `//`.
      const visivel = readFileSync(`${dir}${arquivo}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/reescrev/i.test(visivel)) infratores.push(arquivo);
    }

    expect(infratores).toEqual([]);
  });
});

describe('o interruptor do apagamento', () => {
  it('está DESLIGADO enquanto DELETE /app/memory/:id não existir', () => {
    // Tripwire deliberado: quem ligar esta constante cai neste teste e é obrigado a
    // atualizar o comentário — que é onde está escrito o contrato da rota. Ligar sem a
    // rota faria a tela oferecer um botão que devolve 404, e "falha nunca vira sucesso"
    // vale também pro caminho inverso: sucesso anunciado sem nada atrás.
    // O botão da tela JÁ apaga (DELETE /app/memory/:id existe). Mas a frase acima é lida
    // pela LLM, e ela continua sem tool de esquecer — por isso o interruptor conferido
    // aqui é o da LLM, não o do botão. Confundir os dois traz de volta o "pronto, tirei"
    // que nunca aconteceu.
    expect(XARLOTE_SABE_ESQUECER).toBe(false);
  });
});

describe('as ferramentas de texto', () => {
  it('dobrar tira acento, caixa e espaço duplo — e é o que compara nome', () => {
    expect(dobrar('  MÁRCIA   das  Graças ')).toBe('marcia das gracas');
    expect(dobrar('João Ção Ñu')).toBe('joao cao nu');
  });

  it('limitar avisa que cortou e não parte palavra sem motivo', () => {
    expect(limitar('abcdef', 10)).toBe('abcdef');
    const r = limitar('losartana cinquenta miligramas pela manha toda', 20);
    expect(r.endsWith('…')).toBe(true);
    expect(r.length).toBeLessThanOrEqual(21);
    expect(r).not.toContain('  ');
  });

  it('limitar corta no teto quando não há fronteira de palavra utilizável', () => {
    // Sem espaço no trecho, o corte é seco — mas o "…" continua avisando. O que não
    // pode acontecer é devolver só o aviso e jogar o conteúdo todo fora.
    expect(limitar('palavraenormessemespaco', 8)).toBe('palavrae…');
  });
});
