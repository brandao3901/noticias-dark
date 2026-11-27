import type {
  ExtractedSource,
  GdeltArticle,
  MediaAsset,
} from '../app/models/studio.models';
import { WEB_USER_AGENT, WIKIMEDIA_USER_AGENT } from './http';
import { safeFetchWithRedirectGuard, validateSafePublicUrl } from './ssrf-guard';

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  ndash: '–',
  mdash: '—',
  hellip: '...',
  ldquo: '"',
  rdquo: '"',
  lsquo: "'",
  rsquo: "'",
  laquo: '"',
  raquo: '"',
  ordm: 'º',
  ordf: 'ª',
  deg: '°',
  aacute: 'á',
  Aacute: 'Á',
  agrave: 'à',
  Agrave: 'À',
  acirc: 'â',
  Acirc: 'Â',
  atilde: 'ã',
  Atilde: 'Ã',
  auml: 'ä',
  Auml: 'Ä',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  Egrave: 'È',
  ecirc: 'ê',
  Ecirc: 'Ê',
  iacute: 'í',
  Iacute: 'Í',
  icirc: 'î',
  Icirc: 'Î',
  oacute: 'ó',
  Oacute: 'Ó',
  ocirc: 'ô',
  Ocirc: 'Ô',
  otilde: 'õ',
  Otilde: 'Õ',
  ouml: 'ö',
  Ouml: 'Ö',
  uacute: 'ú',
  Uacute: 'Ú',
  ucirc: 'û',
  Ucirc: 'Û',
  uuml: 'ü',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, num) => {
      const cp = Number(num);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-zA-Z]+);/g, (full, name: string) => NAMED_HTML_ENTITIES[name] ?? full)
    .normalize('NFC');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMetaTag(html: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex1 = new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    );
    const match1 = html.match(regex1);
    if (match1?.[1]) return decodeEntities(match1[1].trim());

    const regex2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      'i',
    );
    const match2 = html.match(regex2);
    if (match2?.[1]) return decodeEntities(match2[1].trim());
  }
  return '';
}

