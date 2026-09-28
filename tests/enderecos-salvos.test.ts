/**
 * Endereço salvo anotado de mais de um jeito — a Xarlote percebe, pergunta e arruma.
 * As linhas abaixo são as do cadastro da Ludmila em 28/09/2026 (o pedido de Cefaliv pegou a
 * "casa" que o banco devolveu primeiro: acertou por sorte e saiu sem o número 201).
 */
import { describe, it, expect } from 'vitest';
import {
  diagnosticarEnderecoSalvo,
  perguntaDeConfirmacaoDeEndereco,
  respostaDeConfirmacaoDeEndereco,
  mesmoLugar,
  partesDoSalvo,
  enderecoValido,
  MARCA_CONFIRMACAO_ENDERECO,
  type EnderecoSalvo,
} from '../packages/shared/src/enderecos-salvos.js';

const CASA_OESTE: EnderecoSalvo = { id: 'a', label: 'casa', street: 'Rua 14', number: null, complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Oeste', city: 'Goiânia', cep: '74115-060', latitude: -16.687, longitude: -49.263, usage_count: 4, is_default: false };
const CASA_201: EnderecoSalvo = { id: 'b', label: 'casa', street: 'Rua 14, 201, Qd. B8, Lt. 20', number: null, complement: null, neighborhood: 'Setor Oeste', city: 'Goiânia', cep: null, latitude: null, longitude: null, usage_count: 0, is_default: false };
const CASA_SUL: EnderecoSalvo = { id: 'c', label: 'casa', street: 'Rua 14', number: null, complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Sul', city: 'Goiânia', cep: '74120-070', latitude: -16.687, longitude: -49.261, usage_count: 1, is_default: false };
const TRABALHO_SUL: EnderecoSalvo = { id: 'd', label: 'trabalho', street: 'Rua 14', number: null, complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Sul', city: 'Goiânia', cep: '74120-070', latitude: -16.687, longitude: -49.261, usage_count: 4, is_default: true };
const TRABALHO_LIXO: EnderecoSalvo = { id: 'e', label: 'trabalho', street: 'CEP 74085130', number: null, complement: null, neighborhood: '', city: '', cep: null, latitude: null, longitude: null, usage_count: 0, is_default: false };
const LUDMILA = [CASA_OESTE, CASA_201, CASA_SUL, TRABALHO_SUL, TRABALHO_LIXO];

describe('leitura das linhas salvas', () => {
  it('o "201" enfiado no campo da rua vira número; "CEP 74085130" como rua não é endereço', () => {
    expect(partesDoSalvo(CASA_201)).toMatchObject({ street: 'Rua 14', number: '201', complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Oeste' });
    expect(enderecoValido(partesDoSalvo(TRABALHO_LIXO))).toBe(false);
    expect(enderecoValido(partesDoSalvo(CASA_OESTE))).toBe(true);
  });

  it('mesmo lugar = mesma rua sem nada divergente; outro setor é outro lugar', () => {
    expect(mesmoLugar(partesDoSalvo(CASA_OESTE), partesDoSalvo(CASA_201))).toBe(true);
    expect(mesmoLugar(partesDoSalvo(CASA_OESTE), partesDoSalvo(CASA_SUL))).toBe(false);
  });
});

describe('diagnóstico — o caso Ludmila (28/09)', () => {
  const FALA = ['Oi xarlote, tudo bem? Pede um cefaliv pra mim por favor. Entregar aqui na rua 14, setor oeste'];

  it('"casa" tem dois lugares (Oeste e Sul): é conflito, e a fala dela aponta o Oeste', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'casa', FALA);
    expect(d.tipo).toBe('conflito');
    if (d.tipo !== 'conflito') return;
    expect(d.variantes).toHaveLength(2);
    expect(d.apontada?.texto).toBe('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste');
  });

  it('as duas linhas do Oeste se FUNDEM: o número de uma, o CEP e a coordenada da outra', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'casa', FALA);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    const oeste = d.apontada!;
    expect(oeste.ids.sort()).toEqual(['a', 'b']);
    expect(oeste.manter).toBe('a');                       // a que tem coordenada e mais uso
    expect(oeste.textoCompleto).toBe('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste, Goiânia, 74115-060');
    expect(oeste.coord).toEqual({ lat: -16.687, lng: -49.263 });
  });

  it('a pergunta cita o endereço completo e começa com a marca (é por ela que a conversa lembra)', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'casa', FALA);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    const p = perguntaDeConfirmacaoDeEndereco(d);
    expect(p.startsWith(MARCA_CONFIRMACAO_ENDERECO)).toBe(true);
    expect(p).toContain('*Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste*, é isso?');
  });

  it('"isso" confirma o apontado; "não" não escolhe nada (o modelo conduz)', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'casa', FALA);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    const p = perguntaDeConfirmacaoDeEndereco(d);
    expect(respostaDeConfirmacaoDeEndereco(p, 'isso', d)?.ids.sort()).toEqual(['a', 'b']);
    expect(respostaDeConfirmacaoDeEndereco(p, 'Sim, é esse mesmo', d)?.manter).toBe('a');
    expect(respostaDeConfirmacaoDeEndereco(p, 'não, mudei de casa', d)).toBeNull();
    // respondeu com o próprio endereço, ou apontou o OUTRO lugar: vale (senão seria loop)
    expect(respostaDeConfirmacaoDeEndereco(p, 'Rua 14, 201, setor oeste', d)?.manter).toBe('a');
    expect(respostaDeConfirmacaoDeEndereco(p, 'não, é o do setor sul', d)?.manter).toBe('c');
    expect(respostaDeConfirmacaoDeEndereco('Outra coisa qualquer', 'isso', d)).toBeNull(); // não era a pergunta
  });

  it('sem pista na fala: lista as opções, e a resposta escolhe por número ou pelo que só uma tem', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'casa', ['pode mandar pra casa']);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    expect(d.apontada).toBeNull();
    const p = perguntaDeConfirmacaoDeEndereco(d);
    expect(p).toContain('1) *Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste*');
    expect(p).toContain('2) *Rua 14, Qd. B8, Lt. 20, Setor Sul*');
    expect(respostaDeConfirmacaoDeEndereco(p, '1', d)?.manter).toBe('a');
    expect(respostaDeConfirmacaoDeEndereco(p, 'o do setor oeste', d)?.manter).toBe('a');
    expect(respostaDeConfirmacaoDeEndereco(p, 'a segunda', d)?.manter).toBe('c');
    expect(respostaDeConfirmacaoDeEndereco(p, 'rua 14', d)).toBeNull();    // as duas têm: ambíguo
  });

  it('"trabalho": a linha-lixo sai; e a mesma rua/quadra/lote no Oeste (da "casa") vira pergunta', () => {
    const d = diagnosticarEnderecoSalvo(LUDMILA, 'trabalho', ['manda pro trabalho']);
    expect(d.tipo).toBe('conflito');
    if (d.tipo !== 'conflito') return;
    expect(d.variantes.map((v) => v.partes.neighborhood).sort()).toEqual(['Setor Oeste', 'Setor Sul']);
  });
});

