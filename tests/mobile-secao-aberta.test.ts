import { describe, it, expect } from 'vitest';
import { secaoAberta } from '../apps/mobile/src/components/ui/secao-aberta.js';

/**
 * A regra de abertura da `CollapsibleSection`.
 *
 * O defeito original: `defaultOpen` era lido UMA vez, no inicializador do `useState`. A
 * tela Saúde monta "Alergias" com contador 0 (a consulta ainda não voltou), a seção
 * congelava fechada, e continuava fechada mesmo depois de a alergia existir — inclusive
 * quando a própria paciente a registrava pelo "+ Contar" da mesma tela. Pior: o
 * `emptyHint` some quando `count` deixa de ser 0, então a linha virava "Alergias · 1"
 * com absolutamente nada embaixo.
 *
 * Este arquivo trava a regra nos dois sentidos: o dado que chega ABRE a seção que nunca
 * foi tocada, e não desfaz a escolha de quem tocou.
 */
describe('secaoAberta', () => {
  it('mantém fechada a seção que pediu `defaultOpen` mas montou vazia', () => {
    expect(secaoAberta({ tocou: false, manual: false, defaultOpen: true, vazia: true })).toBe(false);
  });

  it('ABRE sozinha quando o dado chega — o defeito que travava Alergias fechada', () => {
    const montagem = { tocou: false, manual: false, defaultOpen: true, vazia: true };
    expect(secaoAberta(montagem)).toBe(false);
    // A consulta voltou (ou a paciente tocou em "+ Contar"): `count` foi de 0 pra 1.
    expect(secaoAberta({ ...montagem, vazia: false })).toBe(true);
  });

  it('não abre sozinha a seção que a tela pediu recolhida', () => {
    expect(secaoAberta({ tocou: false, manual: false, defaultOpen: false, vazia: true })).toBe(false);
    expect(secaoAberta({ tocou: false, manual: false, defaultOpen: false, vazia: false })).toBe(false);
  });

  it('trata `count === null` como cheia: "não deu pra contar" não é zero', () => {
    // O componente passa `vazia = count === 0`, então `null` chega aqui como `false`.
    expect(secaoAberta({ tocou: false, manual: false, defaultOpen: true, vazia: false })).toBe(true);
  });

  it('depois do toque, a escolha da pessoa vence o dado que chega depois', () => {
    // Ela fechou uma seção `defaultOpen` cheia. Dado novo não pode reabrir na cara dela.
    expect(secaoAberta({ tocou: true, manual: false, defaultOpen: true, vazia: false })).toBe(false);
    // E ela abriu uma seção vazia pra ler o `emptyHint`: continua aberta.
    expect(secaoAberta({ tocou: true, manual: true, defaultOpen: false, vazia: true })).toBe(true);
  });

  it('o esvaziamento também não fecha o que foi aberto com o dedo', () => {
    // Apagou o último item de uma seção que ela mesma abriu: fica aberta, mostrando o
    // `emptyHint`. Fechar sozinha seria a lacuna que se auto-lacra de novo.
    expect(secaoAberta({ tocou: true, manual: true, defaultOpen: true, vazia: true })).toBe(true);
  });
});