/** Coleta a imagem principal publicada na matéria. */
function extractArticleImage(
  html: string,
  ld: { image?: unknown },
  baseUrl: string,
): { imageUrl: string; imageAlt: string; imageCredit: string } | null {
  const candidates: string[] = [];

  const fromLd = ld.image;
  if (typeof fromLd === 'string') candidates.push(fromLd);
  else if (Array.isArray(fromLd)) {
    for (const item of fromLd) {
      if (typeof item === 'string') candidates.push(item);
      else if (item && typeof item === 'object') {
        const url = (item as Record<string, unknown>)['url'];
        if (typeof url === 'string') candidates.push(url);
      }
    }
  } else if (fromLd && typeof fromLd === 'object') {
    const url = (fromLd as Record<string, unknown>)['url'];
    if (typeof url === 'string') candidates.push(url);
  }

  candidates.push(
    extractMetaTag(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image']),
    extractMetaTag(html, ['twitter:image:src']),
  );

  const imageUrl = candidates
    .map((value) => (value ?? '').trim())
    .find((value) => value.startsWith('http://') || value.startsWith('https://'));

  if (!imageUrl) return null;

  return {
    // Alguns sites publicam URL relativa em og:image; resolve contra a página.
    imageUrl: new URL(imageUrl, baseUrl).toString(),
    imageAlt: extractMetaTag(html, ['og:image:alt', 'twitter:image:alt']),
    imageCredit:
      extractMetaTag(html, ['credit', 'article:author', 'og:article:author']) ||
      extractMetaTag(html, ['author']),
  };
}

function extractJsonLd(html: string): {
  headline?: string;
  description?: string;
  articleBody?: string;
  author?: string;
  datePublished?: string;
  image?: unknown;
} {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const raw = match[1]?.trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['@graph'])
          ? ((parsed as Record<string, unknown>)['@graph'] as unknown[])
          : [parsed];

      for (const node of items) {
        if (!node || typeof node !== 'object') continue;
        const rec = node as Record<string, unknown>;
        const typeVal = String(rec['@type'] ?? '');
        if (typeVal.includes('Article') || rec['headline'] || rec['articleBody']) {
          let authorName = '';
          const author = rec['author'];
          if (typeof author === 'string') authorName = author;
          else if (Array.isArray(author) && author[0] && typeof author[0] === 'object') {
            authorName = String((author[0] as Record<string, unknown>)['name'] ?? '');
          } else if (author && typeof author === 'object') {
            authorName = String((author as Record<string, unknown>)['name'] ?? '');
          }
          return {
            headline: typeof rec['headline'] === 'string' ? rec['headline'] : undefined,
            description: typeof rec['description'] === 'string' ? rec['description'] : undefined,
            articleBody: typeof rec['articleBody'] === 'string' ? rec['articleBody'] : undefined,
            author: authorName || undefined,
            datePublished:
              typeof rec['datePublished'] === 'string' ? rec['datePublished'] : undefined,
            image: rec['image'],
          };
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return {};
}

export async function extractArticleMetadata(rawUrl: string): Promise<ExtractedSource> {
  const fetchedAt = new Date().toISOString();
  const initialCheck = await validateSafePublicUrl(rawUrl);

  if (initialCheck.isSocialX) {
    return {
      url: rawUrl,
      finalUrl: rawUrl,
      domain: initialCheck.parsed?.hostname ?? 'x.com',
      title: 'Link do X (não raspado)',
      description: '',
      excerpt: '',
      author: '',
      publishedAt: '',
      fetchedAt,
      status: 'social_x',
      limitationNote:
        'Links do X não são abertos nem raspados automaticamente. Informe o tema ou cole um link de matéria jornalística pública para pesquisa.',
    };
  }

  if (!initialCheck.allowed || !initialCheck.parsed) {
    return {
      url: rawUrl,
      finalUrl: rawUrl,
      domain: '',
      title: '',
      description: '',
      excerpt: '',
      author: '',
      publishedAt: '',
      fetchedAt,
      status: 'blocked',
      limitationNote: initialCheck.reason ?? 'URL bloqueada pelas regras de segurança.',
    };
  }

  const res = await safeFetchWithRedirectGuard(rawUrl, { timeoutMs: 8500, maxBytes: 1_500_000 });
  const domain = (() => {
    try {
      return new URL(res.finalUrl).hostname.replace(/^www\./, '');
    } catch {
      return initialCheck.parsed.hostname.replace(/^www\./, '');
    }
  })();

  if (!res.ok) {
    return {
      url: rawUrl,
      finalUrl: res.finalUrl,
      domain,
      title: '',
      description: '',
      excerpt: '',
      author: '',
      publishedAt: '',
      fetchedAt,
      status: res.status === 401 || res.status === 403 ? 'limited' : 'error',
      limitationNote:
        res.status === 401 || res.status === 403
          ? `A página retornou HTTP ${res.status} (possível paywall, login ou bloqueio anti-bot). A pesquisa continua pelo título informado.`
          : res.error || `Falha ao abrir a página (HTTP ${res.status}).`,
    };
  }

  const html = res.body;
  const ld = extractJsonLd(html);
  const articleImage = extractArticleImage(html, ld, res.finalUrl || rawUrl);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    ld.headline ||
    extractMetaTag(html, ['og:title', 'twitter:title']) ||
    (titleMatch?.[1] ? stripTags(titleMatch[1]) : '') ||
    domain;

  const description =
    ld.description || extractMetaTag(html, ['og:description', 'description', 'twitter:description']);

  const author =
    ld.author || extractMetaTag(html, ['author', 'article:author', 'parsely-author']);

  const publishedAt =
    ld.datePublished ||
    extractMetaTag(html, ['article:published_time', 'og:published_time', 'publishdate', 'date']);

  let excerpt = ld.articleBody ? stripTags(ld.articleBody) : '';
  if (!excerpt) {
    const cleanedHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    const paragraphs = [...cleanedHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripTags(m[1] ?? ''))
      .filter((p) => p.length >= 60 && !/cookies|assine|inscreva-se|copyright/i.test(p));
    excerpt = paragraphs.slice(0, 8).join('\n\n');
  }

  excerpt = excerpt.slice(0, 2600);

  const paywallDetected =
    excerpt.length < 180 &&
    /assinante|faça login|entre para ler|paywall|enable javascript|ativar o javascript/i.test(html);

  if (paywallDetected || excerpt.length < 140) {
    return {
      url: rawUrl,
      finalUrl: res.finalUrl,
      domain,
      title,
      description,
      excerpt: excerpt || description,
      author,
      publishedAt,
      fetchedAt,
      status: 'limited',
      limitationNote:
        'Texto completo indisponível (site pode exigir login, assinatura ou renderização JavaScript). Pesquisa prossegue com título e metadados disponíveis.',
      imageUrl: articleImage?.imageUrl,
      imageAlt: articleImage?.imageAlt,
      imageCredit: articleImage?.imageCredit,
    };
  }

  return {
    url: rawUrl,
    finalUrl: res.finalUrl,
    domain,
    title,
    description,
    excerpt,
    author,
    publishedAt,
    fetchedAt,
    status: 'ok',
    imageUrl: articleImage?.imageUrl,
    imageAlt: articleImage?.imageAlt,
    imageCredit: articleImage?.imageCredit,
  };
}

const gdeltCache = new Map<string, { ts: number; articles: GdeltArticle[] }>();

export async function searchGdeltCoverage(query: string): Promise<{
  status: 'ok' | 'error' | 'rate_limited';
  articles: GdeltArticle[];
  message?: string;
}> {
  const cleanQuery = query.replace(/["'<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanQuery) {
    return { status: 'error', articles: [], message: 'Informe um tema ou título para consultar o GDELT.' };
  }

  const cached = gdeltCache.get(cleanQuery.toLowerCase());
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return { status: 'ok', articles: cached.articles };
  }

  const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  endpoint.searchParams.set('query', cleanQuery);
  endpoint.searchParams.set('mode', 'ArtList');
  endpoint.searchParams.set('maxrecords', '10');
  endpoint.searchParams.set('timespan', '3d');
  endpoint.searchParams.set('sort', 'DateDesc');
  endpoint.searchParams.set('format', 'json');

  try {
    const res = await fetch(endpoint.toString(), {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': WEB_USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      return {
        status: 'rate_limited',
        articles: [],
        message: 'GDELT DOC API retornou limite temporário (429). Os demais resultados permanecem visíveis.',
      };
    }

    if (!res.ok) {
      return {
        status: 'error',
        articles: [],
        message: `GDELT DOC API respondeu com HTTP ${res.status}.`,
      };
    }

    const rawText = await res.text();
    if (!rawText.trim().startsWith('{')) {
      return {
        status: 'ok',
        articles: [],
        message: 'GDELT não retornou cobertura indexada nos últimos 3 dias para essa consulta.',
      };
    }

    const json = JSON.parse(rawText) as {
      articles?: Array<{
        url?: string;
        title?: string;
        domain?: string;
        seendate?: string;
        language?: string;
      }>;
    };

    const articles: GdeltArticle[] = (json.articles ?? [])
      .filter((a) => a.url && a.title && !a.domain?.includes('twitter.com') && !a.domain?.includes('x.com'))
      .slice(0, 10)
      .map((a, idx) => ({
        id: `gdelt-${idx}-${Buffer.from(a.url!).toString('base64url').slice(0, 8)}`,
        title: a.title!.trim(),
        url: a.url!.trim(),
        domain: (a.domain ?? '').trim(),
        seenDate: formatGdeltDate(a.seendate),
        language: (a.language ?? 'Portuguese').trim(),
      }));

    gdeltCache.set(cleanQuery.toLowerCase(), { ts: Date.now(), articles });
    return { status: 'ok', articles };
  } catch (err) {
    return {
      status: 'error',
      articles: [],
      message: err instanceof Error ? err.message : 'Timeout ou erro ao consultar GDELT DOC API.',
    };
  }
}

function formatGdeltDate(raw?: string): string {
  if (!raw) return new Date().toISOString();
  // GDELT format: 20261124T153000Z
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  }
  return raw;
}

function isDerivativeAllowedLicense(licenseText: string, licenseUrl: string): boolean {
  const combined = `${licenseText} ${licenseUrl}`.toLowerCase();
  if (!combined.trim()) return false;
  // Rejeitar licenças Sem Derivações (ND) pois impedem corte 9:16 e legendagem
  if (combined.includes('by-nd') || combined.includes('nc-nd') || combined.includes('/nd/')) {
    return false;
  }
  return true;
}

const WIKI_UA = WIKIMEDIA_USER_AGENT;

const NON_PHOTO_RE =
  /\.(svg|djvu|pdf|tif|tiff)$/i;
const JUNK_FILENAME_RE =
  /(^|[_\s-])(logo|logotipo|flag|bandeira|brasao|brasão|coat[_\s-]of[_\s-]arms|seal|emblem|escudo|map|mapa|diagram|chart|graph|signature|assinatura|icon|symbol|caricature|meme|screenshot|locator|orthographic|projection|blank[_\s-]|despacho[_\s-]|reclamacao|commons-logo|wikimedia|wikinews|wiktionary|ambox|edit-clear|question_book|padlock|crystal_clear|nuvola_|red_pog)/i;

const QUERY_STOP_TOKENS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'para',
  'com',
  'por',
  'sobre',
  'the',
  'and',
  'for',
  'with',
  'from',
  'news',
  'archive',
]);

