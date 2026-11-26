export type PipelineStage =
  | 'DISCOVERED'
  | 'SOURCED'
  | 'DRAFTED'
  | 'REVIEWED'
  | 'ASSETS_READY'
  | 'VOICE_READY'
  | 'RENDERED'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'REJECTED';

export type ScriptVersionMode = 'short' | 'expanded';

export type EditorialCategory =
  | 'Todas'
  | 'Brasil'
  | 'Economia'
  | 'Tecnologia'
  | 'Entretenimento'
  | 'Celebridades'
  | 'Esportes';

export interface FeedSourceStatus {
  id: string;
  outlet: string;
  editorial: string;
  feedUrl: string;
  status: 'ok' | 'error';
  itemCount: number;
  errorMessage?: string;
  checkedAt: string;
  /** Feed respondeu, mas o item mais recente é antigo (fonte parada). */
  stale?: boolean;
}

export interface NewsOutletFeedItem {
  id: string;
  title: string;
  url: string;
  outlet: string;
  editorial: string;
  publishedAt: string;
  excerpt: string;
  author?: string;
  /** Ranking de viralidade (0–10+), quando o filtro de virais está ativo. */
  viralScore?: number;
  viralReasons?: string[];
  /** Quantos outros veículos publicaram algo com os mesmos termos. */
  sourceCount?: number;
}

export interface GdeltArticle {
  id: string;
  title: string;
  url: string;
  domain: string;
  seenDate: string;
  language: string;
}

export interface ExtractedSource {
  url: string;
  finalUrl: string;
  domain: string;
  title: string;
  description: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  fetchedAt: string;
  status: 'ok' | 'limited' | 'social_x' | 'blocked' | 'error';
  limitationNote?: string;
  /** Imagem principal da matéria (og:image / twitter:image / JSON-LD). */
  imageUrl?: string;
  imageAlt?: string;
  imageCredit?: string;
}

export interface GeminiUrlContextResult {
  status: 'ok' | 'skipped' | 'unconfigured' | 'quota_paused' | 'error';
  model: string;
  summary: string;
  supportedFacts: string[];
  uncertainties: string[];
  retrievedUrls: string[];
  filteredOutCount: number;
  checkedAt: string;
  message?: string;
}

export interface DossierSourceItem {
  id: string;
  kind: 'primary' | 'gdelt' | 'rss' | 'url_context';
  label: string;
  title: string;
  url: string;
  domain: string;
  publishedAt: string;
  consultedAt: string;
  excerpt: string;
}

export interface DossierEvidence {
  primaryExtraction?: ExtractedSource;
  /** Imagem da própria matéria (foto do fato), quando o veículo publica. */
  articleMedia?: MediaAsset[];
  gdeltStatus: 'idle' | 'ok' | 'error' | 'rate_limited';
  gdeltMessage?: string;
  gdeltArticles: GdeltArticle[];
  rssStatus: 'idle' | 'ok' | 'partial' | 'error';
  rssRespondedCount: number;
  rssTotalCount: number;
  rssMatches: NewsOutletFeedItem[];
  geminiContext?: GeminiUrlContextResult;
  sources: DossierSourceItem[];
  lastResearchedAt?: string;
}

export interface MediaAsset {
  id: string;
  provider: 'wikimedia' | 'internet_archive' | 'pexels' | 'article';
  kind: 'image' | 'video';
  title: string;
  pageUrl: string;
  mediaUrl: string;
  thumbUrl: string;
  /** Descricao/categorias do acervo: melhora muito o casamento com a cena. */
  description?: string;
  author: string;
  licenseName: string;
  licenseUrl: string;
  attributionText: string;
  capturedAt: string;
  isIllustrative: boolean;
  width: number;
  height: number;
  orientation: 'vertical' | 'horizontal' | 'square';
  durationSec?: number;
}

export interface ScriptScene {
  id: string;
  order: number;
  durationSec: number;
  narration: string;
  pronunciationNotes: string;
  visualQueryPt: string;
  visualQueryEn: string;
  avatarMode: 'full' | 'pip' | 'hidden';
  avatarExpression: 'neutral' | 'alert' | 'explaining' | 'closing';
  sourceIds: string[];
  mediaAsset?: MediaAsset | null;
  mediaAssets?: MediaAsset[];
  detectedEntities?: string[];
  ignoredEntities?: string[];
  isDocumentaryMedia: boolean;
}

