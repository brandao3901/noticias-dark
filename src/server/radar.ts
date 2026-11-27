import { WEB_USER_AGENT } from './http';
import { parseFeedItems, type ConfiguredFeed } from './feeds';
import { runGeminiJson } from './gemini';
import type {
  RadarArticle,
  RadarClusterItem,
  RadarScores,
  RadarScope,
} from '../app/models/studio.models';

/**
 * Radar Global: pesquisa fora do Brasil, agrupada e avaliada.
 *
 * Duas frentes complementares:
 *  - `tendencias`: Google News em vários países/idiomas + seções de ciência e
 *    tecnologia; o que está crescendo agora.
 *  - `documental`: veículos de ciência, história e engenharia, com janela longa
 *    (a história continua boa meses depois).
 *
 * Regra herdada do módulo de notícias: nada é produzido automaticamente. O radar
 * só apresenta candidatos; quem escolhe é o usuário.
 */

interface RadarFeed extends ConfiguredFeed {
  country: string;
  language: string;
  category: string;
}

const gnews = (
  id: string,
  hg: string,
  gl: string,
  ceid: string,
  country: string,
  language: string,
  category: string,
  topic?: string,
): RadarFeed => ({
  id,
  outlet: 'Google News',
  editorial: category,
  feedUrl: topic
    ? `https://news.google.com/rss/headlines/section/topic/${topic}?hl=${hg}&gl=${gl}&ceid=${ceid}`
    : `https://news.google.com/rss?hl=${hg}&gl=${gl}&ceid=${ceid}`,
  country,
  language,
  category,
});

/** Feed evergreen: portal de ciência/história/engenharia (RSS livre). */
const ever = (
  id: string,
  outlet: string,
  feedUrl: string,
  country: string,
  language: string,
  category: string,
): RadarFeed => ({ id, outlet, editorial: category, feedUrl, country, language, category });

export const RADAR_TREND_FEEDS: RadarFeed[] = [
  gnews('us-top', 'en-US', 'US', 'US:en', 'Estados Unidos', 'inglês', 'Mundo'),
  gnews('us-tech', 'en-US', 'US', 'US:en', 'Estados Unidos', 'inglês', 'Tecnologia', 'TECHNOLOGY'),
  gnews('us-sci', 'en-US', 'US', 'US:en', 'Estados Unidos', 'inglês', 'Ciência', 'SCIENCE'),
  gnews('gb-top', 'en-GB', 'GB', 'GB:en', 'Reino Unido', 'inglês', 'Mundo'),
  gnews('jp-top', 'ja', 'JP', 'JP:ja', 'Japão', 'japonês', 'Mundo'),
  gnews('jp-tech', 'ja', 'JP', 'JP:ja', 'Japão', 'japonês', 'Tecnologia', 'TECHNOLOGY'),
  gnews('de-top', 'de', 'DE', 'DE:de', 'Alemanha', 'alemão', 'Mundo'),
  gnews('de-sci', 'de', 'DE', 'DE:de', 'Alemanha', 'alemão', 'Ciência', 'SCIENCE'),
  gnews('fr-top', 'fr', 'FR', 'FR:fr', 'França', 'francês', 'Mundo'),
  gnews('es-top', 'es', 'ES', 'ES:es', 'Espanha', 'espanhol', 'Mundo'),
  gnews('cn-top', 'zh-CN', 'CN', 'CN:zh-Hans', 'China', 'chinês', 'Mundo'),
  gnews('eg-top', 'ar', 'EG', 'EG:ar', 'Egito', 'árabe', 'Mundo'),
];

