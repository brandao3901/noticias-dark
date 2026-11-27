import { XMLParser } from 'fast-xml-parser';
import { WEB_USER_AGENT } from './http';
import type { FeedSourceStatus, NewsOutletFeedItem } from '../app/models/studio.models';

export interface ConfiguredFeed {
  id: string;
  outlet: string;
  editorial: string;
  feedUrl: string;
}

/**
 * Feeds publicos por editoria.
 *
 * Inclui agregadores (Google News), que garantem variedade e atualidade, e
 * veiculos individuais, que permitem extrair o texto original no dossie.
 * Ordem dentro de cada grupo nao importa: a lista final e ordenada por data.
 */
export const CONFIGURED_FEEDS: ConfiguredFeed[] = [
  {
    id: 'gnews-brasil',
    outlet: 'Google News',
    editorial: 'Brasil',
    feedUrl: 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-mundo',
    outlet: 'Google News',
    editorial: 'Brasil',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-economia',
    outlet: 'Google News',
    editorial: 'Economia',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-tecnologia',
    outlet: 'Google News',
    editorial: 'Tecnologia',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-ciencia',
    outlet: 'Google News',
    editorial: 'Tecnologia',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-esportes',
    outlet: 'Google News',
    editorial: 'Esportes',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'gnews-entretenimento',
    outlet: 'Google News',
    editorial: 'Entretenimento',
    feedUrl: 'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=pt-BR&gl=BR&ceid=BR:pt-419',
  },
  {
    id: 'g1-geral',
    outlet: 'g1',
    editorial: 'Brasil',
    feedUrl: 'https://g1.globo.com/rss/g1/',
  },
  {
    id: 'g1-politica',
    outlet: 'g1',
    editorial: 'Brasil',
    feedUrl: 'https://g1.globo.com/rss/g1/politica/',
  },
  {
    id: 'g1-economia',
    outlet: 'g1',
    editorial: 'Economia',
    feedUrl: 'https://g1.globo.com/rss/g1/economia/',
  },
  {
    id: 'g1-tecnologia',
    outlet: 'g1',
    editorial: 'Tecnologia',
    feedUrl: 'https://g1.globo.com/rss/g1/tecnologia/',
  },
  {
    id: 'g1-ciencia',
    outlet: 'g1',
    editorial: 'Tecnologia',
    feedUrl: 'https://g1.globo.com/rss/g1/ciencia-e-saude/',
  },
  {
    id: 'g1-pop',
    outlet: 'g1',
    editorial: 'Entretenimento',
    feedUrl: 'https://g1.globo.com/rss/g1/pop-arte/',
  },
  {
    id: 'ab-geral',
    outlet: 'Agencia Brasil',
    editorial: 'Brasil',
    feedUrl: 'https://agenciabrasil.ebc.com.br/rss/geral/feed.xml',
  },
  {
    id: 'ab-politica',
    outlet: 'Agencia Brasil',
    editorial: 'Brasil',
    feedUrl: 'https://agenciabrasil.ebc.com.br/rss/politica/feed.xml',
  },
  {
    id: 'ab-economia',
    outlet: 'Agencia Brasil',
    editorial: 'Economia',
    feedUrl: 'https://agenciabrasil.ebc.com.br/rss/economia/feed.xml',
  },
  {
    id: 'ab-esportes',
    outlet: 'Agencia Brasil',
    editorial: 'Esportes',
    feedUrl: 'https://agenciabrasil.ebc.com.br/rss/esportes/feed.xml',
  },
  {
    id: 'ab-internacional',
    outlet: 'Agencia Brasil',
    editorial: 'Brasil',
    feedUrl: 'https://agenciabrasil.ebc.com.br/rss/internacional/feed.xml',
  },
  {
    id: 'folha-cotidiano',
    outlet: 'Folha de S.Paulo',
    editorial: 'Brasil',
    feedUrl: 'https://feeds.folha.uol.com.br/cotidiano/rss091.xml',
  },
  {
    id: 'folha-poder',
    outlet: 'Folha de S.Paulo',
    editorial: 'Brasil',
    feedUrl: 'https://feeds.folha.uol.com.br/poder/rss091.xml',
  },
  {
    id: 'folha-mercado',
    outlet: 'Folha de S.Paulo',
    editorial: 'Economia',
    feedUrl: 'https://feeds.folha.uol.com.br/mercado/rss091.xml',
  },
  {
    id: 'folha-ilustrada',
    outlet: 'Folha de S.Paulo',
    editorial: 'Entretenimento',
    feedUrl: 'https://feeds.folha.uol.com.br/ilustrada/rss091.xml',
  },
  {
    id: 'folha-esporte',
    outlet: 'Folha de S.Paulo',
    editorial: 'Esportes',
    feedUrl: 'https://feeds.folha.uol.com.br/esporte/rss091.xml',
  },
  {
    id: 'uol-noticias',
    outlet: 'UOL',
    editorial: 'Brasil',
    feedUrl: 'https://rss.uol.com.br/feed/noticias.xml',
  },
  {
    id: 'uol-economia',
    outlet: 'UOL',
    editorial: 'Economia',
    feedUrl: 'https://rss.uol.com.br/feed/economia.xml',
  },
  {
    id: 'uol-esporte',
    outlet: 'UOL',
    editorial: 'Esportes',
    feedUrl: 'https://rss.uol.com.br/feed/esporte.xml',
  },
  {
    id: 'uol-tecnologia',
    outlet: 'UOL',
    editorial: 'Tecnologia',
    feedUrl: 'https://rss.uol.com.br/feed/tecnologia.xml',
  },
  {
    id: 'uol-entretenimento',
    outlet: 'UOL',
    editorial: 'Entretenimento',
    feedUrl: 'https://rss.uol.com.br/feed/entretenimento.xml',
  },
  {
    id: 'bbc-brasil',
    outlet: 'BBC Brasil',
    editorial: 'Brasil',
    feedUrl: 'https://feeds.bbci.co.uk/portuguese/rss.xml',
  },
  {
    id: 'carta-capital',
    outlet: 'CartaCapital',
    editorial: 'Brasil',
    feedUrl: 'https://www.cartacapital.com.br/feed/',
  },
  {
    id: 'metropoles-geral',
    outlet: 'Metropoles',
    editorial: 'Brasil',
    feedUrl: 'https://www.metropoles.com/feed',
  },
  {
    // A Choquei foi testada e descartada: choquei.com.br responde com
    // certificado de outra plataforma e choquei.com é um WordPress parado
    // (post mais recente de 31/08, textos de SEO). O conteúdo real dela vive em
    // X/Instagram, que o projeto não raspa. No lugar entraram veículos de
    // celebridades que publicam de fato.
    id: 'ofuxico',
    outlet: 'OFuxico',
    editorial: 'Celebridades',
    feedUrl: 'https://ofuxico.com.br/feed/',
  },
  {
    id: 'capricho',
    outlet: 'Capricho',
    editorial: 'Celebridades',
    feedUrl: 'https://capricho.abril.com.br/feed/',
  },
  {
    id: 'terra-diversao',
    outlet: 'Terra Diversão',
    editorial: 'Entretenimento',
    feedUrl: 'https://www.terra.com.br/diversao/rss.xml',
  },
  {
    id: 'metropoles-celebridades',
    outlet: 'Metropoles Celebridades',
    editorial: 'Celebridades',
    feedUrl: 'https://www.metropoles.com/celebridades/feed',
  },
  {
    id: 'metropoles-entretenimento',
    outlet: 'Metropoles Entretenimento',
    editorial: 'Entretenimento',
    feedUrl: 'https://www.metropoles.com/entretenimento/feed',
  },
  {
    id: 'metropoles-esportes',
    outlet: 'Metropoles Esportes',
    editorial: 'Esportes',
    feedUrl: 'https://www.metropoles.com/esportes/feed',
  },
  {
    id: 'brasil-de-fato',
    outlet: 'Brasil de Fato',
    editorial: 'Brasil',
    feedUrl: 'https://www.brasildefato.com.br/rss',
  },
  {
    id: 'ig-gente',
    outlet: 'Gente (iG)',
    editorial: 'Celebridades',
    feedUrl: 'https://gente.ig.com.br/rss.xml',
  },
  {
    id: 'terra-noticias',
    outlet: 'Terra',
    editorial: 'Brasil',
    feedUrl: 'https://www.terra.com.br/rss.xml',
  },
  {
    id: 'infomoney',
    outlet: 'InfoMoney',
    editorial: 'Economia',
    feedUrl: 'https://www.infomoney.com.br/feed/',
  },
  {
    id: 'exame',
    outlet: 'Exame',
    editorial: 'Economia',
    feedUrl: 'https://exame.com/feed/',
  },
  {
    id: 'tecnoblog',
    outlet: 'Tecnoblog',
    editorial: 'Tecnologia',
    feedUrl: 'https://tecnoblog.net/feed/',
  },
  {
    id: 'showmetech',
    outlet: 'ShowMeTech',
    editorial: 'Tecnologia',
    feedUrl: 'https://www.showmetech.com.br/feed/',
  },
  {
    id: 'mobiletime',
    outlet: 'MobileTime',
    editorial: 'Tecnologia',
    feedUrl: 'https://www.mobiletime.com.br/feed/',
  },
  {
    id: 'olhardigital',
    outlet: 'Olhar Digital',
    editorial: 'Tecnologia',
    feedUrl: 'https://olhardigital.com.br/feed/',
  },
  {
    id: 'canaltech',
    outlet: 'Canaltech',
    editorial: 'Tecnologia',
    feedUrl: 'https://canaltech.com.br/rss/',
  },
  {
    id: 'ge-globo',
    outlet: 'ge',
    editorial: 'Esportes',
    feedUrl: 'https://ge.globo.com/rss/ge/',
  },
  {
    id: 'espn-brasil',
    outlet: 'ESPN Brasil',
    editorial: 'Esportes',
    feedUrl: 'https://www.espn.com.br/espn/rss/news',
  },
  {
    id: 'poder360',
    outlet: 'Poder360',
    editorial: 'Brasil',
    feedUrl: 'https://www.poder360.com.br/feed/',
  },
  {
    id: 'cnn-brasil',
    outlet: 'CNN Brasil',
    editorial: 'Brasil',
    feedUrl: 'https://www.cnnbrasil.com.br/feed/',
  },
  {
    id: 'jovem-pan',
    outlet: 'Jovem Pan',
    editorial: 'Brasil',
    feedUrl: 'https://jovempan.com.br/feed',
  },
  {
    id: 'veja',
    outlet: 'Veja',
    editorial: 'Brasil',
    feedUrl: 'https://veja.abril.com.br/feed/',
  },
  {
    id: 'agencia-senado',
    outlet: 'Agência Senado',
    editorial: 'Brasil',
    feedUrl: 'https://www12.senado.leg.br/noticias/rss',
  },
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

interface FeedCacheEntry {
  fetchedAtMs: number;
  items: NewsOutletFeedItem[];
  statuses: FeedSourceStatus[];
}

let feedCache: FeedCacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function stripHtmlTags(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function textValue(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec['#text'] === 'string') return rec['#text'];
    if (typeof rec['@_href'] === 'string') return rec['@_href'];
  }
  return '';
}

