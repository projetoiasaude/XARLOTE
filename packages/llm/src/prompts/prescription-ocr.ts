export const PRESCRIPTION_OCR_PROMPT = `Analise esta imagem de receita médica e extraia as informações em JSON.

Se não for uma receita médica, retorne { "error": "not_a_prescription" }.

Retorne APENAS o JSON, sem explicações, no formato:
\`\`\`json
{
  "doctor": {
    "name": "string ou null",
    "crm": "string ou null",
    "uf": "string ou null"
  },
  "issued_at": "YYYY-MM-DD ou null",
  "items": [
    {
      "medication_name": "nome do medicamento",
      "active_ingredient": "princípio ativo ou null",
      "dosage": "ex: 500mg ou null",
      "form": "ex: comprimido, cápsula, gotas ou null",
      "quantity": "ex: 20 comprimidos ou null",
      "frequency": "ex: 2x ao dia ou null",
      "duration": "ex: 7 dias ou null",
      "notes": "observações adicionais ou null",
      "confidence": 0.95
    }
  ],
  "raw_text": "texto bruto da receita"
}
\`\`\``;