export const RADAR_EVERGREEN_FEEDS: RadarFeed[] = [
  ever('sciencedaily', 'ScienceDaily', 'https://www.sciencedaily.com/rss/top/science.xml', 'Estados Unidos', 'inglês', 'Ciência'),
  ever('physorg', 'Phys.org', 'https://phys.org/rss-feed/', 'Estados Unidos', 'inglês', 'Ciência'),
  ever('nasa', 'NASA', 'https://www.nasa.gov/news-release/feed/', 'Estados Unidos', 'inglês', 'Espaço'),
  ever('smithsonian', 'Smithsonian', 'https://www.smithsonianmag.com/rss/latest_articles/', 'Estados Unidos', 'inglês', 'História'),
  ever('ieee', 'IEEE Spectrum', 'https://spectrum.ieee.org/feeds/feed.rss', 'Estados Unidos', 'inglês', 'Engenharia'),
  ever('newatlas', 'New Atlas', 'https://newatlas.com/index.rss', 'Austrália', 'inglês', 'Tecnologia'),
  ever('arstechnica', 'Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'Estados Unidos', 'inglês', 'Tecnologia'),
  ever('livescience', 'Live Science', 'https://www.livescience.com/feeds/all', 'Estados Unidos', 'inglês', 'Ciência'),
  ever('atlasobscura', 'Atlas Obscura', 'https://www.atlasobscura.com/feeds/latest', 'Estados Unidos', 'inglês', 'Curiosidades'),
  ever('hakai', 'Hakai Magazine', 'https://hakaimagazine.com/feed/', 'Canadá', 'inglês', 'Natureza'),
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'with', 'after', 'before', 'at', 'by', 'from',
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'que', 'e', 'o',
  'la', 'el', 'los', 'las', 'en', 'y', 'del', 'le', 'les', 'des', 'du', 'et', 'der', 'die', 'das', 'und',
  'nhk', 'news', 'notícias', 'noticias', 'video', 'vídeo', 'live', 'breaking', 'new', 'says', 'said',
]);

const CATEGORY_HINTS: Array<{ re: RegExp; category: string }> = [
  { re: /\b(space|nasa|astro|telesc|orbit|planet|mars|moon|comet|asteroid)\b/i, category: 'Espaço' },
  { re: /\b(ai|robot|chip|quantum|software|semiconductor|comput)\b/i, category: 'Tecnologia' },
  { re: /\b(car|engine|f1|formula|motor|aviation|jet|rail|tunnel|bridge|factory)\b/i, category: 'Engenharia' },
  { re: /\b(archaeolog|ancient|history|century|empire|pharaoh|dinosaur|fossil)\b/i, category: 'História' },
  { re: /\b(study|research|scientist|gene|brain|psycholog|virus|medic)\b/i, category: 'Ciência' },
  { re: /\b(animal|species|wild|ocean|shark|whale|insect|bird)\b/i, category: 'Natureza' },
  { re: /\b(million|billion|company|startup|market|economy|trade)\b/i, category: 'Economia' },
];

/** O radar é de histórias e descobertas: promoção/varejo não entra. */
const RADAR_BLOCK =
  /\b(black friday|cyber monday|deal|deals|coupon|discount|promo|coupon code|sale|best buy|price drop|giveaway|refurbished)\b/i;

/**
 * Mesmo critério do módulo de notícias: o canal não produz violência gratuita.
 * Histórias de crime antigas continuam possíveis pelo fluxo de notícias.
 */
const RADAR_SENSITIVE =
  /\b(dies|died|dead body|killed|murder\w*|shooting|shot dead|funeral|obituary|suicide|rape|abused|massacre|genocide|terror\w*|assassinat\w*|beheaded|torture\w*|executed)\b/i;

const CACHE_TTL_MS = 5 * 60 * 1000;
const AI_CACHE_TTL_MS = 10 * 60 * 1000;

interface RadarCache {
  fetchedAt: number;
  scope: RadarScope;
  articles: RadarArticle[];
  feedErrors: number;
}