function normalizeLink(rawLink: unknown): string {
  if (Array.isArray(rawLink)) {
    for (const item of rawLink) {
      const candidate = textValue(item);
      if (candidate.startsWith('http')) return candidate;
    }
    return '';
  }
  return textValue(rawLink).trim();
}

export function parseFeedItems(xml: string, feed: ConfiguredFeed): NewsOutletFeedItem[] {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const items: NewsOutletFeedItem[] = [];

  const rss = parsed['rss'] as Record<string, unknown> | undefined;
  const channel = rss?.['channel'] as Record<string, unknown> | undefined;
  const rdf = parsed['rdf:RDF'] as Record<string, unknown> | undefined;
  const atom = parsed['feed'] as Record<string, unknown> | undefined;

  let rawEntries: unknown[] = [];
  if (channel?.['item']) {
    rawEntries = Array.isArray(channel['item']) ? channel['item'] : [channel['item']];
  } else if (rdf?.['item']) {
    rawEntries = Array.isArray(rdf['item']) ? rdf['item'] : [rdf['item']];
  } else if (atom?.['entry']) {
    rawEntries = Array.isArray(atom['entry']) ? atom['entry'] : [atom['entry']];
  }

  for (let i = 0; i < Math.min(rawEntries.length, 15); i++) {
    const entry = rawEntries[i] as Record<string, unknown>;
    if (!entry) continue;

    const title = stripHtmlTags(textValue(entry['title']));
    const url = normalizeLink(entry['link'] ?? entry['guid']);
    if (!title || !url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      continue;
    }

    const rawDesc =
      textValue(entry['description']) ||
      textValue(entry['summary']) ||
      textValue(entry['content:encoded']) ||
      textValue(entry['content']);
    const excerpt = stripHtmlTags(rawDesc).slice(0, 260);
    const publishedRaw =
      textValue(entry['pubDate']) ||
      textValue(entry['dc:date']) ||
      textValue(entry['published']) ||
      textValue(entry['updated']);
    const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
    const publishedAt =
      publishedDate && !Number.isNaN(publishedDate.getTime())
        ? publishedDate.toISOString()
        : new Date().toISOString();

    const author = stripHtmlTags(
      textValue(entry['dc:creator']) || textValue(entry['author']),
    ).slice(0, 80);

    items.push({
      id: `${feed.id}-${i}-${Buffer.from(url).toString('base64url').slice(0, 10)}`,
      title,
      url,
      outlet: feed.outlet,
      editorial: feed.editorial,
      publishedAt,
      excerpt,
      author: author || undefined,
    });
  }

  return items;
}