const FOREIGN_MISMATCH_TOKENS = [
  'argentina',
  'arg-',
  '-arg',
  'paraguay',
  'paraguai',
  'uruguay',
  'uruguai',
  'chile',
  'mexico',
  'colombia',
  'venezuela',
  'bolivia',
  'peru',
  'ecuador',
  'spain',
  'espana',
  'portugal',
];

function stripAccentsLower(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenizeSignificant(text: string): string[] {
  return stripAccentsLower(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !QUERY_STOP_TOKENS.has(t));
}

function isPhotographicCandidate(titleOrUrl: string): boolean {
  const clean = titleOrUrl.replace(/^File:|^Ficheiro:/i, '');
  if (NON_PHOTO_RE.test(clean)) return false;
  if (JUNK_FILENAME_RE.test(clean)) return false;
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Casa o token como palavra inteira: "selic" nao pode casar com "selić". */
function matchesWholeWord(normalizedText: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegex(token)}\\b`).test(normalizedText);
}

function scoreAssetCoherence(title: string, query: string): number {
  const normTitle = stripAccentsLower(title);
  const normQuery = stripAccentsLower(query);
  const tokens = tokenizeSignificant(query);
  if (!tokens.length) return 0;

  let matched = 0;
  for (const tok of tokens) {
    if (matchesWholeWord(normTitle, tok)) matched++;
  }

  let score = (matched / tokens.length) * 10;
  if (normQuery.length >= 5 && matchesWholeWord(normTitle, normQuery)) {
    score += 4;
  }

  for (const foreign of FOREIGN_MISMATCH_TOKENS) {
    if (normTitle.includes(foreign) && !normQuery.includes(foreign.replace(/-/g, ''))) {
      score -= 6;
    }
  }

  return score;
}

/**
 * Coerencia de um ativo com o termo da cena, considerando titulo E descricao.
 *
 * A pontuacao textual e a que decide a aceitacao; enquadramento vertical e
 * resolucao servem apenas como desempate, porque o alvo e sempre 9:16.
 */
export function scoreAssetForQuery(asset: MediaAsset, query: string): number {
  const haystack = `${asset.title} ${asset.description ?? ''}`.trim();
  return scoreAssetCoherence(haystack, query);
}

function framingPreference(asset: MediaAsset): number {
  let bonus = 0;
  if (asset.orientation === 'vertical') bonus += 1.5;
  else if (asset.orientation === 'horizontal') bonus -= 0.5;

  const longSide = Math.max(asset.width || 0, asset.height || 0);
  if (longSide >= 1600) bonus += 1;
  else if (longSide > 0 && longSide < 900) bonus -= 1;

  return bonus;
}

/** Conteudo que nao serve como B-roll de noticia (grafico, mapa, logo, print). */
const NON_PHOTO_CONTENT_RE =
  /\b(chart|charts|graph|graphs|diagram|diagrams|map|maps|mapa|mapas|logo|logos|flag|flags|bandeira|bandeiras|brasao|coat of arms|seal|emblem|escudo|screenshot|table|tables|tabela|tabelas|statistics|timeline|poster|cartaz|cartoon|caricature)\b/i;

/** Termos que nao descrevem nada fotografavel: nao viram busca de midia. */
const GENERIC_VISUAL_TOKENS = new Set([
  'reuniao',
  'reunioes',
  'comite',
  'comites',
  'economia',
  'economico',
  'economica',
  'inflacao',
  'juros',
  'noticia',
  'noticias',
  'jornal',
  'estudio',
  'cidade',
  'governo',
  'politica',
  'politico',
  'mercado',
  'empresa',
  'empresas',
  'pessoa',
  'pessoas',
  'trabalho',
  'dinheiro',
  'edificio',
  'predio',
  'sala',
  'mesa',
  'documento',
  'documentos',
  'papel',
  'grafico',
  'mapa',
  'bandeira',
  'fiscal',
  'meta',
  'indice',
  'taxa',
  'taxas',
  'valor',
  'preco',
  'precos',
  'news',
  'broadcast',
  'building',
  'meeting',
  'committee',
  'government',
  'economy',
  'economic',
  'inflation',
  'market',
  'business',
  'report',
  'press',
  'media',
  'office',
  'room',
  'people',
  'person',
]);

/** Uma busca visual só é útil se nomear algo concreto (não "reunião comitê"). */
function isUsefulVisualQuery(term: string): boolean {
  const tokens = tokenizeSignificant(term);
  if (!tokens.length) return false;
  return tokens.some((token) => !GENERIC_VISUAL_TOKENS.has(token));
}

/**
 * Decide se um ativo pode ilustrar um termo da cena.
 *
 * Regras (todas obrigatorias):
 *  1. TODOS os termos da busca precisam aparecer como palavra inteira;
 *  2. se a busca tem uma palavra so, ela precisa vir junto de algum termo de
 *     contexto da cena/pauta — e isso que impede "Selic" de casar com
 *     "Selic Alaska" ou com o sobrenome "Šelić";
 *  3. o enquadramento so desempata, nunca salva um casamento ruim.
 */
export function evaluateAssetMatch(
  asset: MediaAsset,
  term: string,
  contextTokens: string[],
): { accepted: boolean; score: number } {
  // Normaliza a "frase" do ativo para comparar expressão inteira, não palavras soltas.
  const haystack = stripAccentsLower(`${asset.title} ${asset.description ?? ''}`)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (NON_PHOTO_CONTENT_RE.test(haystack)) return { accepted: false, score: 0 };

  const tokens = tokenizeSignificant(term);
  if (!tokens.length) return { accepted: false, score: 0 };

  const allPresent = tokens.every((token) => matchesWholeWord(haystack, token));
  if (!allPresent) return { accepted: false, score: 0 };

  // Nome composto ("Andy Taylor", "Duran Duran") precisa aparecer como
  // expressão: senão "Andy Taylor" casa com "teatro Taylor & Kent ... Andy
  // Mabbett" e "Duran Duran" casa com a pintora Dolores Duran.
  if (tokens.length >= 2 && !haystack.includes(tokens.join(' '))) {
    return { accepted: false, score: 0 };
  }

  const contextHits = contextTokens.filter(
    (token) => !tokens.includes(token) && matchesWholeWord(haystack, token),
  );

  if (tokens.length === 1 && contextHits.length === 0) {
    return { accepted: false, score: 0 };
  }

  const score = 10 + Math.min(4, contextHits.length) * 1.5 + framingPreference(asset);
  return { accepted: true, score };
}

function expandEntityQuery(query: string): string {
  const trimmed = query.trim();
  const lower = stripAccentsLower(trimmed);
  if (lower === 'banco central') return 'Banco Central do Brasil';
  if (lower === 'receita federal') return 'Receita Federal do Brasil';
  if (lower === 'congresso nacional') return 'Congresso Nacional do Brasil';
  if (lower === 'policia federal') return 'Polícia Federal do Brasil';
  if (lower === 'camara dos deputados') return 'Câmara dos Deputados do Brasil';
  if (lower === 'senado federal') return 'Senado Federal do Brasil';
  return trimmed;
}

async function resolveCommonsFilesByTitles(
  fileTitles: string[],
  kind: 'image' | 'video' = 'image',
): Promise<MediaAsset[]> {
  if (!fileTitles.length) return [];

  const uniqueTitles = Array.from(
    new Set(
      fileTitles
        .map((t) => t.replace(/^Ficheiro:/i, 'File:').replace(/^File:/i, 'File:'))
        .map((t) => (t.startsWith('File:') ? t : `File:${t}`)),
    ),
  ).slice(0, 15);

  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', uniqueTitles.join('|'));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|extmetadata|size|mime');
  url.searchParams.set('iiurlwidth', '960');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(7000),
    headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) return [];

  const data = (await res.json()) as {
    query?: {
      pages?: Record<
        string,
        {
          pageid?: number;
          title: string;
          imageinfo?: Array<{
            url?: string;
            thumburl?: string;
            descriptionurl?: string;
            width?: number;
            height?: number;
            duration?: number;
            mime?: string;
            extmetadata?: Record<string, { value?: string }>;
          }>;
        }
      >;
    };
  };

  const orderMap = new Map(uniqueTitles.map((t, idx) => [t.replace(/_/g, ' ').toLowerCase(), idx]));
  const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => {
    const ia = orderMap.get(a.title.replace(/_/g, ' ').toLowerCase()) ?? 99;
    const ib = orderMap.get(b.title.replace(/_/g, ' ').toLowerCase()) ?? 99;
    return ia - ib;
  });

  const nowIso = new Date().toISOString();
  const assets: MediaAsset[] = [];

  for (const page of pages) {
    if (!page.pageid || page.pageid < 0) continue;
    const info = page.imageinfo?.[0];
    if (!info?.url || !info.descriptionurl) continue;
    if (kind === 'image' && (!info.mime?.startsWith('image/') || info.mime === 'image/svg+xml')) continue;
    if (kind === 'video' && !info.mime?.startsWith('video/')) continue;

    const cleanTitle = page.title.replace(/^File:/, '');
    if (kind === 'image' && !isPhotographicCandidate(cleanTitle)) continue;

    const width = info.width ?? 0;
    const height = info.height ?? 0;
    if (kind === 'image' && (width < 320 || height < 220)) continue;

    const meta = info.extmetadata ?? {};
    const licenseName = stripTags(meta['LicenseShortName']?.value ?? '');
    const licenseUrl = meta['LicenseUrl']?.value ?? '';
    const author = stripTags(meta['Artist']?.value ?? meta['Credit']?.value ?? 'Autor não informado');

    if (!licenseName || !isDerivativeAllowedLicense(licenseName, licenseUrl)) continue;

    const orientation: MediaAsset['orientation'] =
      height > width ? 'vertical' : width > height ? 'horizontal' : 'square';

    assets.push({
      id: `wiki-${kind}-${page.pageid}`,
      provider: 'wikimedia',
      kind,
      title: cleanTitle,
      pageUrl: info.descriptionurl,
      mediaUrl: info.url,
      thumbUrl: info.thumburl ?? info.url,
      description: stripTags(
        `${meta['ImageDescription']?.value ?? ''} ${meta['Categories']?.value ?? ''}`,
      ).slice(0, 400),
      author: author.slice(0, 120),
      licenseName,
      licenseUrl: licenseUrl || info.descriptionurl,
      attributionText: `${author.slice(0, 80)} — ${licenseName} via Wikimedia Commons`,
      capturedAt: nowIso,
      isIllustrative: true,
      width,
      height,
      orientation,
      durationSec: info.duration ? Math.round(info.duration) : undefined,
    });
  }

  return assets;
}

async function fetchWikipediaCanonicalPhotos(query: string): Promise<MediaAsset[]> {
  const expanded = expandEntityQuery(query);
  for (const lang of ['pt', 'en']) {
    try {
      const searchUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      searchUrl.searchParams.set('action', 'query');
      searchUrl.searchParams.set('list', 'search');
      searchUrl.searchParams.set('srsearch', expanded);
      searchUrl.searchParams.set('srlimit', '3');
      searchUrl.searchParams.set('format', 'json');

      const srRes = await fetch(searchUrl.toString(), {
        signal: AbortSignal.timeout(5500),
        headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
      });
      if (!srRes.ok || !(srRes.headers.get('content-type') ?? '').includes('json')) continue;

      const srJson = (await srRes.json()) as {
        query?: { search?: Array<{ title: string }> };
      };
      const titles = (srJson.query?.search ?? []).map((x) => x.title);
      if (!titles.length) continue;

      // Garantir que o artigo #1 tenha afinidade mínima com os termos buscados
      const topScore = scoreAssetCoherence(titles[0], expanded);
      if (topScore <= 0 && tokenizeSignificant(expanded).length > 0) continue;

      const propUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      propUrl.searchParams.set('action', 'query');
      propUrl.searchParams.set('titles', titles.slice(0, 2).join('|'));
      propUrl.searchParams.set('prop', 'pageimages|images');
      propUrl.searchParams.set('piprop', 'name');
      propUrl.searchParams.set('imlimit', '12');
      propUrl.searchParams.set('format', 'json');

      const propRes = await fetch(propUrl.toString(), {
        signal: AbortSignal.timeout(5500),
        headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
      });
      if (!propRes.ok || !(propRes.headers.get('content-type') ?? '').includes('json')) continue;

      const propJson = (await propRes.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title: string;
              pageimage?: string;
              images?: Array<{ title: string }>;
            }
          >;
        };
      };

      const orderedPages = Object.values(propJson.query?.pages ?? {}).sort((a, b) => {
        const ia = titles.indexOf(a.title);
        const ib = titles.indexOf(b.title);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });

      const candidateFiles: string[] = [];
      for (const page of orderedPages) {
        if (page.pageimage && isPhotographicCandidate(page.pageimage)) {
          candidateFiles.push(`File:${page.pageimage}`);
        }
        const pageImgs = (page.images ?? [])
          .map((img) => img.title)
          .filter((t) => isPhotographicCandidate(t))
          .sort((a, b) => scoreAssetCoherence(b, expanded) - scoreAssetCoherence(a, expanded));
        candidateFiles.push(...pageImgs);
      }

      if (!candidateFiles.length) continue;
      const resolved = await resolveCommonsFilesByTitles(candidateFiles, 'image');
      if (resolved.length > 0) {
        return resolved;
      }
    } catch {
      // Tenta próximo idioma ou fallback Commons
    }
  }
  return [];
}

export async function searchWikimediaMedia(
  query: string,
  kind: 'image' | 'video' = 'image',
): Promise<{
  assets: MediaAsset[];
  error?: string;
}> {
  const cleanQuery = expandEntityQuery(query);
  if (!cleanQuery) return { assets: [] };

  try {
    const collected: MediaAsset[] = [];
    const seenIds = new Set<string>();

    // Para imagens, priorizar fotos canônicas de artigos da Wikipédia (com licença verificada no Commons)
    if (kind === 'image') {
      const wikiPhotos = await fetchWikipediaCanonicalPhotos(cleanQuery);
      for (const asset of wikiPhotos) {
        if (!seenIds.has(asset.id)) {
          seenIds.add(asset.id);
          collected.push(asset);
        }
      }
    }

    if (kind === 'video' || collected.length < 8) {
      const fileFilter = kind === 'video' ? 'filetype:video' : 'filetype:bitmap';
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrnamespace', '6');
      url.searchParams.set('gsrsearch', `${cleanQuery} ${fileFilter}`);
      url.searchParams.set('gsrlimit', '18');
      url.searchParams.set('prop', 'imageinfo');
      url.searchParams.set('iiprop', 'url|extmetadata|size|mime');
      url.searchParams.set('iiurlwidth', '960');
      url.searchParams.set('format', 'json');
      url.searchParams.set('origin', '*');

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
      });

      if (!res.ok) {
        if (collected.length > 0) return { assets: collected };
        return { assets: [], error: `Wikimedia Commons retornou HTTP ${res.status}.` };
      }

      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) {
        return { assets: collected };
      }

      const data = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              pageid: number;
              title: string;
              index?: number;
              imageinfo?: Array<{
                url?: string;
                thumburl?: string;
                descriptionurl?: string;
                width?: number;
                height?: number;
                duration?: number;
                mime?: string;
                extmetadata?: Record<string, { value?: string }>;
              }>;
            }
          >;
        };
      };

      const pages = Object.values(data.query?.pages ?? {});
      const nowIso = new Date().toISOString();
      const commonsCandidates: Array<{ asset: MediaAsset; score: number }> = [];

      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info?.url || !info.descriptionurl) continue;
        if (kind === 'image' && (!info.mime?.startsWith('image/') || info.mime === 'image/svg+xml')) continue;
        if (kind === 'video' && !info.mime?.startsWith('video/')) continue;

        const cleanTitle = page.title.replace(/^File:/, '');
        if (kind === 'image' && !isPhotographicCandidate(cleanTitle)) continue;

        const width = info.width ?? 0;
        const height = info.height ?? 0;
        if (kind === 'image' && (width < 320 || height < 220)) continue;

        const meta = info.extmetadata ?? {};
        const licenseName = stripTags(meta['LicenseShortName']?.value ?? '');
        const licenseUrl = meta['LicenseUrl']?.value ?? '';
        const author = stripTags(meta['Artist']?.value ?? meta['Credit']?.value ?? 'Autor não informado');

        // RF-08: Rejeitar ativos sem licença identificável ou com restrição ND
        if (!licenseName || !isDerivativeAllowedLicense(licenseName, licenseUrl)) continue;

        const orientation: MediaAsset['orientation'] =
          height > width ? 'vertical' : width > height ? 'horizontal' : 'square';

        const asset: MediaAsset = {
          id: `wiki-${kind}-${page.pageid}`,
          provider: 'wikimedia',
          kind,
          title: cleanTitle,
          pageUrl: info.descriptionurl,
          mediaUrl: info.url,
          thumbUrl: info.thumburl ?? info.url,
          description: stripTags(
            `${meta['ImageDescription']?.value ?? ''} ${meta['Categories']?.value ?? ''}`,
          ).slice(0, 400),
          author: author.slice(0, 120),
          licenseName,
          licenseUrl: licenseUrl || info.descriptionurl,
          attributionText: `${author.slice(0, 80)} — ${licenseName} via Wikimedia Commons`,
          capturedAt: nowIso,
          isIllustrative: true,
          width,
          height,
          orientation,
          durationSec: info.duration ? Math.round(info.duration) : undefined,
        };

        const score = scoreAssetCoherence(cleanTitle, cleanQuery);
        commonsCandidates.push({ asset, score });
      }

      commonsCandidates.sort((a, b) => b.score - a.score);
      for (const item of commonsCandidates) {
        if (item.score < -1 && collected.length >= 2) continue;
        if (!seenIds.has(item.asset.id)) {
          seenIds.add(item.asset.id);
          collected.push(item.asset);
        }
      }
    }

    return { assets: collected.slice(0, 12) };
  } catch (err) {
    return {
      assets: [],
      error: err instanceof Error ? err.message : 'Erro ao consultar Wikimedia Commons.',
    };
  }
}

function formatArchiveLicenseLabel(licenseUrl: string): string {
  const lower = licenseUrl.toLowerCase();
  if (lower.includes('publicdomain/zero')) return 'CC0 1.0 (Domínio Público)';
  if (lower.includes('publicdomain/mark')) return 'Public Domain Mark 1.0';
  if (lower.includes('publicdomain')) return 'Domínio Público';
  const ccMatch = lower.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([0-9.]+)/);
  if (ccMatch) {
    return `CC ${ccMatch[1].toUpperCase()} ${ccMatch[2]}`;
  }
  return 'Licença Creative Commons verificada';
}

export async function searchInternetArchiveMedia(
  query: string,
  kind: 'image' | 'video' = 'video',
): Promise<{
  assets: MediaAsset[];
  configured: boolean;
  error?: string;
}> {
  const cleanQuery = query.replace(/[()":]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanQuery) return { assets: [], configured: true };

  const mediaFilter = kind === 'video' ? 'mediatype:(movies)' : 'mediatype:(image)';
  const luceneQuery = `(${cleanQuery}) AND ${mediaFilter} AND (licenseurl:(*creativecommons.org* OR *publicdomain*))`;

  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', luceneQuery);
  searchUrl.searchParams.append('fl[]', 'identifier');
  searchUrl.searchParams.append('fl[]', 'title');
  searchUrl.searchParams.append('fl[]', 'creator');
  searchUrl.searchParams.append('fl[]', 'licenseurl');
  searchUrl.searchParams.append('fl[]', 'mediatype');
  searchUrl.searchParams.append('fl[]', 'date');
  searchUrl.searchParams.set('rows', '12');
  searchUrl.searchParams.set('page', '1');
  searchUrl.searchParams.set('output', 'json');

  try {
    const res = await fetch(searchUrl.toString(), {
      signal: AbortSignal.timeout(8500),
      headers: { 'User-Agent': WEB_USER_AGENT },
    });

    if (!res.ok) {
      return {
        assets: [],
        configured: true,
        error: `Internet Archive retornou HTTP ${res.status}.`,
      };
    }

    const json = (await res.json()) as {
      response?: {
        docs?: Array<{
          identifier?: string;
          title?: string | string[];
          creator?: string | string[];
          licenseurl?: string;
          mediatype?: string;
        }>;
      };
    };

    const docs = (json.response?.docs ?? [])
      .filter(
        (d) =>
          d.identifier &&
          d.licenseurl &&
          isDerivativeAllowedLicense('', d.licenseurl) &&
          !d.identifier.startsWith('iiif-service'),
      )
      .slice(0, 8);

    const nowIso = new Date().toISOString();
    const resolvedAssets = await Promise.all(
      docs.map(async (doc): Promise<MediaAsset | null> => {
        const identifier = doc.identifier!;
        const licenseUrl = doc.licenseurl!;
        const licenseName = formatArchiveLicenseLabel(licenseUrl);
        const titleStr = Array.isArray(doc.title) ? doc.title[0] : (doc.title ?? identifier);
        const creatorRaw = Array.isArray(doc.creator)
          ? doc.creator[0]
          : (doc.creator ?? 'Acervo Internet Archive');
        const author = stripTags(creatorRaw || 'Acervo Internet Archive').slice(0, 100);
        const pageUrl = `https://archive.org/details/${encodeURIComponent(identifier)}`;
        const thumbUrl = `https://archive.org/services/img/${encodeURIComponent(identifier)}`;

        let mediaUrl = thumbUrl;
        let durationSec: number | undefined;
        let width = 1280;
        let height = 720;

        try {
          const metaRes = await fetch(
            `https://archive.org/metadata/${encodeURIComponent(identifier)}/files`,
            { signal: AbortSignal.timeout(4500) },
          );
          if (metaRes.ok) {
            const metaJson = (await metaRes.json()) as {
              result?: Array<{
                name?: string;
                format?: string;
                length?: string;
                width?: string;
                height?: string;
              }>;
            };
            const files = metaJson.result ?? [];
            if (kind === 'video') {
              const mp4 =
                files.find((f) => f.name?.endsWith('.mp4') && /h\.264|mpeg4/i.test(f.format ?? '')) ??
                files.find((f) => f.name?.endsWith('.mp4'));
              if (mp4?.name) {
                mediaUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(mp4.name)}`;
                if (mp4.length && Number.isFinite(Number(mp4.length))) {
                  durationSec = Math.round(Number(mp4.length));
                }
                if (mp4.width && mp4.height) {
                  width = Number(mp4.width) || width;
                  height = Number(mp4.height) || height;
                }
              }
            } else {
              const imgFile = files.find((f) =>
                /\.(jpe?g|png|webp)$/i.test(f.name ?? '') && !f.name?.includes('_thumb'),
              );
              if (imgFile?.name) {
                mediaUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(imgFile.name)}`;
              }
            }
          }
        } catch {
          // Fallback to thumbUrl if per-item file metadata times out
        }

        const orientation: MediaAsset['orientation'] =
          height > width ? 'vertical' : width > height ? 'horizontal' : 'square';

        return {
          id: `ia-${kind}-${identifier}`,
          provider: 'internet_archive',
          kind,
          title: stripTags(titleStr).slice(0, 140),
          pageUrl,
          mediaUrl,
          thumbUrl,
          author,
          licenseName,
          licenseUrl,
          attributionText: `${author} — ${licenseName} via Internet Archive`,
          capturedAt: nowIso,
          isIllustrative: true,
          width,
          height,
          orientation,
          durationSec,
        };
      }),
    );

    const ranked = resolvedAssets
      .filter((a): a is MediaAsset => a !== null)
      .sort((a, b) => scoreAssetCoherence(b.title, cleanQuery) - scoreAssetCoherence(a.title, cleanQuery));

    return {
      assets: ranked,
      configured: true,
    };
  } catch (err) {
    return {
      assets: [],
      configured: true,
      error: err instanceof Error ? err.message : 'Erro ao consultar Internet Archive.',
    };
  }
}