let radarCache: RadarCache | null = null;
const aiCache = new Map<string, { at: number; ai: RadarClusterItem['ai'] }>();

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokensOf(title: string): Set<string> {
  const words = stripAccents(title.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function guessCategory(article: RadarArticle): string {
  const blob = `${article.title} ${article.excerpt}`;
  for (const hint of CATEGORY_HINTS) if (hint.re.test(blob)) return hint.category;
  return article.category || 'Mundo';
}

async function fetchFeed(feed: RadarFeed): Promise<RadarArticle[]> {
  try {
    const res = await fetch(feed.feedUrl, {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': WEB_USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseFeedItems(xml, feed);
    return items.map((item) => ({
      id: `${feed.id}:${item.id || item.url}`,
      title: item.title,
      url: item.url,
      outlet: feed.outlet,
      country: feed.country,
      language: feed.language,
      publishedAt: item.publishedAt,
      excerpt: (item.excerpt ?? '').slice(0, 400),
      category: feed.category,
    }));
  } catch {
    return [];
  }
}

async function collectArticles(scope: RadarScope, forceRefresh: boolean): Promise<RadarCache> {
  const now = Date.now();
  if (!forceRefresh && radarCache && radarCache.scope === scope && now - radarCache.fetchedAt < CACHE_TTL_MS) {
    return radarCache;
  }

  const feeds = scope === 'documental' ? RADAR_EVERGREEN_FEEDS : RADAR_TREND_FEEDS;
  const results = await Promise.all(feeds.map((feed) => fetchFeed(feed)));
  const articles = results.flat();
  const feedErrors = results.filter((items) => items.length === 0).length;

  radarCache = { fetchedAt: now, scope, articles, feedErrors };
  return radarCache;
}

/** Agrupa publicações do mesmo acontecimento (título parecido = mesma história). */
export function clusterArticles(articles: RadarArticle[]): RadarClusterItem[] {
  const sorted = [...articles].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  const groups: Array<{ tokens: Set<string>; articles: RadarArticle[] }> = [];
  for (const article of sorted) {
    // Descarta promoção/varejo e violência explícita antes de agrupar.
    if (RADAR_BLOCK.test(article.title) || RADAR_SENSITIVE.test(article.title)) continue;

    const tokens = tokensOf(article.title);
    if (tokens.size < 2) continue;

    const match = groups.find((group) => jaccard(group.tokens, tokens) >= 0.45);
    if (match) {
      match.articles.push(article);
      for (const token of tokens) match.tokens.add(token);
    } else {
      groups.push({ tokens, articles: [article] });
    }
  }

  const now = Date.now();
  return groups.slice(0, 80).map((group, index) => {
    const [lead] = group.articles;
    const countries = Array.from(new Set(group.articles.map((a) => a.country)));
    const languages = Array.from(new Set(group.articles.map((a) => a.language)));
    const sources = group.articles.length;
    const ageHours = Math.max(
      0,
      (now - new Date(lead.publishedAt).getTime()) / 3_600_000,
    );
    const velocity = sources / Math.max(1, ageHours + 1);
    const recency = Math.max(0, 1 - ageHours / (ageHours > 72 ? 720 : 72));

    const observedScore = Math.round(
      30 * Math.min(1, sources / 5) +
        20 * Math.min(1, countries.length / 3) +
        15 * Math.min(1, languages.length / 2) +
        20 * recency +
        15 * Math.min(1, velocity / 1.5),
    );

    return {
      id: `radar-${index + 1}-${lead.id}`.slice(0, 90),
      title: lead.title,
      summary: lead.excerpt || group.articles.find((a) => a.excerpt)?.excerpt || '',
      category: guessCategory(lead),
      countries,
      languages,
      publishedAt: lead.publishedAt,
      articles: group.articles.slice(0, 6),
      observed: {
        fontes: sources,
        paises: countries.length,
        idiomas: languages.length,
        idadeHoras: Math.round(ageHours),
        score: observedScore,
      },
      score: observedScore,
    };
  });
}


/**
 * Viralidade do candidato: quantos veículos, países e idiomas falam do mesmo
 * assunto e há quanto tempo. É o que separa "saiu em um site" de "está
 * repercutindo no mundo" — a nota editorial da IA entra depois, como bônus.
 */
function viralOf(cluster: RadarClusterItem): NonNullable<RadarClusterItem['viral']> {
  const { fontes, paises, idiomas, idadeHoras } = cluster.observed;
  const velocidade = fontes / Math.max(1, idadeHoras + 1);

  const score = Math.round(
    40 * Math.min(1, fontes / 5) +
      30 * Math.min(1, paises / 3) +
      20 * Math.min(1, idiomas / 2) +
      10 * Math.min(1, velocidade / 1.5),
  );

  const rotulo =
    score >= 60
      ? ('viralizando' as const)
      : score >= 35
        ? ('repercutindo' as const)
        : score >= 18
          ? ('emergente' as const)
          : ('isolada' as const);

  return { score, rotulo };
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          interesse: { type: 'number' },
          crescimento: { type: 'number' },
          concorrencia: { type: 'number' },
          oportunidade: { type: 'number' },
          narrativo: { type: 'number' },
          visual: { type: 'number' },
          confiabilidade: { type: 'number' },
          relevanciaBr: { type: 'number' },
          recomendacao: { type: 'string' },
          categoria: { type: 'string' },
          formato: { type: 'string' },
          personalidade: { type: 'string' },
          resumo: { type: 'string' },
        },
        required: [
          'id', 'interesse', 'crescimento', 'concorrencia', 'oportunidade',
          'narrativo', 'visual', 'confiabilidade', 'relevanciaBr', 'recomendacao',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['itens'],
  additionalProperties: false,
};

function clamp10(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 5;
  return Math.max(0, Math.min(10, Math.round(num)));
}

/**
 * Avaliação da IA sobre os melhores candidatos observados.
 *
 * Separada de propósito: o que é dado medido (fontes, países, idade) fica em
 * `observed`; o que é julgamento da IA fica em `ai`. A interface mostra os dois.
 */
export async function scoreClustersWithAi(
  clusters: RadarClusterItem[],
  scope: RadarScope,
): Promise<{ aiAvailable: boolean; message?: string }> {
  const candidates = [...clusters]
    .sort((a, b) => b.observed.score - a.observed.score)
    .slice(0, 12);

  const pending = candidates.filter((cluster) => {
    const cached = aiCache.get(cluster.id);
    if (cached && Date.now() - cached.at < AI_CACHE_TTL_MS) {
      cluster.ai = cached.ai;
      return false;
    }
    return true;
  });

  if (!pending.length) return { aiAvailable: true };

  const lista = pending
    .map(
      (cluster, index) =>
        `${index + 1}. id=${cluster.id}
   título: ${cluster.title}
   fontes: ${cluster.observed.fontes} · países: ${cluster.countries.join(', ')} · idade: ${cluster.observed.idadeHoras}h
   trecho: ${cluster.summary.slice(0, 220) || '(sem trecho)'}`,
    )
    .join('\n');

  const prompt = `Você é editor de um canal brasileiro de Shorts documentais e jornalísticos.
Avalie os candidatos abaixo (${scope === 'documental' ? 'pautas atemporais' : 'tendências recentes'}) para um vídeo de 40 a 60 segundos em português do Brasil.

Candidatos:
${lista}

Para CADA id, dê notas de 0 a 10:
- interesse: relevância e procura pelo assunto
- crescimento: velocidade com que está ganhando atenção
- concorrencia: (10 = pouca concorrência em português, 0 = saturado)
- oportunidade: existe ângulo diferente do óbvio
- narrativo: dá para contar como história
- visual: existem imagens/vídeos bons disponíveis
- confiabilidade: fontes sólidas confirmam
- relevanciaBr: desperta interesse no público brasileiro

Também devolva:
- recomendacao: 1 frase direta dizendo se vale produzir e por quê
- categoria: segmento curto (ex.: "Espaço", "Engenharia", "História")
- formato: um de "noticia" | "minidocumentario" | "curiosidade" | "investigativa" | "descoberta"
- personalidade: um de "documentario" | "misterioso" | "impactante" | "explicativo" | "jornalistico"
- resumo: 1 ou 2 frases em português explicando a história

Não invente fatos. Se a informação for fraca, dê nota baixa em confiabilidade.`;

  const result = await runGeminiJson<{ itens: Array<Record<string, unknown>> }>({
    prompt,
    schema: SCORE_SCHEMA,
    temperature: 0.3,
  });

  if (!result.ok || !result.data?.itens) {
    return { aiAvailable: false, message: result.message ?? 'IA indisponível para avaliar as pautas.' };
  }

  for (const item of result.data.itens) {
    const cluster = clusters.find((candidate) => candidate.id === item['id']);
    if (!cluster) continue;

    const scores: RadarScores = {
      interesse: clamp10(item['interesse']),
      crescimento: clamp10(item['crescimento']),
      concorrencia: clamp10(item['concorrencia']),
      oportunidade: clamp10(item['oportunidade']),
      narrativo: clamp10(item['narrativo']),
      visual: clamp10(item['visual']),
      confiabilidade: clamp10(item['confiabilidade']),
      relevanciaBr: clamp10(item['relevanciaBr']),
    };

    const total = Math.round(
      Object.values(scores).reduce((sum, value) => sum + value, 0) / Object.keys(scores).length * 10,
    );

    cluster.ai = {
      scores,
      total,
      recomendacao: String(item['recomendacao'] ?? '').slice(0, 240),
      categoria: String(item['categoria'] ?? '').slice(0, 40) || cluster.category,
      formato: ['noticia', 'minidocumentario', 'curiosidade', 'investigativa', 'descoberta'].includes(
        String(item['formato']),
      )
        ? (String(item['formato']) as RadarClusterItem['ai'] extends undefined ? never : NonNullable<RadarClusterItem['ai']>['formato'])
        : 'noticia',
      personalidade: ['documentario', 'misterioso', 'impactante', 'explicativo', 'jornalistico'].includes(
        String(item['personalidade']),
      )
        ? (String(item['personalidade']) as NonNullable<RadarClusterItem['ai']>['personalidade'])
        : 'jornalistico',
      resumo: String(item['resumo'] ?? '').slice(0, 320),
    };

    if (cluster.ai.categoria) cluster.category = cluster.ai.categoria;
    // Nota final: 45% dado observado, 55% avaliação editorial.
    cluster.score = Math.round(cluster.observed.score * 0.45 + total * 0.55);
    aiCache.set(cluster.id, { at: Date.now(), ai: cluster.ai });
  }

  return { aiAvailable: true };
}

/** Radar completo: coleta, agrupa e (se possível) avalia. */
export interface RadarFilters {
  /** Prioriza o que está repercutindo (vem primeiro na lista). */
  viralOnly: boolean;
  /** Quando true, devolve SOMENTE as virais. */
  onlyViral?: boolean;
  /** Nota mínima final (0–100). */
  minScore: number;
  /** Quantas pautas devolver no máximo. */
  limit: number;
}

export async function buildRadar(params: {
  scope: RadarScope;
  forceRefresh?: boolean;
  withAi?: boolean;
  filters?: Partial<RadarFilters>;
}): Promise<{
  items: RadarClusterItem[];
  aiAvailable: boolean;
  message?: string;
  generatedAt: string;
  feedErrors: number;
  totalCandidates: number;
  viralCount: number;
  filters: RadarFilters;
}> {
  const cache = await collectArticles(params.scope, Boolean(params.forceRefresh));
  const clusters = clusterArticles(cache.articles);

  // Ordena já pelos sinais de repercussão: a IA avalia os melhores primeiro.
  for (const cluster of clusters) {
    cluster.viral = viralOf(cluster);
  }

  let aiAvailable = false;
  let message: string | undefined;
  if (params.withAi !== false) {
    const ai = await scoreClustersWithAi(
      [...clusters].sort((a, b) => b.viral!.score - a.viral!.score || b.score - a.score),
      params.scope,
    );
    aiAvailable = ai.aiAvailable;
    message = ai.message;
  }

  // Nota final considerando a viralidade medida (sem IA ela ainda ordena).
  for (const cluster of clusters) {
    const viral = cluster.viral!.score;
    // Viralidade é o critério principal: o usuário quer o que está pegando.
    cluster.score = cluster.ai
      ? Math.round(cluster.observed.score * 0.3 + cluster.ai.total * 0.3 + viral * 0.4)
      : Math.round(cluster.observed.score * 0.45 + viral * 0.55);
  }

  const filters: RadarFilters = {
    // Tendências: por padrão só o que repercutiu em mais de um lugar.
    viralOnly: params.filters?.viralOnly ?? params.scope === 'tendencias',
    minScore: params.filters?.minScore ?? 0,
    limit: Math.max(1, Math.min(60, params.filters?.limit ?? 18)),
  };

  const isViral = (cluster: RadarClusterItem): boolean => {
    const { fontes, paises } = cluster.observed;
    // "Viral" = repercutiu em mais de um veículo ou em mais de um país.
    return (fontes >= 2 || paises >= 2) && (cluster.viral?.score ?? 0) >= 30;
  };

  // Rótulo segue o mesmo critério: nada de chamar de "repercutindo" um item
  // que só saiu em um veículo.
  for (const cluster of clusters) {
    if (!cluster.viral) continue;
    const viral = cluster.viral.score;
    cluster.viral = {
      score: viral,
      rotulo: isViral(cluster)
        ? viral >= 55
          ? 'viralizando'
          : 'repercutindo'
        : viral >= 18
          ? 'emergente'
          : 'isolada',
    };
  }

  const scored = clusters.filter((cluster) => cluster.score >= filters.minScore);
  const virais = scored.filter(isViral).sort((a, b) => b.score - a.score);
  const emergentes = scored
    .filter((cluster) => !isViral(cluster))
    .sort((a, b) => b.score - a.score || (b.viral?.score ?? 0) - (a.viral?.score ?? 0));

  // Prioriza as virais e completa com as emergentes: o usuário nunca fica com
  // uma lista vazia num dia fraco, mas as que estão repercutindo vêm primeiro.
  const visible = filters.viralOnly ? [...virais, ...emergentes] : [...virais, ...emergentes];
  const viralCount = virais.length;

  if (params.filters?.onlyViral) {
    visible.splice(virais.length);
  }

  const totalCandidates = visible.length;

  return {
    items: visible.slice(0, filters.limit),
    viralCount,
    aiAvailable,
    message,
    generatedAt: new Date().toISOString(),
    feedErrors: cache.feedErrors,
    totalCandidates,
    filters,
  };
}

/** Análise profunda de uma pauta escolhida (etapa 3 da criação). */
export async function analyzeRadarTopic(params: {
  title: string;
  urls?: string[];
  excerpts?: string[];
  category?: string;
}): Promise<{
  ok: boolean;
  message?: string;
  analysis?: {
    fatos: string[];
    incertos: string[];
    angulo: string;
    porqueInteressa: string;
    gancho: string;
    formato: string;
    personalidade: string;
    tecnicas: string[];
  };
}> {
  const material = [
    params.title,
    ...(params.excerpts ?? []).slice(0, 4),
    ...(params.urls ?? []).slice(0, 4),
  ]
    .filter(Boolean)
    .join('\n');

  const schema = {
    type: 'object',
    properties: {
      fatos: { type: 'array', items: { type: 'string' } },
      incertos: { type: 'array', items: { type: 'string' } },
      angulo: { type: 'string' },
      porqueInteressa: { type: 'string' },
      gancho: { type: 'string' },
      formato: { type: 'string' },
      personalidade: { type: 'string' },
      tecnicas: { type: 'array', items: { type: 'string' } },
    },
    required: ['fatos', 'incertos', 'angulo', 'porqueInteressa', 'gancho', 'formato', 'personalidade', 'tecnicas'],
    additionalProperties: false,
  };

  const prompt = `Analise a pauta abaixo para um Short de 40–60 s em português do Brasil.

MATERIAL:
${material}

Devolva:
- fatos: 3 a 6 fatos que o material sustenta (não invente)
- incertos: pontos que precisam de confirmação
- angulo: o ângulo menos óbvio e mais interessante
- porqueInteressa: o que faz essa história merecer um vídeo
- gancho: uma frase de abertura (máx. 18 palavras) que cria curiosidade sem entregar tudo
- formato: "noticia" | "minidocumentario" | "curiosidade" | "investigativa" | "descoberta"
- personalidade: "documentario" | "misterioso" | "impactante" | "explicativo" | "jornalistico"
- tecnicas: 2 a 4 técnicas de retenção adequadas (lacuna de curiosidade, quebra de expectativa, antecipação, recompensas progressivas, identificação pessoal)`;

  const result = await runGeminiJson<{
    fatos: string[];
    incertos: string[];
    angulo: string;
    porqueInteressa: string;
    gancho: string;
    formato: string;
    personalidade: string;
    tecnicas: string[];
  }>({ prompt, schema, temperature: 0.35 });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'Não foi possível analisar a pauta.' };
  }

  return {
    ok: true,
    analysis: {
      fatos: (result.data.fatos ?? []).slice(0, 6),
      incertos: (result.data.incertos ?? []).slice(0, 6),
      angulo: String(result.data.angulo ?? ''),
      porqueInteressa: String(result.data.porqueInteressa ?? ''),
      gancho: String(result.data.gancho ?? ''),
      formato: String(result.data.formato ?? 'noticia'),
      personalidade: String(result.data.personalidade ?? 'jornalistico'),
      tecnicas: (result.data.tecnicas ?? []).slice(0, 4),
    },
  };
}
