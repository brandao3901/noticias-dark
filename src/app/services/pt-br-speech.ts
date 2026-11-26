/**
 * Normalizacao de texto para fala em portugues do Brasil.
 *
 * Vive fora do servico de preview porque o servidor tambem narra: o audio
 * gerado no render precisa da mesma pronuncia que a previa do navegador, senao
 * "15%" soa diferente no arquivo final.
 */

const PT_BR_SPEECH_ACRONYMS: Record<string, string> = {
  STF: 'Supremo Tribunal Federal',
  STJ: 'Superior Tribunal de Justiça',
  TSE: 'Tribunal Superior Eleitoral',
  BC: 'Banco Central',
  BCB: 'Banco Central',
  IBGE: 'I B G E',
  INSS: 'I N S S',
  BNDES: 'B N D E S',
  ANVISA: 'Anvisa',
  PIB: 'Pib',
  PIX: 'Píx',
  ONU: 'Onu',
  OMS: 'O M S',
  GDELT: 'G-Délt',
};

export function normalizeTextForPtBrSpeech(raw: string): string {
  let text = raw
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\.{3}|…/g, '.')
    .replace(/(\d+)\s*°\s*C\b/gi, '$1 graus Celsius')
    .replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 por cento')
    .replace(/R\$\s*(\d+(?:[.,]\d+)?)/g, '$1 reais')
    .replace(/\s+&\s+/g, ' e ')
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(/\b([A-Z]{2,6})\b/g, (full, code: string) => PT_BR_SPEECH_ACRONYMS[code] ?? full);
  return text.normalize('NFC');
}