const STOP_PROPER_WORDS = new Set([  'segundo',
  'conforme',
  'após',
  'apos',
  'fato',
  'fatos',
  'confira',
  'atenção',
  'atencao',
  'veja',
  'saiba',
  'hoje',
  'ontem',
  'amanhã',
  'amanha',
  'ainda',
  'nesta',
  'neste',
  'nesse',
  'nessa',
  'desta',
  'deste',
  'sobre',
  'entre',
  'contra',
  'durante',
  'antes',
  'depois',
  'porque',
  'registro',
  'apuração',
  'apuracao',
  'até',
  'ate',
  'brasil',
  'economia',
  'tecnologia',
  'entretenimento',
  'celebridades',
  'esportes',
  'geral',
  'canal',
  'canal dark',
  'gdelt',
  'rss',
  'uol',
  'g1',
  'r7',
  'folha',
  'metrópoles',
  'metropoles',
  'janeiro',
  'fevereiro',
  'março',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
  'segunda',
  'terça',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
  'sabado',
  'domingo',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'ao',
  'aos',
  'à',
  'às',
  'um',
  'uma',
  'uns',
  'umas',
  'por',
  'pelo',
  'pela',
  'para',
  'com',
  'sem',
  'sob',
  'mas',
  'que',
  'quem',
  'onde',
  'quando',
  'como',
  'já',
  'ja',
  'há',
  'ha',
  'foi',
  'são',
  'sao',
  'será',
  'sera',
  'pode',
  'vai',
  'tem',
]);

