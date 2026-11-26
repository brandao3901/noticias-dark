import { youtubeFetch } from './youtube-auth';

/**
 * Leitura do canal: métricas por vídeo (critério 14 da spec) e comentários.
 * Escopos: yt-analytics.readonly (métricas) e youtube.force-ssl (comentários).
 */

const ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';

export interface VideoAnalytics {
  videoId: string;
  views: number;
  averageViewDurationSec: number;
  averageViewPercentage: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  subscribersLost: number;
  estimatedRevenue?: number;
  startDate: string;
  endDate: string;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface AnalyticsReport {
  columnHeaders?: Array<{ name?: string }>;
  rows?: Array<Array<number | string>>;
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}

function rowToNumbers(headers: string[], row: Array<number | string>): Record<string, number> {
  const out: Record<string, number> = {};
  headers.forEach((name, index) => {
    const value = row[index];
    out[name] = typeof value === 'number' ? value : Number(value) || 0;
  });
  return out;
}

/**
 * Métricas do vídeo nos últimos `days` dias. `null` = conta sem acesso/escopo:
 * a interface mostra "sem dados" em vez de erro.
 */
export async function fetchVideoAnalytics(params: {
  videoId: string;
  days?: number;
}): Promise<VideoAnalytics | null> {
  const days = Math.max(1, Math.min(365, Math.round(params.days ?? 90)));
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const metrics = [
    'views',
    'averageViewDuration',
    'averageViewPercentage',
    'likes',
    'comments',
    'shares',
    'subscribersGained',
    'subscribersLost',
  ]
    .concat(process.env['YOUTUBE_MONETARY_SCOPE'] === '1' ? ['estimatedRevenue'] : [])
    .join(',');

  const query = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: isoDay(start),
    endDate: isoDay(end),
    metrics,
    filters: `video==${params.videoId}`,
  });

  try {
    const res = await youtubeFetch(`/reports?${query.toString()}`, {}, ANALYTICS_BASE);
    if (!res.ok) return null;

    const data = (await res.json()) as AnalyticsReport;
    const headers = (data.columnHeaders ?? []).map((h) => h.name ?? '');
    const row = data.rows?.[0];
    if (!row) return null;

    const values = rowToNumbers(headers, row);
    return {
      videoId: params.videoId,
      views: values['views'] ?? 0,
      averageViewDurationSec: Number((values['averageViewDuration'] ?? 0).toFixed(1)),
      averageViewPercentage: Number((values['averageViewPercentage'] ?? 0).toFixed(1)),
      likes: values['likes'] ?? 0,
      comments: values['comments'] ?? 0,
      shares: values['shares'] ?? 0,
      subscribersGained: values['subscribersGained'] ?? 0,
      subscribersLost: values['subscribersLost'] ?? 0,
      estimatedRevenue: values['estimatedRevenue'],
      startDate: isoDay(start),
      endDate: isoDay(end),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comentários
// ---------------------------------------------------------------------------

export interface YoutubeCommentReply {
  id: string;
  author: string;
  text: string;
  publishedAt: string;
}

export interface YoutubeComment {
  id: string;
  author: string;
  text: string;
  publishedAt: string;
  likeCount: number;
  replies: YoutubeCommentReply[];
}

export interface CommentListResult {
  /** false quando o canal desativou comentários no vídeo. */
  enabled: boolean;
  items: YoutubeComment[];
}

interface ThreadSnippet {
  totalReplyCount?: number;
  topLevelComment?: {
    id?: string;
    snippet?: {
      authorDisplayName?: string;
      textDisplay?: string;
      textOriginal?: string;
      publishedAt?: string;
      likeCount?: number;
    };
  };
  replies?: { comments?: Array<{ id?: string; snippet?: { authorDisplayName?: string; textOriginal?: string; textDisplay?: string; publishedAt?: string } }> };
}

export async function listComments(
  videoId: string,
  maxResults = 25,
): Promise<CommentListResult> {
  const query = new URLSearchParams({
    part: 'snippet,replies',
    videoId,
    maxResults: String(Math.max(1, Math.min(100, maxResults))),
    order: 'relevance',
    textFormat: 'plainText',
  });

  try {
    const res = await youtubeFetch(`/commentThreads?${query.toString()}`);
    if (res.status === 403) {
      // commentsDisabled: o vídeo existe, só não aceita comentários.
      const body = (await res.text().catch(() => '')) as string;
      if (/commentsDisabled/i.test(body)) return { enabled: false, items: [] };
      throw new Error('Sem permissão para ler comentários. Reconecte a conta com o escopo youtube.force-ssl.');
    }
    if (!res.ok) throw new Error(`Falha ao ler comentários (HTTP ${res.status}).`);

    const data = (await res.json()) as { items?: ThreadSnippet[] };
    const items: YoutubeComment[] = (data.items ?? []).map((thread) => {
      const top = thread.topLevelComment;
      return {
        id: top?.id ?? '',
        author: top?.snippet?.authorDisplayName ?? 'desconhecido',
        text: top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? '',
        publishedAt: top?.snippet?.publishedAt ?? '',
        likeCount: top?.snippet?.likeCount ?? 0,
        replies: (thread.replies?.comments ?? []).map((reply) => ({
          id: reply.id ?? '',
          author: reply.snippet?.authorDisplayName ?? 'desconhecido',
          text: reply.snippet?.textOriginal ?? reply.snippet?.textDisplay ?? '',
          publishedAt: reply.snippet?.publishedAt ?? '',
        })),
      };
    });

    return { enabled: true, items };
  } catch (err) {
    if (err instanceof Error && /permissão|HTTP/.test(err.message)) throw err;
    return { enabled: true, items: [] };
  }
}

export async function replyToComment(parentId: string, text: string): Promise<{ id: string }> {
  const res = await youtubeFetch('/comments?part=snippet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      snippet: { parentId, textOriginal: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Falha ao responder (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { id?: string };
  return { id: data.id ?? '' };
}

export async function setCommentModeration(
  commentId: string,
  moderationStatus: 'published' | 'heldForReview' | 'rejected',
): Promise<void> {
  const query = new URLSearchParams({
    id: commentId,
    moderationStatus,
  });
  const res = await youtubeFetch(`/comments/setModerationStatus?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(`Falha ao moderar comentário (HTTP ${res.status}).`);
  }
}