async function fetchSingleFeed(feed: ConfiguredFeed): Promise<{
  status: FeedSourceStatus;
  items: NewsOutletFeedItem[];
}> {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(feed.feedUrl, {
      signal: AbortSignal.timeout(6500),
      headers: {
        'User-Agent': WEB_USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
      },
    });
    if (!res.ok) {
      return {
        status: {
          ...feed,
          status: 'error',
          itemCount: 0,
          errorMessage: `HTTP ${res.status}`,
          checkedAt,
        },
        items: [],
      };
    }
    const xml = await res.text();
    const items = parseFeedItems(xml, feed);

    // Feed pode responder 200 e estar parado (caso da Choquei, cujo último post
    // era de três meses antes). Silêncio aqui faria o painel mentir.
    const newestMs = items.reduce((max, item) => {
      const ts = new Date(item.publishedAt).getTime();
      return Number.isFinite(ts) && ts > max ? ts : max;
    }, 0);
    const stale = items.length > 0 && Date.now() - newestMs > 7 * 24 * 60 * 60 * 1000;

    return {
      status: {
        ...feed,
        status: 'ok',
        itemCount: items.length,
        checkedAt,
        stale,
        errorMessage: stale ? 'Sem itens recentes (feed parado há mais de 7 dias).' : undefined,
      },
      items,
    };
  } catch (err) {
    return {
      status: {
        ...feed,
        status: 'error',
        itemCount: 0,
        errorMessage: err instanceof Error ? err.message : 'Falha na leitura do feed',
        checkedAt,
      },
      items: [],
    };
  }
}