const ACRONYM_EXPANSIONS: Record<string, string> = {
  STF: 'Supremo Tribunal Federal',
  STJ: 'Superior Tribunal de Justiça',
  TSE: 'Tribunal Superior Eleitoral',
  BC: 'Banco Central do Brasil',
  BCB: 'Banco Central do Brasil',
  PF: 'Polícia Federal Brasil',
  PRF: 'Polícia Rodoviária Federal',
  IBGE: 'IBGE Brasil',
  INSS: 'INSS Brasil',
  BNDES: 'BNDES Brasil',
  ANVISA: 'Anvisa Brasil',
  MEC: 'Ministério da Educação Brasil',
  ONU: 'United Nations',
  OMS: 'World Health Organization',
  NASA: 'NASA',
  PIX: 'Pix Banco Central',
};

/** Verbos que abrem manchete e não são nome de ninguém ("Morre Andy Taylor"). */
const HEADLINE_VERBS = new Set([
  'morre',
  'morreu',
  'diz',
  'afirma',
  'revela',
  'revelou',
  'confessa',
  'confessou',
  'anuncia',
  'anunciou',
  'nega',
  'negou',
  'processa',
  'detona',
  'detonou',
  'critica',
  'criticou',
  'rebate',
  'rebateu',
  'responde',
  'respondeu',
  'assume',
  'assumiu',
  'desabafa',
  'desabafou',
  'flagra',
  'flagrou',
  'interna',
  'internou',
  'opera',
  'operou',
  'volta',
  'voltou',
  'deixa',
  'deixou',
  'ganha',
  'ganhou',
  'perde',
  'perdeu',
  'faz',
  'fez',
  'mostra',
  'mostrou',
  'surge',
  'surgiu',
  'posa',
  'posou',
  'aparece',
  'apareceu',
  'comemora',
  'comemorou',
  'chora',
  'chorou',
  'briga',
  'brigou',
  'recusa',
  'recusou',
  'confirma',
  'confirmou',
]);

