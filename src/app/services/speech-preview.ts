import { Injectable, OnDestroy, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { ScriptScene } from '../models/studio.models';
import { normalizeTextForPtBrSpeech } from './pt-br-speech';

export { normalizeTextForPtBrSpeech } from './pt-br-speech';

export interface VoiceOption {
  name: string;
  lang: string;
  isPreferredDaniel: boolean;
  isPtBr: boolean;
}

@Injectable({ providedIn: 'root' })
export class SpeechPreview implements OnDestroy {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly voices = signal<VoiceOption[]>([]);
  readonly selectedVoiceName = signal<string>('');
  readonly hasPtBrVoice = signal<boolean>(true);
  readonly isPlaying = signal(false);
  readonly currentSceneIndex = signal<number>(0);
  readonly sceneProgress = signal<number>(0);
  readonly jawOpen = signal<number>(0);
  readonly speakingEnergy = signal<number>(0);
  readonly lastAudioError = signal<string | null>(null);
  readonly importedAudioDuration = signal<number>(0);
  readonly importedAudioName = signal<string | null>(null);

  private animFrameId: number | null = null;
  private speechPulseUntil = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private importedObjectUrl: string | null = null;
  private importedAudioFile: File | null = null;
  private stopRequested = false;

  private ttsSceneStartMs = 0;
  private ttsEstimatedSceneMs = 4000;
  private ttsTextLength = 1;
  private ttsHasBoundary = false;
  private ttsBoundaryRatio = 0;

  constructor() {
    if (this.isBrowser && 'speechSynthesis' in window) {
      this.refreshVoices();
      window.speechSynthesis.addEventListener('voiceschanged', this.handleVoicesChanged);
    }
  }

  private readonly handleVoicesChanged = (): void => {
    this.refreshVoices();
  };

  private scoreVoice(v: SpeechSynthesisVoice): number {
    const lang = v.lang.toLowerCase().replace('_', '-');
    const name = v.name.toLowerCase();
    let score = 0;
    if (lang === 'pt-br') score += 120;
    else if (lang.startsWith('pt')) score += 60;
    if (/natural|online|neural|google/.test(name)) score += 45;
    if (/francisca|antonio|thalita|daniel|luciana|felipe|maria/.test(name)) score += 25;
    if (/espeak|mbrola/.test(name)) score -= 50;
    return score;
  }

  refreshVoices(): void {
    if (!this.isBrowser || !('speechSynthesis' in window)) return;
    const all = window.speechSynthesis.getVoices();
    if (!all.length) return;

    const ptVoices = all.filter((v) => v.lang.toLowerCase().startsWith('pt'));
    this.hasPtBrVoice.set(ptVoices.length > 0);
    const listSource = ptVoices.length ? [...ptVoices] : [...all];
    listSource.sort((a, b) => this.scoreVoice(b) - this.scoreVoice(a));

    const mapped: VoiceOption[] = listSource.map((v) => {
      const normLang = v.lang.toLowerCase().replace('_', '-');
      return {
        name: v.name,
        lang: v.lang,
        isPreferredDaniel: /daniel/i.test(v.name) && /pt/i.test(v.lang),
        isPtBr: normLang === 'pt-br',
      };
    });

    this.voices.set(mapped);

    const currentValid = mapped.some((m) => m.name === this.selectedVoiceName());
    if (!currentValid && mapped.length > 0) {
      this.selectedVoiceName.set(mapped[0].name);
    }
  }

  loadLocalAudioFile(file: File): Promise<{ durationSec: number; name: string }> {
    this.lastAudioError.set(null);
    return new Promise((resolve, reject) => {
      if (!this.isBrowser) {
        reject(new Error('Disponível apenas no navegador.'));
        return;
      }
      if (this.importedObjectUrl) {
        URL.revokeObjectURL(this.importedObjectUrl);
      }
      const objectUrl = URL.createObjectURL(file);
      this.importedObjectUrl = objectUrl;
      this.importedAudioFile = file;

      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        const dur = Number.isFinite(probe.duration) ? Math.round(probe.duration * 10) / 10 : 0;
        this.importedAudioDuration.set(dur);
        this.importedAudioName.set(file.name);
        resolve({ durationSec: dur, name: file.name });
      };
      probe.onerror = () => {
        this.lastAudioError.set('Não foi possível decodificar o arquivo de áudio (use WAV PCM ou MP3 válido).');
        reject(new Error('Falha ao ler metadados do áudio.'));
      };
      probe.src = objectUrl;
    });
  }

  playImportedAudio(scenes: ScriptScene[]): void {
    if (!this.isBrowser || !this.importedObjectUrl) {
      this.lastAudioError.set('Importe um arquivo WAV/MP3 exportado do Clipchamp primeiro.');
      return;
    }

    this.stop();
    this.lastAudioError.set(null);
    this.stopRequested = false;

    try {
      const audio = new Audio(this.importedObjectUrl);
      this.audioEl = audio;
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      this.analyser = analyser;

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const totalSceneSec = Math.max(1, scenes.reduce((acc, s) => acc + s.durationSec, 0));

      const tick = () => {
        if (!this.isPlaying() || this.stopRequested || !this.analyser || !this.audioEl) return;
        this.analyser.getByteTimeDomainData(buffer);
        let sumSq = 0;
        for (let i = 0; i < buffer.length; i++) {
          const norm = (buffer[i] - 128) / 128;
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / buffer.length);
        const jaw = Math.min(0.95, Math.max(0, rms * 3.4));
        this.jawOpen.set(jaw);
        this.speakingEnergy.set(rms);

        // Map currentTime to scene index and local progress within the scene
        const dur = Number.isFinite(this.audioEl.duration) && this.audioEl.duration > 0
          ? this.audioEl.duration
          : totalSceneSec;
        const progress = Math.max(0, Math.min(0.9999, this.audioEl.currentTime / dur));
        let accum = 0;
        let idx = 0;
        let localProg = 0;
        for (let i = 0; i < scenes.length; i++) {
          const span = scenes[i].durationSec / totalSceneSec;
          const nextAccum = accum + span;
          if (progress <= nextAccum || i === scenes.length - 1) {
            idx = i;
            localProg = span > 0 ? Math.max(0, Math.min(0.999, (progress - accum) / span)) : 0;
            break;
          }
          accum = nextAccum;
        }
        this.currentSceneIndex.set(idx);
        this.sceneProgress.set(localProg);
        this.animFrameId = requestAnimationFrame(tick);
      };

      audio.onended = () => {
        this.stop();
      };
      audio.onerror = () => {
        this.lastAudioError.set('Erro ao reproduzir faixa de áudio importada.');
        this.stop();
      };

      this.isPlaying.set(true);
      void audio.play().then(() => {
        this.animFrameId = requestAnimationFrame(tick);
      });
    } catch (err) {
      this.lastAudioError.set(
        err instanceof Error ? err.message : 'Erro ao inicializar Web Audio API.',
      );
      this.stop();
    }
  }

  playScenesTts(scenes: ScriptScene[], startIndex = 0, rate = 1.0): void {
    if (!this.isBrowser || !('speechSynthesis' in window)) {
      this.lastAudioError.set('SpeechSynthesis indisponível neste navegador.');
      return;
    }

    this.stop();
    this.lastAudioError.set(null);
    this.stopRequested = false;
    this.refreshVoices();

    const validScenes = scenes.filter((s) => s.narration.trim().length > 0);
    if (!validScenes.length) {
      this.lastAudioError.set('Nenhuma cena com texto de narração para reproduzir.');
      return;
    }

    this.isPlaying.set(true);
    this.startTtsAnimationLoop();
    this.speakSceneAt(scenes, Math.min(startIndex, scenes.length - 1), rate);
  }

  private speakSceneAt(scenes: ScriptScene[], index: number, rate: number): void {
    if (this.stopRequested || index >= scenes.length) {
      this.stop();
      return;
    }

    const scene = scenes[index];
    this.currentSceneIndex.set(index);
    this.sceneProgress.set(0);

    const spokenText = normalizeTextForPtBrSpeech(scene.narration);
    if (!spokenText) {
      this.speakSceneAt(scenes, index + 1, rate);
      return;
    }

    const clampedRate = Math.max(0.7, Math.min(1.5, rate));
    this.ttsSceneStartMs = performance.now();
    this.ttsTextLength = Math.max(1, spokenText.length);
    this.ttsEstimatedSceneMs = Math.max(2200, Math.round((spokenText.length / (14 * clampedRate)) * 1000));
    this.ttsHasBoundary = false;
    this.ttsBoundaryRatio = 0;

    const utterance = new SpeechSynthesisUtterance(spokenText);

    const allVoices = window.speechSynthesis.getVoices();
    const chosen =
      allVoices.find((v) => v.name === this.selectedVoiceName()) ??
      [...allVoices]
        .filter((v) => v.lang.toLowerCase().startsWith('pt'))
        .sort((a, b) => this.scoreVoice(b) - this.scoreVoice(a))[0];

    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang || 'pt-BR';
    } else {
      utterance.lang = 'pt-BR';
    }
    utterance.rate = clampedRate;

    utterance.onboundary = (event) => {
      // Pulse jaw opening and update spoken character progress
      this.speechPulseUntil = performance.now() + 210;
      if (typeof event.charIndex === 'number' && event.charIndex >= 0) {
        this.ttsHasBoundary = true;
        const ratio = Math.max(0, Math.min(0.99, event.charIndex / this.ttsTextLength));
        if (ratio >= this.ttsBoundaryRatio) {
          this.ttsBoundaryRatio = ratio;
          this.sceneProgress.set(ratio);
        }
      }
    };

    utterance.onstart = () => {
      this.ttsSceneStartMs = performance.now();
      this.speechPulseUntil = performance.now() + 280;
    };

    utterance.onend = () => {
      if (!this.stopRequested) {
        this.speakSceneAt(scenes, index + 1, rate);
      }
    };

    utterance.onerror = () => {
      if (!this.stopRequested) {
        this.stop();
      }
    };

    window.speechSynthesis.speak(utterance);
  }

  private startTtsAnimationLoop(): void {
    const loop = (now: number) => {
      if (!this.isPlaying() || this.stopRequested) {
        this.jawOpen.set(0);
        this.speakingEnergy.set(0);
        return;
      }

      if (!this.ttsHasBoundary) {
        const elapsed = Math.max(0, now - this.ttsSceneStartMs);
        const estRatio = Math.max(0, Math.min(0.98, elapsed / this.ttsEstimatedSceneMs));
        this.sceneProgress.set(estRatio);
      }

      const activePulse = now < this.speechPulseUntil;
      const wave = 0.24 + 0.16 * Math.sin(now * 0.022) + 0.1 * Math.cos(now * 0.037);
      const targetJaw = activePulse ? Math.min(0.55, Math.max(0.14, wave)) : 0.12 + 0.06 * Math.sin(now * 0.015);
      this.jawOpen.set(targetJaw);
      this.speakingEnergy.set(activePulse ? 0.25 : 0.08);
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.stopRequested = true;
    this.isPlaying.set(false);
    this.sceneProgress.set(0);
    this.jawOpen.set(0);
    this.speakingEnergy.set(0);

    if (this.animFrameId !== null && this.isBrowser) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.isBrowser && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
      this.audioEl = null;
    }

    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
      this.analyser = null;
    }
  }

  async getImportedAudioBase64(): Promise<string | undefined> {
    const file = this.importedAudioFile;
    if (!file || file.size > 20 * 1024 * 1024) return undefined;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  ngOnDestroy(): void {
    this.stop();
    if (this.isBrowser && 'speechSynthesis' in window) {
      window.speechSynthesis.removeEventListener('voiceschanged', this.handleVoicesChanged);
    }
    if (this.importedObjectUrl) {
      URL.revokeObjectURL(this.importedObjectUrl);
    }
  }
}
