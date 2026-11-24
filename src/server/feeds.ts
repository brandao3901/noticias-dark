import { XMLParser } from 'fast-xml-parser';
import type { FeedSourceStatus, NewsOutletFeedItem } from '../app/models/studio.models';

interface ConfiguredFeed {
  id: string;
  outlet: string;
  editorial: string;
  feedUrl: string;
}

// Section 15 & 21: Public editorial feeds of configured Brazilian news outlets
export const CONFIGURED_FEEDS: ConfiguredFeed[] = [
  {
    id: 'g1-geral',
    outlet: 'g1',
    editorial: 'Brasil',
    feedUrl: 'https://g1.globo.com/rss/g1/',
  },
  {
    id: 'g1-tech',
    outlet: 'g1',
    editorial: 'Tecnologia',
    feedUrl: 'https://g1.globo.com/rss/g1/tecnologia/',
  },
  {
    id: 'g1-economia',
    outlet: 'g1',
    editorial: 'Economia',
    feedUrl: 'https://g1.globo.com/rss/g1/economia/',
  },
  {
    id: 'folha-cotidiano',
    outlet: 'Folha de S.Paulo',
    editorial: 'Brasil',
    feedUrl: 'https://feeds.folha.uol.com.br/cotidiano/rss091.xml',
  },
  {
    id: 'folha-mercado',
    outlet: 'Folha de S.Paulo',
    editorial: 'Economia',
    feedUrl: 'https://feeds.folha.uol.com.br/mercado/rss091.xml',
  },
  {
    id: 'uol-noticias',
    outlet: 'UOL',
    editorial: 'Brasil',
    feedUrl: 'https://rss.uol.com.br/feed/noticias.xml',
  },
  {
    id: 'r7-noticias',
    outlet: 'R7',
    editorial: 'Brasil',
    feedUrl: 'https://noticias.r7.com/feed.xml',
  },
  {
    id: 'metropoles-geral',
    outlet: 'Metrópoles',
    editorial: 'Brasil',
    feedUrl: 'https://www.metropoles.com/feed',
  },
  {
    id: 'metropoles-celebridades',
    outlet: 'Metrópoles Celebridades',
    editorial: 'Celebridades',
    feedUrl: 'https://www.metropoles.com/celebridades/feed',
  },
  {
    id: 'metropoles-entretenimento',
    outlet: 'Metrópoles Entretenimento',
    editorial: 'Entretenimento',
    feedUrl: 'https://www.metropoles.com/entretenimento/feed',
  },
  {
    id: 'ig-gente',
    outlet: 'Gente (iG)',
    editorial: 'Celebridades',
    feedUrl: 'https://gente.ig.com.br/rss.xml',
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

function parseFeedItems(xml: string, feed: ConfiguredFeed): NewsOutletFeedItem[] {
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
        'User-Agent': 'CanalDarkEditorial/0.1 (+https://canaldark.local)',
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
    return {
      status: {
        ...feed,
        status: 'ok',
        itemCount: items.length,
        checkedAt,
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

export async function fetchAllEditorialFeeds(forceRefresh = false): Promise<{
  items: NewsOutletFeedItem[];
  statuses: FeedSourceStatus[];
  respondedCount: number;
  totalCount: number;
}> {
  const now = Date.now();
  if (!forceRefresh && feedCache && now - feedCache.fetchedAtMs < CACHE_TTL_MS) {
    const respondedCount = feedCache.statuses.filter((s) => s.status === 'ok').length;
    return {
      items: feedCache.items,
      statuses: feedCache.statuses,
      respondedCount,
      totalCount: feedCache.statuses.length,
    };
  }

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

  feedCache = {
    fetchedAtMs: now,
    items: deduped,
    statuses,
  };

  const respondedCount = statuses.filter((s) => s.status === 'ok').length;
  return {
    items: deduped,
    statuses,
    respondedCount,
    totalCount: statuses.length,
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
