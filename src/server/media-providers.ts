import type { MediaAsset } from '../app/models/studio.models';
import { WEB_USER_AGENT } from './http';
import { searchInternetArchiveMedia, searchWikimediaMedia } from './research';

/**
 * Acervos de imagem gratuitos, além de Wikimedia e Internet Archive.
 *
 *  - Openverse: agregador de licenças Creative Commons (sem chave).
 *  - NASA: imagens de domínio público (sem chave).
 *  - Pexels: banco de fotos com licença livre (chave gratuita opcional).
 *
 * Todas devolvem `MediaAsset` com licença e crédito — o manifesto de direitos
 * depende disso. Nenhum provedor derruba os outros: a busca em "todas as fontes"
 * usa `allSettled`.
 */

export type MediaProviderId = 'wikimedia' | 'internet_archive' | 'openverse' | 'nasa' | 'pexels';

export interface MediaSearchResult {
  assets: MediaAsset[];
  error?: string;
}

export interface ProviderInfo {
  id: MediaProviderId;
  label: string;
  /** Precisa de chave configurada? */
  requiresKey: boolean;
  available: boolean;
  supportsVideo: boolean;
}

function orientationOf(width: number, height: number): MediaAsset['orientation'] {
  if (!width || !height) return 'square';
  if (height > width * 1.05) return 'vertical';
  if (width > height * 1.05) return 'horizontal';
  return 'square';
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const nowIso = () => new Date().toISOString();

/** Openverse: CC com uso comercial e modificação permitidos. */
export async function searchOpenverseMedia(query: string, kind: 'image' | 'video' = 'image'): Promise<MediaSearchResult> {
  const url = new URL(kind === 'video' ? 'https://api.openverse.org/v1/videos/' : 'https://api.openverse.org/v1/images/');
  url.searchParams.set('q', query);
  url.searchParams.set('page_size', '20');
  url.searchParams.set('license_type', 'commercial,modification');
  url.searchParams.set('mature', 'false');

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { assets: [], error: `Openverse respondeu HTTP ${res.status}.` };
    }

    const data = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
    };

    const assets: MediaAsset[] = [];
    for (const item of data.results ?? []) {
      const mediaUrl = String(item['url'] ?? '');
      if (!mediaUrl.startsWith('http')) continue;

      const width = Number(item['width']) || 0;
      const height = Number(item['height']) || 0;
      if (kind === 'image' && (width > 0 && width < 400)) continue;

      const license = String(item['license'] ?? '').toLowerCase();
      const version = String(item['license_version'] ?? '');
      const licenseName = license === 'cc0' ? 'CC0 (domínio público)' : `CC ${license.toUpperCase()} ${version}`.trim();
      const creator = stripTags(String(item['creator'] ?? '')) || 'Autor não informado';
      const title = stripTags(String(item['title'] ?? '')) || query;

      assets.push({
        id: `openverse-${String(item['id'] ?? mediaUrl).slice(0, 40)}`,
        provider: 'openverse',
        kind,
        title: title.slice(0, 120),
        pageUrl: String(item['foreign_landing_url'] ?? item['detail_url'] ?? ''),
        mediaUrl,
        thumbUrl: String(item['thumbnail'] ?? mediaUrl),
        description: Array.isArray(item['tags'])
          ? (item['tags'] as Array<Record<string, unknown>>)
              .map((tag) => String(tag['name'] ?? ''))
              .filter(Boolean)
              .join(', ')
              .slice(0, 300)
          : '',
        author: creator.slice(0, 120),
        licenseName,
        licenseUrl: String(item['license_url'] ?? ''),
        attributionText: `${creator.slice(0, 80)} — ${licenseName} via Openverse`,
        capturedAt: nowIso(),
        isIllustrative: true,
        width,
        height,
        orientation: orientationOf(width, height),
      });
    }

    return { assets };
  } catch (err) {
    return { assets: [], error: err instanceof Error ? err.message : 'Erro ao consultar Openverse.' };
  }
}

/** NASA Image and Video Library (domínio público). */
export async function searchNasaMedia(query: string): Promise<MediaSearchResult> {
  const url = new URL('https://images-api.nasa.gov/search');
  url.searchParams.set('q', query);
  url.searchParams.set('media_type', 'image');
  url.searchParams.set('page_size', '20');

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { assets: [], error: `NASA respondeu HTTP ${res.status}.` };
    }

    const data = (await res.json()) as {
      collection?: { items?: Array<Record<string, unknown>> };
    };

    const assets: MediaAsset[] = [];
    for (const item of data.collection?.items ?? []) {
      const data0 = (Array.isArray(item['data']) ? item['data'][0] : null) as Record<string, unknown> | null;
      const links = (Array.isArray(item['links']) ? item['links'] : []) as Array<Record<string, unknown>>;
      const href = String(links[0]?.['href'] ?? '');
      if (!href.startsWith('http')) continue;

      const nasaId = String(data0?.['nasa_id'] ?? '');
      const title = stripTags(String(data0?.['title'] ?? 'NASA')) || 'NASA';

      assets.push({
        id: `nasa-${nasaId || assets.length}`,
        provider: 'nasa',
        kind: 'image',
        title: title.slice(0, 120),
        pageUrl: nasaId ? `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}` : '',
        mediaUrl: href,
        thumbUrl: href,
        description: stripTags(String(data0?.['description'] ?? '')).slice(0, 300),
        author: 'NASA',
        licenseName: 'Domínio público (NASA)',
        licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
        attributionText: 'NASA — domínio público',
        capturedAt: nowIso(),
        isIllustrative: true,
        width: 0,
        height: 0,
        orientation: 'vertical',
      });
    }

    return { assets };
  } catch (err) {
    return { assets: [], error: err instanceof Error ? err.message : 'Erro ao consultar NASA.' };
  }
}

