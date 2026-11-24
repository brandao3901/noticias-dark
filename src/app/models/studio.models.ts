export type PipelineStage =
  | 'DISCOVERED'
  | 'SOURCED'
  | 'DRAFTED'
  | 'REVIEWED'
  | 'ASSETS_READY'
  | 'VOICE_READY'
  | 'RENDERED'
  | 'APPROVED'
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
  provider: 'wikimedia' | 'internet_archive' | 'pexels';
  kind: 'image' | 'video';
  title: string;
  pageUrl: string;
  mediaUrl: string;
  thumbUrl: string;
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
  voiceName: string;
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
}
