import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DossierSourceItem,
  MediaAsset,
  PautaRecord,
  ScriptVersionMode,
} from './app/models/studio.models';
import { fetchAllEditorialFeeds, matchFeedsByQuery, rankViralItems } from './server/feeds';
import {
  generateStructuredShortScript,
  geminiTtsStatus,
  getGeminiStatus,
  runGeminiUrlContextAnalysis,
} from './server/gemini';
import {
  DEFAULT_NARRATION_STYLE,
  NARRATION_STYLES,
  TTS_VOICES,
  defaultTtsEngine,
  isTtsEngine,
  synthesizeVoicePreview,
} from './server/narration';
import {
  autoFillScenesMedia,
  extractArticleMetadata,
  scoreAssetForQuery,
  searchGdeltCoverage,
  searchInternetArchiveMedia,
  searchWikimediaMedia,
} from './server/research';
import {
  renderVerticalShortMp4,
  channelLabel,
  type RenderNarrationOptions,
  type RenderSceneInput,
  type RenderSourceInput,
} from './server/export-video';
import {
  cancelJob,
  enqueueJob,
  enqueueRender,
  getJob,
  listJobs,
  subscribe,
  unsubscribe,
  type PublishJobResult,
  type RenderJobResult,
} from './server/render-jobs';
import {
  buildPublishMetadata,
  validateMetadata,
} from './server/publish-metadata';
import {
  assertPublishable,
  hasThirdPartyMedia,
  publishPauta,
  PublishError,
  readPublishRecord,
  type PublishRequest,
} from './server/publish-service';
import { checkYoutubeQuota } from './server/publish-quota';
import { instagramStatus } from './server/instagram';
import { tiktokStatus } from './server/tiktok';
import {
  buildConsentUrl,
  clearStoredToken,
  clearYoutubeCredentials,
  exchangeCode,
  getChannelInfo,
  saveYoutubeClientId,
  saveYoutubeCredentials,
  saveExpectedChannelId,
  writeStoredToken,
  youtubeRedirectUri,
  youtubeStatus,
} from './server/youtube-auth';
import {
  fetchVideoAnalytics,
  listComments,
  replyToComment,
  setCommentModeration,
} from './server/youtube-insights';
import { setYoutubeThumbnail } from './server/youtube-upload';
import {
  addSchedule,
  autopilotPublishedToday,
  cancelSchedule,
  finishSchedule,
  listSchedule,
  noteAutopilotPublish,
  readAutopilot,
  startScheduler,
  writeAutopilot,
} from './server/scheduler';
import {
  deleteProject,
  filePath,
  listProjects,
  projectDir,
  readProject,
  sanitizeProjectId,
  saveRenderArtifacts,
  writeProject,
} from './server/projects';
import { srtToVtt } from './server/subtitles';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

try {
  process.loadEnvFile?.();
} catch {
  // .env é opcional; variáveis de ambiente da plataforma continuam sendo usadas
}

const app = express();
const angularApp = new AngularNodeAppEngine({
  allowedHosts: ['*.run.app', 'localhost', '127.0.0.1'],
});

app.use(express.json({ limit: '25mb' }));

// Status de configuração sem expor segredos
app.get('/api/config/status', (_req, res) => {
  res.json({
    ...getGeminiStatus(),
    channelLabel: channelLabel(),
    tts: {
      ...geminiTtsStatus(),
      defaultEngine: defaultTtsEngine(),
      defaultStyle: DEFAULT_NARRATION_STYLE,
      voices: TTS_VOICES,
      styles: NARRATION_STYLES,
    },
  });
});

// Amostra de voz para a interface escolher antes de renderizar
app.post('/api/tts/preview', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const preview = await synthesizeVoicePreview({
      engine: isTtsEngine(body['engine']) ? body['engine'] : undefined,
      voice: typeof body['voice'] === 'string' ? body['voice'] : undefined,
      style: typeof body['style'] === 'string' ? body['style'] : undefined,
    });

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Tts-Engine', preview.engine);
    res.setHeader('X-Tts-Voice', preview.voice);
    if (preview.model) res.setHeader('X-Tts-Model', preview.model);
    res.send(preview.wav);
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : 'Falha ao gerar a amostra de voz.',
    });
  }
});

// Descoberta RSS dos veículos configurados
app.get('/api/discovery/rss', async (req, res) => {
  try {
    const editorial = typeof req.query['editorial'] === 'string' ? req.query['editorial'] : 'Todas';
    const query = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const refresh = req.query['refresh'] === '1';
    // Janela de atualidade em horas (0 = sem filtro). Padrao: 72h.
    const maxAgeRaw = Number(req.query['maxAge']);
    const maxAge = Number.isFinite(maxAgeRaw) && maxAgeRaw >= 0 ? maxAgeRaw : 72;
    // Filtro de virais: pontua tudo e devolve só o que passa do corte.
    const viral = req.query['viral'] === '1';
    const minViralRaw = Number(req.query['minViral']);
    const minViral = Number.isFinite(minViralRaw) && minViralRaw > 0 ? minViralRaw : 4;

    const result = await fetchAllEditorialFeeds(refresh, maxAge);

    // A pontuação usa a lista inteira (repetição entre veículos é o sinal mais
    // forte), e só depois os filtros de editoria/termo são aplicados.
    let items = viral ? rankViralItems(result.items) : result.items;

    if (editorial && editorial !== 'Todas') {
      items = items.filter((item) => item.editorial.toLowerCase() === editorial.toLowerCase());
    }
    if (query.trim()) {
      items = matchFeedsByQuery(items, query);
    }
    if (viral) {
      items = items.filter((item) => (item.viralScore ?? 0) >= minViral).slice(0, 120);
    }

    res.json({
      items,
      statuses: result.statuses,
      respondedCount: result.respondedCount,
      totalCount: result.totalCount,
      newestAt: result.newestAt,
      maxAgeHours: maxAge,
      viral,
      minViral: viral ? minViral : null,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao consultar feeds RSS.',
    });
  }
});

