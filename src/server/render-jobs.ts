import type { Response } from 'express';

/**
 * Fila de render: um job por vez, com progresso por etapa.
 *
 * Renderizar é caro (voz, avatar, FFmpeg) e a requisição HTTP não deve ficar
 * pendurada por um minuto. O job roda em segundo plano e a interface acompanha
 * por SSE, então o usuário pode navegar enquanto o vídeo é montado.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type JobKind = 'render' | 'publish';

export interface RenderJobResult {
  seconds: number;
  narrationRate: number;
  videoUrl: string;
  thumbnailUrl: string | null;
  files: string[];
  dir: string;
  mode: 'final' | 'preview';
  /** Motor/voz/modelo de TTS usados na narração. */
  ttsEngine?: string;
  ttsVoice?: string;
  ttsModel?: string;
  ttsFallback?: string;
  /** Formato visual do vídeo (fotos, documento ou cartões). */
  videoMode?: string;
  /** Cortes e ritmo, para conferência rápida na interface. */
  cuts?: number;
  avgShotSec?: number;
}

export interface PublishJobResult {
  pautaId: string;
  youtubeUrl?: string;
  youtubeVideoId?: string;
  platforms: string[];
  skipped: Array<{ platform: string; reason: string }>;
  warnings: string[];
  quotaUsed: number;
}

export type JobResult = RenderJobResult | PublishJobResult;

export interface RenderJobPublic {
  id: string;
  kind: JobKind;
  label: string;
  pautaId: string | null;
  mode: 'final' | 'preview';
  status: JobStatus;
  stage: string;
  pct: number;
  message: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedSec?: number;
  error?: string;
  result?: JobResult;
}

export type ProgressReporter = (stage: string, pct: number, message?: string) => void;

interface RenderJobInternal extends RenderJobPublic {
  cancelled: boolean;
  run: (report: ProgressReporter) => Promise<JobResult>;
}

const MAX_HISTORY = 25;
const queue: RenderJobInternal[] = [];
const jobs = new Map<string, RenderJobInternal>();
const subscribers = new Set<Response>();
let processing = false;
let jobCounter = 0;

function toPublic(job: RenderJobInternal): RenderJobPublic {
  const { run: _run, cancelled: _cancelled, ...rest } = job;
  return rest;
}

function snapshot(): RenderJobPublic[] {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(toPublic);
}

function broadcast(): void {
  const payload = JSON.stringify({ jobs: snapshot() });
  for (const res of subscribers) {
    try {
      res.write(`event: jobs\ndata: ${payload}\n\n`);
    } catch {
      subscribers.delete(res);
    }
  }
}

/** Eventos do job (progresso). Throttle evita inundar o SSE a cada cena. */
let lastBroadcastAt = 0;
let lastBroadcastStage = '';
function broadcastThrottled(stage: string): void {
  const now = Date.now();
  // Troca de etapa sempre vai (senão uma etapa inteira desaparece da barra);
  // só o mesmo estágio é agrupado.
  if (stage === lastBroadcastStage && now - lastBroadcastAt < 200) return;
  lastBroadcastStage = stage;
  lastBroadcastAt = now;
  broadcast();
}

function trimHistory(): void {
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  for (const job of finished.slice(MAX_HISTORY)) {
    jobs.delete(job.id);
  }
}

export function subscribe(res: Response): void {
  subscribers.add(res);
  res.write('event: jobs\ndata: ' + JSON.stringify({ jobs: snapshot() }) + '\n\n');
}

export function unsubscribe(res: Response): void {
  subscribers.delete(res);
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function listJobs(): RenderJobPublic[] {
  return snapshot();
}

export function getJob(id: string): RenderJobPublic | null {
  const job = jobs.get(id);
  return job ? toPublic(job) : null;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.stage = 'cancelado';
    job.finishedAt = new Date().toISOString();
    job.pct = 0;
    job.message = 'Cancelado antes de iniciar.';
    broadcast();
    return true;
  }

  if (job.status === 'running') {
    job.cancelled = true;
    job.message = 'Cancelamento solicitado…';
    broadcast();
    return true;
  }

  return false;
}

/** Enfileira um job (render ou publicação). */
export function enqueueJob(params: {
  kind: JobKind;
  label: string;
  pautaId: string | null;
  mode?: 'final' | 'preview';
  reuseIfActive?: boolean;
  run: (report: ProgressReporter) => Promise<JobResult>;
}): RenderJobPublic {
  // Clique repetido em "Gerar vídeo" não pode empilhar renders da mesma pauta:
  // a fila é serial e o app parecia travado enquanto os jobs esperavam.
  if (params.reuseIfActive && params.pautaId) {
    const active = Array.from(jobs.values()).find(
      (item) =>
        item.pautaId === params.pautaId &&
        item.kind === params.kind &&
        (item.status === 'queued' || item.status === 'running'),
    );
    if (active) return toPublic(active);
  }

  jobCounter += 1;
  const now = new Date().toISOString();

  const job: RenderJobInternal = {
    id: `job-${Date.now()}-${jobCounter}`,
    kind: params.kind,
    label: params.label,
    pautaId: params.pautaId,
    mode: params.mode ?? 'final',
    status: 'queued',
    stage: 'na fila',
    pct: 0,
    message: 'Aguardando a vez.',
    createdAt: now,
    cancelled: false,
    run: params.run,
  };

  jobs.set(job.id, job);
  queue.push(job);
  trimHistory();
  broadcast();
  void processQueue();

  return toPublic(job);
}

/** Compatibilidade: o render continua entrando pelo mesmo caminho de sempre. */
export function enqueueRender(params: {
  label: string;
  pautaId: string | null;
  mode: 'final' | 'preview';
  run: (report: ProgressReporter) => Promise<RenderJobResult>;
}): RenderJobPublic {
  return enqueueJob({ ...params, kind: 'render', reuseIfActive: true });
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      if (job.cancelled) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        broadcast();
        continue;
      }

      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.stage = 'iniciando';
      job.pct = 1;
      job.message = job.kind === 'publish' ? 'Preparando a publicação.' : 'Preparando o render.';
      broadcast();

      const report: ProgressReporter = (stage, pct, message) => {
        if (job.cancelled) return;
        job.stage = stage;
        job.pct = Math.max(0, Math.min(99, Math.round(pct)));
        if (message) job.message = message;
        broadcastThrottled(stage);
      };

      try {
        const result = await job.run(report);
        if (job.cancelled) {
          job.status = 'cancelled';
          job.stage = 'cancelado';
          job.message = 'Cancelado durante a execução.';
        } else {
          job.status = 'done';
          job.stage = 'concluído';
          job.pct = 100;
          job.message =
            job.kind === 'publish'
              ? 'Publicado.'
              : `Pacote pronto${(result as RenderJobResult).mode === 'preview' ? ' (prévia)' : ''}.`;
          job.result = result;
        }
      } catch (err) {
        job.status = 'failed';
        job.stage = 'falhou';
        job.message =
          job.kind === 'publish' ? 'A publicação não foi concluída.' : 'O render não foi concluído.';
        job.error = err instanceof Error ? err.message : String(err);
      } finally {
        job.finishedAt = new Date().toISOString();
        job.elapsedSec = job.startedAt
          ? Number(((Date.now() - new Date(job.startedAt).getTime()) / 1000).toFixed(1))
          : undefined;
        broadcast();
      }
    }
  } finally {
    processing = false;
  }
}