describe('diagnóstico — sem conflito', () => {
  it('linhas repetidas do mesmo lugar: usa uma, fundida, e marca as outras (e o lixo) pra sair', () => {
    const todos: EnderecoSalvo[] = [
      { ...CASA_OESTE, id: 'x1' },
      { ...CASA_201, id: 'x2' },
      { ...TRABALHO_LIXO, id: 'x3', label: 'casa' },
    ];
    const d = diagnosticarEnderecoSalvo(todos, 'casa', []);
    expect(d.tipo).toBe('unico');
    if (d.tipo !== 'unico') return;
    expect(d.lugar.texto).toBe('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste');
    expect(d.remover.sort()).toEqual(['x2', 'x3']);
  });

  it('um endereço só, limpo: usa como está, nada a remover', () => {
    const d = diagnosticarEnderecoSalvo([CASA_OESTE], 'casa', []);
    expect(d).toMatchObject({ tipo: 'unico', remover: [] });
  });

  it('rótulo inexistente ou só com lixo → nenhum', () => {
    expect(diagnosticarEnderecoSalvo(LUDMILA, 'academia', []).tipo).toBe('nenhum');
    expect(diagnosticarEnderecoSalvo([TRABALHO_LIXO], 'trabalho', []).tipo).toBe('nenhum');
  });

  it('outro rótulo em OUTRA rua não é conflito (duas casas de verdade podem existir)', () => {
    const outra: EnderecoSalvo = { id: 'z', label: 'trabalho', street: 'Avenida T-63', number: '1296', complement: null, neighborhood: 'Setor Bueno', city: 'Goiânia', cep: '74230-100', latitude: -16.7, longitude: -49.27, usage_count: 2 };
    const d = diagnosticarEnderecoSalvo([CASA_OESTE, outra], 'casa', []);
    expect(d.tipo).toBe('unico');
  });
});