// Extração segura da matéria informada por URL
app.post('/api/research/extract', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) {
    res.status(400).json({ error: 'Informe uma URL válida.' });
    return;
  }

  try {
    const extracted = await extractArticleMetadata(url);
    res.json(extracted);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Falha ao extrair metadados da página.',
    });
  }
});

// Consulta de cobertura recente via GDELT DOC 2.0 API (sem chave, últimos 3 dias)
app.get('/api/research/gdelt', async (req, res) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (!q) {
    res.status(400).json({ error: 'Parâmetro q obrigatório para consulta GDELT.' });
    return;
  }

  try {
    const result = await searchGdeltCoverage(q);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      status: 'error',
      articles: [],
      message: err instanceof Error ? err.message : 'Erro ao consultar GDELT.',
    });
  }
});

// Síntese complementar via Gemini URL Context (sem Google Search grounding)
app.post('/api/gemini/url-context', async (req, res) => {
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const urls = Array.isArray(req.body?.urls)
    ? req.body.urls.filter((u: unknown): u is string => typeof u === 'string')
    : [];

  if (!topic) {
    res.status(400).json({ error: 'Informe o tema da pauta.' });
    return;
  }

  const result = await runGeminiUrlContextAnalysis(topic, urls);
  res.json(result);
});

// Geração estruturada de roteiro em cenas com referências por fonte
app.post('/api/gemini/script', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const editorial = typeof req.body?.editorial === 'string' ? req.body.editorial.trim() : 'Brasil';
  const mode: ScriptVersionMode = req.body?.mode === 'expanded' ? 'expanded' : 'short';
  const sources = Array.isArray(req.body?.sources) ? (req.body.sources as DossierSourceItem[]) : [];
  const geminiContextSummary =
    typeof req.body?.geminiContextSummary === 'string' ? req.body.geminiContextSummary : undefined;

  if (!title) {
    res.status(400).json({ error: 'Título da pauta é obrigatório.' });
    return;
  }

  const result = await generateStructuredShortScript({
    title,
    editorial,
    mode,
    sources,
    geminiContextSummary,
  });

  res.json(result);
});

// Busca de mídia licenciada sem chave (Wikimedia Commons e Internet Archive)
app.get('/api/media/search', async (req, res) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const provider =
    req.query['provider'] === 'internet_archive' ? 'internet_archive' : 'wikimedia';
  const kind = req.query['kind'] === 'video' ? 'video' : 'image';

  if (!q) {
    res.status(400).json({ error: 'Informe termos de busca para pesquisar mídia.' });
    return;
  }

  if (provider === 'internet_archive') {
    const result = await searchInternetArchiveMedia(q, kind);
    res.json({
      ...result,
      assets: [...result.assets].sort(
        (a, b) => scoreAssetForQuery(b, q) - scoreAssetForQuery(a, q),
      ),
    });
    return;
  }

  const result = await searchWikimediaMedia(q, kind);
  res.json({
    ...result,
    assets: [...result.assets].sort((a, b) => scoreAssetForQuery(b, q) - scoreAssetForQuery(a, q)),
    configured: true,
  });
});

// Busca automática de nomes citados e preenchimento múltiplo de mídia por cena
app.post('/api/media/auto-fill', async (req, res) => {
  const pautaTitle = typeof req.body?.pautaTitle === 'string' ? req.body.pautaTitle.trim() : '';
  const editorial = typeof req.body?.editorial === 'string' ? req.body.editorial.trim() : 'Brasil';
  const kindPreference =
    req.body?.kindPreference === 'image' || req.body?.kindPreference === 'video'
      ? req.body.kindPreference
      : 'both';
  const maxPerScene = Math.max(1, Math.min(4, Number(req.body?.maxPerScene) || 2));
  const rawScenes = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
  // Imagens da matéria vêm do cliente (extraídas no dossiê) e entram primeiro.
  const articleAssets = Array.isArray(req.body?.articleAssets)
    ? (req.body.articleAssets as MediaAsset[]).filter(
        (asset) => asset && typeof asset.mediaUrl === 'string' && asset.mediaUrl.startsWith('http'),
      )
    : [];

  const scenes = rawScenes
    .filter((s: unknown): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .slice(0, 15)
    .map((s: Record<string, unknown>) => ({
      id: typeof s['id'] === 'string' ? s['id'] : '',
      narration: typeof s['narration'] === 'string' ? s['narration'] : '',
      visualQueryPt: typeof s['visualQueryPt'] === 'string' ? s['visualQueryPt'] : '',
      visualQueryEn: typeof s['visualQueryEn'] === 'string' ? s['visualQueryEn'] : '',
      ignoredEntities: Array.isArray(s['ignoredEntities'])
        ? s['ignoredEntities'].filter((x): x is string => typeof x === 'string')
        : [],
    }))
    .filter((s: { id: string }) => Boolean(s.id));

  if (!scenes.length) {
    res.status(400).json({ error: 'Informe ao menos uma cena do roteiro para buscar mídia.' });
    return;
  }

  try {
    const data = await autoFillScenesMedia({
      pautaTitle,
      editorial,
      kindPreference,
      maxPerScene,
      articleAssets,
      scenes,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao executar busca automática de mídia por nomes citados.',
    });
  }
});

// ---------------------------------------------------------------------------
// Pacote por pauta (spec §4.12 e §10): cada pauta vira um diretório auditável
// ---------------------------------------------------------------------------

app.get('/api/projects', async (_req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao listar projetos.',
    });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  if (!id) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  const project = await readProject(id);
  if (!project) {
    res.status(404).json({ error: 'Pauta não encontrada no disco.' });
    return;
  }
  res.json(project);
});

