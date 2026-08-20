/**
 * O resumo em texto puro, para o médico colar no prontuário eletrônico dele.
 *
 * ## Por que isto existe
 *
 * O consultório não roda a Xarlote: roda um sistema de prontuário que só aceita texto. Sem
 * este botão, o médico que quiser registrar "paciente alérgico a dipirona (anafilaxia)"
 * redigita — e redigitar dado clínico é onde nasce erro de transcrição. Copiar é a ponte
 * mais barata entre esta página e o sistema que ele já usa.
 *
 * ## O que sai
 *
 * Exatamente o que está na tela, na mesma ordem, com as mesmas ressalvas. Nada a mais:
 * o texto copiado circula por e-mail e por sistema de terceiro, então ele carrega tão pouco
 * quanto a página — nome, idade, quadro clínico. Sem telefone, sem CPF, sem data de
 * nascimento, sem o endereço do link.
 *
 * PURO: recebe o resumo e o instante; devolve string. Sem `navigator`, sem DOM.
 */
import { dataBr } from '../br-data';
import { adesaoPercentual, frescor, ordenarAlergias, type ResumoMedico } from './resumo';

const RUBRICA_GRAVIDADE: Record<string, string> = {
  grave: 'grave',
  moderada: 'moderada',
  leve: 'leve',
  desconhecida: 'gravidade não confirmada',
};

export function resumoTexto(r: ResumoMedico, nowMs: number): string {
  const L: string[] = [];
  /**
   * `n` é a contagem de ENTIDADES, e `itens` são as LINHAS que as desenham.
   *
   * Nos blocos simples é a mesma coisa (uma alergia = uma linha), mas em EXAMES um único
   * exame rende uma linha do exame, uma por marcador, uma pelos omitidos e uma pela
   * observação. Contar linhas imprimiria `EXAMES (5)` para um exame — e este é o único
   * texto do produto que vira registro permanente no prontuário eletrônico de terceiro.
   * Por isso a contagem é um parâmetro explícito, não um `itens.length` implícito.
   */
  const bloco = (titulo: string, itens: string[], vazio: string, n: number = itens.length) => {
    L.push('');
    L.push(n > 0 ? `${titulo} (${n})` : titulo);
    // Seção vazia continua no texto, com a explicação. Uma seção que desaparece do
    // documento faz o leitor concluir que a pergunta não se aplica.
    L.push(...(itens.length > 0 ? itens : [`  ${vazio}`]));
  };

  L.push('RESUMO CLÍNICO — Xarlote');
  L.push(
    [r.paciente.nome ?? 'Paciente', r.paciente.idade !== null ? `${r.paciente.idade} anos` : null]
      .filter(Boolean)
      .join(' · '),
  );
  L.push(`Retrato ${frescor(r.geradoEm, nowMs).texto} — compartilhado pelo próprio paciente.`);

  bloco(
    'ALERGIAS',
    ordenarAlergias(r.alergias).map((a) => {
      const det = [a.reacao, a.gravidadeBruta ?? RUBRICA_GRAVIDADE[a.gravidade]].filter(Boolean).join(' · ');
      return `  - ${a.substancia}${det ? ` — ${det}` : ''}`;
    }),
    'Nenhuma alergia registrada. Ausência de registro não é negativa de alergia.',
  );

  bloco(
    'MEDICAMENTOS EM USO',
    r.medicamentos.map((m) => {
      const det = [m.dosagem, m.frequencia].filter(Boolean).join(' · ');
      return `  - ${m.nome}${det ? ` — ${det}` : ''}`;
    }),
    'Nenhum medicamento registrado.',
  );

  bloco(
    'CONDIÇÕES',
    r.condicoes.map((c) => `  - ${c.nome}${c.desde ? ` (desde ${dataBr(c.desde)})` : ''}`),
    'Nenhuma condição registrada.',
  );

  const exames: string[] = [];
  for (const e of r.exames) {
    exames.push(`  - ${e.tipo}${e.data ? ` — ${dataBr(e.data)}` : ' — data não identificada'}`);
    for (const v of e.valores) {
      const u = v.unidade ? ` ${v.unidade}` : '';
      const ref = v.referencia ? ` (ref. ${v.referencia})` : '';
      exames.push(`      ${v.marcador}: ${v.valor}${u}${ref}`);
    }
    if (e.valoresOmitidos > 0) exames.push(`      (+${e.valoresOmitidos} marcadores não incluídos no resumo)`);
    if (e.resumo) exames.push(`      obs.: ${e.resumo}`);
  }
  bloco('EXAMES', exames, 'Nenhum exame registrado.', r.exames.length);

  const pct = adesaoPercentual(r.adesao30d);
  L.push('');
  L.push(
    pct === null
      ? 'ADESÃO (30 DIAS)\n  Sem doses registradas no período.'
      : `ADESÃO (30 DIAS)\n  ${pct}% das doses registradas foram confirmadas pelo paciente.`,
  );

  L.push('');
  L.push('Organizado pela Xarlote a partir do que o paciente relatou e do que foi registrado');
  L.push('no acompanhamento. NÃO é laudo nem diagnóstico, e pode estar incompleto.');

  return L.join('\n');
}
