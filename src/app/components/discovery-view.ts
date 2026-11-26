import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { EditorialCategory, NewsOutletFeedItem, ScriptVersionMode } from '../models/studio.models';
import { StudioStore } from '../services/studio-store';

const EDITORIALS: EditorialCategory[] = [
  'Todas',
  'Brasil',
  'Economia',
  'Tecnologia',
  'Entretenimento',
  'Celebridades',
  'Esportes',
];

@Component({
  selector: 'app-discovery-view',
  imports: [ReactiveFormsModule, MatIconModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-8">
      <!-- Cadastro de Pauta por URL -->
      <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight text-slate-50">
              Entrada de pauta e descoberta pública
            </h1>
            <p class="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-400">
              Cadastre um link de matéria pública ou selecione uma notícia dos feeds editoriais brasileiros. Links do X não são raspados: preserve a pauta e informe o assunto ou um link jornalístico público.
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              (click)="startDemo('short')"
              class="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px] leading-none">play_circle</mat-icon>
              <span>Prova técnica (45–60s)</span>
            </button>
            <button
              type="button"
              (click)="startDemo('expanded')"
              class="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px] leading-none">movie</mat-icon>
              <span>Prova técnica (90–150s)</span>
            </button>
          </div>
        </div>

        <form [formGroup]="intakeForm" class="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div class="lg:col-span-6">
            <label for="pauta-url" class="block text-xs font-medium text-slate-300">
              URL da matéria pública
            </label>
            <input
              id="pauta-url"
              type="url"
              formControlName="url"
              placeholder="https://g1.globo.com/..."
              class="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
            />
          </div>

          <div class="lg:col-span-4">
            <label for="pauta-title" class="block text-xs font-medium text-slate-300">
              Título ou assunto (opcional — obrigatório para link do X)
            </label>
            <input
              id="pauta-title"
              type="text"
              formControlName="title"
              placeholder="Ex.: Nova regra do Pix entra em vigor..."
              class="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
            />
          </div>

          <div class="lg:col-span-2">
            <label for="pauta-editorial" class="block text-xs font-medium text-slate-300">
              Editoria
            </label>
            <select
              id="pauta-editorial"
              formControlName="editorial"
              class="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2.5 text-sm text-slate-100 focus:border-[#e59a38] focus:outline-none"
            >
              @for (ed of selectableEditorials; track ed) {
                <option [value]="ed">{{ ed }}</option>
              }
            </select>
          </div>

          <div class="lg:col-span-12 flex flex-wrap items-center justify-between gap-4 pt-1">
            <p class="text-xs text-slate-400">
              Extração local bloqueia endereços de rede privada, respeita timeout e não envia dados para terceiros na captura.
            </p>
            <div class="flex flex-wrap items-center gap-3 shrink-0">
              <button
                type="button"
                (click)="submitUrl(false)"
                [disabled]="store.researchBusy()"
                class="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-transparent px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">bookmark_add</mat-icon>
                <span>Adicionar pauta</span>
              </button>
              <button
                type="button"
                (click)="submitUrl(true)"
                [disabled]="store.researchBusy()"
                class="inline-flex items-center gap-2 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] transition-colors hover:bg-[#f0aa4b] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">travel_explore</mat-icon>
                <span>{{ store.researchBusy() ? 'Pesquisando fontes...' : 'Adicionar e pesquisar matéria' }}</span>
              </button>
            </div>
          </div>
        </form>
      </section>

      <!-- Feeds Públicos dos Veículos Configurados -->
      <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
        <div class="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <h2 class="text-lg font-semibold text-slate-100">
              Monitoramento de feeds públicos brasileiros
            </h2>
            <p class="mt-0.5 text-xs text-slate-400">
              g1 · Folha de S.Paulo · UOL · R7 · Metrópoles · Agência Brasil · CNN · Poder360 · Google News · TecMundo · ge · ESPN
              @if (store.feedTotalCount() > 0) {
                <span class="text-slate-300 font-mono-tabular">
                  · {{ store.feedRespondedCount() }} de {{ store.feedTotalCount() }} feeds responderam
                </span>
              }
              @if (store.feedNewestAt(); as newest) {
                <span class="text-slate-300 font-mono-tabular">
                  · mais recente {{ newest | date: 'dd/MM HH:mm' }}
                </span>
              }
              @if (store.viralOnly()) {
                <span class="text-[#f5c273]">· ordenado por viralidade</span>
              }
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <!-- Filtro principal: virais no lugar da lista completa -->
            <div class="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0a0d12] p-1">
              <button
                type="button"
                (click)="store.setViralOnly(true)"
                class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                [class.bg-[#e59a38]]="store.viralOnly()"
                [class.text-[#0a0d12]]="store.viralOnly()"
                [class.text-slate-300]="!store.viralOnly()"
              >
                🔥 Virais
              </button>
              <button
                type="button"
                (click)="store.setViralOnly(false)"
                class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                [class.bg-white/15]="!store.viralOnly()"
                [class.text-white]="!store.viralOnly()"
                [class.text-slate-400]="store.viralOnly()"
              >
                Tudo
              </button>
            </div>
            <input
              type="search"
              [formControl]="feedSearchControl"
              placeholder="Filtrar manchetes por termo..."
              class="w-60 rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
            />
            <select
              aria-label="Janela de atualidade das notícias"
              [value]="store.feedMaxAgeHours()"
              (change)="onMaxAgeChange($event)"
              class="rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-1.5 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
            >
              <option [value]="24">Últimas 24 h</option>
              <option [value]="48">Últimas 48 h</option>
              <option [value]="72">Últimos 3 dias</option>
              <option [value]="168">Últimos 7 dias</option>
              <option [value]="0">Sem filtro de data</option>
            </select>
            <button
              type="button"
              (click)="store.loadFeeds(true)"
              [disabled]="store.feedsLoading()"
              class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px]">refresh</mat-icon>
              <span>{{ store.feedsLoading() ? 'Atualizando...' : 'Atualizar feeds' }}</span>
            </button>
          </div>
        </div>

        <!-- Filtros de editoria (controles funcionais) -->
        <div class="mt-4 flex flex-wrap items-center gap-1.5">
          @for (ed of editorials; track ed) {
            <button
              type="button"
              (click)="selectedEditorial.set(ed)"
              class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
              [class.bg-[#e59a38]]="selectedEditorial() === ed"
              [class.text-[#0a0d12]]="selectedEditorial() === ed"
              [class.bg-[#0a0d12]]="selectedEditorial() !== ed"
              [class.text-slate-300]="selectedEditorial() !== ed"
              [class.hover:text-white]="selectedEditorial() !== ed"
            >
              {{ ed }}
            </button>
          }
        </div>

        @if (store.feedsError()) {
          <div class="mt-4 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-xs text-red-200">
            {{ store.feedsError() }}
          </div>
        }

        @if (failedFeedOutlets().length > 0) {
          <p class="mt-3 text-xs text-amber-300/90">
            Feeds indisponíveis nesta rodada (os demais resultados permanecem ativos): {{ failedFeedOutlets().join(', ') }}.
          </p>
        }
        @if (staleFeedOutlets().length > 0) {
          <p class="mt-2 text-xs text-slate-400">
            Fontes sem publicação recente (respondem, mas estão paradas): {{ staleFeedOutlets().join(', ') }}.
          </p>
        }

        @if (store.feedsLoading() && filteredFeedItems().length === 0) {
          <div class="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            @for (n of [1, 2, 3, 4]; track n) {
              <div class="h-28 rounded-lg border border-white/5 bg-[#0a0d12]/70 p-4">
                <div class="h-3 w-32 rounded bg-white/10"></div>
                <div class="mt-3 h-4 w-5/6 rounded bg-white/10"></div>
                <div class="mt-2 h-3 w-2/3 rounded bg-white/5"></div>
              </div>
            }
          </div>
        } @else if (filteredFeedItems().length === 0) {
          <div class="mt-5 rounded-lg border border-white/10 bg-[#0a0d12] p-8 text-center">
            <p class="text-sm text-slate-300">Nenhuma manchete corresponde aos filtros atuais.</p>
            <button
              type="button"
              (click)="resetFeedFilters()"
              class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5"
            >
              <mat-icon class="text-[15px]">filter_alt_off</mat-icon>
              <span>Limpar filtros</span>
            </button>
          </div>
        } @else {
          <div class="mt-5 divide-y divide-white/10 rounded-lg border border-white/10 bg-[#0a0d12]">
            @for (item of filteredFeedItems().slice(0, visibleCount()); track item.id) {
              <article class="flex flex-col justify-between gap-3 p-4 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span class="font-medium text-slate-200">{{ item.outlet }}</span>
                    <span aria-hidden="true">·</span>
                    <span>{{ item.editorial }}</span>
                    <span aria-hidden="true">·</span>
                    <span class="font-mono-tabular">{{ item.publishedAt | date: 'dd/MM HH:mm' }}</span>
                  </div>
                  <h3 class="mt-1 text-sm font-semibold leading-snug text-slate-100">
                    {{ item.title }}
                  </h3>
                  @if (item.viralScore) {
                    <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span class="rounded bg-[#e59a38]/15 px-1.5 py-0.5 text-[10px] font-semibold font-mono-tabular text-[#f5c273]">
                        🔥 {{ item.viralScore }}
                      </span>
                      @for (reason of item.viralReasons ?? []; track reason) {
                        <span class="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-400">
                          {{ reason }}
                        </span>
                      }
                    </div>
                  }
                  @if (item.excerpt) {
                    <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {{ item.excerpt }}
                    </p>
                  }
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <a
                    [href]="item.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
                  >
                    <mat-icon class="text-[15px]">open_in_new</mat-icon>
                    <span>Ler</span>
                  </a>
                  <button
                    type="button"
                    (click)="pickFeedItem(item)"
                    [disabled]="store.researchBusy()"
                    class="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-[#e59a38] hover:text-[#0a0d12] disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <mat-icon class="text-[15px]">add_task</mat-icon>
                    <span>Criar pauta e pesquisar</span>
                  </button>
                </div>
              </article>
            }
          </div>

          @if (filteredFeedItems().length > visibleCount()) {
            <div class="mt-3 flex items-center justify-between gap-3">
              <span class="text-xs text-slate-400 font-mono-tabular">
                {{ visibleCount() }} de {{ filteredFeedItems().length }} manchetes
              </span>
              <button
                type="button"
                (click)="showMore()"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap"
              >
                <mat-icon class="text-[15px]">expand_more</mat-icon>
                <span>Mostrar mais manchetes</span>
              </button>
            </div>
          }
        }
      </section>
    </div>
  `,
})
export class DiscoveryView {
  readonly store = inject(StudioStore);
  readonly navigateToDossier = output<void>();
  readonly navigateToStudio = output<void>();

  readonly editorials = EDITORIALS;
  readonly selectableEditorials: EditorialCategory[] = EDITORIALS.filter((e) => e !== 'Todas');
  readonly selectedEditorial = signal<EditorialCategory>('Todas');
  readonly feedQuery = signal('');
  readonly visibleCount = signal(30);

  readonly feedSearchControl = new FormControl('', { nonNullable: true });

  readonly intakeForm = new FormGroup({
    url: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    title: new FormControl('', { nonNullable: true }),
    editorial: new FormControl<EditorialCategory>('Brasil', { nonNullable: true }),
  });

  readonly failedFeedOutlets = computed(() =>
    this.store
      .feedStatuses()
      .filter((s) => s.status === 'error')
      .map((s) => s.outlet),
  );

  /** Fontes que respondem mas não publicam nada recente. */
  readonly staleFeedOutlets = computed(() => {
    const statuses = this.store.feedStatuses();
    const counts = new Map<string, number>();
    for (const status of statuses) counts.set(status.outlet, (counts.get(status.outlet) ?? 0) + 1);

    return statuses
      .filter((s) => s.status === 'ok' && s.stale)
      // Quando o veículo tem vários feeds, dizer qual seção parou (ex.: g1-ciencia).
      .map((s) => ((counts.get(s.outlet) ?? 0) > 1 ? `${s.outlet} (${s.id})` : s.outlet));
  });

  readonly filteredFeedItems = computed(() => {
    const ed = this.selectedEditorial();
    const q = this.feedQuery().trim().toLowerCase();
    return this.store.feedItems().filter((item) => {
      const matchEd = ed === 'Todas' || item.editorial.toLowerCase() === ed.toLowerCase();
      const matchQ =
        !q ||
        item.title.toLowerCase().includes(q) ||
        item.outlet.toLowerCase().includes(q) ||
        item.excerpt.toLowerCase().includes(q);
      return matchEd && matchQ;
    });
  });

  constructor() {
    this.feedSearchControl.valueChanges.subscribe((val) => {
      this.feedQuery.set(val);
    });
  }

  async submitUrl(researchNow: boolean): Promise<void> {
    const raw = this.intakeForm.getRawValue();
    const created = await this.store.addPauta({
      url: raw.url,
      title: raw.title,
      editorial: raw.editorial,
      researchNow,
    });
    if (created) {
      this.intakeForm.patchValue({ url: '', title: '' });
      if (researchNow) {
        this.navigateToDossier.emit();
      }
    }
  }

  async pickFeedItem(item: NewsOutletFeedItem): Promise<void> {
    const ed: EditorialCategory = this.selectableEditorials.includes(item.editorial as EditorialCategory)
      ? (item.editorial as EditorialCategory)
      : 'Brasil';
    const created = await this.store.addPauta({
      url: item.url,
      title: item.title,
      editorial: ed,
      researchNow: true,
    });
    if (created) {
      this.navigateToDossier.emit();
    }
  }

  startDemo(mode: ScriptVersionMode): void {
    this.store.createDemoPauta(mode);
    this.navigateToStudio.emit();
  }

  resetFeedFilters(): void {
    this.selectedEditorial.set('Todas');
    this.feedSearchControl.setValue('');
    this.visibleCount.set(30);
  }

  onMaxAgeChange(event: Event): void {
    const hours = Number((event.target as HTMLSelectElement).value);
    this.visibleCount.set(30);
    this.store.setFeedMaxAge(Number.isFinite(hours) ? hours : 72);
  }

  showMore(): void {
    this.visibleCount.update((count) => count + 30);
  }
}