/** Remove o verbo de manchete do começo do nome próprio. */
function stripHeadlineVerb(candidate: string): string {
  const words = candidate.split(/\s+/);
  if (words.length < 2) return candidate;
  return HEADLINE_VERBS.has(stripAccentsLower(words[0])) ? words.slice(1).join(' ') : candidate;
}

export function extractMentionedNames(text: string): string[] {
  if (!text || !text.trim()) return [];
  const rawHits: Array<{ pos: number; end: number; name: string; isMulti?: boolean }> = [];
  const coveredSpans: Array<{ start: number; end: number }> = [];

  const isCovered = (start: number, end: number) =>
    coveredSpans.some((s) => start >= s.start && end <= s.end);

  const normalizeName = (raw: string): string =>
    raw
      .replace(/^[\s"'“”‘’(\[]+|[\s"'“”‘’.,;:!?)\]]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  // 1. Nomes compostos com maiúsculas (ex.: Luiz Inácio Lula da Silva, Banco Central do Brasil, Elon Musk)
  const capWord = '[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõçüA-ZÁÉÍÓÚÂÊÔÃÕÇ0-9-]{1,}';
  const connector = '(?:da|de|do|das|dos|e|van|von|di|del)';
  const multiNameRe = new RegExp(`\\b(${capWord}(?:\\s+(?:${connector}\\s+)?${capWord}){1,4})\\b`, 'g');
  for (const m of text.matchAll(multiNameRe)) {
    let candidate = m[1];
    let startPos = m.index ?? 0;
    const endPos = startPos + candidate.length;
    const firstWord = candidate.split(' ')[0]?.toLowerCase() ?? '';
    if (STOP_PROPER_WORDS.has(firstWord)) {
      const firstLen = candidate.split(' ')[0]?.length ?? 0;
      const rest = candidate.slice(firstLen).trimStart();
      if (!rest || STOP_PROPER_WORDS.has(rest.toLowerCase())) continue;
      if (!rest.includes(' ') && rest.length < 4) continue;
      startPos += candidate.length - rest.length;
      candidate = rest;
    }
    const clean = normalizeName(stripHeadlineVerb(candidate));
    if (clean.length < 3 || STOP_PROPER_WORDS.has(clean.toLowerCase())) continue;
    coveredSpans.push({ start: startPos, end: endPos });
    rawHits.push({ pos: startPos, end: endPos, name: clean, isMulti: clean.includes(' ') });
  }

  // 2. Siglas relevantes (2 a 6 letras maiúsculas) na posição em que aparecem
  const acronymRe = /\b([A-Z]{2,6})\b/g;
  for (const m of text.matchAll(acronymRe)) {
    const code = m[1];
    const startPos = m.index ?? 0;
    const endPos = startPos + code.length;
    if (code === 'HTTP' || code === 'HTTPS' || code === 'HTML' || code === 'JSON' || code === 'GDELT') continue;
    if (isCovered(startPos, endPos)) continue;
    if (ACRONYM_EXPANSIONS[code]) {
      coveredSpans.push({ start: startPos, end: endPos });
      rawHits.push({ pos: startPos, end: endPos, name: ACRONYM_EXPANSIONS[code] });
    } else if (code.length >= 3 && !STOP_PROPER_WORDS.has(code.toLowerCase())) {
      coveredSpans.push({ start: startPos, end: endPos });
      rawHits.push({ pos: startPos, end: endPos, name: code });
    }
  }

  // 3. Nomes próprios únicos no meio da frase na posição em que aparecem
  const singleMidRe = /(?:^|[a-záéíóúâêôãõç,;:]\s+)([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõçü]{3,})\b/g;
  for (const m of text.matchAll(singleMidRe)) {
    const word = m[1];
    const fullIdx = m.index ?? 0;
    const wordOffset = m[0].lastIndexOf(word);
    const startPos = fullIdx + Math.max(0, wordOffset);
    const endPos = startPos + word.length;
    const prefix = text.slice(Math.max(0, startPos - 3), startPos);
    if (startPos === 0 || /[.!?]\s*$/.test(prefix)) continue;
    if (isCovered(startPos, endPos)) continue;
    const clean = normalizeName(word);
    const singleLower = clean.toLowerCase();
    if (clean.length < 3 || STOP_PROPER_WORDS.has(singleLower)) continue;
    const alreadyPartOfMulti = rawHits.some(
      (existing) => existing.isMulti && existing.name.toLowerCase().split(/\s+/).includes(singleLower),
    );
    if (alreadyPartOfMulti) continue;
    rawHits.push({ pos: startPos, end: endPos, name: clean });
  }

  // Ordenar estritamente pela ordem em que aparecem no texto e remover duplicados mantendo a 1ª aparição
  rawHits.sort((a, b) => a.pos - b.pos);
  const results: string[] = [];
  const seen = new Set<string>();
  for (const hit of rawHits) {
    const key = hit.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(hit.name);
    }
  }

  return results.slice(0, 8);
}

export async function autoFillScenesMedia(params: {
  pautaTitle: string;
  editorial: string;
  kindPreference: 'both' | 'image' | 'video';
  maxPerScene: number;
  /** Imagens publicadas na própria matéria: entram antes do acervo. */
  articleAssets?: MediaAsset[];
  scenes: Array<{
    id: string;
    narration: string;
    visualQueryPt: string;
    visualQueryEn: string;
    ignoredEntities?: string[];
  }>;
}): Promise<{
  results: Array<{
    sceneId: string;
    detectedNames: string[];
    queriesUsed: string[];
    assets: MediaAsset[];
  }>;
}> {
  const maxPerScene = Math.max(1, Math.min(4, params.maxPerScene || 1));
  const titleNames = extractMentionedNames(params.pautaTitle);
  const queryCache = new Map<string, MediaAsset[]>();
  const globallyUsedIds = new Set<string>();
  const globallyUsedTitles = new Set<string>();

  const runCachedSearch = async (
    query: string,
    provider: 'wikimedia' | 'internet_archive',
    kind: 'image' | 'video',
  ): Promise<MediaAsset[]> => {
    const key = `${provider}::${kind}::${query.toLowerCase()}`;
    const existing = queryCache.get(key);
    if (existing) return existing;
    // Todas as fontes disponíveis (Openverse/NASA/Pexels junto com Wikimedia e
    // Archive). O autofill NUNCA gera IA: só anexa foto real de acervo.
    const { searchAllMedia } = await import('./media-providers');
    const merged = await searchAllMedia(query, kind);
    queryCache.set(key, merged.assets);
    return merged.assets;
  };

  const results: Array<{
    sceneId: string;
    detectedNames: string[];
    queriesUsed: string[];
    assets: MediaAsset[];
  }> = [];

  for (const scene of params.scenes) {
    const ignoredSet = new Set((scene.ignoredEntities ?? []).map((n) => n.toLowerCase()));
    // Ordem estrita conforme citação na narração da cena, depois título da pauta
    const sceneNames = extractMentionedNames(scene.narration)
      .map(expandEntityQuery)
      .filter((n) => !ignoredSet.has(n.toLowerCase()));
    const expandedTitleNames = titleNames
      .map(expandEntityQuery)
      .filter((n) => !ignoredSet.has(n.toLowerCase()));
    const mergedNames: string[] = [];
    const seenName = new Set<string>();
    for (const n of [...sceneNames, ...expandedTitleNames]) {
      const k = n.toLowerCase();
      if (!seenName.has(k)) {
        seenName.add(k);
        mergedNames.push(n);
      }
    }

    // Contexto da cena: serve para exigir um segundo sinal de relevância
    // quando o termo buscado e uma palavra unica (ex.: "Selic").
    const contextTokens = Array.from(
      new Set(
        tokenizeSignificant(`${params.pautaTitle} ${scene.narration} ${scene.visualQueryPt ?? ''}`)
          .filter((token) => token.length >= 4),
      ),
    ).slice(0, 14);

    // Nomes próprios citados têm prioridade absoluta; as queries visuais do
    // roteiro entram depois, e só se nomearem algo concreto. A editoria nunca
    // entra — era ela que puxava imagem de estoque sem relação com a notícia.
    const searchTerms = [
      ...mergedNames,
      ...[scene.visualQueryPt?.trim(), scene.visualQueryEn?.trim()].filter(
        (q): q is string => Boolean(q && q.length >= 3 && isUsefulVisualQuery(q)),
      ),
    ].filter((q): q is string => Boolean(q && q.length >= 3));

    const uniqueTerms: string[] = [];
    const seenTerm = new Set<string>();
    for (const t of searchTerms) {
      const key = t.toLowerCase();
      if (seenTerm.has(key)) continue;
      seenTerm.add(key);
      uniqueTerms.push(t);
      if (uniqueTerms.length >= 4) break;
    }

    const chosen: MediaAsset[] = [];
    const chosenIds = new Set<string>();
    const queriesUsed: string[] = [];

    const titleKey = (asset: MediaAsset): string =>
      stripAccentsLower(asset.title)
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, 80);

    const addUniqueAsset = (asset: MediaAsset): boolean => {
      const key = titleKey(asset);
      if (chosenIds.has(asset.id) || globallyUsedTitles.has(key)) return false;
      chosenIds.add(asset.id);
      globallyUsedIds.add(asset.id);
      globallyUsedTitles.add(key);
      chosen.push(asset);
      return true;
    };

    const pickBest = (pool: MediaAsset[], term: string): MediaAsset | null => {
      const ranked = pool
        .filter((asset) => !chosenIds.has(asset.id))
        .map((asset) => {
          const match = evaluateAssetMatch(asset, term, contextTokens);
          return { asset, accepted: match.accepted, score: match.score };
        })
        .filter((entry) => entry.accepted)
        .sort((a, b) => b.score - a.score);

      // Prefere um ativo ainda não usado em outra cena; se todos já foram
      // usados, aceita o melhor (evita repetir imagem no mesmo vídeo).
      const fresh = ranked.find((entry) => !globallyUsedIds.has(entry.asset.id));
      return (fresh ?? ranked[0])?.asset ?? null;
    };

    const pickOneForTerm = async (term: string): Promise<boolean> => {
      if (params.kindPreference === 'video') {
        const wikiVideos = await runCachedSearch(term, 'wikimedia', 'video');
        const iaVideos =
          wikiVideos.length < 2 ? await runCachedSearch(term, 'internet_archive', 'video') : [];
        const pick = pickBest([...wikiVideos, ...iaVideos], term);
        return pick ? addUniqueAsset(pick) : false;
      }

      const wikiImgs = await runCachedSearch(term, 'wikimedia', 'image');
      const imgPick = pickBest(wikiImgs, term);
      if (imgPick) return addUniqueAsset(imgPick);

      // Vídeo só entra quando é muito coerente com o termo.
      if (params.kindPreference === 'both') {
        const wikiVideos = await runCachedSearch(term, 'wikimedia', 'video');
        const strongVideo = pickBest(wikiVideos, term);
        return strongVideo ? addUniqueAsset(strongVideo) : false;
      }

      return false;
    };

    // Antes de qualquer acervo: a foto publicada na matéria é a imagem real do
    // fato. Entra primeiro e ocupa a primeira cena que tiver espaço.
    for (const asset of params.articleAssets ?? []) {
      if (chosen.length >= maxPerScene) break;
      if (addUniqueAsset(asset)) queriesUsed.push('imagem da matéria');
    }

    for (const term of uniqueTerms) {
      if (chosen.length >= maxPerScene) break;
      queriesUsed.push(term);
      await pickOneForTerm(term);
    }

    results.push({
      sceneId: scene.id,
      detectedNames: mergedNames.slice(0, 6),
      queriesUsed: Array.from(new Set(queriesUsed)),
      assets: chosen,
    });
  }

  return { results };
}
