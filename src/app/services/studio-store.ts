import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import type {
  DossierSourceItem,
  EditableScript,
  EditorialCategory,
  EditorialSignals,
  ExtractedSource,
  FeedSourceStatus,
  GdeltArticle,
  GeminiUrlContextResult,
  MediaAsset,
  NewsOutletFeedItem,
  PautaRecord,
  PipelineStage,
  ProviderConfigStatus,
  QcCheckItem,
  YoutubePublishState,
  QcReport,
  ScriptScene,
  ScriptVersionMode,
} from '../models/studio.models';

const STORAGE_KEY = 'canal_dark_pautas_v1';

export function getSceneMediaList(scene: ScriptScene | null | undefined): MediaAsset[] {
  if (!scene) return [];
  if (Array.isArray(scene.mediaAssets) && scene.mediaAssets.length > 0) {
    return scene.mediaAssets;
  }
  return scene.mediaAsset ? [scene.mediaAsset] : [];
}

export function splitTextIntoSubtitleCues(text: string, maxChars = 42): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return ['Sem texto nesta cena'];
  if (clean.length <= maxChars) return [clean];

  const words = clean.split(' ');
  const cues: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) cues.push(current);
      current = word.length > maxChars ? word.slice(0, maxChars) : word;
    }
  }
  if (current) cues.push(current);

  return cues.length ? cues : [clean.slice(0, maxChars)];
}

const QUICK_ENTITY_STOP_WORDS = new Set([
  'segundo',
  'conforme',
  'após',
  'apos',
  'antes',
  'durante',
  'sobre',
  'entre',
  'contra',
  'depois',
  'porque',
  'nesta',
  'neste',
  'nesse',
  'nessa',
  'desta',
  'deste',
  'fato',
  'fatos',
  'destaque',
  'registro',
  'apuração',
  'apuracao',
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
  'brasil',
  'economia',
  'tecnologia',
  'entretenimento',
  'celebridades',
  'esportes',
  'geral',
  'canal',
  'canal dark',
  'segunda',
  'terça',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
  'sabado',
  'domingo',
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
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'ao',
  'aos',
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

const QUICK_ACRONYM_EXPANSIONS: Record<string, string> = {
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

/** Verbos que abrem manchete e nao sao nome de ninguem ("Morre Andy Taylor"). */
const HEADLINE_VERBS = new Set([
  'morre', 'morreu', 'diz', 'afirma', 'revela', 'revelou', 'confessa', 'confessou',
  'anuncia', 'anunciou', 'nega', 'negou', 'processa', 'detona', 'detonou', 'critica',
  'criticou', 'rebate', 'rebateu', 'responde', 'respondeu', 'assume', 'assumiu',
  'desabafa', 'desabafou', 'flagra', 'flagrou', 'interna', 'internou', 'opera', 'operou',
  'volta', 'voltou', 'deixa', 'deixou', 'ganha', 'ganhou', 'perde', 'perdeu', 'faz', 'fez',
  'mostra', 'mostrou', 'surge', 'surgiu', 'posa', 'posou', 'aparece', 'apareceu',
  'comemora', 'comemorou', 'chora', 'chorou', 'briga', 'brigou', 'recusa', 'recusou',
  'confirma', 'confirmou',
]);

function stripHeadlineVerb(candidate: string): string {
  const words = candidate.split(/\s+/);
  if (words.length < 2) return candidate;
  const first = words[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return HEADLINE_VERBS.has(first) ? words.slice(1).join(' ') : candidate;
}

function extractOrderedNamesFromSingleText(text: string): string[] {
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

  const capWord = '[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõçüA-ZÁÉÍÓÚÂÊÔÃÕÇ0-9-]{1,}';
  const connector = '(?:da|de|do|das|dos|e|van|von|di|del)';
  const multiRe = new RegExp(`\\b(${capWord}(?:\\s+(?:${connector}\\s+)?${capWord}){1,4})\\b`, 'g');
  for (const m of text.matchAll(multiRe)) {
    let candidate = m[1];
    let startPos = m.index ?? 0;
    const endPos = startPos + candidate.length;
    const first = candidate.split(' ')[0]?.toLowerCase() ?? '';
    if (QUICK_ENTITY_STOP_WORDS.has(first)) {
      const firstLen = candidate.split(' ')[0]?.length ?? 0;
      const rest = candidate.slice(firstLen).trimStart();
      if (!rest || QUICK_ENTITY_STOP_WORDS.has(rest.toLowerCase())) continue;
      if (!rest.includes(' ') && rest.length < 4) continue;
      startPos += candidate.length - rest.length;
      candidate = rest;
    }
    const clean = normalizeName(stripHeadlineVerb(candidate));
    if (clean.length < 3 || QUICK_ENTITY_STOP_WORDS.has(clean.toLowerCase())) continue;
    coveredSpans.push({ start: startPos, end: endPos });
    rawHits.push({ pos: startPos, end: endPos, name: clean, isMulti: clean.includes(' ') });
  }

  const acronymRe = /\b([A-Z]{2,6})\b/g;
  for (const m of text.matchAll(acronymRe)) {
    const code = m[1];
    const startPos = m.index ?? 0;
    const endPos = startPos + code.length;
    if (code === 'HTTP' || code === 'HTTPS' || code === 'HTML' || code === 'JSON' || code === 'GDELT') continue;
    if (isCovered(startPos, endPos)) continue;
    if (QUICK_ACRONYM_EXPANSIONS[code]) {
      coveredSpans.push({ start: startPos, end: endPos });
      rawHits.push({ pos: startPos, end: endPos, name: QUICK_ACRONYM_EXPANSIONS[code] });
    } else if (code.length >= 3 && !QUICK_ENTITY_STOP_WORDS.has(code.toLowerCase())) {
      coveredSpans.push({ start: startPos, end: endPos });
      rawHits.push({ pos: startPos, end: endPos, name: code });
    }
  }

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
    if (clean.length < 3 || QUICK_ENTITY_STOP_WORDS.has(singleLower)) continue;
    const alreadyPartOfMulti = rawHits.some(
      (existing) => existing.isMulti && existing.name.toLowerCase().split(/\s+/).includes(singleLower),
    );
    if (alreadyPartOfMulti) continue;
    rawHits.push({ pos: startPos, end: endPos, name: clean });
  }

  rawHits.sort((a, b) => a.pos - b.pos);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of rawHits) {
    const k = hit.name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(hit.name);
    }
  }
  return out;
}

export function extractOrderedEntityNames(narration: string, fallbackTitle = ''): string[] {
  const fromNarration = extractOrderedNamesFromSingleText(narration);
  const fromTitle = extractOrderedNamesFromSingleText(fallbackTitle);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...fromNarration, ...fromTitle]) {
    const k = name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(name);
    }
  }
  return merged.slice(0, 6);
}

const DEMO_SHORT_TEXT_SCENES: Array<{ durationSec: number; narration: string; visualPt: string; visualEn: string; avatarMode: 'full' | 'pip' | 'hidden'; expr: 'neutral' | 'alert' | 'explaining' | 'closing' }> = [
  {
    durationSec: 10,
    narration: 'Este é um roteiro fictício de validação técnica do estúdio Canal Dark, com estimativa próxima de cinquenta segundos em leitura padrão.',
    visualPt: 'estúdio jornalismo escuro',
    visualEn: 'dark news studio microphone',
    avatarMode: 'full',
    expr: 'neutral',
  },
  {
    durationSec: 14,
    narration: 'Na primeira etapa, a pauta reúne o texto extraído do link, resultados recentes do GDELT dos últimos três dias e feeds públicos de veículos brasileiros.',
    visualPt: 'sala de redação jornais',
    visualEn: 'newsroom editorial desk',
    avatarMode: 'pip',
    expr: 'explaining',
  },
  {
    durationSec: 14,
    narration: 'Em seguida, o roteiro só vincula afirmações às fontes listadas no dossiê, e cada imagem ou vídeo passa por checagem de licença antes da montagem vertical.',
    visualPt: 'edição de vídeo linha do tempo',
    visualEn: 'video editing timeline',
    avatarMode: 'pip',
    expr: 'alert',
  },
  {
    durationSec: 14,
    narration: 'Nenhum arquivo é publicado automaticamente: a revisão humana aprova o pacote final após conferir narração, legendas em área segura e manifesto de direitos.',
    visualPt: 'microfone gravação voz',
    visualEn: 'podcast microphone studio',
    avatarMode: 'full',
    expr: 'closing',
  },
];