describe('revisão de 28/09 — o que a primeira versão errava', () => {
  it('B1: as COLUNAS valem; o parser não reescreve "S/N", "Portão azul", "Rua RE 3" nem o setor', () => {
    const casos: EnderecoSalvo[] = [
      { id: '1', label: 'casa', street: 'Rua 14', number: 'S/N', complement: 'Portão azul', neighborhood: 'Setor Oeste', city: 'Goiânia', cep: '74115-060', latitude: -16.6, longitude: -49.2 },
      { id: '2', label: 'casa', street: 'Rua RE 3', number: '5', complement: 'Condomínio Solar, casa 5', neighborhood: 'Setor Marista', city: 'Goiânia', cep: null, latitude: -16.7, longitude: -49.25 },
      { id: '3', label: 'casa', street: 'Q. 5', number: null, complement: null, neighborhood: null, city: 'Goiânia', cep: null, latitude: -16.7, longitude: -49.3 },
    ];
    for (const e of casos) {
      const p = partesDoSalvo(e);
      expect(p).toEqual({ street: e.street, number: e.number, complement: e.complement, neighborhood: e.neighborhood, city: e.city, state: null, cep: e.cep });
    }
    // endereço de uma linha só: o texto do pedido é o de sempre (rua, número, complemento, setor, cidade)
    const d = diagnosticarEnderecoSalvo([casos[0]!], 'casa', []);
    if (d.tipo !== 'unico') throw new Error('esperava único');
    expect(d.lugar.textoCompleto).toBe('Rua 14, S/N, Portão azul, Setor Oeste, Goiânia, 74115-060');
  });

  it('S6: o CEP da coluna vence um CEP que apareça no texto da rua', () => {
    const e: EnderecoSalvo = { id: 'k', label: 'casa', street: 'Rua 14, 74120-070', cep: '74115-060', latitude: -16.6, longitude: -49.2 };
    expect(partesDoSalvo(e).cep).toBe('74115-060');
  });

  it('S3: "T-63" e "C-149" são ruas; linha com coordenada nunca é lixo', () => {
    expect(enderecoValido({ street: 'T-63', number: '1296', complement: null, neighborhood: 'Setor Bueno', city: null, state: null, cep: null })).toBe(true);
    expect(enderecoValido({ street: 'C-149', number: null, complement: null, neighborhood: null, city: null, state: null, cep: null })).toBe(true);
    expect(enderecoValido({ street: null, number: null, complement: null, neighborhood: null, city: null, state: null, cep: null }, true)).toBe(true);
  });

  it('S4: linha única SEM coordenada (pode ser texto inferido) é confirmada antes de usar', () => {
    const d = diagnosticarEnderecoSalvo([CASA_201], 'casa', []);
    expect(d.tipo).toBe('conflito');
    if (d.tipo !== 'conflito') return;
    const p = perguntaDeConfirmacaoDeEndereco(d);
    expect(p).toContain('*Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste*, é isso?');
    expect(p).not.toContain('mais de um jeito');
    expect(respostaDeConfirmacaoDeEndereco(p, 'sim', d)?.ids).toEqual(['b']);
  });

  describe('B2: na dúvida, nenhuma escolha (errar manda pro setor errado E apaga o cadastro certo)', () => {
    const FALA = ['Entregar aqui na rua 14, setor oeste'];
    const unico = diagnosticarEnderecoSalvo(LUDMILA, 'casa', FALA);
    const lista = diagnosticarEnderecoSalvo(LUDMILA, 'casa', ['manda pra casa']);
    if (unico.tipo !== 'conflito' || lista.tipo !== 'conflito') throw new Error('esperava conflito');
    const pUnico = perguntaDeConfirmacaoDeEndereco(unico);
    const pLista = perguntaDeConfirmacaoDeEndereco(lista);

    it('negar o mostrado nunca o escolhe', () => {
      expect(respostaDeConfirmacaoDeEndereco(pUnico, 'não, não é no setor oeste', unico)).toBeNull();
      expect(respostaDeConfirmacaoDeEndereco(pUnico, 'Não. Rua 14, 210, setor oeste', unico)).toBeNull();
    });

    it('"sim" com número diferente é endereço novo, não confirmação', () => {
      expect(respostaDeConfirmacaoDeEndereco(pUnico, 'sim, mas é o 210', unico)).toBeNull();
    });

    it('na lista, negação ou endereço novo → nada; número só vale sozinho', () => {
      expect(respostaDeConfirmacaoDeEndereco(pLista, 'não é o 1, é o 2', lista)).toBeNull();
      expect(respostaDeConfirmacaoDeEndereco(pLista, 'o 1 não, o segundo', lista)).toBeNull();
      expect(respostaDeConfirmacaoDeEndereco(pLista, 'nenhum dos 2, mudei pra Rua 9', lista)).toBeNull();
      expect(respostaDeConfirmacaoDeEndereco(pLista, 'Rua 3, 12, Setor Oeste', lista)).toBeNull();
      expect(respostaDeConfirmacaoDeEndereco(pLista, 'é a opção 2', lista)?.manter).toBe('c');
      expect(respostaDeConfirmacaoDeEndereco(pLista, '1', lista)?.manter).toBe('a');
    });

    it('a pergunta que não bate mais com o cadastro não escolhe nada', () => {
      expect(respostaDeConfirmacaoDeEndereco(`${MARCA_CONFIRMACAO_ENDERECO}: *Rua 99, Setor X*, é isso?`, 'sim', unico)).toBeNull();
    });
  });

  it('N1: duas opções que só diferem no CEP aparecem com o CEP, e "2" escolhe a segunda', () => {
    const x: EnderecoSalvo = { id: 'p1', label: 'casa', street: 'Rua 10', number: '5', neighborhood: 'Setor Sul', cep: '74000-001', latitude: -16.6, longitude: -49.2, usage_count: 3 };
    const y: EnderecoSalvo = { id: 'p2', label: 'casa', street: 'Rua 10', number: '5', neighborhood: 'Setor Sul', cep: '74000-999', latitude: -16.61, longitude: -49.21, usage_count: 1 };
    const d = diagnosticarEnderecoSalvo([x, y], 'casa', []);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    const p = perguntaDeConfirmacaoDeEndereco(d);
    expect(p).toContain('CEP 74000-001');
    expect(p).toContain('CEP 74000-999');
    expect(respostaDeConfirmacaoDeEndereco(p, '2', d)?.manter).toBe('p2');
  });
});

