import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { StudioStore } from '../services/studio-store';

interface KokoroVoiceView {
  id: string;
  label: string;
  description: string;
}

interface KokoroStateView {
  modelsReady: boolean;
  voices: KokoroVoiceView[];
  current: { a?: string; b?: string; mix?: number; speed?: number; lang?: string } | null;
  default: { engine: string; voice: string };
}

const PURE_VOICES = ['pm_alex', 'pf_dora', 'pm_santa'];

/**
 * Estúdio de voz do canal (Kokoro, offline).
 *
 * A mistura salva aqui vira a voz de **todas** as pautas: o servidor segue
 * `config.json.default` no render, então não é preciso configurar pauta por pauta.
 */
@Component({
  selector: 'app-kokoro-voice-studio',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-slate-100">Voz do canal (Kokoro offline)</h2>
          <p class="mt-1 text-xs text-slate-400">
            Mistura duas vozes e grava como padrão. <strong class="text-slate-200">Todos os vídeos</strong>
            passam a usar esta voz — não precisa configurar em cada pauta.
          </p>
        </div>
        <span
          class="rounded px-2 py-1 text-[10px]"
          [class.bg-emerald-500/15]="statusLabel() === 'Pronta'"
          [class.text-emerald-300]="statusLabel() === 'Pronta'"
          [class.bg-amber-500/15]="statusLabel() !== 'Pronta'"
          [class.text-amber-200]="statusLabel() !== 'Pronta'"
        >
          {{ statusLabel() }}
        </span>
      </div>

      @if (!modelsReady()) {
        <p class="mt-4 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          Modelos ausentes. Rode <code class="text-amber-100">python python/download_models.py</code>
          (uma vez, ~354 MB) e recarregue a página.
        </p>
      } @else {
        <div class="mt-5 grid gap-4 md:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-slate-300">Voz 1</span>
            <select
              [value]="voiceA()"
              (change)="voiceA.set(pick($event))"
              class="rounded border border-white/15 bg-[#0d121b] px-2 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
            >
              @for (voice of pureVoices(); track voice.id) {
                <option [value]="voice.id">{{ voice.label }} — {{ voice.description }}</option>
              }
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-slate-300">Voz 2</span>
            <select
              [value]="voiceB()"
              (change)="voiceB.set(pick($event))"
              class="rounded border border-white/15 bg-[#0d121b] px-2 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
            >
              @for (voice of pureVoices(); track voice.id) {
                <option [value]="voice.id">{{ voice.label }} — {{ voice.description }}</option>
              }
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-slate-300">
              Mistura — {{ mixPercent() }}% {{ voiceA() }} + {{ 100 - mixPercent() }}% {{ voiceB() }}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              [value]="mixPercent()"
              (input)="onMix($event)"
              class="accent-[#e59a38]"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-slate-300">
              Velocidade — {{ speed().toFixed(2) }}x
            </span>
            <input
              type="range"
              min="0.7"
              max="1.4"
              step="0.05"
              [value]="speed()"
              (input)="onSpeed($event)"
              class="accent-[#e59a38]"
            />
          </label>
        </div>

        <label class="mt-4 flex flex-col gap-1">
          <span class="text-[11px] font-medium text-slate-300">Frase de teste</span>
          <textarea
            rows="2"
            [value]="phrase()"
            (input)="phrase.set($any($event.target).value)"
            class="w-full rounded border border-white/15 bg-[#0d121b] px-2 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
          ></textarea>
        </label>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            (click)="playPreview()"
            [disabled]="busy()"
            class="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40"
          >
            <mat-icon class="text-[16px]">{{ busy() ? 'hourglass_top' : 'volume_up' }}</mat-icon>
            <span>{{ busy() ? 'Sintetizando…' : 'Ouvir prévia' }}</span>
          </button>

          <button
            type="button"
            (click)="saveVoice()"
            [disabled]="saving() || busy()"
            class="inline-flex items-center gap-1 rounded bg-[#e59a38] px-3 py-1.5 text-xs font-semibold text-[#0d121b] hover:bg-[#f0aa4b] disabled:opacity-40"
          >
            <mat-icon class="text-[16px]">save</mat-icon>
            <span>{{ saving() ? 'Salvando…' : 'Salvar como voz do canal' }}</span>
          </button>

          <span class="text-[11px] text-slate-400">{{ summary() }}</span>
        </div>

        @if (message(); as msg) {
          <p
            class="mt-3 text-[11px]"
            [class.text-emerald-300]="msg.kind === 'ok'"
            [class.text-amber-300]="msg.kind === 'warn'"
          >
            {{ msg.text }}
          </p>
        }
      }
    </section>
  `,
})
export class KokoroVoiceStudio {
  private readonly store = inject(StudioStore);
  readonly pauta = this.store.activePauta;

  readonly voices = signal<KokoroVoiceView[]>([]);
  readonly modelsReady = signal(true);

  readonly voiceA = signal('pm_alex');
  readonly voiceB = signal('pf_dora');
  readonly mixPercent = signal(70);
  readonly speed = signal(1);
  readonly phrase = signal(
    'O comitê manteve a taxa de juros em quinze por cento ao ano. Você acha que vai cair?',
  );

  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly message = signal<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  readonly pureVoices = computed(() => {
    const list = this.voices().filter((voice) => PURE_VOICES.includes(voice.id));
    return list.length ? list : this.voices();
  });

  readonly statusLabel = computed(() => (this.modelsReady() ? 'Pronta' : 'Modelos ausentes'));

  readonly summary = computed(
    () => `${this.mixPercent()}% ${this.voiceA()} + ${100 - this.mixPercent()}% ${this.voiceB()} · ${this.speed().toFixed(2)}x`,
  );

  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private loaded = false;

  constructor() {
    effect(() => {
      if (this.loaded) return;
      this.loaded = true;
      void this.loadState();
    });
  }

  pick(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  onMix(event: Event): void {
    this.mixPercent.set(this.clamp(Number((event.target as HTMLInputElement).value)));
  }

  onSpeed(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.speed.set(value);
  }

  clamp(value: number): number {
    return Math.min(100, Math.max(0, value));
  }

  private async loadState(): Promise<void> {
    try {
      const res = await fetch('/api/kokoro/state');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as KokoroStateView;
      this.modelsReady.set(data.modelsReady);
      this.voices.set(data.voices ?? []);
      const current = data.current;
      if (current?.a) this.voiceA.set(current.a);
      if (current?.b) this.voiceB.set(current.b);
      if (typeof current?.mix === 'number') this.mixPercent.set(Math.round(current.mix * 100));
      if (typeof current?.speed === 'number') this.speed.set(current.speed);
      if (!data.modelsReady) {
        this.message.set({
          kind: 'warn',
          text: 'Rode python python/download_models.py para habilitar o estúdio.',
        });
      }
    } catch (err) {
      this.message.set({
        kind: 'warn',
        text: err instanceof Error ? err.message : 'Falha ao ler a configuração de voz.',
      });
    }
  }

  async playPreview(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);

    try {
      const res = await fetch('/api/kokoro/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          a: this.voiceA(),
          b: this.voiceB(),
          mix: this.mixPercent() / 100,
          speed: this.speed(),
          text: this.phrase(),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Falha na prévia (HTTP ${res.status}).`);
      }

      const blob = await res.blob();
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(blob);
      this.audio = this.audio ?? new Audio();
      this.audio.src = this.objectUrl;
      await this.audio.play().catch(() => undefined);
    } catch (err) {
      this.message.set({
        kind: 'warn',
        text: err instanceof Error ? err.message : 'Erro ao gerar a prévia.',
      });
    } finally {
      this.busy.set(false);
    }
  }

  async saveVoice(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.message.set(null);

    try {
      const res = await fetch('/api/kokoro/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          a: this.voiceA(),
          b: this.voiceB(),
          mix: this.mixPercent() / 100,
          speed: this.speed(),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Falha ao salvar (HTTP ${res.status}).`);
      }

      const pauta = this.pauta();
      if (pauta) {
        // A pauta aberta passa a seguir a voz do canal (e o render também).
        this.store.updateNarrationState(pauta.id, {
          engine: 'kokoro',
          voiceName: 'blend',
          rate: this.speed(),
          useChannelVoice: true,
        });
      }

      this.message.set({
        kind: 'ok',
        text: `Voz do canal salva: ${this.summary()}. Vale para todas as pautas.`,
      });
    } catch (err) {
      this.message.set({
        kind: 'warn',
        text: err instanceof Error ? err.message : 'Erro ao salvar a voz do canal.',
      });
    } finally {
      this.saving.set(false);
    }
  }
}
