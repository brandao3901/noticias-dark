import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type {
  EditorialCategory,
  RadarClusterItem,
  RadarFormat,
  RadarPersonality,
  RadarResponse,
  RadarScope,
} from '../models/studio.models';
import { StudioStore } from '../services/studio-store';

/**
 * Radar Global: pautas fora do Brasil.
 *
 * Complementa a aba Descoberta (notícias brasileiras, que continua igual).
 * Aqui só se escolhe a pauta; a produção continua manual, como sempre.
 */
@Component({
  selector: 'app-radar-view',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mx-auto max-w-[1440px] px-6 py-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="text-xl font-semibold text-slate-100">Radar Global</h2>
          <p class="mt-1 text-sm text-slate-400">
            Histórias de outros países e nichos, agrupadas por assunto. Você escolhe a pauta;
            nada é produzido automaticamente.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex rounded-lg border border-white/10 bg-[#111620] p-0.5 text-xs">
            <button
              type="button"
              (click)="setScope('tendencias')"
              class="rounded px-3 py-1.5"
              [class.bg-white/10]="scope() === 'tendencias'"
              [class.text-slate-100]="scope() === 'tendencias'"
            >
              Tendências (agora)
            </button>
            <button
              type="button"
              (click)="setScope('documental')"
              class="rounded px-3 py-1.5"
              [class.bg-white/10]="scope() === 'documental'"
              [class.text-slate-100]="scope() === 'documental'"
            >
              Histórias e curiosidades
            </button>
          </div>

          <button
            type="button"
            (click)="toggleOnlyViral()"
            class="inline-flex items-center gap-1 rounded border px-3 py-1.5 text-xs"
            [class.border-[#e59a38]]="onlyViral()"
            [class.text-[#f0aa4b]]="onlyViral()"
            [class.border-white/15]="!onlyViral()"
            [class.text-slate-200]="!onlyViral()"
            title="Mostrar somente o que está repercutindo em mais de um veículo ou país"
          >
            <mat-icon class="text-[16px]">filter_alt</mat-icon>
            <span>Só virais</span>
          </button>

          <button
            type="button"
            (click)="load(true)"
            [disabled]="loading()"
            class="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40"
          >
            <mat-icon class="text-[16px]">{{ loading() ? 'hourglass_top' : 'refresh' }}</mat-icon>
            <span>{{ loading() ? 'Buscando…' : 'Atualizar' }}</span>
          </button>
        </div>
      </div>

      <p class="mt-2 text-[11px] text-slate-500">
        {{ scopeHint() }} · <strong class="text-slate-300">{{ viralCount() }} viral(is)</strong> no topo,
        {{ items().length }} exibidas de {{ totalCandidates() }} ·
        nota = dados observados + viralidade + avaliação editorial
        @if (!aiAvailable() && !loading()) {
          <span class="text-amber-300"> · IA indisponível: mostrando só os dados observados</span>
        }
      </p>

      @if (error(); as message) {
        <p class="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          {{ message }}
        </p>
      }

      @if (loading() && !items().length) {
        <p class="mt-6 text-sm text-slate-400">Consultando feeds de vários países…</p>
      }

      <div class="mt-5 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        @for (item of items(); track item.id) {
          <article class="flex flex-col rounded-xl border border-white/10 bg-[#111620] p-4">
            <div class="flex items-start justify-between gap-2">
              <span class="rounded bg-[#e59a38]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#f0aa4b]">
                {{ item.category }}
              </span>
              <span class="text-[10px] text-slate-500">
                {{ item.observed.fontes }} fonte(s) · {{ item.observed.paises }} país(es) · {{ ageLabel(item) }}
              </span>
            </div>

            <h3 class="mt-2 text-sm font-semibold leading-snug text-slate-100">{{ item.title }}</h3>

            @if (item.viral; as viral) {
              <p class="mt-1 text-[10px]" [class]="viralClass(viral.rotulo)">
                {{ viralLabel(viral.rotulo) }} · viralidade {{ viral.score }}/100
              </p>
            }

            @if (item.ai?.resumo) {
              <p class="mt-1 text-xs leading-relaxed text-slate-300">{{ item.ai?.resumo }}</p>
            } @else if (item.summary) {
              <p class="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-400">{{ item.summary }}</p>
            }

            <div class="mt-3 flex flex-wrap gap-1 text-[10px] text-slate-400">
              @for (country of item.countries.slice(0, 3); track country) {
                <span class="rounded border border-white/10 px-1.5 py-0.5">{{ country }}</span>
              }
              @for (language of item.languages.slice(0, 2); track language) {
                <span class="rounded border border-white/10 px-1.5 py-0.5">{{ language }}</span>
              }
            </div>

            <div class="mt-3 space-y-1.5">
              <div class="flex items-center gap-2 text-[10px] text-slate-400">
                <span class="w-16">Dados</span>
                <div class="h-1.5 flex-1 rounded bg-white/10">
                  <div class="h-1.5 rounded bg-slate-400" [style.width.%]="item.observed.score"></div>
                </div>
                <span class="w-6 text-right">{{ item.observed.score }}</span>
              </div>
              @if (item.ai; as ai) {
                <div class="flex items-center gap-2 text-[10px] text-slate-400">
                  <span class="w-16">Editorial</span>
                  <div class="h-1.5 flex-1 rounded bg-white/10">
                    <div class="h-1.5 rounded bg-[#e59a38]" [style.width.%]="ai.total"></div>
                  </div>
                  <span class="w-6 text-right">{{ ai.total }}</span>
                </div>
              }
            </div>

            @if (item.ai?.recomendacao) {
              <p class="mt-2 text-[11px] leading-relaxed text-slate-300">
                <mat-icon class="align-middle text-[13px] text-[#e59a38]">lightbulb</mat-icon>
                {{ item.ai?.recomendacao }}
              </p>
            }

            @if (item.ai; as ai) {
              <p class="mt-1 text-[10px] text-slate-500">
                formato sugerido: {{ formatoLabel(ai.formato) }} · tom: {{ personalidadeLabel(ai.personalidade) }}
              </p>
            }

            <div class="mt-3 flex items-center gap-2">
              <button
                type="button"
                (click)="produce(item)"
                [disabled]="producingId() === item.id"
                class="inline-flex items-center gap-1 rounded bg-[#e59a38] px-2.5 py-1 text-[11px] font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-40"
              >
                <mat-icon class="text-[15px]">movie</mat-icon>
                <span>{{ producingId() === item.id ? 'Abrindo…' : 'Produzir esta pauta' }}</span>
              </button>
              @if (item.articles[0]; as first) {
                <a
                  [href]="first.url"
                  target="_blank"
                  rel="noreferrer"
                  class="text-[11px] text-slate-400 underline decoration-white/20 hover:text-slate-200"
                >
                  origem
                </a>
              }
            </div>
          </article>
        }
      </div>
    </section>
  `,
})
export class RadarView {
  private readonly store = inject(StudioStore);

  readonly created = output<void>();

  readonly scope = signal<RadarScope>('documental');
  readonly items = signal<RadarClusterItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly aiAvailable = signal(false);
  readonly onlyViral = signal(false);
  readonly viralCount = signal(0);
  readonly totalCandidates = signal(0);
  readonly producingId = signal<string | null>(null);

  readonly scopeHint = computed(() =>
    this.scope() === 'tendencias'
      ? 'O que está crescendo agora, em vários países e idiomas'
      : 'Histórias atemporais: como as coisas funcionam, descobertas, história e curiosidades do cotidiano',
  );

  private loaded = false;

  constructor() {
    effect(() => {
      if (this.loaded) return;
      this.loaded = true;
      void this.load(false);
    });
  }

  setScope(scope: RadarScope): void {
    if (this.scope() === scope) return;
    this.scope.set(scope);
    this.items.set([]);
    void this.load(false);
  }

  toggleOnlyViral(): void {
    this.onlyViral.update((value) => !value);
    this.items.set([]);
    void this.load(false);
  }

  viralLabel(rotulo: string): string {
    const labels: Record<string, string> = {
      viralizando: 'viralizando',
      repercutindo: 'repercutindo',
      emergente: 'emergente',
      isolada: 'pouco repercutido',
    };
    return labels[rotulo] ?? rotulo;
  }

  viralClass(rotulo: string): string {
    if (rotulo === 'viralizando') return 'text-emerald-300';
    if (rotulo === 'repercutindo') return 'text-[#f0aa4b]';
    if (rotulo === 'emergente') return 'text-slate-400';
    return 'text-slate-500';
  }

  async load(refresh: boolean): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const params = new URLSearchParams({ radar: this.scope() });
      if (refresh) params.set('refresh', '1');
      if (this.onlyViral()) params.set('viral', '2');
      const res = await fetch(`/api/radar?${params.toString()}`);
      const data = (await res.json()) as RadarResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      this.items.set(data.items ?? []);
      this.viralCount.set(Number(data.viralCount) || 0);
      this.totalCandidates.set(Number(data.totalCandidates) || 0);
      this.aiAvailable.set(Boolean(data.aiAvailable));
      if (!data.aiAvailable && data.message) this.error.set(data.message);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Falha ao consultar o Radar.');
    } finally {
      this.loading.set(false);
    }
  }

  ageLabel(item: RadarClusterItem): string {
    const hours = item.observed.idadeHoras;
    if (hours < 1) return 'agora';
    if (hours < 24) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }

  formatoLabel(formato: string): string {
    const labels: Record<string, string> = {
      noticia: 'notícia',
      minidocumentario: 'minidocumentário',
      curiosidade: 'curiosidade explicativa',
      investigativa: 'história investigativa',
      descoberta: 'narrativa de descoberta',
    };
    return labels[formato] ?? formato;
  }

  personalidadeLabel(personality: string): string {
    const labels: Record<string, string> = {
      documentario: 'documentário cinematográfico',
      misterioso: 'misterioso',
      impactante: 'impactante e dinâmico',
      explicativo: 'explicativo',
      jornalistico: 'jornalístico',
    };
    return labels[personality] ?? personality;
  }

  async produce(item: RadarClusterItem): Promise<void> {
    const first = item.articles[0];
    if (!first || this.producingId()) return;

    this.producingId.set(item.id);
    this.error.set(null);
    try {
      // Etapa 3 da criação: análise da pauta antes de produzir.
      let analysis: Record<string, unknown> | undefined;
      try {
        const res = await fetch('/api/radar/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.title,
            category: item.category,
            urls: item.articles.map((article) => article.url).slice(0, 4),
            excerpts: item.articles.map((article) => article.excerpt).filter(Boolean).slice(0, 4),
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { analysis?: Record<string, unknown> };
          analysis = data.analysis;
        }
      } catch {
        // Sem análise o fluxo continua: o roteiro usa só o dossiê.
      }

      const created = await this.store.addPauta({
        url: first.url,
        title: item.title,
        editorial: this.editorialFor(item.category),
        researchNow: true,
      });
      if (!created) return;

      const FORMATOS: RadarFormat[] = ['noticia', 'minidocumentario', 'curiosidade', 'investigativa', 'descoberta'];
      const PERSONALIDADES: RadarPersonality[] = ['documentario', 'misterioso', 'impactante', 'explicativo', 'jornalistico'];
      const formatoBruto = String(analysis?.['formato'] ?? item.ai?.formato ?? '');
      const personalidadeBruta = String(analysis?.['personalidade'] ?? item.ai?.personalidade ?? '');
      const formato = FORMATOS.includes(formatoBruto as RadarFormat) ? (formatoBruto as RadarFormat) : undefined;
      const personalidade = PERSONALIDADES.includes(personalidadeBruta as RadarPersonality)
        ? (personalidadeBruta as RadarPersonality)
        : undefined;
      const tecnicas = Array.isArray(analysis?.['tecnicas'])
        ? (analysis['tecnicas'] as string[])
        : undefined;

      this.store.setPautaRadar(created.id, {
        formato,
        personalidade,
        tecnicas,
        analise: analysis
          ? {
              fatos: Array.isArray(analysis['fatos']) ? (analysis['fatos'] as string[]) : undefined,
              incertos: Array.isArray(analysis['incertos'])
                ? (analysis['incertos'] as string[])
                : undefined,
              angulo: typeof analysis['angulo'] === 'string' ? analysis['angulo'] : undefined,
              gancho: typeof analysis['gancho'] === 'string' ? analysis['gancho'] : undefined,
              porqueInteressa:
                typeof analysis['porqueInteressa'] === 'string'
                  ? analysis['porqueInteressa']
                  : undefined,
            }
          : undefined,
        score: item.score,
        origem: item.articles[0]?.url,
      });

      this.created.emit();
    } finally {
      this.producingId.set(null);
    }
  }

  /** Encarta a categoria livre do radar nas editorias que o app já usa. */
  private editorialFor(category: string): EditorialCategory {
    const normalized = category.toLowerCase();
    if (normalized.includes('econom')) return 'Economia';
    if (normalized.includes('esport')) return 'Esportes';
    if (normalized.includes('celebr')) return 'Celebridades';
    if (
      normalized.includes('tecnolog') ||
      normalized.includes('ciência') ||
      normalized.includes('ciencia') ||
      normalized.includes('espaço') ||
      normalized.includes('espaco') ||
      normalized.includes('engenharia') ||
      normalized.includes('natureza')
    ) {
      return 'Tecnologia';
    }
    return 'Brasil';
  }
}
