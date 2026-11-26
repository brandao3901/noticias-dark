import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { DiscoveryView } from './components/discovery-view';
import { DossierView } from './components/dossier-view';
import { MemoryGuard } from './components/memory-guard';
import { MediaVoiceView } from './components/media-voice-view';
import { ScriptView } from './components/script-view';
import { StudioQcView } from './components/studio-qc-view';
import { SpeechPreview } from './services/speech-preview';
import { StudioStore } from './services/studio-store';

type StudioTab = 'discovery' | 'dossier' | 'script' | 'media' | 'studio';

@Component({
  selector: 'app-root',
  imports: [
    MatIconModule,
    DatePipe,
    DiscoveryView,
    DossierView,
    MemoryGuard,
    ScriptView,
    MediaVoiceView,
    StudioQcView,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen flex flex-col bg-[#0a0d12] text-[#e6eaf0]">
      <app-memory-guard />
      <!-- Top Bar Contract: 3 zonas (Marca, 5 links de uma linha, 1 ação primária) -->
      <header class="sticky top-0 z-30 border-b border-white/10 bg-[#0a0d12]/95 backdrop-blur">
        <div class="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#descoberta"
            (click)="setTab('discovery', $event)"
            class="font-display text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0"
          >
            Canal Dark
          </a>

          <nav class="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <button
              type="button"
              (click)="activeTab.set('discovery')"
              class="py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-100"
              [class.text-slate-50]="activeTab() === 'discovery'"
              [class.underline]="activeTab() === 'discovery'"
              [class.underline-offset-8]="activeTab() === 'discovery'"
            >
              Descoberta
            </button>
            <button
              type="button"
              (click)="activeTab.set('dossier')"
              class="py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-100"
              [class.text-slate-50]="activeTab() === 'dossier'"
              [class.underline]="activeTab() === 'dossier'"
              [class.underline-offset-8]="activeTab() === 'dossier'"
            >
              Dossiê
            </button>
            <button
              type="button"
              (click)="activeTab.set('script')"
              class="py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-100"
              [class.text-slate-50]="activeTab() === 'script'"
              [class.underline]="activeTab() === 'script'"
              [class.underline-offset-8]="activeTab() === 'script'"
            >
              Roteiro
            </button>
            <button
              type="button"
              (click)="activeTab.set('media')"
              class="py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-100"
              [class.text-slate-50]="activeTab() === 'media'"
              [class.underline]="activeTab() === 'media'"
              [class.underline-offset-8]="activeTab() === 'media'"
            >
              Mídia e Voz
            </button>
            <button
              type="button"
              (click)="activeTab.set('studio')"
              class="py-1 transition-colors whitespace-nowrap shrink-0 hover:text-slate-100"
              [class.text-slate-50]="activeTab() === 'studio'"
              [class.underline]="activeTab() === 'studio'"
              [class.underline-offset-8]="activeTab() === 'studio'"
            >
              Estúdio e QC
            </button>
          </nav>

          <div class="flex items-center shrink-0">
            <button
              type="button"
              (click)="goToNewPauta()"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] transition-colors hover:bg-[#f0aa4b] whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px]">add</mat-icon>
              <span>Nova pauta</span>
            </button>
          </div>
        </div>
      </header>

      <!-- Navegação móvel compacta -->
      <div class="flex md:hidden items-center gap-2 overflow-x-auto border-b border-white/10 bg-[#111620] px-4 py-2 text-xs">
        <button type="button" (click)="activeTab.set('discovery')" class="px-2.5 py-1 rounded whitespace-nowrap" [class.bg-white/10]="activeTab() === 'discovery'">Descoberta</button>
        <button type="button" (click)="activeTab.set('dossier')" class="px-2.5 py-1 rounded whitespace-nowrap" [class.bg-white/10]="activeTab() === 'dossier'">Dossiê</button>
        <button type="button" (click)="activeTab.set('script')" class="px-2.5 py-1 rounded whitespace-nowrap" [class.bg-white/10]="activeTab() === 'script'">Roteiro</button>
        <button type="button" (click)="activeTab.set('media')" class="px-2.5 py-1 rounded whitespace-nowrap" [class.bg-white/10]="activeTab() === 'media'">Mídia e Voz</button>
        <button type="button" (click)="activeTab.set('studio')" class="px-2.5 py-1 rounded whitespace-nowrap" [class.bg-white/10]="activeTab() === 'studio'">Estúdio e QC</button>
      </div>

      <!-- Corpo principal: Fila lateral de pautas + Área de trabalho -->
      <div class="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 px-6 py-6 lg:flex-row">
        <!-- Fila lateral de pautas -->
        <aside class="w-full shrink-0 lg:w-[270px]">
          <div class="rounded-xl border border-white/10 bg-[#111620] p-4">
            <div class="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 class="text-sm font-semibold text-slate-100">Fila de pautas</h2>
              <span class="text-xs font-mono-tabular text-slate-400">{{ store.pautas().length }}</span>
            </div>

            @if (store.pautas().length === 0) {
              <p class="mt-4 text-xs leading-relaxed text-slate-400">
                Nenhuma pauta salva ainda. Cole um link ou escolha uma manchete na aba Descoberta.
              </p>
            } @else {
              <ul class="mt-3 space-y-2 max-h-[65vh] overflow-y-auto pr-1">
                @for (p of store.pautas(); track p.id) {
                  <li
                    class="rounded-lg border p-3 transition-colors"
                    [class.border-[#e59a38]]="store.activePautaId() === p.id"
                    [class.bg-[#0a0d12]]="store.activePautaId() === p.id"
                    [class.border-white/10]="store.activePautaId() !== p.id"
                    [class.hover:bg-white/[0.03]]="store.activePautaId() !== p.id"
                  >
                    <button
                      type="button"
                      (click)="selectFromQueue(p.id)"
                      class="w-full text-left"
                    >
                      <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                        <span class="truncate font-medium text-slate-300">{{ p.editorial }}</span>
                        <span class="font-mono-tabular shrink-0">{{ p.stage }}</span>
                      </div>
                      <div class="mt-1 line-clamp-2 text-xs font-medium text-slate-100">
                        {{ p.title }}
                      </div>
                    </button>
                    <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span class="font-mono-tabular">{{ p.updatedAt | date: 'dd/MM HH:mm' }}</span>
                      <button
                        type="button"
                        (click)="removePauta($event, p.id)"
                        class="text-slate-400 hover:text-red-300"
                        title="Excluir pauta"
                      >
                        <mat-icon class="text-[14px]">close</mat-icon>
                      </button>
                    </div>
                  </li>
                }
              </ul>
            }
          </div>
        </aside>

        <!-- Área principal -->
        <main class="min-w-0 flex-1 space-y-5">
          @if (store.actionFeedback(); as fb) {
            <div
              class="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs"
              [class.border-red-500/35]="fb.type === 'error'"
              [class.bg-red-950/25]="fb.type === 'error'"
              [class.text-red-200]="fb.type === 'error'"
              [class.border-amber-500/35]="fb.type === 'warn'"
              [class.bg-amber-950/25]="fb.type === 'warn'"
              [class.text-amber-200]="fb.type === 'warn'"
              [class.border-white/15]="fb.type === 'info'"
              [class.bg-[#111620]]="fb.type === 'info'"
              [class.text-slate-200]="fb.type === 'info'"
            >
              <span>{{ fb.text }}</span>
              <button type="button" (click)="store.clearFeedback()" class="shrink-0 opacity-75 hover:opacity-100">
                <mat-icon class="text-[16px]">close</mat-icon>
              </button>
            </div>
          }

          @switch (activeTab()) {
            @case ('discovery') {
              <app-discovery-view
                (navigateToDossier)="activeTab.set('dossier')"
                (navigateToStudio)="activeTab.set('studio')"
              />
            }
            @case ('dossier') {
              <app-dossier-view (goToScript)="activeTab.set('script')" />
            }
            @case ('script') {
              <app-script-view (goToMedia)="activeTab.set('media')" />
            }
            @case ('media') {
              <app-media-voice-view (goToStudio)="activeTab.set('studio')" />
            }
            @case ('studio') {
              <app-studio-qc-view />
            }
          }
        </main>
      </div>
    </div>
  `,
})
export class App {
  readonly store = inject(StudioStore);
  private readonly speech = inject(SpeechPreview);
  readonly activeTab = signal<StudioTab>('discovery');

  setTab(tab: StudioTab, ev: Event): void {
    ev.preventDefault();
    this.activeTab.set(tab);
  }

  goToNewPauta(): void {
    this.activeTab.set('discovery');
  }

  selectFromQueue(id: string): void {
    this.speech.stop();
    this.store.selectPauta(id);
    if (this.activeTab() === 'discovery') {
      this.activeTab.set('dossier');
    }
  }

  removePauta(ev: Event, id: string): void {
    ev.stopPropagation();
    this.store.deletePauta(id);
  }
}
