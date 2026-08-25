/**
 * O cancelamento que a Xarlote anunciou e o sistema não fez.
 *
 * 25/08/2026. O Ciro pediu pra cancelar a consulta de reumatologia. A clínica foi
 * avisada e a Rita confirmou. Mas `cancel_consultation` RECUSOU executar (havia duas
 * consultas possíveis) e, no mesmo minuto, a Xarlote escreveu que estava tudo certo.
 * A consulta continuou `scheduled` e o lembrete das 08:00 do dia seguinte, armado.
 *
 * O texto abaixo é o REAL.
 */
import { describe, it, expect } from 'vitest';
import { verificarAnuncios, falaHonestaPara } from '../packages/shared/src/claim-guard.js';

const FALA_DO_CIRO = 'Tudo certo, Ciro! Cancelamento confirmado com a clínica e já cancelei o lembrete da consulta aqui também 💙';

describe('o anúncio que a ferramenta desmente', () => {
  it('BLOQUEIA o texto do caso Ciro: cancel_consultation recusou', () => {
    const r = verificarAnuncios(FALA_DO_CIRO, ['cancel_consultation'], []);
    expect(r.blocked.map((b) => b.kind)).toContain('cancelamento');
    expect(r.blocked[0]?.tool).toBe('cancel_consultation');
  });

  it('pega também o lembrete que ele disse ter cancelado sem nem tentar', () => {
    // `cancel_reminders` não foi chamada em turno nenhum: sem ferramenta, é SUSPEITA,
    // não bloqueio — o modelo pode estar falando de algo do passado.
    const r = verificarAnuncios(FALA_DO_CIRO, ['cancel_consultation'], []);
    expect(r.suspect.map((s) => s.kind)).toContain('lembrete_cancelado');
  });

  it('NÃO bloqueia quando a ferramenta funcionou (o caminho normal)', () => {
    const r = verificarAnuncios(FALA_DO_CIRO, [], ['cancel_consultation']);
    expect(r.blocked).toHaveLength(0);
  });

  it('sucesso vence falha na mesma família: duas farmácias, uma alcançada', () => {
    const texto = 'Já falei com a farmácia e mandei sua receita 💙';
    const r = verificarAnuncios(texto, ['message_supplier'], ['message_supplier']);
    expect(r.blocked).toHaveLength(0);
  });

  it('honestidade não é bloqueada: "não consegui cancelar" passa', () => {
    const r = verificarAnuncios('Não consegui cancelar a consulta aqui 😕 Me confirma qual é?', ['cancel_consultation'], []);
    expect(r.blocked).toHaveLength(0);
  });

  it('nega por ORAÇÃO, não pela mensagem toda', () => {
    // A primeira oração é verdadeira (a tool de mensagem funcionou), a segunda é honesta.
    // Nenhuma das duas pode ser bloqueada por causa da outra.
    const texto = 'Falei com a clínica, sim. Mas não consegui cancelar aqui no sistema.';
    const r = verificarAnuncios(texto, ['cancel_consultation'], ['contact_establishment']);
    expect(r.blocked).toHaveLength(0);
  });

  it.each([
    ['Pronto, cancelei seu pedido!', 'cancel_order', 'cancelamento'],
    ['Confirmado! Sua consulta está marcada 🎉', 'confirm_consultation_selection', 'agendamento'],
    ['Fechei o pedido com a farmácia 💙', 'confirm_order_selection', 'pedido_fechado'],
    ['Já avisei a farmácia sobre a troca', 'message_supplier', 'mensagem_a_terceiro'],
    ['Guardei seu exame no perfil ✅', 'save_exam_result', 'registro_salvo'],
  ])('bloqueia "%s" quando %s falha', (texto, tool, kind) => {
    const r = verificarAnuncios(texto, [tool], []);
    expect(r.blocked.map((b) => b.kind)).toContain(kind);
  });

  it('conversa comum não vira alarme', () => {
    const r = verificarAnuncios('Oi! Como você tá se sentindo hoje? 💙', ['cancel_consultation'], []);
    expect(r.blocked).toHaveLength(0);
    expect(r.suspect).toHaveLength(0);
  });

  it('texto vazio não quebra', () => {
    expect(verificarAnuncios('', ['cancel_consultation'], [])).toEqual({ blocked: [], suspect: [] });
  });

  it('a fala substituta é honesta e termina pedindo o próximo passo', () => {
    const fala = falaHonestaPara('cancelamento');
    expect(fala).toContain('?');
    // Não pode afirmar que nada aconteceu do lado de fora: no caso Ciro a clínica FOI
    // avisada, e só o nosso registro falhou. Mentir na direção oposta é mentir igual.
    expect(fala.toLowerCase()).not.toContain('não cancelei');
  });
});