describe('segunda revisão de 28/09', () => {
  it('"o 1 sim" / "pode ser o 1" é a OPÇÃO 1, mesmo com "Rua 1" na opção 2', () => {
    const oeste: EnderecoSalvo = { id: 'o', label: 'casa', street: 'Rua 14', number: '201', neighborhood: 'Setor Oeste', cep: '74115-060', latitude: -16.68, longitude: -49.26, usage_count: 5 };
    const sul: EnderecoSalvo = { id: 's', label: 'casa', street: 'Rua 1', number: '50', neighborhood: 'Setor Sul', cep: '74083-010', latitude: -16.69, longitude: -49.25, usage_count: 2 };
    const d = diagnosticarEnderecoSalvo([oeste, sul], 'casa', []);
    if (d.tipo !== 'conflito') throw new Error('esperava conflito');
    const p = perguntaDeConfirmacaoDeEndereco(d);
    for (const r of ['o 1 sim', '1 mesmo', 'pode ser o 1', 'a 1 por favor', 'É a opção 1']) {
      expect(respostaDeConfirmacaoDeEndereco(p, r, d)?.manter).toBe('o');
    }
    expect(respostaDeConfirmacaoDeEndereco(p, 'a 2', d)?.manter).toBe('s');
    // "1" solto numa frase que não é só a escolha: na dúvida, nada (não vira "Rua 1")
    expect(respostaDeConfirmacaoDeEndereco(p, 'quero a do setor 1 ali', d)).toBeNull();
  });

  it('o setor que só existe DENTRO do campo da rua não se perde', () => {
    const e: EnderecoSalvo = { id: 'q', label: 'casa', street: 'Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste', neighborhood: null, city: null, cep: null, latitude: null, longitude: null };
    expect(partesDoSalvo(e)).toMatchObject({ street: 'Rua 14', number: '201', complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Oeste' });
    const d = diagnosticarEnderecoSalvo([e], 'casa', []);
    if (d.tipo !== 'conflito') throw new Error('sem coordenada: confirma antes');
    expect(perguntaDeConfirmacaoDeEndereco(d)).toContain('*Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste*');
  });
});

