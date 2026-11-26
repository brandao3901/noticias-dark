import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

interface ChromeMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * Vigia de memória da aba.
 *
 * O Chrome derruba a página com "Out of Memory" quando o heap passa do limite.
 * Avisamos antes, com botão de recarregar (o estado vem do servidor, nada se perde).
 *
 * `performance.memory` só existe no Chromium; em outros navegadores o vigia fica mudo.
 */
@Component({
  selector: 'app-memory-guard',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (warning()) {
      <div
        class="fixed bottom-4 left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 rounded-xl border border-amber-500/40 bg-[#1a1206] p-3 shadow-2xl"
        role="status"
      >
        <div class="flex items-start gap-3">
          <mat-icon class="text-[20px] text-amber-300">memory</mat-icon>
          <div class="flex-1">
            <p class="text-xs font-semibold text-amber-200">A página está usando muita memória</p>
            <p class="mt-1 text-[11px] text-amber-100/80">
              {{ usedLabel() }} de heap. Recarregar libera a memória — pautas, roteiro e voz
              continuam salvos no servidor.
            </p>
          </div>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              (click)="reload()"
              class="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-[#0a0d12] hover:bg-amber-400"
            >
              Recarregar
            </button>
            <button
              type="button"
              (click)="lightMode()"
              class="rounded border border-white/15 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/10"
              title="Desliga o vídeo de prévia e mantém só a imagem"
            >
              Modo leve
            </button>
            <button
              type="button"
              (click)="dismiss()"
              class="rounded border border-white/15 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/10"
            >
              Depois
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class MemoryGuard {
  private readonly destroyRef = inject(DestroyRef);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly warning = signal(false);
  readonly usedLabel = signal('');

  /** Limite de aviso: bem abaixo do que derruba a aba (~4 GB). */
  private readonly threshold = 600 * 1024 * 1024;

  constructor() {
    if (typeof window === 'undefined' || typeof performance === 'undefined') return;

    const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
    if (!memory) return;

    this.timer = setInterval(() => {
      const used = Number(memory.usedJSHeapSize) || 0;
      const limit = Number(memory.jsHeapSizeLimit) || 0;
      const nearLimit = limit > 0 && used > limit * 0.55;
      const overThreshold = used > this.threshold;

      if (overThreshold || nearLimit) {
        this.usedLabel.set(`${Math.round(used / (1024 * 1024))} MB`);
        this.warning.set(true);
      }
    }, 20_000);

    this.destroyRef.onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  dismiss(): void {
    this.warning.set(false);
  }

  lightMode(): void {
    try {
      localStorage.setItem('canal_dark_modo_leve', '1');
    } catch {
      // sem localStorage: segue sem modo leve
    }
    window.location.reload();
  }

  reload(): void {
    window.location.reload();
  }
}