export interface EditableScript {
  mode: ScriptVersionMode;
  suggestedTitle: string;
  hook: string;
  uncertaintyNote: string;
  closing: string;
  scenes: ScriptScene[];
  modelUsed: string;
  generatedAt: string;
  lastEditedAt: string;
  isDemoScript?: boolean;
  promptNoticeAccepted: boolean;
}

export interface NarrationState {
  mode: 'tts' | 'clipchamp';
  /** Motor de voz: Gemini TTS (padrao) ou Edge neural (reserva). */
  engine?: 'gemini' | 'edge';
  voiceName: string;
  /** Preset de estilo do Gemini TTS (ancora, explicativo, urgente, leve, neutro). */
  style?: string;
  rate: number;
  audioFileName?: string;
  audioDurationSec?: number;
  audioReady: boolean;
}

export interface QcCheckItem {
  id: string;
  label: string;
  severity: 'blocking' | 'warning' | 'pass';
  detail: string;
}

export interface QcReport {
  checkedAt: string;
  hasBlockingErrors: boolean;
  warningCount: number;
  items: QcCheckItem[];
}

export interface EditorialSignals {
  independentSourceCount: number;
  hasRecentCoverage: boolean;
  hasPrimaryText: boolean;
  hasUncertaintyFlag: boolean;
  isSingleSource: boolean;
}

export interface PautaRecord {
  id: string;
  url: string;
  title: string;
  editorial: EditorialCategory;
  stage: PipelineStage;
  isSocialXUrl: boolean;
  createdAt: string;
  updatedAt: string;
  dossier: DossierEvidence;
  script?: EditableScript;
  narration: NarrationState;
  qc?: QcReport;
  approvalNote: string;
  approvedAt?: string;
  /** Último pacote renderizado e arquivado no servidor (spec §4.12). */
  render?: {
    seconds: number;
    videoUrl: string;
    thumbnailUrl?: string | null;
    mode: 'final' | 'preview';
    renderedAt: string;
  };
  /** Publicação no YouTube (e demais plataformas, quando liberadas). */
  youtube?: YoutubePublishState;
  analyticsNotes?: {
    engagedViews?: number;
    avgViewDurationSec?: number;
    avgPercentViewed?: number;
    stayedToWatchPct?: number;
    subscribersGained?: number;
  };
}

export interface ProviderConfigStatus {
  geminiConfigured: boolean;
  geminiQuotaPaused: boolean;
  geminiCooldownUntil?: string;
  activeModel: string;
  /** Tarja de identidade impressa no vídeo (configurável por CHANNEL_LABEL). */
  channelLabel?: string;
}

// ---------------------------------------------------------------------------
// Publicação (YouTube, TikTok, Instagram)
// ---------------------------------------------------------------------------

export type PublishPlatform = 'youtube' | 'tiktok' | 'instagram';

/** Metadados do post: o que vai como título, descrição/legenda e tags. */
export interface PublishMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  titleAlternatives: string[];
  generatedBy: 'gemini' | 'deterministico';
}

export interface YoutubePublishState {
  videoId: string;
  url: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  publishedAt: string;
  scheduledFor?: string;
  thumbnailSet: boolean;
  captionsSet: boolean;
}

export interface TiktokPublishState {
  publishId: string;
  publishedAt: string;
  privacy: string;
  url?: string;
}

export interface InstagramPublishState {
  mediaId: string;
  publishedAt: string;
  permalink?: string;
}

/** Registro do pacote publicado, gravado em `publish.json` dentro da pauta. */
export interface PublishRecord {
  schemaVersion: 'canal-dark-publish/0.1';
  updatedAt: string;
  metadata: PublishMetadata;
  youtube?: YoutubePublishState;
  tiktok?: TiktokPublishState;
  instagram?: InstagramPublishState;
  /** Histórico de capas trocadas manualmente (auxílio A/B do Studio). */
  thumbnailHistory?: Array<{ file: string; setAt: string }>;
  requests?: Array<{ platform: PublishPlatform; at: string; detail: string }>;
}

export interface ScheduleEntry {
  id: string;
  pautaId: string;
  platforms: PublishPlatform[];
  whenIso: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  metadata: PublishMetadata;
  status: 'scheduled' | 'done' | 'cancelled' | 'failed';
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

export interface AutopilotConfig {
  enabled: boolean;
  /** Só publica pauta já aprovada por humano. Desligar não é permitido no MVP. */
  requireApproval: boolean;
  maxPerDay: number;
  platforms: PublishPlatform[];
}