app.put('/api/projects/:id', async (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  if (!id) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  const body = req.body as PautaRecord | undefined;
  if (!body || typeof body !== 'object' || typeof body.title !== 'string') {
    res.status(400).json({ error: 'Corpo do projeto inválido.' });
    return;
  }
  try {
    await writeProject(id, { ...body, id });
    res.json({ ok: true, dir: projectDir(id) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao salvar o projeto.',
    });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  if (!id) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  const removed = await deleteProject(id);
  res.json({ ok: removed });
});

// Vídeo com suporte a Range (o player consegue buscar/arrastar).
app.get('/api/projects/:id/video', (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  const path = id ? filePath(id, 'video.mp4') : null;
  if (!id || !path) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  res.sendFile(path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Vídeo ainda não renderizado.' });
  });
});

app.get('/api/projects/:id/thumbnail', (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  const path = id ? filePath(id, 'thumbnail.jpg') : null;
  if (!id || !path) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  res.sendFile(path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Capa não encontrada.' });
  });
});

app.get('/api/projects/:id/file/:name', (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  const name = req.params['name'] ?? '';
  const path = id ? filePath(id, name) : null;
  if (!id || !path) {
    res.status(400).json({ error: 'Arquivo não permitido.' });
    return;
  }
  res.sendFile(path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado.' });
  });
});

// ---------------------------------------------------------------------------
// Render: montagem do pedido, gate de aprovação, execução e fila
// ---------------------------------------------------------------------------

interface RenderSpec {
  pautaId: string | null;
  mode: 'final' | 'preview';
  scenes: RenderSceneInput[];
  srtContent: string;
  audioBase64?: string;
  narration?: RenderNarrationOptions;
  dynamics?: 'alta' | 'normal';
  captions?: 'karaoke' | 'classica';
  headline?: string;
  closingText?: string;
  editorial?: string;
  videoMode?: 'fotos' | 'documento' | 'cards';
  sources?: RenderSourceInput[];
  artifacts: { manifestJson: string; scriptText: string; qcReport?: unknown };
}

