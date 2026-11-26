/**
 * User-Agents usados nas requisições de saída.
 *
 * Portais brasileiros (UOL, R7, CNN, Metrópoles) devolvem 403 para UA de bot e
 * 200 para UA de navegador — foi assim que a extração "perdia" título e foto da
 * matéria. Leitores de feed usam UA de navegador pelo mesmo motivo.
 *
 * A Wikimedia é exceção: a política deles EXIGE UA descritivo com contato, e
 * bloquearia o contrário.
 */
function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** Navegador comum: portais, CDNs de imagem, GDELT e Internet Archive. */
export const WEB_USER_AGENT = pick(
  process.env['CANAL_DARK_USER_AGENT'],
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
);

/** Wikimedia Commons/Wikipédia: descritivo e com contato, como a política pede. */
export const WIKIMEDIA_USER_AGENT =
  'CanalDarkEditorial/0.1 (https://canaldark.local; contact@canaldark.local)';

/** Cabeçalhos padrão de página, no idioma do público. */
export const HTML_HEADERS: Record<string, string> = {
  'User-Agent': WEB_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
};