@Injectable({ providedIn: 'root' })
export class StudioStore {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly configStatus = signal<ProviderConfigStatus>({
    geminiConfigured: false,
    geminiQuotaPaused: false,
    activeModel: 'gemini-3.8-flash',
  });

  readonly geminiDisabledByUser = signal(false);

  readonly pautas = signal<PautaRecord[]>([]);
  readonly activePautaId = signal<string | null>(null);

  readonly feedItems = signal<NewsOutletFeedItem[]>([]);
  readonly feedStatuses = signal<FeedSourceStatus[]>([]);
  readonly feedRespondedCount = signal(0);
  readonly feedTotalCount = signal(0);
  readonly feedNewestAt = signal<string | null>(null);
  /** Janela de atualidade em horas (0 = sem filtro). */
  readonly feedMaxAgeHours = signal(72);
  /** Só notícias com sinal viral (padrão), em vez da lista completa. */
  readonly viralOnly = signal(true);
  readonly viralMinScore = signal(4);
  readonly feedsLoading = signal(false);
  readonly feedsError = signal<string | null>(null);

  readonly researchBusy = signal(false);
  readonly scriptBusy = signal(false);
  readonly mediaBusy = signal(false);
  readonly actionFeedback = signal<{ type: 'info' | 'warn' | 'error'; text: string } | null>(null);

  readonly activePauta = computed<PautaRecord | null>(() => {
    const id = this.activePautaId();
    return this.pautas().find((p) => p.id === id) ?? null;
  });

  readonly activeEditorialSignals = computed<EditorialSignals>(() => {
    const pauta = this.activePauta();
    if (!pauta) {
      return {
        independentSourceCount: 0,
        hasRecentCoverage: false,
        hasPrimaryText: false,
        hasUncertaintyFlag: false,
        isSingleSource: true,
      };
    }
    const domains = new Set(pauta.dossier.sources.map((s) => s.domain).filter(Boolean));
    const independentSourceCount = domains.size;
    return {
      independentSourceCount,
      hasRecentCoverage: pauta.dossier.gdeltArticles.length > 0 || pauta.dossier.rssMatches.length > 0,
      hasPrimaryText: pauta.dossier.primaryExtraction?.status === 'ok',
      hasUncertaintyFlag: Boolean(
        pauta.script?.uncertaintyNote?.trim() ||
          pauta.dossier.geminiContext?.uncertainties?.length ||
          pauta.dossier.primaryExtraction?.limitationNote,
      ),
      isSingleSource: independentSourceCount <= 1,
    };
  });

  constructor() {
    this.loadFromStorage();
    if (this.isBrowser) {
      void this.refreshConfigStatus();
      void this.loadFeeds(false);
      void this.syncFromServer();
    }
  }