/** Remove itens mais antigos que a janela pedida (0 = sem filtro). */
function applyMaxAge(items: NewsOutletFeedItem[], maxAgeHours: number): NewsOutletFeedItem[] {
  if (!maxAgeHours || maxAgeHours <= 0) return items;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  return items.filter((item) => {
    const published = new Date(item.publishedAt).getTime();
    return Number.isFinite(published) ? published >= cutoff : true;
  });
}

async function refreshAllFeeds(): Promise<FeedCacheEntry> {
  const now = Date.now();
  const settled = await Promise.all(CONFIGURED_FEEDS.map((f) => fetchSingleFeed(f)));
  const statuses = settled.map((s) => s.status);
  const rawItems = settled.flatMap((s) => s.items);

  // Deduplicate by URL and normalized title
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const deduped: NewsOutletFeedItem[] = [];

  for (const item of rawItems) {
    const cleanUrl = item.url.split('#')[0].replace(/\/$/, '').toLowerCase();
    const cleanTitle = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seenUrls.has(cleanUrl) || seenTitles.has(cleanTitle)) continue;
    seenUrls.add(cleanUrl);
    seenTitles.add(cleanTitle);
    deduped.push(item);
  }

  deduped.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return { fetchedAtMs: now, items: deduped, statuses };
}

