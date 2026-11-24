import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DossierSourceItem,
  ScriptVersionMode,
} from './app/models/studio.models';
import { fetchAllEditorialFeeds, matchFeedsByQuery } from './server/feeds';
import {
  generateStructuredShortScript,
  getGeminiStatus,
  runGeminiUrlContextAnalysis,
} from './server/gemini';
import {
  autoFillScenesMedia,
  extractArticleMetadata,
  searchGdeltCoverage,
  searchInternetArchiveMedia,
  searchWikimediaMedia,
} from './server/research';
import { renderVerticalShortMp4, type RenderSceneInput } from './server/export-video';

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
  res.json(getGeminiStatus());
});

// Descoberta RSS dos veículos configurados
app.get('/api/discovery/rss', async (req, res) => {
  try {
    const editorial = typeof req.query['editorial'] === 'string' ? req.query['editorial'] : 'Todas';
    const query = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const refresh = req.query['refresh'] === '1';

    const result = await fetchAllEditorialFeeds(refresh);
    let items = result.items;

    if (editorial && editorial !== 'Todas') {
      items = items.filter((item) => item.editorial.toLowerCase() === editorial.toLowerCase());
    }
    if (query.trim()) {
      items = matchFeedsByQuery(items, query);
    }

    res.json({
      items,
      statuses: result.statuses,
      respondedCount: result.respondedCount,
      totalCount: result.totalCount,
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
    res.json(result);
    return;
  }

  const result = await searchWikimediaMedia(q, kind);
  res.json({ ...result, configured: true });
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
      scenes,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro ao executar busca automática de mídia por nomes citados.',
    });
  }
});

// Renderização real do pacote final 9:16 em MP4 via FFmpeg
app.post('/api/export/render-mp4', async (req, res) => {
  const rawScenes = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
  const srtContent = typeof req.body?.srtContent === 'string' ? req.body.srtContent : '';
  const audioBase64 = typeof req.body?.audioBase64 === 'string' ? req.body.audioBase64 : undefined;

  const scenes: RenderSceneInput[] = rawScenes
    .filter((s: unknown): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .slice(0, 20)
    .map((s: Record<string, unknown>) => ({
      durationSec: Math.max(2, Math.min(30, Number(s['durationSec']) || 6)),
      mediaItems: Array.isArray(s['mediaItems'])
        ? s['mediaItems']
            .filter((m: unknown): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
            .map((m: Record<string, unknown>) => ({
              kind: m['kind'] === 'video' ? ('video' as const) : ('image' as const),
              mediaUrl: typeof m['mediaUrl'] === 'string' ? m['mediaUrl'] : '',
              thumbUrl: typeof m['thumbUrl'] === 'string' ? m['thumbUrl'] : '',
            }))
        : [],
    }));

  if (!scenes.length || !srtContent.trim()) {
    res.status(400).json({ error: 'Roteiro e legendas são obrigatórios para renderizar o vídeo.' });
    return;
  }

  try {
    const mp4Buffer = await renderVerticalShortMp4({ scenes, srtContent, audioBase64 });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="canal-dark-9x16.mp4"');
    res.send(mp4Buffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Falha ao renderizar o vídeo MP4 no servidor.',
    });
  }
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