  private loadFromStorage(): void {
    if (!this.isBrowser) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PautaRecord[];
        if (Array.isArray(parsed)) {
          this.pautas.set(parsed);
          if (parsed.length > 0 && !this.activePautaId()) {
            this.activePautaId.set(parsed[0].id);
          }
        }
      }
    } catch {
      // Ignore corrupted local storage
    }
  }

  private persist(): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pautas()));
    } catch {
      // Ignore storage quota issues
    }
    this.scheduleServerSync();
  }

  // --- Persistência no servidor (pacote por pauta, spec §4.12) --------------

  private readonly syncedSnapshots = new Map<string, string>();
  private serverSyncTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleServerSync(): void {
    if (!this.isBrowser) return;
    if (this.serverSyncTimer) clearTimeout(this.serverSyncTimer);
    this.serverSyncTimer = setTimeout(() => {
      void this.syncPautasToServer();
    }, 800);
  }

  /** Envia ao servidor só o que mudou desde o último envio bem-sucedido. */
  async syncPautasToServer(): Promise<void> {
    if (!this.isBrowser) return;
    for (const pauta of this.pautas()) {
      const snapshot = JSON.stringify(pauta);
      if (this.syncedSnapshots.get(pauta.id) === snapshot) continue;
      try {
        await firstValueFrom(
          this.http.put<{ ok: boolean }>(`/api/projects/${encodeURIComponent(pauta.id)}`, pauta),
        );
        this.syncedSnapshots.set(pauta.id, snapshot);
      } catch {
        // Servidor indisponível: o localStorage continua sendo o fallback.
        return;
      }
    }
  }

  /** Garante que a pauta esteja no disco antes de operações que dependem dela. */
  async flushProject(id: string): Promise<boolean> {
    if (!this.isBrowser) return false;
    const pauta = this.pautas().find((p) => p.id === id);
    if (!pauta) return false;
    try {
      await firstValueFrom(
        this.http.put<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, pauta),
      );
      this.syncedSnapshots.set(id, JSON.stringify(pauta));
      return true;
    } catch {
      return false;
    }
  }

  /** Recupera pautas que existem no disco e não estão neste navegador. */
  async syncFromServer(): Promise<void> {
    if (!this.isBrowser) return;
    try {
      const list = await firstValueFrom(
        this.http.get<{ projects: Array<{ id: string; updatedAt: string }> }>('/api/projects'),
      );
      const local = new Map(this.pautas().map((p) => [p.id, p]));
      const merged = [...this.pautas()];
      let changed = false;

      for (const item of list.projects ?? []) {
        const localPauta = local.get(item.id);
        if (localPauta && new Date(localPauta.updatedAt).getTime() >= new Date(item.updatedAt).getTime()) {
          continue;
        }
        try {
          const remote = await firstValueFrom(
            this.http.get<PautaRecord>(`/api/projects/${encodeURIComponent(item.id)}`),
          );
          const index = merged.findIndex((p) => p.id === item.id);
          if (index >= 0) merged[index] = remote;
          else merged.push(remote);
          changed = true;
        } catch {
          // Projeto ilegível no disco: ignorado sem derrubar a lista.
        }
      }

      if (changed) {
        this.pautas.set(merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
        if (!this.activePautaId() && merged.length > 0) this.activePautaId.set(merged[0].id);
        this.persist();
      }
    } catch {
      // Sem servidor (build estático, por exemplo): segue só com o localStorage.
    }
  }

  /** Marca a pauta como publicada e guarda o vídeo do YouTube. */
  markPublished(id: string, info: YoutubePublishState | null): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) =>
        p.id === id
          ? {
              ...p,
              stage: info ? 'PUBLISHED' : p.stage,
              updatedAt: nowIso,
              youtube: info ?? p.youtube,
            }
          : p,
      ),
    );
    this.recomputeQc(id);
    this.persist();
  }

  /** Marca a pauta como renderizada e guarda os dados do pacote arquivado. */
  markRendered(
    id: string,
    info: { seconds: number; videoUrl: string; thumbnailUrl?: string | null; mode: 'final' | 'preview' },
  ): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) =>
        p.id === id
          ? {
              ...p,
              stage: 'RENDERED',
              updatedAt: nowIso,
              render: { ...info, renderedAt: nowIso },
            }
          : p,
      ),
    );
    this.recomputeQc(id);
    this.persist();
  }

  clearFeedback(): void {
    this.actionFeedback.set(null);
  }

  async refreshConfigStatus(): Promise<void> {
    try {
      const status = await firstValueFrom(
        this.http.get<ProviderConfigStatus>('/api/config/status'),
      );
      this.configStatus.set(status);
    } catch {
      // Keep default status
    }
  }

  toggleGeminiProvider(): void {
    this.geminiDisabledByUser.update((v) => !v);
  }

  setFeedMaxAge(hours: number): void {
    this.feedMaxAgeHours.set(hours);
    void this.loadFeeds(false);
  }

  setViralOnly(value: boolean): void {
    if (this.viralOnly() === value) return;
    this.viralOnly.set(value);
    void this.loadFeeds(false);
  }

  async loadFeeds(forceRefresh: boolean): Promise<void> {
    this.feedsLoading.set(true);
    this.feedsError.set(null);
    try {
      const res = await firstValueFrom(
        this.http.get<{
          items: NewsOutletFeedItem[];
          statuses: FeedSourceStatus[];
          respondedCount: number;
          totalCount: number;
          newestAt?: string;
        }>(
          `/api/discovery/rss?refresh=${forceRefresh ? '1' : '0'}` +
            `&maxAge=${this.feedMaxAgeHours()}` +
            `&viral=${this.viralOnly() ? '1' : '0'}` +
            `&minViral=${this.viralMinScore()}`,
        ),
      );
      this.feedItems.set(res.items ?? []);
      this.feedStatuses.set(res.statuses ?? []);
      this.feedRespondedCount.set(res.respondedCount ?? 0);
      this.feedTotalCount.set(res.totalCount ?? 0);
      this.feedNewestAt.set(res.newestAt ?? null);
    } catch (err) {
      this.feedsError.set(
        err instanceof Error ? err.message : 'Não foi possível consultar os feeds públicos.',
      );
    } finally {
      this.feedsLoading.set(false);
    }
  }

  private normalizeUrl(raw: string): string {
    try {
      const u = new URL(raw.trim());
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return raw.trim();
    }
  }

  private isXHost(urlStr: string): boolean {
    try {
      const h = new URL(urlStr).hostname.toLowerCase();
      return h === 'x.com' || h.endsWith('.x.com') || h === 'twitter.com' || h.endsWith('.twitter.com') || h === 't.co';
    } catch {
      return false;
    }
  }

  async addPauta(params: {
    url: string;
    title?: string;
    editorial: EditorialCategory;
    researchNow: boolean;
  }): Promise<PautaRecord | null> {
    this.clearFeedback();
    const rawUrl = params.url.trim();
    if (!rawUrl) {
      this.actionFeedback.set({ type: 'error', text: 'Informe uma URL para cadastrar a pauta.' });
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      this.actionFeedback.set({ type: 'error', text: 'URL inválida. Use o formato completo com https://.' });
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.actionFeedback.set({ type: 'error', text: 'Apenas links http:// ou https:// são aceitos.' });
      return null;
    }

    const normalized = this.normalizeUrl(rawUrl);
    const duplicate = this.pautas().find((p) => this.normalizeUrl(p.url) === normalized);
    if (duplicate) {
      this.activePautaId.set(duplicate.id);
      this.actionFeedback.set({
        type: 'warn',
        text: 'Essa URL já existe na fila de pautas; pauta existente selecionada.',
      });
      return duplicate;
    }

    const isSocialXUrl = this.isXHost(normalized);
    const nowIso = new Date().toISOString();
    const fallbackTitle =
      params.title?.trim() ||
      (isSocialXUrl ? 'Pauta a partir de assunto (link do X preservado)' : parsed.hostname.replace(/^www\./, ''));

    const record: PautaRecord = {
      id: `pauta-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      url: normalized,
      title: fallbackTitle,
      editorial: params.editorial,
      stage: 'DISCOVERED',
      isSocialXUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
      dossier: {
        gdeltStatus: 'idle',
        gdeltArticles: [],
        rssStatus: 'idle',
        rssRespondedCount: 0,
        rssTotalCount: 0,
        rssMatches: [],
        sources: [],
      },
      narration: {
        mode: 'tts',
        voiceName: '',
        rate: 1.0,
        audioReady: false,
      },
      approvalNote: '',
    };

    this.pautas.update((list) => [record, ...list]);
    this.activePautaId.set(record.id);
    this.persist();

    if (isSocialXUrl) {
      this.actionFeedback.set({
        type: 'warn',
        text: 'Links do X não são abertos ou raspados. A pauta foi preservada; informe o assunto no título ou adicione um link de matéria pública para ampliar a pesquisa.',
      });
    }

    if (params.researchNow) {
      await this.researchPauta(record.id);
    }

    return this.pautas().find((p) => p.id === record.id) ?? record;
  }

  createDemoPauta(mode: ScriptVersionMode): PautaRecord {
    const nowIso = new Date().toISOString();
    const isExpanded = mode === 'expanded';
    const extraExpandedScenes: typeof DEMO_SHORT_TEXT_SCENES = [
      {
        durationSec: 16,
        narration: 'Na versão monetizável, a cena extra só existe para passar de um minuto com contexto útil, e não para esticar o vídeo.',
        visualPt: 'análise de dados jornalismo',
        visualEn: 'data journalism screen',
        avatarMode: 'pip',
        expr: 'explaining',
      },
    ];
    const sourceDemoScenes = isExpanded
      ? [...DEMO_SHORT_TEXT_SCENES, ...extraExpandedScenes]
      : DEMO_SHORT_TEXT_SCENES;
    const scenes: ScriptScene[] = sourceDemoScenes.map((sc, idx) => ({
      id: `demo-scene-${idx + 1}`,
      order: idx + 1,
      durationSec: sc.durationSec,
      narration: sc.narration,
      pronunciationNotes: 'Canal Dark, GDELT (gê-délt)',
      visualQueryPt: sc.visualPt,
      visualQueryEn: sc.visualEn,
      avatarMode: sc.avatarMode,
      avatarExpression: sc.expr,
      sourceIds: ['SRC-DEMO-1'],
      isDocumentaryMedia: false,
      mediaAsset: null,
    }));

    const demo: PautaRecord = {
      id: `demo-${Date.now()}`,
      url: 'https://canaldark.local/prova-tecnica',
      title: isExpanded
        ? 'Prova Técnica: Roteiro Monetizável (60–75s)'
        : 'Prova Técnica: Roteiro Curto (45–58s)',
      editorial: 'Tecnologia',
      stage: 'DRAFTED',
      isSocialXUrl: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      dossier: {
        gdeltStatus: 'ok',
        gdeltArticles: [],
        rssStatus: 'ok',
        rssRespondedCount: 0,
        rssTotalCount: 0,
        rssMatches: [],
        sources: [
          {
            id: 'SRC-DEMO-1',
            kind: 'primary',
            label: 'Especificação Técnica Canal Dark (Texto Fictício de Teste)',
            title: 'Texto fictício de demonstração técnica — não é notícia real',
            url: 'https://canaldark.local/prova-tecnica',
            domain: 'canaldark.local',
            publishedAt: nowIso,
            consultedAt: nowIso,
            excerpt:
              'Material fictício criado exclusivamente para validar prévia vertical 9:16, voz pt-BR, sincronização labial do avatar e geração de legendas SRT.',
          },
        ],
      },
      script: {
        mode,
        suggestedTitle: isExpanded
          ? 'Validação Técnica Monetizável — Canal Dark'
          : 'Validação Técnica Curta — Canal Dark',
        hook: scenes[0]?.narration ?? '',
        uncertaintyNote: 'Texto fictício de validação técnica; não representa notícia apurada.',
        closing: scenes[scenes.length - 1]?.narration ?? '',
        scenes,
        modelUsed: 'demo-local',
        generatedAt: nowIso,
        lastEditedAt: nowIso,
        isDemoScript: true,
        promptNoticeAccepted: true,
      },
      narration: {
        mode: 'tts',
        voiceName: '',
        rate: 1.0,
        audioReady: true,
      },
      approvalNote: '',
    };

    this.pautas.update((list) => [demo, ...list]);
    this.activePautaId.set(demo.id);
    this.recomputeQc(demo.id);
    this.persist();
    return demo;
  }

  selectPauta(id: string): void {
    this.activePautaId.set(id);
    this.clearFeedback();
  }

  deletePauta(id: string): void {
    this.pautas.update((list) => list.filter((p) => p.id !== id));
    if (this.activePautaId() === id) {
      this.activePautaId.set(this.pautas()[0]?.id ?? null);
    }
    this.syncedSnapshots.delete(id);
    this.persist();
    if (this.isBrowser) {
      firstValueFrom(this.http.delete(`/api/projects/${encodeURIComponent(id)}`)).catch(() => undefined);
    }
  }

  /** Guarda a sugestão do Radar (formato, tom, técnicas e análise). */
  setPautaRadar(id: string, radar: PautaRecord['radar']): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => (p.id === id ? { ...p, radar, updatedAt: nowIso } : p)),
    );
    this.persist();
  }

  updatePautaTitle(id: string, title: string): void {
    this.pautas.update((list) =>
      list.map((p) =>
        p.id === id ? { ...p, title: title.trim() || p.title, updatedAt: new Date().toISOString() } : p,
      ),
    );
    this.persist();
  }

  async researchPauta(id: string, customTopicQuery?: string): Promise<void> {
    const target = this.pautas().find((p) => p.id === id);
    if (!target) return;

    this.researchBusy.set(true);
    this.clearFeedback();

    try {
      // 1. Extrair página de origem (ou detectar link do X sem raspar)
      const extracted = await firstValueFrom(
        this.http.post<ExtractedSource>('/api/research/extract', { url: target.url }),
      );

      const resolvedTitle =
        customTopicQuery?.trim() ||
        (target.isSocialXUrl
          ? target.title
          : extracted.status === 'ok' || (extracted.status === 'limited' && extracted.title)
            ? target.title === new URL(target.url).hostname.replace(/^www\./, '')
              ? extracted.title
              : target.title
            : target.title);

      const searchTopic = customTopicQuery?.trim() || extracted.title || resolvedTitle;
      const gdeltQuery =
        searchTopic && !searchTopic.includes('Link do X') && searchTopic !== 'x.com'
          ? searchTopic.split(/\s+/).slice(0, 7).join(' ')
          : '';

      // 2. Consultar GDELT (sem chave) e RSS públicos em paralelo, de forma independente
      const [gdeltRes, rssRes] = await Promise.all([
        gdeltQuery
          ? firstValueFrom(
              this.http.get<{
                status: 'ok' | 'error' | 'rate_limited';
                articles: GdeltArticle[];
                message?: string;
              }>(`/api/research/gdelt?q=${encodeURIComponent(gdeltQuery)}`),
            ).catch(() => ({
              status: 'error' as const,
              articles: [] as GdeltArticle[],
              message: 'Falha ao consultar GDELT DOC API.',
            }))
          : Promise.resolve({
              status: 'error' as const,
              articles: [] as GdeltArticle[],
              message: 'Informe o tema da pauta para consultar cobertura recente no GDELT.',
            }),
        firstValueFrom(
          this.http.get<{
            items: NewsOutletFeedItem[];
            respondedCount: number;
            totalCount: number;
          }>(`/api/discovery/rss?q=${encodeURIComponent(gdeltQuery || resolvedTitle)}`),
        ).catch(() => ({
          items: [] as NewsOutletFeedItem[],
          respondedCount: 0,
          totalCount: 0,
        })),
      ]);

      const consultedAt = new Date().toISOString();
      const sources: DossierSourceItem[] = [];
      let srcCounter = 1;

      if (!target.isSocialXUrl && (extracted.status === 'ok' || extracted.status === 'limited')) {
        sources.push({
          id: `SRC-${srcCounter++}`,
          kind: 'primary',
          label: `Fonte Primária (${extracted.domain})`,
          title: extracted.title || resolvedTitle,
          url: extracted.finalUrl || target.url,
          domain: extracted.domain,
          publishedAt: extracted.publishedAt || consultedAt,
          consultedAt,
          excerpt: extracted.excerpt || extracted.description || extracted.limitationNote || '',
        });
      }

      for (const art of gdeltRes.articles.slice(0, 6)) {
        sources.push({
          id: `SRC-${srcCounter++}`,
          kind: 'gdelt',
          label: `GDELT (${art.domain})`,
          title: art.title,
          url: art.url,
          domain: art.domain,
          publishedAt: art.seenDate,
          consultedAt,
          excerpt: `Matéria localizada via GDELT DOC API em ${art.domain}.`,
        });
      }

      for (const item of rssRes.items.slice(0, 5)) {
        if (sources.some((s) => this.normalizeUrl(s.url) === this.normalizeUrl(item.url))) continue;
        sources.push({
          id: `SRC-${srcCounter++}`,
          kind: 'rss',
          label: `RSS (${item.outlet})`,
          title: item.title,
          url: item.url,
          domain: (() => {
            try {
              return new URL(item.url).hostname.replace(/^www\./, '');
            } catch {
              return item.outlet;
            }
          })(),
          publishedAt: item.publishedAt,
          consultedAt,
          excerpt: item.excerpt || item.title,
        });
      }

      // 3. Síntese complementar via Gemini URL Context (se habilitado e chave presente)
      let geminiContext: GeminiUrlContextResult | undefined;
      if (!this.geminiDisabledByUser()) {
        const candidateUrls = sources.map((s) => s.url).slice(0, 12);
        if (candidateUrls.length > 0) {
          geminiContext = await firstValueFrom(
            this.http.post<GeminiUrlContextResult>('/api/gemini/url-context', {
              topic: gdeltQuery || resolvedTitle,
              urls: candidateUrls,
            }),
          ).catch(() => undefined);
          await this.refreshConfigStatus();
        }
      }

      const nextStage: PipelineStage =
        sources.length > 0 && target.stage === 'DISCOVERED' ? 'SOURCED' : target.stage;

      // Foto publicada pelo veículo: é a imagem real do fato. Fica registrada
      // como ativo com crédito e link da matéria, mas com direitos reservados.
      const articleMedia: MediaAsset[] = [];
      if (!target.isSocialXUrl && extracted.imageUrl) {
        const credit = extracted.imageCredit || extracted.domain || 'veículo';
        articleMedia.push({
          id: `article-${id}-1`,
          provider: 'article',
          kind: 'image',
          title: extracted.imageAlt || extracted.title || 'Imagem publicada na matéria',
          pageUrl: extracted.finalUrl || target.url,
          mediaUrl: extracted.imageUrl,
          thumbUrl: extracted.imageUrl,
          description: extracted.imageAlt || extracted.description,
          author: credit,
          licenseName: '© veículo (uso editorial a confirmar)',
          licenseUrl: extracted.finalUrl || target.url,
          attributionText: `${credit} — imagem publicada na matéria`,
          capturedAt: consultedAt,
          isIllustrative: false,
          width: 0,
          height: 0,
          orientation: 'horizontal',
        });
      }

      this.pautas.update((list) =>
        list.map((p) =>
          p.id === id
            ? {
                ...p,
                title: resolvedTitle || p.title,
                stage: nextStage,
                updatedAt: consultedAt,
                dossier: {
                  primaryExtraction: extracted,
                  articleMedia,
                  gdeltStatus: gdeltRes.status,
                  gdeltMessage: gdeltRes.message,
                  gdeltArticles: gdeltRes.articles,
                  rssStatus:
                    rssRes.totalCount === 0
                      ? 'error'
                      : rssRes.respondedCount < rssRes.totalCount
                        ? 'partial'
                        : 'ok',
                  rssRespondedCount: rssRes.respondedCount,
                  rssTotalCount: rssRes.totalCount,
                  rssMatches: rssRes.items,
                  geminiContext,
                  sources,
                  lastResearchedAt: consultedAt,
                },
              }
            : p,
        ),
      );
      this.recomputeQc(id);
      this.persist();
    } finally {
      this.researchBusy.set(false);
    }
  }

  async generateScriptWithGemini(id: string, mode: ScriptVersionMode): Promise<void> {
    const target = this.pautas().find((p) => p.id === id);
    if (!target) return;

    if (this.geminiDisabledByUser()) {
      this.actionFeedback.set({
        type: 'warn',
        text: 'O provedor Gemini está desativado manualmente no momento. Reative-o ou crie/edite cenas manualmente.',
      });
      return;
    }

    if (!target.dossier.sources.length) {
      this.actionFeedback.set({
        type: 'warn',
        text: 'Pesquise a pauta para reunir fontes verificáveis no dossiê antes de gerar o roteiro.',
      });
      return;
    }

    this.scriptBusy.set(true);
    this.clearFeedback();

    try {
      const res = await firstValueFrom(
        this.http.post<{
          status: 'ok' | 'unconfigured' | 'quota_paused' | 'error';
          script?: EditableScript;
          message?: string;
        }>('/api/gemini/script', {
          title: target.title,
          editorial: target.editorial,
          mode,
          sources: target.dossier.sources,
          geminiContextSummary: target.dossier.geminiContext?.summary,
        }),
      );

      await this.refreshConfigStatus();

      if (res.status !== 'ok' || !res.script) {
        this.actionFeedback.set({
          type: res.status === 'quota_paused' ? 'warn' : 'error',
          text: res.message ?? 'Não foi possível gerar o roteiro via Gemini.',
        });
        return;
      }

      const hydratedScript: EditableScript = {
        ...res.script,
        scenes: res.script.scenes.map((sc) => ({
          ...sc,
          detectedEntities:
            sc.detectedEntities?.length
              ? sc.detectedEntities
              : extractOrderedEntityNames(sc.narration, target.title),
        })),
      };

      const nextStage: PipelineStage =
        target.stage === 'DISCOVERED' || target.stage === 'SOURCED' ? 'DRAFTED' : target.stage;

      this.pautas.update((list) =>
        list.map((p) =>
          p.id === id
            ? {
                ...p,
                stage: nextStage,
                updatedAt: new Date().toISOString(),
                script: hydratedScript,
              }
            : p,
        ),
      );
      this.recomputeQc(id);
      this.persist();
    } catch (err) {
      this.actionFeedback.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Erro ao comunicar com o endpoint de roteiro.',
      });
    } finally {
      this.scriptBusy.set(false);
    }
  }

  createBlankManualScript(id: string, mode: ScriptVersionMode): void {
    const target = this.pautas().find((p) => p.id === id);
    if (!target) return;
    const nowIso = new Date().toISOString();
    const defaultSrc = target.dossier.sources[0]?.id ? [target.dossier.sources[0].id] : [];
    const script: EditableScript = {
      mode,
      suggestedTitle: target.title,
      hook: '',
      uncertaintyNote: target.dossier.sources.length <= 1 ? 'Baseado em fonte única até o momento; revisar antes de aprovar.' : '',
      closing: '',
      modelUsed: 'edicao-manual',
      generatedAt: nowIso,
      lastEditedAt: nowIso,
      promptNoticeAccepted: true,
      scenes: [
        {
          id: 'scene-1',
          order: 1,
          durationSec: 7,
          narration: '',
          pronunciationNotes: '',
          visualQueryPt: target.title.split(/\s+/).slice(0, 4).join(' '),
          visualQueryEn: 'breaking news studio',
          avatarMode: 'full',
          avatarExpression: 'neutral',
          sourceIds: defaultSrc,
          isDocumentaryMedia: false,
        },
      ],
    };

    this.pautas.update((list) =>
      list.map((p) =>
        p.id === id
          ? {
              ...p,
              stage: p.stage === 'DISCOVERED' || p.stage === 'SOURCED' ? 'DRAFTED' : p.stage,
              updatedAt: nowIso,
              script,
            }
          : p,
      ),
    );
    this.recomputeQc(id);
    this.persist();
  }

  buildDraftFromDossier(id: string, mode: ScriptVersionMode): void {
    const target = this.pautas().find((p) => p.id === id);
    if (!target) return;

    if (!target.dossier.sources.length) {
      this.actionFeedback.set({
        type: 'warn',
        text: 'Pesquise a pauta no dossiê antes de montar o rascunho automático, ou crie um roteiro em branco.',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const sources = target.dossier.sources;
    const primary = sources[0];
    const maxBodySources = mode === 'short' ? 3 : 6;
    const bodySources = sources.slice(0, maxBodySources);
    const shortWords = target.title.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    const queryPt = shortWords || target.editorial;
    const queryEn = `${target.editorial} news archive`;

    const scenes: ScriptScene[] = [
      {
        id: 'scene-1',
        order: 1,
        durationSec: 7,
        narration: `Fato em destaque em ${target.editorial}: ${target.title}.`,
        pronunciationNotes: '',
        visualQueryPt: queryPt,
        visualQueryEn: queryEn,
        avatarMode: 'full',
        avatarExpression: 'alert',
        sourceIds: primary ? [primary.id] : [],
        isDocumentaryMedia: false,
      },
    ];

    bodySources.forEach((src, index) => {
      const cleanExcerpt = (src.excerpt || src.title || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, mode === 'short' ? 130 : 170);
      scenes.push({
        id: `scene-${index + 2}`,
        order: index + 2,
        durationSec: mode === 'short' ? 9 : 12,
        narration: cleanExcerpt
          ? `Segundo ${src.domain}: ${cleanExcerpt}${cleanExcerpt.endsWith('.') ? '' : '.'}`
          : `Registro de ${src.domain}: ${src.title}.`,
        pronunciationNotes: '',
        visualQueryPt: queryPt,
        visualQueryEn: queryEn,
        avatarMode: index % 2 === 0 ? 'pip' : 'hidden',
        avatarExpression: 'explaining',
        sourceIds: [src.id],
        isDocumentaryMedia: false,
      });
    });

    const distinctDomains = new Set(sources.map((s) => s.domain)).size;
    const uncertaintyText =
      distinctDomains <= 1
        ? 'Até o momento há apenas uma fonte registrada neste dossiê; confirmar desdobramentos antes da aprovação.'
        : `Apuração baseada em ${distinctDomains} domínios independentes consultados no dossiê; revisar datas e atribuições antes de aprovar.`;

    scenes.push({
      id: `scene-${scenes.length + 1}`,
      order: scenes.length + 1,
      durationSec: 8,
      narration: `${uncertaintyText} Confira os links originais na descrição para acompanhar atualizações.`,
      pronunciationNotes: '',
      visualQueryPt: `${target.editorial} estúdio`,
      visualQueryEn: 'editorial studio desk',
      avatarMode: 'full',
      avatarExpression: 'closing',
      sourceIds: bodySources.map((s) => s.id),
      isDocumentaryMedia: false,
    });

    const enrichedScenes = scenes.map((sc) => {
      const entities = extractOrderedEntityNames(sc.narration, target.title);
      return {
        ...sc,
        detectedEntities: entities,
        visualQueryPt: entities.length ? entities.slice(0, 3).join(', ') : sc.visualQueryPt,
      };
    });

    const script: EditableScript = {
      mode,
      suggestedTitle: target.title,
      hook: enrichedScenes[0]?.narration ?? target.title,
      uncertaintyNote: uncertaintyText,
      closing: enrichedScenes[enrichedScenes.length - 1]?.narration ?? '',
      modelUsed: 'rascunho-dossie-local',
      generatedAt: nowIso,
      lastEditedAt: nowIso,
      promptNoticeAccepted: true,
      scenes: enrichedScenes,
    };

    this.pautas.update((list) =>
      list.map((p) =>
        p.id === id
          ? {
              ...p,
              stage: p.stage === 'DISCOVERED' || p.stage === 'SOURCED' ? 'DRAFTED' : p.stage,
              updatedAt: nowIso,
              script,
            }
          : p,
      ),
    );
    this.recomputeQc(id);
    this.persist();
    this.actionFeedback.set({
      type: 'info',
      text: `Rascunho estruturado com ${scenes.length} cenas a partir de ${sources.length} fonte(s) do dossiê. Revise e ajuste a narração antes de avançar.`,
    });
  }

  updateScript(id: string, updater: (script: EditableScript) => EditableScript): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== id || !p.script) return p;
        const updatedScript = { ...updater(p.script), lastEditedAt: nowIso };
        return {
          ...p,
          updatedAt: nowIso,
          script: updatedScript,
        };
      }),
    );
    this.recomputeQc(id);
    this.persist();
  }

  assignSceneMedia(pautaId: string, sceneId: string, asset: MediaAsset | null, isDocumentary: boolean): void {
    if (!asset) {
      this.clearAllSceneMedia(pautaId, sceneId);
      return;
    }
    this.addSceneMedia(pautaId, sceneId, asset, isDocumentary);
  }

  addSceneMedia(pautaId: string, sceneId: string, asset: MediaAsset, isDocumentary?: boolean): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const existing = getSceneMediaList(sc);
          if (existing.some((a) => a.id === asset.id)) {
            return {
              ...sc,
              mediaAssets: existing,
              mediaAsset: existing[0] ?? null,
              isDocumentaryMedia: isDocumentary ?? sc.isDocumentaryMedia,
            };
          }
          const updated = [...existing, asset];
          return {
            ...sc,
            mediaAssets: updated,
            mediaAsset: updated[0] ?? null,
            isDocumentaryMedia: isDocumentary ?? sc.isDocumentaryMedia,
          };
        });
        const allHaveValidMedia = scenes.every((sc) => {
          const assets = getSceneMediaList(sc);
          return assets.length > 0 && assets.every((a) => Boolean(a.licenseName));
        });
        const nextStage: PipelineStage =
          allHaveValidMedia && (p.stage === 'DRAFTED' || p.stage === 'REVIEWED')
            ? 'ASSETS_READY'
            : p.stage;
        return {
          ...p,
          stage: nextStage,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.recomputeQc(pautaId);
    this.persist();
  }

  removeSceneMediaAsset(pautaId: string, sceneId: string, assetId: string): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const updated = getSceneMediaList(sc).filter((a) => a.id !== assetId);
          return {
            ...sc,
            mediaAssets: updated,
            mediaAsset: updated[0] ?? null,
          };
        });
        return {
          ...p,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.recomputeQc(pautaId);
    this.persist();
  }

  moveSceneMediaAsset(pautaId: string, sceneId: string, assetId: string, delta: -1 | 1): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const listAssets = [...getSceneMediaList(sc)];
          const idx = listAssets.findIndex((a) => a.id === assetId);
          const targetIdx = idx + delta;
          if (idx < 0 || targetIdx < 0 || targetIdx >= listAssets.length) return sc;
          const [moved] = listAssets.splice(idx, 1);
          listAssets.splice(targetIdx, 0, moved);
          return {
            ...sc,
            mediaAssets: listAssets,
            mediaAsset: listAssets[0] ?? null,
          };
        });
        return {
          ...p,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.persist();
  }

  clearAllSceneMedia(pautaId: string, sceneId: string): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) =>
          sc.id === sceneId ? { ...sc, mediaAssets: [], mediaAsset: null, isDocumentaryMedia: false } : sc,
        );
        return {
          ...p,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.recomputeQc(pautaId);
    this.persist();
  }

  toggleSceneDocumentary(pautaId: string, sceneId: string): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) =>
          sc.id === sceneId ? { ...sc, isDocumentaryMedia: !sc.isDocumentaryMedia } : sc,
        );
        return {
          ...p,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.persist();
  }

  removeSceneDetectedEntity(pautaId: string, sceneId: string, entity: string): void {
    const nowIso = new Date().toISOString();
    const targetLower = entity.trim().toLowerCase();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId || !p.script) return p;
        const scenes = p.script.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const remaining = (sc.detectedEntities ?? []).filter(
            (e) => e.trim().toLowerCase() !== targetLower,
          );
          const existingIgnored = sc.ignoredEntities ?? [];
          const nextIgnored = existingIgnored.some((e) => e.trim().toLowerCase() === targetLower)
            ? existingIgnored
            : [...existingIgnored, entity];
          return {
            ...sc,
            detectedEntities: remaining,
            ignoredEntities: nextIgnored,
          };
        });
        return {
          ...p,
          updatedAt: nowIso,
          script: { ...p.script, scenes, lastEditedAt: nowIso },
        };
      }),
    );
    this.persist();
  }

  /**
   * Refaz a mídia de TODAS as cenas de uma vez: descarta o que estava vinculado
   * e busca de novo com os critérios atuais. Útil quando as regras de coerência
   * mudam (ou quando a pauta foi montada com imagens erradas).
   */
  async refillAllScenesMedia(
    pautaId: string,
    options: { maxPerScene: number; kindPreference: 'both' | 'image' | 'video' },
  ): Promise<void> {
    const target = this.pautas().find((p) => p.id === pautaId);
    if (!target?.script?.scenes?.length) return;

    this.clearFeedback();
    await this.autoFillMediaFromNames(pautaId, {
      maxPerScene: options.maxPerScene,
      kindPreference: options.kindPreference,
      replaceExisting: true,
    });

    const updated = this.pautas().find((p) => p.id === pautaId);
    const total = (updated?.script?.scenes ?? []).reduce(
      (acc, scene) => acc + getSceneMediaList(scene).length,
      0,
    );
    const empty = (updated?.script?.scenes ?? []).filter(
      (scene) => getSceneMediaList(scene).length === 0,
    ).length;

    this.actionFeedback.set({
      type: empty > 0 ? 'warn' : 'info',
      text:
        `Mídia refeita: ${total} ativo(s) em ${updated?.script?.scenes?.length ?? 0} cena(s)` +
        (empty > 0
          ? `. ${empty} cena(s) ficaram sem imagem coerente e usam o cenário do estúdio.`
          : '.'),
    });
  }

  async autoFillMediaFromNames(
    pautaId: string,
    options: {
      sceneId?: string;
      maxPerScene: number;
      kindPreference: 'both' | 'image' | 'video';
      replaceExisting?: boolean;
    },
  ): Promise<void> {
    const target = this.pautas().find((p) => p.id === pautaId);
    if (!target?.script?.scenes?.length) return;

    const targetScenes = options.sceneId
      ? target.script.scenes.filter((s) => s.id === options.sceneId)
      : target.script.scenes;

    if (!targetScenes.length) return;

    this.mediaBusy.set(true);
    this.clearFeedback();

    try {
      const response = await firstValueFrom(
        this.http.post<{
          results: Array<{
            sceneId: string;
            detectedNames: string[];
            queriesUsed: string[];
            assets: MediaAsset[];
          }>;
        }>('/api/media/auto-fill', {
          pautaTitle: target.title,
          editorial: target.editorial,
          kindPreference: options.kindPreference,
          maxPerScene: options.maxPerScene,
          // A foto da matéria tem prioridade sobre qualquer acervo.
          articleAssets: target.dossier.articleMedia ?? [],
          scenes: targetScenes.map((s) => ({
            id: s.id,
            narration: s.narration,
            visualQueryPt: s.visualQueryPt,
            visualQueryEn: s.visualQueryEn,
            ignoredEntities: s.ignoredEntities ?? [],
          })),
        }),
      );

      const bySceneId = new Map(response.results.map((r) => [r.sceneId, r]));
      const nowIso = new Date().toISOString();
      let addedCount = 0;
      const detectedSet = new Set<string>();

      this.pautas.update((list) =>
        list.map((p) => {
          if (p.id !== pautaId || !p.script) return p;
          const scenes = p.script.scenes.map((sc) => {
            const match = bySceneId.get(sc.id);
            if (!match) return sc;
            match.detectedNames.forEach((n) => detectedSet.add(n));
            const base = options.replaceExisting ? [] : getSceneMediaList(sc);
            const merged = [...base];
            for (const asset of match.assets) {
              if (!merged.some((a) => a.id === asset.id)) {
                merged.push(asset);
                addedCount++;
              }
            }
            return {
              ...sc,
              detectedEntities: match.detectedNames,
              mediaAssets: merged,
              mediaAsset: merged[0] ?? null,
            };
          });
          const allHaveValidMedia = scenes.every((sc) => {
            const assets = getSceneMediaList(sc);
            return assets.length > 0 && assets.every((a) => Boolean(a.licenseName));
          });
          const nextStage: PipelineStage =
            allHaveValidMedia && (p.stage === 'DRAFTED' || p.stage === 'REVIEWED')
              ? 'ASSETS_READY'
              : p.stage;

          return {
            ...p,
            stage: nextStage,
            updatedAt: nowIso,
            script: { ...p.script, scenes, lastEditedAt: nowIso },
          };
        }),
      );

      this.recomputeQc(pautaId);
      this.persist();

      this.actionFeedback.set({
        type: addedCount > 0 ? 'info' : 'warn',
        text:
          addedCount > 0
            ? `Busca por nomes citados (${Array.from(detectedSet).slice(0, 4).join(', ') || 'tema da pauta'}): ${addedCount} mídia(s) licenciada(s) adicionada(s) automaticamente.`
            : 'Nenhuma mídia adicional compatível encontrada para os nomes detectados.',
      });
    } catch (err) {
      this.actionFeedback.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Erro ao buscar mídias por nomes citados.',
      });
    } finally {
      this.mediaBusy.set(false);
    }
  }

  updateNarrationState(pautaId: string, patch: Partial<PautaRecord['narration']>): void {
    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) => {
        if (p.id !== pautaId) return p;
        const narration = { ...p.narration, ...patch };
        const nextStage: PipelineStage =
          narration.audioReady && (p.stage === 'ASSETS_READY' || p.stage === 'DRAFTED')
            ? 'VOICE_READY'
            : p.stage;
        return {
          ...p,
          stage: nextStage,
          updatedAt: nowIso,
          narration,
        };
      }),
    );
    this.recomputeQc(pautaId);
    this.persist();
  }

  async searchMedia(
    query: string,
    provider: 'wikimedia' | 'internet_archive',
    kind: 'image' | 'video' = 'image',
  ): Promise<{ assets: MediaAsset[]; configured: boolean; error?: string }> {
    this.mediaBusy.set(true);
    try {
      return await firstValueFrom(
        this.http.get<{ assets: MediaAsset[]; configured: boolean; error?: string }>(
          `/api/media/search?q=${encodeURIComponent(query)}&provider=${provider}&kind=${kind}`,
        ),
      );
    } catch (err) {
      return {
        assets: [],
        configured: true,
        error: err instanceof Error ? err.message : 'Erro ao buscar acervos.',
      };
    } finally {
      this.mediaBusy.set(false);
    }
  }

  recomputeQc(pautaId: string): QcReport | null {
    const pauta = this.pautas().find((p) => p.id === pautaId);
    if (!pauta) return null;

    const items: QcCheckItem[] = [];
    const script = pauta.script;
    const scenes = script?.scenes ?? [];
    const totalWords = scenes
      .map((s) => s.narration.trim())
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    const estSeconds = Math.round((totalWords / 130) * 60);

    // 1. Fontes no dossiê
    if (pauta.dossier.sources.length === 0) {
      items.push({
        id: 'qc-sources',
        label: 'Dossiê de fontes verificáveis',
        severity: 'blocking',
        detail: 'Nenhuma fonte consultada no dossiê. Realize a pesquisa antes de aprovar.',
      });
    } else {
      const domains = new Set(pauta.dossier.sources.map((s) => s.domain));
      items.push({
        id: 'qc-sources',
        label: 'Dossiê de fontes verificáveis',
        severity: domains.size >= 2 || script?.isDemoScript ? 'pass' : 'warning',
        detail:
          domains.size >= 2
            ? `${pauta.dossier.sources.length} registros em ${domains.size} domínios independentes.`
            : 'Apenas 1 fonte independente encontrada. Prefira corroborar com uma segunda fonte.',
      });
    }

    // 2. Roteiro e vínculo de afirmações
    if (!script || scenes.length === 0) {
      items.push({
        id: 'qc-script',
        label: 'Roteiro estruturado por cenas',
        severity: 'blocking',
        detail: 'Gere ou redija pelo menos uma cena com narração em português.',
      });
    } else {
      const unlinked = scenes.filter((s) => s.sourceIds.length === 0 || !s.narration.trim());
      if (unlinked.length > 0) {
        items.push({
          id: 'qc-script-links',
          label: 'Vínculo de afirmações às fontes',
          severity: 'blocking',
          detail: `${unlinked.length} cena(s) sem narração ou sem ID de fonte vinculado.`,
        });
      } else {
        items.push({
          id: 'qc-script-links',
          label: 'Vínculo de afirmações às fontes',
          severity: 'pass',
          detail: `Todas as ${scenes.length} cenas possuem texto e referência ao dossiê.`,
        });
      }
    }

    // 3. Direitos de mídia por cena (RF-08)
    if (scenes.length > 0) {
      const missingMedia = scenes.filter((s) => getSceneMediaList(s).length === 0);
      const invalidLicense = scenes.filter((s) =>
        getSceneMediaList(s).some((a) => !a.licenseName),
      );
      const totalAssets = scenes.reduce((acc, s) => acc + getSceneMediaList(s).length, 0);
      if (invalidLicense.length > 0) {
        items.push({
          id: 'qc-media-rights',
          label: 'Ficha de direitos e licenças',
          severity: 'blocking',
          detail: `${invalidLicense.length} cena(s) com ativo sem licença identificável (bloqueado pela política de direitos).`,
        });
      } else if (missingMedia.length > 0) {
        items.push({
          id: 'qc-media-rights',
          label: 'Cobertura visual das cenas',
          severity: 'warning',
          detail: `${missingMedia.length} cena(s) ainda sem imagem/vídeo licenciado atribuído (${totalAssets} ativos vinculados no restante).`,
        });
      } else {
        items.push({
          id: 'qc-media-rights',
          label: 'Ficha de direitos e licenças',
          severity: 'pass',
          detail: `Todas as ${scenes.length} cenas cobertas (${totalAssets} ativos licenciados com origem e autor registrados).`,
        });
      }
    }

    // 3b. Foto publicada pelo veículo: é a imagem real do fato, mas os direitos
    // ficam com quem publicou. O crédito está no manifesto; a decisão é humana.
    const articleAssets = scenes
      .flatMap((scene) => getSceneMediaList(scene))
      .filter((asset) => asset.provider === 'article');
    if (articleAssets.length > 0) {
      items.push({
        id: 'qc-article-media',
        label: 'Foto da matéria (direito do veículo)',
        severity: 'warning',
        detail: `${articleAssets.length} cena(s) usam imagem publicada pelo veículo. Crédito e link da matéria estão no manifesto, mas o direito de uso é do veículo: confirme antes de publicar.`,
      });
    }

    // 4. Narração pt-BR
    items.push({
      id: 'qc-voice',
      label: 'Narração pt-BR pronta',
      severity: pauta.narration.audioReady ? 'pass' : 'warning',
      detail: pauta.narration.audioReady
        ? pauta.narration.mode === 'clipchamp'
          ? `Áudio Clipchamp importado (${pauta.narration.audioFileName ?? 'local'}).`
          : `Narração ${pauta.narration.engine === 'edge' ? 'Edge neural' : 'Gemini TTS'} · voz ${
              pauta.narration.voiceName || 'padrão'
            }${pauta.narration.style && pauta.narration.engine !== 'edge' ? ` · estilo ${pauta.narration.style}` : ''}.`
        : 'Gere a amostra de voz e confirme a narração pt-BR (Gemini TTS) antes de renderizar.',
    });

    // Ritmo: as métricas do canal mostram que 70 s derruba a retenção. O alvo
    // é o modo rápido (~42 s), com fechamento em pergunta para gerar comentário.
    {
      const scriptScenes = pauta.script?.scenes ?? [];
      const words = scriptScenes.reduce(
        (acc, scene) => acc + (scene.narration ?? '').split(/\s+/).filter(Boolean).length,
        0,
      );
      const scriptMode = pauta.script?.mode ?? 'rapido';
      const targetSec = scriptMode === 'expanded' ? 62 : scriptMode === 'rapido' ? 42 : 50;
      const estimatedSec = words / 2.5;
      const closingIsQuestion = /\?/.test(pauta.script?.closing ?? '');
      const withinTarget = estimatedSec >= targetSec - 8 && estimatedSec <= targetSec + 10;

      items.push({
        id: 'qc-pacing',
        label: 'Ritmo, gancho e fechamento',
        severity: withinTarget && closingIsQuestion ? 'pass' : 'warning',
        detail:
          `${words} palavras ≈ ${estimatedSec.toFixed(0)} s (alvo ${targetSec} s). ` +
          (withinTarget
            ? 'Duração no ponto. '
            : estimatedSec > targetSec
              ? 'Está longo: corte contexto, fique no fato e no desfecho. '
              : 'Está curto: falta o desfecho ou a consequência. ') +
          (closingIsQuestion
            ? 'Fechamento com pergunta ✓'
            : 'Termine o roteiro com uma pergunta ao público (gera comentário).'),
      });
    }

    // 5. Política de duração: o menor vídeo que ainda monetiza (Critério 15).
    // Abaixo de 1 minuto fica fora do compartilhamento de receita do feed de
    // Shorts; acima de 3 minutos deixa de ser Short.
    const MONETIZATION_FLOOR_SEC = 60;
    const SHORTS_CEILING_SEC = 180;
    if (estSeconds > 0 && estSeconds < MONETIZATION_FLOOR_SEC) {
      items.push({
        id: 'qc-duration-floor',
        label: 'Abaixo da faixa de monetização',
        severity: 'warning',
        detail: `Estimativa de ${estSeconds}s (${totalWords} palavras). Abaixo de 1 minuto o Short fica fora do compartilhamento de receita do feed; acrescente 1–2 cenas curtas.`,
      });
    } else if (estSeconds > SHORTS_CEILING_SEC) {
      items.push({
        id: 'qc-duration-ceiling',
        label: 'Acima do limite de Short',
        severity: 'warning',
        detail: `Estimativa de ${estSeconds}s. Passando de 3 minutos o vídeo deixa de ser Short e sai do feed.`,
      });
    } else if (estSeconds > 0) {
      items.push({
        id: 'qc-duration',
        label: 'Duração na faixa monetizável',
        severity: 'pass',
        detail: `${totalWords} palavras (~${estSeconds}s a 130 pal/min), dentro da janela de 1 a 3 minutos. Lembre que acima de 1 minuto uma reivindicação ativa de direitos ainda pode bloquear o vídeo.`,
      });
    }

    // 6. Regra anti-publicação automática
    items.push({
      id: 'qc-human-gate',
      label: 'Aprovação humana obrigatória',
      severity: pauta.stage === 'APPROVED' ? 'pass' : 'warning',
      detail:
        pauta.stage === 'APPROVED'
          ? `Aprovado em ${pauta.approvedAt ?? ''}. Publicação automática permanece desativada.`
          : 'Aguardando revisão humana explícita antes de liberar o pacote final.',
    });

    const report: QcReport = {
      checkedAt: new Date().toISOString(),
      hasBlockingErrors: items.some((i) => i.severity === 'blocking'),
      warningCount: items.filter((i) => i.severity === 'warning').length,
      items,
    };

    this.pautas.update((list) =>
      list.map((p) => (p.id === pautaId ? { ...p, qc: report } : p)),
    );
    return report;
  }

  approveOrRejectPauta(pautaId: string, decision: 'APPROVED' | 'REJECTED', note: string): boolean {
    const qc = this.recomputeQc(pautaId);
    if (decision === 'APPROVED' && qc?.hasBlockingErrors) {
      this.actionFeedback.set({
        type: 'error',
        text: 'Resolva os itens bloqueantes do QC (fontes, vínculo de afirmações ou licenças) antes de aprovar.',
      });
      return false;
    }

    const nowIso = new Date().toISOString();
    this.pautas.update((list) =>
      list.map((p) =>
        p.id === pautaId
          ? {
              ...p,
              stage: decision,
              approvalNote: note.trim(),
              approvedAt: decision === 'APPROVED' ? nowIso : undefined,
              updatedAt: nowIso,
            }
          : p,
      ),
    );
    this.recomputeQc(pautaId);
    this.persist();
    return true;
  }

  buildSubtitles(pauta: PautaRecord, format: 'srt' | 'vtt'): string {
    const scenes = pauta.script?.scenes ?? [];
    let cursor = 0;
    const lines: string[] = [];
    if (format === 'vtt') {
      lines.push('WEBVTT', '');
    }

    const fmt = (sec: number): string => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      const pad = (n: number, len = 2) => String(n).padStart(len, '0');
      const sep = format === 'srt' ? ',' : '.';
      return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
    };

    let cueCounter = 1;
    scenes.forEach((sc) => {
      const sceneStart = cursor;
      const sceneEnd = cursor + sc.durationSec;
      cursor = sceneEnd;

      const rawText = sc.narration.trim() || '...';
      const cues = splitTextIntoSubtitleCues(rawText, 42);
      const totalChars = Math.max(1, cues.reduce((sum, c) => sum + c.length, 0));
      let subCursor = sceneStart;

      cues.forEach((cue, cueIdx) => {
        const subStart = subCursor;
        const share = cue.length / totalChars;
        const subEnd =
          cueIdx === cues.length - 1
            ? sceneEnd
            : Math.min(sceneEnd, subStart + sc.durationSec * share);
        subCursor = subEnd;

        if (format === 'srt') lines.push(String(cueCounter++));
        lines.push(`${fmt(subStart)} --> ${fmt(subEnd)}`);
        lines.push(cue);
        lines.push('');
      });
    });

    return lines.join('\n');
  }

  buildRightsManifest(pauta: PautaRecord): string {
    const manifest = {
      schemaVersion: 'canal-dark-manifest/0.1',
      generatedAt: new Date().toISOString(),
      pauta: {
        id: pauta.id,
        title: pauta.title,
        editorial: pauta.editorial,
        originUrl: pauta.url,
        stage: pauta.stage,
        approvedAt: pauta.approvedAt ?? null,
        approvalNote: pauta.approvalNote || null,
        autoPublishEnabled: false,
      },
      sources: pauta.dossier.sources,
      script: pauta.script
        ? {
            mode: pauta.script.mode,
            modelUsed: pauta.script.modelUsed,
            suggestedTitle: pauta.script.suggestedTitle,
            uncertaintyNote: pauta.script.uncertaintyNote,
            scenes: pauta.script.scenes.map((sc) => {
              const mediaList = getSceneMediaList(sc).map((asset) => ({
                provider: asset.provider,
                kind: asset.kind,
                title: asset.title,
                pageUrl: asset.pageUrl,
                mediaUrl: asset.mediaUrl,
                author: asset.author,
                licenseName: asset.licenseName,
                licenseUrl: asset.licenseUrl,
                attributionText: asset.attributionText,
                capturedAt: asset.capturedAt,
              }));
              return {
                order: sc.order,
                durationSec: sc.durationSec,
                narration: sc.narration,
                sourceIds: sc.sourceIds,
                avatarMode: sc.avatarMode,
                isDocumentaryMedia: sc.isDocumentaryMedia,
                mediaRights: mediaList[0] ?? null,
                mediaRightsList: mediaList,
              };
            }),
          }
        : null,
      narration: {
        mode: pauta.narration.mode,
        voiceName: pauta.narration.voiceName,
        audioFileName: pauta.narration.audioFileName ?? null,
        avatarNotice: 'Avatar fictício procedural; nenhuma pessoa real imitada.',
      },
      qcReport: pauta.qc ?? null,
    };

    return JSON.stringify(manifest, null, 2);
  }

  buildScriptAndDescriptionText(pauta: PautaRecord): string {
    const lines: string[] = [
      `TÍTULO SUGERIDO: ${pauta.script?.suggestedTitle || pauta.title}`,
      `EDITORIA: ${pauta.editorial}`,
      `STATUS: ${pauta.stage}${pauta.approvedAt ? ` (aprovado em ${pauta.approvedAt})` : ''}`,
      '',
      '=== ROTEIRO POR CENAS ===',
    ];

    for (const sc of pauta.script?.scenes ?? []) {
      lines.push(`\n[Cena ${sc.order} · ${sc.durationSec}s]`);
      lines.push(sc.narration.trim() || '(sem texto)');
      if (sc.sourceIds.length) {
        lines.push(`Fontes: ${sc.sourceIds.join(', ')}`);
      }
      const credits = getSceneMediaList(sc).map((m) => `${m.title} (${m.attributionText})`);
      if (credits.length) {
        lines.push(`Mídias: ${credits.join(' | ')}`);
      }
    }

    if (pauta.script?.uncertaintyNote) {
      lines.push('', `RESSALVA DE APURAÇÃO: ${pauta.script.uncertaintyNote}`);
    }

    lines.push('', '=== FONTES DO DOSSIÊ (DESCRIÇÃO) ===');
    for (const src of pauta.dossier.sources) {
      lines.push(`- [${src.id}] ${src.title} (${src.domain}) -> ${src.url}`);
    }

    return lines.join('\n').normalize('NFC');
  }
}