export function pexelsConfigured(): boolean {
  return Boolean(process.env['PEXELS_API_KEY']?.trim());
}

/** Pexels (chave gratuita). Licença permite uso comercial sem atribuição. */
export async function searchPexelsMedia(query: string, kind: 'image' | 'video' = 'image'): Promise<MediaSearchResult> {
  const key = process.env['PEXELS_API_KEY']?.trim();
  if (!key) {
    return { assets: [], error: 'Pexels não configurado: adicione PEXELS_API_KEY no .env.' };
  }

  const url = new URL(kind === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', '20');
  url.searchParams.set('orientation', 'portrait');

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Authorization: key, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { assets: [], error: `Pexels respondeu HTTP ${res.status}.` };
    }

    const data = (await res.json()) as {
      photos?: Array<Record<string, unknown>>;
      videos?: Array<Record<string, unknown>>;
    };

    const assets: MediaAsset[] = [];
    for (const photo of data.photos ?? []) {
      const src = (photo['src'] ?? {}) as Record<string, unknown>;
      const mediaUrl = String(src['original'] ?? src['large2x'] ?? '');
      if (!mediaUrl.startsWith('http')) continue;

      const width = Number(photo['width']) || 0;
      const height = Number(photo['height']) || 0;
      const photographer = stripTags(String(photo['photographer'] ?? '')) || 'Pexels';

      assets.push({
        id: `pexels-${String(photo['id'] ?? mediaUrl)}`,
        provider: 'pexels',
        kind: 'image',
        title: stripTags(String(photo['alt'] ?? '')) || query,
        pageUrl: String(photo['url'] ?? ''),
        mediaUrl,
        thumbUrl: String(src['medium'] ?? mediaUrl),
        description: stripTags(String(photo['alt'] ?? '')),
        author: photographer.slice(0, 120),
        licenseName: 'Pexels License',
        licenseUrl: 'https://www.pexels.com/license/',
        attributionText: `${photographer.slice(0, 80)} — Pexels License`,
        capturedAt: nowIso(),
        isIllustrative: true,
        width,
        height,
        orientation: orientationOf(width, height),
      });
    }

    return { assets };
  } catch (err) {
    return { assets: [], error: err instanceof Error ? err.message : 'Erro ao consultar Pexels.' };
  }
}

/** Situação dos provedores para a interface (e para o `auto`). */
export function mediaProviders(): ProviderInfo[] {
  return [
    { id: 'wikimedia', label: 'Wikimedia Commons', requiresKey: false, available: true, supportsVideo: true },
    { id: 'openverse', label: 'Openverse (CC)', requiresKey: false, available: true, supportsVideo: true },
    { id: 'nasa', label: 'NASA', requiresKey: false, available: true, supportsVideo: false },
    { id: 'internet_archive', label: 'Internet Archive', requiresKey: false, available: true, supportsVideo: true },
    { id: 'pexels', label: 'Pexels', requiresKey: true, available: pexelsConfigured(), supportsVideo: true },
  ];
}

export interface AllMediaResult {
  assets: MediaAsset[];
  errors: Array<{ provider: MediaProviderId; message: string }>;
}

/** Busca em todas as fontes disponíveis, sem deixar uma derrubar as outras. */
export async function searchAllMedia(
  query: string,
  kind: 'image' | 'video' = 'image',
): Promise<AllMediaResult> {
  const jobs: Array<Promise<{ provider: MediaProviderId; result: MediaSearchResult }>> = [
    searchWikimediaMedia(query, kind).then((result) => ({ provider: 'wikimedia' as const, result })),
    searchOpenverseMedia(query, kind).then((result) => ({ provider: 'openverse' as const, result })),
    searchInternetArchiveMedia(query, kind).then((result) => ({ provider: 'internet_archive' as const, result })),
  ];
  if (kind === 'image') {
    jobs.push(searchNasaMedia(query).then((result) => ({ provider: 'nasa' as const, result })));
  }
  if (pexelsConfigured()) {
    jobs.push(searchPexelsMedia(query, kind).then((result) => ({ provider: 'pexels' as const, result })));
  }

  const settled = await Promise.allSettled(jobs);
  const assets: MediaAsset[] = [];
  const errors: Array<{ provider: MediaProviderId; message: string }> = [];
  const seen = new Set<string>();

  for (const entry of settled) {
    if (entry.status === 'rejected') continue;
    const { provider, result } = entry.value;
    if (result.error) errors.push({ provider, message: result.error });

    for (const asset of result.assets) {
      const key = asset.mediaUrl.split('?')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      assets.push(asset);
    }
  }

  return { assets, errors };
}