function parseRenderRequest(body: Record<string, unknown> | undefined): {
  status?: number;
  error?: string;
  spec?: RenderSpec;
} {
  const rawScenes = Array.isArray(body?.['scenes']) ? (body?.['scenes'] as unknown[]) : [];
  const srtContent = typeof body?.['srtContent'] === 'string' ? body['srtContent'] : '';
  const audioBase64 = typeof body?.['audioBase64'] === 'string' ? body['audioBase64'] : undefined;

  const scenes: RenderSceneInput[] = rawScenes
    .filter((s: unknown): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .slice(0, 20)
    .map((s: Record<string, unknown>) => {
      const rawMode = s['avatarMode'];
      const avatarMode =
        rawMode === 'full' || rawMode === 'pip' || rawMode === 'hidden' ? rawMode : undefined;
      const rawExpression = s['avatarExpression'];
      const avatarExpression =
        rawExpression === 'neutral' ||
        rawExpression === 'alert' ||
        rawExpression === 'explaining' ||
        rawExpression === 'closing'
          ? rawExpression
          : undefined;

      return {
        durationSec: Math.max(2, Math.min(30, Number(s['durationSec']) || 6)),
        narration: typeof s['narration'] === 'string' ? s['narration'] : undefined,
        avatarMode,
        avatarExpression,
        mediaItems: Array.isArray(s['mediaItems'])
          ? s['mediaItems']
              .filter((m: unknown): m is Record<string, unknown> =>
                Boolean(m && typeof m === 'object'),
              )
              .map((m: Record<string, unknown>) => ({
                kind: m['kind'] === 'video' ? ('video' as const) : ('image' as const),
                mediaUrl: typeof m['mediaUrl'] === 'string' ? m['mediaUrl'] : '',
                thumbUrl: typeof m['thumbUrl'] === 'string' ? m['thumbUrl'] : '',
              }))
          : [],
      };
    });

  const narrationBody = body?.['narration'];
  const narration =
    narrationBody && typeof narrationBody === 'object'
      ? {
          enabled: (narrationBody as Record<string, unknown>)['enabled'] === true,
          engine:
            (narrationBody as Record<string, unknown>)['engine'] === 'gemini' ||
            (narrationBody as Record<string, unknown>)['engine'] === 'edge'
              ? ((narrationBody as Record<string, unknown>)['engine'] as 'gemini' | 'edge')
              : undefined,
          voice:
            typeof (narrationBody as Record<string, unknown>)['voice'] === 'string'
              ? String((narrationBody as Record<string, unknown>)['voice'])
              : undefined,
          style:
            typeof (narrationBody as Record<string, unknown>)['style'] === 'string'
              ? String((narrationBody as Record<string, unknown>)['style'])
              : undefined,
          rate: Number((narrationBody as Record<string, unknown>)['rate']) || undefined,
          minSeconds: Number((narrationBody as Record<string, unknown>)['minSeconds']) || undefined,
          fallbackToEdge: (narrationBody as Record<string, unknown>)['fallbackToEdge'] !== false,
        }
      : undefined;

  if (!scenes.length || !srtContent.trim()) {
    return { status: 400, error: 'Roteiro e legendas são obrigatórios para renderizar o vídeo.' };
  }

  const rawPautaId = typeof body?.['pautaId'] === 'string' ? body['pautaId'] : '';
  const pautaId = rawPautaId ? sanitizeProjectId(rawPautaId) : null;
  const mode: 'final' | 'preview' = body?.['mode'] === 'preview' ? 'preview' : 'final';

  if (rawPautaId && !pautaId) {
    return { status: 400, error: 'Identificador de pauta inválido.' };
  }

  const dynamics = body?.['dynamics'] === 'normal' ? 'normal' : 'alta';
  const captions = body?.['captions'] === 'classica' ? 'classica' : 'karaoke';
  const headline = typeof body?.['headline'] === 'string' ? String(body['headline']) : undefined;
  const closingText =
    typeof body?.['closingText'] === 'string' ? String(body['closingText']) : undefined;

  const rawVideoMode = body?.['videoMode'];
  const editorial = typeof body?.['editorial'] === 'string' ? String(body['editorial']).slice(0, 40) : undefined;
  const videoMode: 'fotos' | 'documento' | 'cards' =
    rawVideoMode === 'documento' ? 'documento' : rawVideoMode === 'cards' ? 'cards' : 'fotos';
  const rawSources = Array.isArray(body?.['sources']) ? (body['sources'] as unknown[]) : [];
  const sources: RenderSourceInput[] = rawSources
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, 3)
    .map((item) => ({
      title: String(item['title'] ?? '').slice(0, 200),
      domain: String(item['domain'] ?? '').slice(0, 80),
      url: String(item['url'] ?? '').slice(0, 300),
      excerpt: String(item['excerpt'] ?? '').slice(0, 1200),
      publishedAt: typeof item['publishedAt'] === 'string' ? item['publishedAt'] : undefined,
    }))
    .filter((item) => item.title.trim().length > 0);

  const artifactsBody = body?.['artifacts'] as Record<string, unknown> | undefined;
  const artifacts = {
    manifestJson: typeof artifactsBody?.['manifestJson'] === 'string' ? String(artifactsBody['manifestJson']) : '{}',
    scriptText: typeof artifactsBody?.['scriptText'] === 'string' ? String(artifactsBody['scriptText']) : '',
    qcReport: artifactsBody?.['qcReport'] ?? undefined,
  };

  return {
    spec: {
      pautaId,
      mode,
      scenes,
      srtContent,
      audioBase64,
      narration,
      dynamics,
      captions,
      headline,
      closingText,
      editorial,
      videoMode,
      sources,
      artifacts,
    },
  };
}

/**
 * Pacote final só sai com aprovação humana e QC limpo (spec §11, critérios 2 e
 * 8). Roda antes de enfileirar: recusar depois de 1 minuto de fila é pior.
 */
async function checkRenderGate(spec: RenderSpec): Promise<{ status?: number; error?: string }> {
  if (!spec.pautaId || spec.mode !== 'final') return {};

  const project = await readProject(spec.pautaId);
  if (!project) {
    return {
      status: 409,
      error:
        'Pauta ainda não salva no disco. Salve a pauta (ela é gravada automaticamente ao editar) e tente de novo.',
    };
  }
  if (project.qc?.hasBlockingErrors) {
    return {
      status: 409,
      error:
        'O QC tem itens bloqueantes (fontes, vínculo de afirmações ou licenças). Resolva antes de gerar o pacote final — ou use "Renderizar prévia".',
    };
  }
  if (project.stage !== 'APPROVED') {
    return {
      status: 409,
      error: `Aprovação humana obrigatória antes do pacote final (estágio atual: ${project.stage}). Use "Renderizar prévia" para revisar.`,
    };
  }
  return {};
}

