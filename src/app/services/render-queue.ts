import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';

export interface RenderJobResultView {
  seconds: number;
  narrationRate: number;
  videoUrl: string;
  thumbnailUrl: string | null;
  files: string[];
  dir: string;
  mode: 'final' | 'preview';
}

export interface PublishJobResultView {
  pautaId: string;
  youtubeUrl?: string;
  youtubeVideoId?: string;
  platforms: string[];
  skipped: Array<{ platform: string; reason: string }>;
  warnings: string[];
  quotaUsed: number;
}

export interface RenderJobView {
  id: string;
  kind: 'render' | 'publish';
  label: string;
  pautaId: string | null;
  mode: 'final' | 'preview';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  pct: number;
  message: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedSec?: number;
  error?: string;
  result?: RenderJobResultView | PublishJobResultView;
}

/**
 * Acompanha a fila de render do servidor por SSE.
 *
 * O render leva dezenas de segundos (voz, avatar, FFmpeg): em vez de segurar a
 * requisição, o servidor devolve um job e manda o progresso por eventos.
 */
@Injectable({ providedIn: 'root' })
export class RenderQueue {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly jobs = signal<RenderJobView[]>([]);
  readonly connected = signal(false);

  readonly activeJob = computed(
    () =>
      this.jobs().find((job) => job.status === 'running') ??
      this.jobs().find((job) => job.status === 'queued') ??
      null,
  );

  readonly activeCount = computed(
    () => this.jobs().filter((job) => job.status === 'running' || job.status === 'queued').length,
  );

  private source: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (this.isBrowser) this.connect();
  }

  private connect(): void {
    if (typeof EventSource === 'undefined') {
      this.startPolling();
      return;
    }

    try {
      const source = new EventSource('/api/jobs/events');
      this.source = source;

      source.addEventListener('jobs', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { jobs?: RenderJobView[] };
          this.jobs.set(payload.jobs ?? []);
          this.connected.set(true);
        } catch {
          // Evento malformado: mantém o último estado conhecido.
        }
      });

      source.onopen = () => this.connected.set(true);
      source.onerror = () => {
        this.connected.set(false);
        // O EventSource reconecta sozinho; o polling é apenas rede de segurança.
        this.startPolling();
      };
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer || !this.isBrowser) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 2000);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const data = (await res.json()) as { jobs?: RenderJobView[] };
      this.jobs.set(data.jobs ?? []);
      this.connected.set(true);
      if (this.source && this.source.readyState === EventSource.OPEN) this.stopPolling();
    } catch {
      this.connected.set(false);
    }
  }

  /** Enfileira o render e devolve o job criado (ou lança com a mensagem do gate). */
  async enqueue(payload: unknown): Promise<RenderJobView> {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => null)) as { job?: RenderJobView; error?: string } | null;
    if (!res.ok || !data?.job) {
      throw new Error(data?.error ?? `Falha ao enfileirar o render (HTTP ${res.status}).`);
    }

    this.jobs.update((list) => [data.job as RenderJobView, ...list.filter((j) => j.id !== data.job!.id)]);
    return data.job;
  }

  async cancel(id: string): Promise<void> {
    await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => undefined);
  }
}
