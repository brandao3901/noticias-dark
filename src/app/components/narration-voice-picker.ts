import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { StudioStore } from '../services/studio-store';

interface TtsVoiceView {
  id: string;
  engine: 'kokoro' | 'gemini' | 'edge';
  label: string;
  description: string;
}

interface TtsStatusView {
  defaultEngine: 'kokoro' | 'gemini' | 'edge';
  defaultStyle: string;
  voices: TtsVoiceView[];
  styles: Array<{ id: string; label: string }>;
  configured: boolean;
  model: string;
  paused: boolean;
}

/**
 * Escolha da voz da narração: motor (Gemini TTS / Edge), voz, estilo e amostra.
 *
 * A escolha é gravada em `pauta.narration` e é o que o render usa — a tela não
 * decide nada por conta própria, então prévia e arquivo final usam a mesma voz.
 */
@Component({
  selector: 'app-narration-voice-picker',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pauta(); as p) {
      <div class="space-y-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-[11px] font-medium text-slate-300">Voz da narração</label>
          @if (status(); as st) {
            <span
              class="rounded px-1.5 py-0.5 text-[10px]"
              [class.bg-emerald-500/15]="!st.paused"
              [class.text-emerald-300]="!st.paused"
              [class.bg-amber-500/15]="st.paused"
              [class.text-amber-200]="st.paused"
            >
              {{ st.paused ? 'Gemini TTS pausado (cota)' : st.model }}
            </span>
          }
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <select
            aria-label="Motor de voz"
            [value]="engine()"
            (change)="onEngine($event)"
            class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
          >
            <option value="kokoro">Kokoro offline (voz do canal)</option>
            <option value="gemini">Gemini TTS (recomendado)</option>
            <option value="edge">Edge neural (reserva)</option>
          </select>

          <select
            aria-label="Voz"
            [value]="p.narration.voiceName || defaultVoiceId()"
            (change)="onVoice($event)"
            class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
          >
            @for (voice of voicesForEngine(); track voice.id) {
              <option [value]="voice.id">{{ voice.label }} — {{ voice.description }}</option>
            }
          </select>

          @if (engine() === 'gemini') {
            <select
              aria-label="Estilo da narração"
              [value]="p.narration.style || defaultStyle()"
              (change)="onStyle($event)"
              class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
            >
              @for (style of styles(); track style.id) {
                <option [value]="style.id">{{ style.label }}</option>
              }
            </select>
          }

          <button
            type="button"
            (click)="playSample()"
            [disabled]="loadingSample()"
            class="inline-flex items-center gap-1 rounded border border-white/15 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40"
          >
            <mat-icon class="text-[15px]">{{ loadingSample() ? 'hourglass_top' : 'volume_up' }}</mat-icon>
            <span>{{ loadingSample() ? 'Gerando amostra…' : 'Ouvir amostra' }}</span>
          </button>
        </div>

        @if (error(); as message) {
          <p class="text-[11px] text-amber-300">{{ message }}</p>
        }
        @if (engine() === 'gemini') {
          <p class="text-[10px] text-slate-500">
            Gemini TTS usa a cota gratuita da chave já configurada; se a cota estourar, o render cai
            automaticamente na voz reserva do Edge.
          </p>
        }
      </div>
    }
  `,
})
export class NarrationVoicePicker {
  readonly store = inject(StudioStore);
  readonly pauta = this.store.activePauta;

  readonly status = signal<TtsStatusView | null>(null);
  readonly loadingSample = signal(false);
  readonly error = signal<string | null>(null);

  readonly engine = computed<'kokoro' | 'gemini' | 'edge'>(() => {
    const narration = this.pauta()?.narration;
    if (narration?.engine === 'kokoro' || narration?.engine === 'edge' || narration?.engine === 'gemini') {
      return narration.engine;
    }
    // Pauta antiga com voz Edge salva no nome: respeita o prefixo.
    if (narration?.voiceName?.startsWith('pt-BR-')) return 'edge';
    return this.status()?.defaultEngine ?? 'kokoro';
  });

  readonly voicesForEngine = computed(() => {
    const all = this.status()?.voices ?? [];
    const engine = this.engine();
    const filtered = all.filter((voice) => voice.engine === engine);
    return filtered.length ? filtered : all;
  });

  readonly defaultVoiceId = computed(() => this.voicesForEngine()[0]?.id ?? 'Kore');
  readonly defaultStyle = computed(() => this.status()?.defaultStyle ?? 'ancora');
  readonly styles = computed(() =>
    this.status()?.styles?.length
      ? this.status()!.styles
      : [
          { id: 'ancora', label: 'Âncora de telejornal' },
          { id: 'explicativo', label: 'Explicativo' },
          { id: 'urgente', label: 'Urgente' },
          { id: 'leve', label: 'Leve' },
          { id: 'neutro', label: 'Neutro' },
        ],
  );

  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private loaded = false;

  constructor() {
    effect(() => {
      if (this.loaded) return;
      this.loaded = true;
      void this.loadStatus();
    });
  }

  private async loadStatus(): Promise<void> {
    try {
      const res = await fetch('/api/config/status');
      if (!res.ok) return;
      const data = (await res.json()) as { tts?: TtsStatusView };
      if (data.tts) this.status.set(data.tts);
    } catch {
      // Sem status: a interface mantém os padrões locais.
    }
  }

  onEngine(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const engine: 'kokoro' | 'gemini' | 'edge' =
      value === 'edge' ? 'edge' : value === 'kokoro' ? 'kokoro' : 'gemini';
    const pauta = this.pauta();
    if (!pauta) return;

    const voice = this.status()?.voices.find((item) => item.engine === engine);
    const fallbackVoice = engine === 'edge' ? 'pt-BR-AntonioNeural' : engine === 'kokoro' ? 'blend' : 'Kore';
    this.store.updateNarrationState(pauta.id, {
      engine,
      voiceName: voice?.id ?? fallbackVoice,
    });
  }

  onVoice(event: Event): void {
    const pauta = this.pauta();
    if (!pauta) return;
    const voiceName = (event.target as HTMLSelectElement).value;
    this.store.updateNarrationState(pauta.id, { voiceName });
  }

  onStyle(event: Event): void {
    const pauta = this.pauta();
    if (!pauta) return;
    this.store.updateNarrationState(pauta.id, {
      style: (event.target as HTMLSelectElement).value,
    });
  }

  async playSample(): Promise<void> {
    const pauta = this.pauta();
    if (!pauta) return;

    this.loadingSample.set(true);
    this.error.set(null);

    try {
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: this.engine(),
          voice: pauta.narration.voiceName || this.defaultVoiceId(),
          style: pauta.narration.style || this.defaultStyle(),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Falha ao gerar amostra (HTTP ${res.status}).`);
      }

      const blob = await res.blob();
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(blob);
      this.audio = this.audio ?? new Audio();
      this.audio.src = this.objectUrl;
      await this.audio.play().catch(() => undefined);

      // A amostra também marca a narração como pronta para o QC.
      this.store.updateNarrationState(pauta.id, { audioReady: true });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao gerar a amostra de voz.');
    } finally {
      this.loadingSample.set(false);
    }
  }
}