async function executeRender(
  spec: RenderSpec,
  report?: (stage: string, pct: number, message?: string) => void,
): Promise<RenderJobResult> {
  const result = await renderVerticalShortMp4({
    scenes: spec.scenes,
    srtContent: spec.srtContent,
    audioBase64: spec.audioBase64,
    narration: spec.narration,
    dynamics: spec.dynamics,
    captions: spec.captions,
    headline: spec.headline,
    closingText: spec.closingText,
    editorial: spec.editorial,
    videoMode: spec.videoMode,
    sources: spec.sources,
    onProgress: report,
  });

  if (!spec.pautaId) {
    // Sem pauta identificada não há pacote: o vídeo é descartado depois do envio.
    throw new Error('Render sem pauta identificada não gera pacote arquivado.');
  }

  report?.('arquivo', 96, 'Gravando o pacote da pauta…');
  const saved = await saveRenderArtifacts(spec.pautaId, {
    video: result.buffer,
    srtContent: spec.srtContent,
    vttContent: srtToVtt(spec.srtContent),
    scriptText: spec.artifacts.scriptText,
    manifestJson: spec.artifacts.manifestJson,
    qcReport: spec.artifacts.qcReport,
    durationSec: result.durationSec,
    narrationRate: result.narrationRate,
    tts: { engine: result.ttsEngine, voice: result.ttsVoice, model: result.ttsModel },
    dynamics: result.dynamics,
    cuts: result.cuts,
    avgShotSec: result.avgShotSec,
    firstCutSec: result.firstCutSec,
    videoMode: result.videoMode ?? spec.videoMode ?? 'fotos',
  });

  return {
    seconds: result.durationSec,
    narrationRate: result.narrationRate ?? 1,
    videoUrl: `/api/projects/${spec.pautaId}/video`,
    thumbnailUrl: saved.thumbnailPath ? `/api/projects/${spec.pautaId}/thumbnail` : null,
    files: saved.files,
    dir: saved.dir,
    mode: spec.mode,
    ttsEngine: result.ttsEngine,
    ttsVoice: result.ttsVoice,
    ttsModel: result.ttsModel,
  };
}

// Fila de render: devolve o job na hora e a interface acompanha por SSE.
app.post('/api/render', async (req, res) => {
  const parsed = parseRenderRequest(req.body as Record<string, unknown> | undefined);
  if (!parsed.spec) {
    res.status(parsed.status ?? 400).json({ error: parsed.error });
    return;
  }
  if (!parsed.spec.pautaId) {
    res.status(400).json({ error: 'A fila exige o identificador da pauta.' });
    return;
  }

  const gate = await checkRenderGate(parsed.spec);
  if (gate.error) {
    res.status(gate.status ?? 409).json({ error: gate.error });
    return;
  }

  const spec = parsed.spec;
  const job = enqueueRender({
    label: spec.artifacts.scriptText.split('\n')[0]?.slice(0, 80) || 'render',
    pautaId: spec.pautaId,
    mode: spec.mode,
    run: (report) => executeRender(spec, report),
  });

  res.status(202).json({ job, statusUrl: `/api/jobs/${job.id}` });
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

// SSE precisa vir ANTES de `/api/jobs/:id`, senão "events" casa como id.
app.get('/api/jobs/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  subscribe(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(res);
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params['id'] ?? '');
  if (!job) {
    res.status(404).json({ error: 'Job não encontrado.' });
    return;
  }
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const cancelled = cancelJob(req.params['id'] ?? '');
  res.json({ ok: cancelled });
});

// Renderização síncrona (compatibilidade e testes): mesma validação e gate.
app.post('/api/export/render-mp4', async (req, res) => {
  const parsed = parseRenderRequest(req.body as Record<string, unknown> | undefined);
  if (!parsed.spec) {
    res.status(parsed.status ?? 400).json({ error: parsed.error });
    return;
  }

  const gate = await checkRenderGate(parsed.spec);
  if (gate.error) {
    res.status(gate.status ?? 409).json({ error: gate.error });
    return;
  }

  try {
    if (!parsed.spec.pautaId) {
      const result = await renderVerticalShortMp4({
        scenes: parsed.spec.scenes,
        srtContent: parsed.spec.srtContent,
        audioBase64: parsed.spec.audioBase64,
        narration: parsed.spec.narration,
        dynamics: parsed.spec.dynamics,
        captions: parsed.spec.captions,
        headline: parsed.spec.headline,
        closingText: parsed.spec.closingText,
        editorial: parsed.spec.editorial,
        videoMode: parsed.spec.videoMode,
        sources: parsed.spec.sources,
      });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="canal-dark-9x16.mp4"');
      res.setHeader('X-Video-Seconds', String(result.durationSec));
      res.setHeader('X-Narration-Rate', String(result.narrationRate ?? 1));
      res.setHeader('X-Narration-Seconds', String(result.narrationSeconds ?? 0));
      res.send(result.buffer);
      return;
    }

    const result = await executeRender(parsed.spec);
    res.json({ ok: true, pautaId: parsed.spec.pautaId, ...result });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Falha ao renderizar o vídeo MP4 no servidor.',
    });
  }
});

// ---------------------------------------------------------------------------
// Publicação: YouTube (completo), TikTok e Instagram (condicionados a auditoria)
// ---------------------------------------------------------------------------

function authPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#0a0d12;color:#e6eaf0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:560px;padding:32px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:#111620}
h1{font-size:18px;margin:0 0 8px;color:${ok ? '#6ee7b7' : '#fca5a5'}}p{line-height:1.6;color:#a8b3c4}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

app.get('/api/youtube/status', async (_req, res) => {
  try {
    res.json({
      youtube: { ...(await youtubeStatus()), redirectUri: youtubeRedirectUri() },
      tiktok: tiktokStatus(),
      instagram: instagramStatus(),
      quota: await checkYoutubeQuota(0),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao ler status.' });
  }
});

/**
 * Salva Client ID/Secret no `.env` e aplica em memória: o usuário cola no
 * painel e conecta na hora, sem reiniciar servidor nem editar arquivo.
 */
app.post('/api/youtube/config', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : '';
  const clientSecret = typeof body['clientSecret'] === 'string' ? body['clientSecret'] : '';

  try {
    // Sem secret ainda: salva só o ID e pede o restante.
    if (clientId.trim() && !clientSecret.trim()) {
      await saveYoutubeClientId(clientId);
      res.json({
        ok: true,
        configured: false,
        needsSecret: true,
        clientId: clientId.trim(),
        redirectUri: youtubeRedirectUri(),
        status: await youtubeStatus(),
      });
      return;
    }

    await saveYoutubeCredentials({
      clientId,
      clientSecret,
      redirectUri: typeof body['redirectUri'] === 'string' ? body['redirectUri'] : undefined,
    });
    res.json({
      ok: true,
      configured: true,
      redirectUri: youtubeRedirectUri(),
      status: await youtubeStatus(),
    });
  } catch (err) {
    res.status(422).json({
      error: err instanceof Error ? err.message : 'Não foi possível salvar as credenciais.',
    });
  }
});

app.get('/api/youtube/auth/start', (_req, res) => {
  const url = buildConsentUrl(`canal-dark-${Date.now()}`);
  if (!url) {
    res.status(409).json({
      error:
        'Configure YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env (Google Cloud > Credenciais) antes de conectar.',
    });
    return;
  }
  res.redirect(url);
});

app.get('/api/youtube/auth/callback', async (req, res) => {
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  const denied = typeof req.query['error'] === 'string' ? req.query['error'] : '';

  if (denied) {
    res.status(400).send(authPage('Autorização recusada', `O Google retornou: ${denied}.`, false));
    return;
  }
  if (!code) {
    res.status(400).send(authPage('Código ausente', 'A URL de retorno não trouxe o código de autorização.', false));
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    await writeStoredToken({
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      obtainedAt: new Date().toISOString(),
    });
    const channel = await getChannelInfo(true);
    res.send(
      authPage(
        'YouTube conectado',
        `Canal: <strong>${channel?.title ?? '(verificando)'}</strong>. Pode fechar esta aba e voltar ao Canal Dark.`,
        true,
      ),
    );
  } catch (err) {
    res
      .status(500)
      .send(authPage('Falha ao conectar', err instanceof Error ? err.message : 'Erro desconhecido.', false));
  }
});

/**
 * Fixa o canal de publicação. Sem isso, o token da conta Google pode apontar
 * para o canal pessoal e o vídeo sai no lugar errado.
 */
app.post('/api/youtube/expected-channel', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    let channelId = typeof body['channelId'] === 'string' ? body['channelId'].trim() : '';

    if (!channelId) {
      const channel = await getChannelInfo(true);
      channelId = channel?.id ?? '';
    }

    if (!/^UC[A-Za-z0-9_-]{20,}$/.test(channelId)) {
      res.status(422).json({
        error: 'Canal inválido. Conecte o YouTube primeiro (o ID começa com UC) ou informe channelId.',
      });
      return;
    }

    await saveExpectedChannelId(channelId);
    res.json({ ok: true, status: await youtubeStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao fixar o canal.' });
  }
});

app.delete('/api/youtube/expected-channel', async (_req, res) => {
  await saveExpectedChannelId(null);
  res.json({ ok: true, status: await youtubeStatus() });
});

app.post('/api/youtube/disconnect', async (_req, res) => {
  await clearStoredToken();
  res.json({ ok: true });
});

/** Trocar de projeto/conta: apaga credenciais salvas e o token. */
app.delete('/api/youtube/config', async (_req, res) => {
  await clearStoredToken();
  await clearYoutubeCredentials();
  res.json({ ok: true, configured: false });
});

app.post('/api/publish/metadata', async (req, res) => {
  const pautaId = sanitizeProjectId(typeof req.body?.pautaId === 'string' ? req.body.pautaId : '');
  if (!pautaId) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  const project = await readProject(pautaId);
  if (!project) {
    res.status(404).json({ error: 'Pauta não encontrada no disco.' });
    return;
  }

  try {
    const metadata = await buildPublishMetadata(project, {
      useGemini: req.body?.useGemini !== false,
    });
    res.json({
      metadata,
      problems: validateMetadata(metadata),
      hasThirdPartyMedia: hasThirdPartyMedia(project),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao gerar metadados.',
    });
  }
});

app.post('/api/publish', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pautaId = sanitizeProjectId(typeof body['pautaId'] === 'string' ? body['pautaId'] : '');
  if (!pautaId) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }

  const platforms = Array.isArray(body['platforms'])
    ? (body['platforms'] as unknown[])
        .filter((value): value is string => typeof value === 'string')
        .filter((value) => value === 'youtube' || value === 'tiktok' || value === 'instagram')
    : ['youtube'];

  const privacyRaw = body['privacyStatus'];
  const privacyStatus: PublishRequest['privacyStatus'] =
    privacyRaw === 'public' || privacyRaw === 'private' || privacyRaw === 'unlisted'
      ? privacyRaw
      : undefined;

  const rawMetadata = body['metadata'];
  const metadata: PublishRequest['metadata'] =
    rawMetadata && typeof rawMetadata === 'object' && typeof (rawMetadata as { title?: unknown }).title === 'string'
      ? (rawMetadata as PublishRequest['metadata'])
      : undefined;

  const request: PublishRequest = {
    pautaId,
    platforms: platforms as Array<'youtube' | 'tiktok' | 'instagram'>,
    metadata,
    privacyStatus,
    publishAt: typeof body['publishAt'] === 'string' ? body['publishAt'] : undefined,
    confirmRights: body['confirmRights'] === true,
    force: body['force'] === true,
  };

  try {
    await assertPublishable(request);
  } catch (err) {
    if (err instanceof PublishError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  const job = enqueueJob({
    kind: 'publish',
    label: `Publicar ${pautaId}`,
    pautaId,
    mode: 'final',
    run: async (report): Promise<PublishJobResult> => {
      const result = await publishPauta(request, report);
      return {
        pautaId,
        youtubeUrl: result.youtube?.url,
            youtubeVideoId: result.youtube?.videoId,
        platforms: Array.from(
          new Set([
            ...(result.youtube ? ['youtube'] : []),
            ...(result.tiktok ? ['tiktok'] : []),
            ...(result.instagram ? ['instagram'] : []),
          ]),
        ),
        skipped: result.skipped,
        warnings: result.warnings,
        quotaUsed: result.quotaUsed,
      };
    },
  });

  res.status(202).json({ job });
});

app.get('/api/projects/:id/publish', async (req, res) => {
  const id = sanitizeProjectId(req.params['id'] ?? '');
  if (!id) {
    res.status(400).json({ error: 'Identificador de pauta inválido.' });
    return;
  }
  res.json({ publish: await readPublishRecord(id) });
});

app.get('/api/youtube/analytics', async (req, res) => {
  const pautaId = sanitizeProjectId(typeof req.query['pautaId'] === 'string' ? req.query['pautaId'] : '');
  if (!pautaId) {
    res.status(400).json({ error: 'Informe pautaId.' });
    return;
  }
  const project = await readProject(pautaId);
  const videoId = project?.youtube?.videoId;
  if (!project || !videoId) {
    res.status(409).json({ error: 'Esta pauta ainda não tem vídeo publicado no YouTube.' });
    return;
  }

  const analytics = await fetchVideoAnalytics({
    videoId,
    days: Number(req.query['days']) || 90,
  });

  if (!analytics) {
    res.status(409).json({
      error:
        'Sem dados de analytics. Reconecte a conta concedendo o escopo yt-analytics.readonly (ou aguarde as primeiras 24h de métricas).',
    });
    return;
  }

  // Preenche o campo que a spec previa (critério 14) e nunca era escrito.
  await writeProject(pautaId, {
    ...project,
    analyticsNotes: {
      engagedViews: analytics.views,
      avgViewDurationSec: analytics.averageViewDurationSec,
      avgPercentViewed: analytics.averageViewPercentage,
      stayedToWatchPct: analytics.averageViewPercentage,
      subscribersGained: analytics.subscribersGained,
    },
    updatedAt: new Date().toISOString(),
  });

  res.json({ analytics });
});

app.get('/api/youtube/comments', async (req, res) => {
  const pautaId = sanitizeProjectId(typeof req.query['pautaId'] === 'string' ? req.query['pautaId'] : '');
  const project = pautaId ? await readProject(pautaId) : null;
  const videoId = project?.youtube?.videoId;
  if (!videoId) {
    res.status(409).json({ error: 'Esta pauta ainda não tem vídeo publicado.' });
    return;
  }
  try {
    res.json(await listComments(videoId, Number(req.query['max']) || 25));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Erro ao ler comentários.' });
  }
});

app.post('/api/youtube/comments/reply', async (req, res) => {
  const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!parentId || text.length < 1) {
    res.status(400).json({ error: 'Informe parentId e text.' });
    return;
  }
  try {
    res.json(await replyToComment(parentId, text.slice(0, 2000)));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Falha ao responder.' });
  }
});

app.post('/api/youtube/comments/moderate', async (req, res) => {
  const commentId = typeof req.body?.commentId === 'string' ? req.body.commentId.trim() : '';
  const status = req.body?.status;
  const allowed = ['published', 'heldForReview', 'rejected'];
  if (!commentId || !allowed.includes(String(status))) {
    res.status(400).json({ error: 'Informe commentId e status (published|heldForReview|rejected).' });
    return;
  }
  try {
    await setCommentModeration(
      commentId,
      status as 'published' | 'heldForReview' | 'rejected',
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Falha ao moderar.' });
  }
});

app.post('/api/youtube/thumbnail', async (req, res) => {
  const pautaId = sanitizeProjectId(typeof req.body?.pautaId === 'string' ? req.body.pautaId : '');
  const project = pautaId ? await readProject(pautaId) : null;
  const videoId = project?.youtube?.videoId;
  if (!pautaId || !videoId) {
    res.status(409).json({ error: 'Publique o vídeo antes de trocar a capa.' });
    return;
  }
  const thumbnailPath = join(projectDir(pautaId), 'thumbnail.jpg');
  try {
    await setYoutubeThumbnail(videoId, thumbnailPath);
    res.json({ ok: true, note: 'Capa trocada. Para comparar de verdade, use Test & Compare no YouTube Studio (não existe API).' });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Falha ao trocar a capa.' });
  }
});

app.get('/api/schedule', async (_req, res) => {
  res.json({ schedule: await listSchedule(), autopilot: await readAutopilot() });
});

app.post('/api/schedule', async (req, res) => {
  const pautaId = sanitizeProjectId(typeof req.body?.pautaId === 'string' ? req.body.pautaId : '');
  const whenIso = typeof req.body?.whenIso === 'string' ? req.body.whenIso : '';
  if (!pautaId || !whenIso) {
    res.status(400).json({ error: 'Informe pautaId e whenIso.' });
    return;
  }
  if (!Number.isFinite(new Date(whenIso).getTime())) {
    res.status(400).json({ error: 'Data/hora inválida.' });
    return;
  }

  const project = await readProject(pautaId);
  if (!project) {
    res.status(404).json({ error: 'Pauta não encontrada.' });
    return;
  }

  const metadata = await buildPublishMetadata(project, { useGemini: false });
  const privacyRaw = req.body?.privacyStatus;
  const entry = await addSchedule({
    pautaId,
    platforms: Array.isArray(req.body?.platforms) ? req.body.platforms : ['youtube'],
    whenIso,
    privacyStatus:
      privacyRaw === 'public' || privacyRaw === 'private' ? privacyRaw : 'unlisted',
    metadata,
  });

  res.status(201).json({ entry });
});

app.post('/api/schedule/:id/cancel', async (req, res) => {
  res.json({ ok: await cancelSchedule(req.params['id'] ?? '') });
});

app.get('/api/autopilot', async (_req, res) => {
  res.json({
    autopilot: await readAutopilot(),
    publishedToday: await autopilotPublishedToday(),
  });
});

app.put('/api/autopilot', async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  const autopilot = await writeAutopilot({
    enabled: patch['enabled'] === true,
    maxPerDay: Number(patch['maxPerDay']) || undefined,
    platforms: Array.isArray(patch['platforms'])
      ? (patch['platforms'] as unknown[]).filter(
          (value): value is 'youtube' | 'tiktok' | 'instagram' =>
            value === 'youtube' || value === 'tiktok' || value === 'instagram',
        )
      : undefined,
  });
  res.json({ autopilot });
});

// Agendador: dispara publicações vencidas e o autopilot (que só publica pauta já aprovada).
startScheduler({
  runEntry: async (entry) => {
    try {
      const job = enqueueJob({
        kind: 'publish',
        label: `Agendado ${entry.pautaId}`,
        pautaId: entry.pautaId,
        mode: 'final',
        run: async (report): Promise<PublishJobResult> => {
          const result = await publishPauta(
            {
              pautaId: entry.pautaId,
              platforms: entry.platforms,
              metadata: entry.metadata,
              privacyStatus: entry.privacyStatus,
            },
            report,
          );
          return {
            pautaId: entry.pautaId,
            youtubeUrl: result.youtube?.url,
            youtubeVideoId: result.youtube?.videoId,
            platforms: entry.platforms,
            skipped: result.skipped,
            warnings: result.warnings,
            quotaUsed: result.quotaUsed,
          };
        },
      });
      await finishSchedule(entry.id, 'done', `job ${job.id}`);
    } catch (err) {
      await finishSchedule(entry.id, 'failed', err instanceof Error ? err.message : String(err));
    }
  },

  runAutopilot: async () => {
    const config = await readAutopilot();
    if (!config.enabled) return;
    if ((await autopilotPublishedToday()) >= config.maxPerDay) return;

    const busy = listJobs().some((job) => job.status === 'running' || job.status === 'queued');
    if (busy) return;

    for (const summary of await listProjects()) {
      // Somente pauta aprovada e com vídeo renderizado.
      if (summary.stage !== 'APPROVED' || !summary.hasVideo) continue;

      const record = await readPublishRecord(summary.id);
      if (record?.youtube?.videoId) continue;

      const project = await readProject(summary.id);
      if (!project || project.qc?.hasBlockingErrors) continue;

      const request = {
        pautaId: summary.id,
        platforms: config.platforms,
        privacyStatus: 'unlisted' as const,
      };
      try {
        await assertPublishable(request);
      } catch {
        continue;
      }

      enqueueJob({
        kind: 'publish',
        label: `Autopilot ${summary.id}`,
        pautaId: summary.id,
        mode: 'final',
        run: async (report): Promise<PublishJobResult> => {
          const result = await publishPauta(request, report);
          return {
            pautaId: summary.id,
            youtubeUrl: result.youtube?.url,
            youtubeVideoId: result.youtube?.videoId,
            platforms: config.platforms,
            skipped: result.skipped,
            warnings: result.warnings,
            quotaUsed: result.quotaUsed,
          };
        },
      });
      await noteAutopilotPublish();
      break;
    }
  },
});

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// Angular SSR catch-all must be LAST
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Canal Dark server listening on http://0.0.0.0:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