export async function fetchAllEditorialFeeds(
  forceRefresh = false,
  maxAgeHours = 72,
): Promise<{
  items: NewsOutletFeedItem[];
  statuses: FeedSourceStatus[];
  respondedCount: number;
  totalCount: number;
  newestAt?: string;
}> {
  const now = Date.now();
  // O cache guarda a lista completa: janelas de tempo diferentes (24h, 7d)
  // reaproveitam a mesma coleta.
  if (forceRefresh || !feedCache || now - feedCache.fetchedAtMs >= CACHE_TTL_MS) {
    feedCache = await refreshAllFeeds();
  }

  const entry = feedCache;
  const respondedCount = entry.statuses.filter((s) => s.status === 'ok').length;

  return {
    items: applyMaxAge(entry.items, maxAgeHours).slice(0, 400),
    statuses: entry.statuses,
    respondedCount,
    totalCount: entry.statuses.length,
    newestAt: entry.items[0]?.publishedAt,
  };
}

export function matchFeedsByQuery(items: NewsOutletFeedItem[], query: string): NewsOutletFeedItem[] {
  const tokens = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  if (!tokens.length) return items.slice(0, 12);

  const scored = items
    .map((item) => {
      const hay = `${item.title} ${item.excerpt}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const hits = tokens.reduce((acc, tok) => (hay.includes(tok) ? acc + 1 : acc), 0);
      return { item, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  return scored.slice(0, 12).map((x) => x.item);
}

// ---------------------------------------------------------------------------
// Ranking de virais
//
// "Viral" aqui não é opinião: é a soma de sinais verificáveis no próprio feed —
// palavras de apelo na manchete, veículo de celebridades, o mesmo assunto
// aparecendo em vários veículos e o quão recente é. Tudo auditável na interface.
// ---------------------------------------------------------------------------

const VIRAL_SIGNALS: Array<{ re: RegExp; weight: number; reason: string }> = [
  { re: /\b(viralizou|viraliza|bombou|repercutiu|repercussao)\b/, weight: 3, reason: 'viralizou' },
  { re: /\b(internautas|redes sociais|na web|twitter|x\/|tiktok|instagram|stories)\b/, weight: 2, reason: 'repercussão na web' },
  { re: /\b(treta|climao|detonou|alfinetou|indireta|criticou|rebateu|respondeu)\b/, weight: 2, reason: 'conflito público' },
  { re: /\b(flagra|flagrou|assume|confessa|revela|revelou|desabafa|desabafou|admite)\b/, weight: 2, reason: 'revelação' },
  { re: /\b(namoro|namora|affair|termina|terminou|casamento|casou|traicao|romance|beijo)\b/, weight: 2, reason: 'vida amorosa' },
  { re: /\b(morre|morreu|morte|acidente|internado|internada|cirurgia|doenca|cancer)\b/, weight: 3, reason: 'fato grave' },
  { re: /\b(influencer|influenciadora|famosos|celebridade|sertanejo|funk|bbb|a famosa)\b/, weight: 2, reason: 'cultura pop' },
  { re: /\b(polemica|processa|processo|justica|proibido|liminar|acusacao|denuncia)\b/, weight: 1, reason: 'polêmica' },
  { re: /\b(chocante|surpreendente|inacreditavel|absurdo|bizarro|inedito)\b/, weight: 2, reason: 'apelo de choque' },
  { re: /\b(exclusivo|urgente|agora|acabou de)\b/, weight: 1, reason: 'urgência' },
];

const CELEBRITY_OUTLET_RE = /choquei|celebridades|gente \(ig\)|entretenimento/i;

const VIRAL_STOPWORDS = new Set([
  'para', 'como', 'mais', 'sobre', 'apos', 'ainda', 'entre', 'contra', 'desde', 'quando',
  'onde', 'porque', 'esta', 'estao', 'esse', 'essa', 'isso', 'pelo', 'pela', 'dos', 'das',
  'com', 'sem', 'por', 'que', 'sua', 'seu', 'nas', 'nos', 'uma', 'veja', 'confira',
]);

function viralTokens(text: string): Set<string> {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const out = new Set<string>();
  for (const token of normalized.split(/[^a-z0-9]+/)) {
    if (token.length >= 4 && !VIRAL_STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/**
 * Pontua cada manchete e devolve as mais virais primeiro.
 * `sourceCount` é quantos OUTROS veículos usaram os mesmos termos — repetição
 * entre veículos é o sinal mais confiável de assunto quente.
 */
export function rankViralItems(items: NewsOutletFeedItem[]): NewsOutletFeedItem[] {
  const now = Date.now();
  const tokenIndex = new Map<string, Set<string>>();
  const prepared = items.map((item) => {
    const tokens = viralTokens(`${item.title} ${item.excerpt}`);
    return { item, tokens };
  });

  for (const { item, tokens } of prepared) {
    for (const token of tokens) {
      let outlets = tokenIndex.get(token);
      if (!outlets) {
        outlets = new Set<string>();
        tokenIndex.set(token, outlets);
      }
      outlets.add(item.outlet);
    }
  }

  return prepared
    .map(({ item, tokens }) => {
      const otherOutlets = new Set<string>();
      for (const token of tokens) {
        for (const outlet of tokenIndex.get(token) ?? []) {
          if (outlet !== item.outlet) otherOutlets.add(outlet);
        }
      }
      const sourceCount = otherOutlets.size;

      const haystack = `${item.title} ${item.excerpt}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      const reasons: string[] = [];
      let score = 0;

      for (const signal of VIRAL_SIGNALS) {
        if (signal.re.test(haystack)) {
          score += signal.weight;
          reasons.push(signal.reason);
        }
      }

      if (CELEBRITY_OUTLET_RE.test(item.outlet)) {
        score += 2;
        reasons.push('veículo de celebridades');
      }

      if (sourceCount >= 2) {
        score += Math.min(3, sourceCount);
        reasons.push(`${sourceCount} veículos no mesmo assunto`);
      }

      const ageHours = (now - new Date(item.publishedAt).getTime()) / 3_600_000;
      if (ageHours <= 6) {
        score += 2;
        reasons.push('últimas 6h');
      } else if (ageHours <= 24) {
        score += 1;
      }

      return {
        ...item,
        viralScore: Math.round(score * 10) / 10,
        viralReasons: Array.from(new Set(reasons)).slice(0, 3),
        sourceCount,
      };
    })
    .sort((a, b) => (b.viralScore ?? 0) - (a.viralScore ?? 0));
}
