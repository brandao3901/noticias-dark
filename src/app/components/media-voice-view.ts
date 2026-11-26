import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { MediaAsset, ScriptScene } from '../models/studio.models';
import { KokoroVoiceStudio } from './kokoro-voice-studio';
import { NarrationVoicePicker } from './narration-voice-picker';
import { SpeechPreview } from '../services/speech-preview';
import { StudioStore, getSceneMediaList } from '../services/studio-store';

@Component({
  selector: 'app-media-voice-view',
  imports: [ReactiveFormsModule, MatIconModule, KokoroVoiceStudio, NarrationVoicePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.activePauta(); as pauta) {
      <div class="space-y-6">
        <!-- Seleção de Mídia Licenciada por Cena -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div>
              <h1 class="text-xl font-semibold text-slate-50">Mídia licenciada e ficha de direitos</h1>
              <p class="mt-1 text-xs leading-relaxed text-slate-400">
                Adicione uma ou mais fotos e vídeos por cena. Ativos sem licença identificável ou com restrição ND são bloqueados.
              </p>
            </div>
            <button
              type="button"
              (click)="goToStudio.emit()"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px]">smart_display</mat-icon>
              <span>Abrir prévia 9:16 e QC</span>
            </button>
          </div>

          @if (pauta.script?.scenes?.length) {
            <!-- Barra de busca automática por nomes citados -->
            <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="min-w-[220px] flex-1">
                <div class="text-xs font-semibold text-slate-100">
                  Preenchimento automático por nomes citados
                </div>
                <p class="mt-0.5 text-[11px] text-slate-400">
                  Detecta pessoas, órgãos, empresas e locais citados nas cenas e no título para adicionar fotos e vídeos licenciados automaticamente.
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2 shrink-0">
                <select
                  aria-label="Mídias por cena"
                  [value]="autoMaxPerScene()"
                  (change)="onAutoMaxChange($event)"
                  class="rounded-lg border border-white/15 bg-[#111620] px-2.5 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
                >
                  <option value="1">1 mídia / cena</option>
                  <option value="2">2 mídias / cena</option>
                  <option value="3">3 mídias / cena</option>
                </select>

                <select
                  aria-label="Tipo de mídia automático"
                  [value]="autoKindPref()"
                  (change)="onAutoKindChange($event)"
                  class="rounded-lg border border-white/15 bg-[#111620] px-2.5 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
                >
                  <option value="both">Fotos e vídeos</option>
                  <option value="image">Somente fotos</option>
                  <option value="video">Somente vídeos</option>
                </select>

                <button
                  type="button"
                  (click)="runAutoFillAll(pauta.id)"
                  [disabled]="store.mediaBusy()"
                  class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-45 whitespace-nowrap"
                >
                  <mat-icon class="text-[16px]">auto_fix_high</mat-icon>
                  <span>{{ store.mediaBusy() ? 'Buscando nomes...' : 'Buscar nomes citados e adicionar' }}</span>
                </button>

                <button
                  type="button"
                  (click)="refillAll(pauta.id)"
                  [disabled]="store.mediaBusy()"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-45 whitespace-nowrap"
                  title="Descarta a mídia atual de todas as cenas e busca de novo com as regras atuais"
                >
                  <mat-icon class="text-[16px]">restart_alt</mat-icon>
                  <span>Refazer mídia das cenas</span>
                </button>
              </div>
            </div>

            <!-- Foto publicada pelo veículo: a imagem real do fato -->
            @if (articleMedia().length) {
              <div class="mt-4 rounded-lg border border-[#e59a38]/30 bg-[#e59a38]/[0.05] p-3.5">
                <div class="text-xs font-semibold text-slate-100">Foto da matéria</div>
                <p class="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                  Imagem publicada pelo próprio veículo. É a foto real do fato, mas o direito de uso é do
                  veículo — o crédito e o link da matéria entram no manifesto de direitos.
                </p>
                <div class="mt-2 flex flex-wrap gap-2">
                  @for (asset of articleMedia(); track asset.id) {
                    <div class="flex items-center gap-2 rounded border border-white/10 bg-[#0a0d12] p-1.5">
                      <img
                        [src]="asset.thumbUrl"
                        [alt]="asset.title"
                        referrerpolicy="no-referrer"
                        class="h-12 w-9 rounded object-cover shrink-0 bg-black"
                      />
                      <div class="min-w-0 max-w-[220px]">
                        <div class="truncate text-[11px] font-medium text-slate-200">{{ asset.title }}</div>
                        <div class="truncate text-[10px] text-slate-500 font-mono-tabular">
                          {{ asset.author }} · crédito no manifesto
                        </div>
                      </div>
                      <button
                        type="button"
                        (click)="attachToActiveScene(pauta.id, asset)"
                        class="shrink-0 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-100 hover:bg-[#e59a38] hover:text-[#0a0d12]"
                      >
                        Adicionar à Cena {{ activeSceneOrder() }}
                      </button>
                    </div>
                  }
                </div>
              </div>
            }

            <div class="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-12">              <!-- Lista de cenas para vincular múltiplas mídias -->
              <div class="lg:col-span-5 space-y-2.5">
                <div class="flex items-center justify-between text-xs font-medium text-slate-300">
                  <span>Cenas do roteiro</span>
                  <span class="text-[11px] text-slate-400 font-mono-tabular">
                    Cena {{ activeSceneOrder() }} selecionada
                  </span>
                </div>
                @for (scene of pauta.script!.scenes; track scene.id) {
                  @let assets = sceneAssets(scene);
                  <div
                    class="rounded-lg border p-3.5 transition-colors"
                    [class.border-[#e59a38]]="activeSceneId() === scene.id"
                    [class.bg-[#0a0d12]]="activeSceneId() === scene.id"
                    [class.border-white/10]="activeSceneId() !== scene.id"
                    [class.bg-[#0a0d12]/60]="activeSceneId() !== scene.id"
                  >
                    <button
                      type="button"
                      (click)="selectScene(scene.id, scene.detectedEntities?.[0] || scene.visualQueryPt || scene.visualQueryEn)"
                      class="w-full text-left"
                    >
                      <div class="flex items-center justify-between gap-2 text-xs font-mono-tabular">
                        <span class="font-semibold text-slate-100">Cena {{ scene.order }} · {{ scene.durationSec }}s</span>
                        <span
                          [class.text-emerald-400]="assets.length > 0"
                          [class.text-amber-300]="assets.length === 0"
                        >
                          {{ assets.length > 0 ? assets.length + (assets.length === 1 ? ' mídia' : ' mídias') : 'Sem mídia' }}
                        </span>
                      </div>
                      <p class="mt-1 line-clamp-2 text-xs text-slate-400">
                        {{ scene.narration || 'Sem narração' }}
                      </p>
                    </button>

                    @if (scene.detectedEntities?.length) {
                      <div class="mt-2.5 flex flex-wrap items-center gap-2">
                        <span class="text-[10px] text-slate-500">Ordem:</span>
                        @for (entity of scene.detectedEntities!; track entity) {
                          <div class="relative inline-flex items-center">
                            <button
                              type="button"
                              (click)="searchEntityName(scene.id, entity)"
                              class="rounded border border-white/10 bg-[#111620] pl-2 pr-3 py-0.5 text-[10px] text-slate-300 hover:border-[#e59a38] hover:text-[#e59a38]"
                            >
                              {{ entity }}
                            </button>
                            <button
                              type="button"
                              [attr.aria-label]="'Remover nome ' + entity"
                              title="Remover nome sugerido"
                              (click)="removeDetectedName($event, pauta.id, scene.id, entity)"
                              class="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/15 bg-[#1a2232] text-slate-300 hover:border-red-400 hover:bg-red-950 hover:text-red-200"
                            >
                              <mat-icon class="!h-[10px] !w-[10px] !text-[10px] !leading-[10px]">close</mat-icon>
                            </button>
                          </div>
                        }
                      </div>
                    }

                    @if (assets.length > 0) {
                      <div class="mt-2.5 space-y-1.5 border-t border-white/10 pt-2.5">
                        @for (asset of assets; track asset.id; let idx = $index; let first = $first; let last = $last) {
                          <div class="flex items-center gap-2 rounded border border-white/10 bg-[#111620] p-1.5">
                            <img
                              [src]="asset.thumbUrl"
                              [alt]="asset.title"
                              referrerpolicy="no-referrer"
                              class="h-9 w-12 rounded object-cover shrink-0 bg-black"
                            />
                            <div class="min-w-0 flex-1">
                              <div class="truncate text-[11px] font-medium text-slate-200">
                                {{ idx + 1 }}. {{ asset.title }}
                              </div>
                              <div class="truncate text-[10px] text-slate-400 font-mono-tabular">
                                {{ asset.kind === 'video' ? 'Vídeo' : 'Foto' }} · {{ asset.licenseName }}
                              </div>
                            </div>
                            <div class="flex items-center gap-0.5 shrink-0">
                              @if (!first) {
                                <button
                                  type="button"
                                  title="Mover para cima"
                                  (click)="moveAsset(pauta.id, scene.id, asset.id, -1)"
                                  class="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                >
                                  <mat-icon class="text-[14px]">arrow_upward</mat-icon>
                                </button>
                              }
                              @if (!last) {
                                <button
                                  type="button"
                                  title="Mover para baixo"
                                  (click)="moveAsset(pauta.id, scene.id, asset.id, 1)"
                                  class="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                >
                                  <mat-icon class="text-[14px]">arrow_downward</mat-icon>
                                </button>
                              }
                              <button
                                type="button"
                                title="Remover esta mídia"
                                (click)="removeAsset(pauta.id, scene.id, asset.id)"
                                class="rounded p-1 text-red-300 hover:bg-red-950/40"
                              >
                                <mat-icon class="text-[14px]">close</mat-icon>
                              </button>
                            </div>
                          </div>
                        }

                        <div class="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px]">
                          <button
                            type="button"
                            (click)="store.toggleSceneDocumentary(pauta.id, scene.id)"
                            class="text-slate-400 hover:text-slate-200 underline"
                          >
                            {{ scene.isDocumentaryMedia ? 'Marcado como registro do fato' : 'Marcado como ilustrativo' }}
                          </button>
                          <div class="flex items-center gap-2">
                            <button
                              type="button"
                              (click)="runAutoFillScene(pauta.id, scene.id)"
                              [disabled]="store.mediaBusy()"
                              class="text-emerald-400 hover:underline disabled:opacity-40"
                            >
                              + Auto-buscar nomes
                            </button>
                            <button
                              type="button"
                              (click)="clearSceneMedia($event, pauta.id, scene.id)"
                              class="text-red-300 hover:underline"
                            >
                              Limpar cena
                            </button>
                          </div>
                        </div>
                      </div>
                    } @else {
                      <div class="mt-2 flex items-center justify-end border-t border-white/10 pt-2">
                        <button
                          type="button"
                          (click)="runAutoFillScene(pauta.id, scene.id)"
                          [disabled]="store.mediaBusy()"
                          class="text-[11px] font-medium text-emerald-400 hover:underline disabled:opacity-40"
                        >
                          + Buscar nomes desta cena
                        </button>
                      </div>
                    }
                  </div>
                }
              </div>

              <!-- Busca em Wikimedia Commons e Internet Archive (sem chave de API) -->
              <div class="lg:col-span-7 space-y-4">
                <div class="flex flex-wrap items-end gap-3">
                  <div class="min-w-[180px] flex-1">
                    <label for="media-query" class="block text-xs font-medium text-slate-300">
                      Termos de busca (nome citado, EN ou PT)
                    </label>
                    <input
                      id="media-query"
                      type="text"
                      [formControl]="mediaQueryControl"
                      placeholder="Ex.: Banco Central, Brasilia congress, newsroom..."
                      class="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
                    />
                  </div>
                  <div class="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0a0d12] p-1">
                    <button
                      type="button"
                      (click)="provider.set('wikimedia')"
                      class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                      [class.bg-white/15]="provider() === 'wikimedia'"
                      [class.text-white]="provider() === 'wikimedia'"
                      [class.text-slate-400]="provider() !== 'wikimedia'"
                    >
                      Wikimedia Commons
                    </button>
                    <button
                      type="button"
                      (click)="provider.set('internet_archive')"
                      class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                      [class.bg-white/15]="provider() === 'internet_archive'"
                      [class.text-white]="provider() === 'internet_archive'"
                      [class.text-slate-400]="provider() !== 'internet_archive'"
                    >
                      Internet Archive
                    </button>
                  </div>
                  <div class="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0a0d12] p-1">
                    <button
                      type="button"
                      (click)="mediaKind.set('image')"
                      class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                      [class.bg-[#e59a38]]="mediaKind() === 'image'"
                      [class.text-[#0a0d12]]="mediaKind() === 'image'"
                      [class.text-slate-400]="mediaKind() !== 'image'"
                    >
                      Imagens
                    </button>
                    <button
                      type="button"
                      (click)="mediaKind.set('video')"
                      class="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                      [class.bg-[#e59a38]]="mediaKind() === 'video'"
                      [class.text-[#0a0d12]]="mediaKind() === 'video'"
                      [class.text-slate-400]="mediaKind() !== 'video'"
                    >
                      Vídeos
                    </button>
                  </div>
                  <button
                    type="button"
                    (click)="runMediaSearch()"
                    [disabled]="store.mediaBusy()"
                    class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-3.5 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <mat-icon class="text-[16px]">image_search</mat-icon>
                    <span>{{ store.mediaBusy() ? 'Buscando...' : 'Buscar acervo' }}</span>
                  </button>
                </div>

                <p class="text-[11px] text-slate-400">
                  Clique em "+ Adicionar à cena" em quantas fotos ou vídeos desejar — os itens são acumulados na Cena {{ activeSceneOrder() }} na ordem exibida ao lado.
                </p>

                @if (mediaError()) {
                  <div class="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-200">
                    {{ mediaError() }}
                  </div>
                }

                @if (searchResults().length === 0) {
                  <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-8 text-center text-xs text-slate-400">
                    Use "Buscar nomes citados e adicionar" acima para preencher automaticamente, ou selecione uma cena à esquerda e clique em "Buscar acervo".
                  </div>
                } @else {
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    @for (asset of searchResults(); track asset.id) {
                      @let alreadyAdded = isAssetInActiveScene(asset.id);
                      <div
                        class="rounded-lg border bg-[#0a0d12] overflow-hidden flex flex-col"
                        [class.border-emerald-500/50]="alreadyAdded"
                        [class.border-white/10]="!alreadyAdded"
                      >
                        <div class="relative aspect-video bg-black/40 overflow-hidden">
                          <img
                            [src]="asset.thumbUrl"
                            [alt]="asset.title"
                            referrerpolicy="no-referrer"
                            class="h-full w-full object-cover"
                          />
                        </div>
                        <div class="p-3 flex-1 flex flex-col justify-between gap-2">
                          <div>
                            <div class="text-xs font-medium text-slate-100 line-clamp-1">{{ asset.title }}</div>
                            <div class="mt-1 text-[11px] text-slate-400 font-mono-tabular">
                              {{ asset.provider === 'internet_archive' ? 'Internet Archive' : 'Wikimedia' }} · {{ asset.kind === 'video' ? 'Vídeo' : 'Imagem' }} · {{ asset.width }}×{{ asset.height }}
                              @if (asset.durationSec) {
                                <span> · {{ asset.durationSec }}s</span>
                              }
                            </div>
                            <div class="mt-1 text-[11px] text-emerald-400">
                              Licença: {{ asset.licenseName }}
                            </div>
                            <a
                              [href]="asset.pageUrl"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="mt-1 inline-block text-[11px] text-slate-400 underline hover:text-slate-200"
                            >
                              Página original e créditos ({{ asset.author }})
                            </a>
                          </div>
                          @if (alreadyAdded) {
                            <button
                              type="button"
                              (click)="removeAsset(pauta.id, activeSceneId(), asset.id)"
                              class="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-950/30 py-1.5 text-xs font-medium text-emerald-200 hover:bg-red-950/40 hover:border-red-500/40 hover:text-red-200 transition-colors"
                            >
                              <mat-icon class="text-[15px]">check_circle</mat-icon>
                              <span>Na Cena {{ activeSceneOrder() }} (remover)</span>
                            </button>
                          } @else {
                            <button
                              type="button"
                              (click)="attachToActiveScene(pauta.id, asset)"
                              class="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-white/10 py-1.5 text-xs font-medium text-slate-100 hover:bg-[#e59a38] hover:text-[#0a0d12] transition-colors"
                            >
                              <mat-icon class="text-[15px]">add_photo_alternate</mat-icon>
                              <span>Adicionar à Cena {{ activeSceneOrder() }}</span>
                            </button>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          } @else {
            <p class="mt-4 text-xs text-slate-400">
              Gere ou crie um roteiro na aba Roteiro antes de vincular imagens ou vídeos por cena.
            </p>
          }
        </section>

        <!-- Narração pt-BR: Prévia SpeechSynthesis & Fluxo Assistido Clipchamp -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-100">Narração em português do Brasil (pt-BR)</h2>
              <p class="mt-0.5 text-xs text-slate-400">
                Use a voz local do navegador/Windows (como Microsoft Daniel) para validação rápida ou importe o WAV/MP3 exportado do Clipchamp para a montagem final.
              </p>
            </div>
            <div class="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0a0d12] p-1">
              <button
                type="button"
                (click)="setNarrationMode(pauta.id, 'tts')"
                class="rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap"
                [class.bg-[#e59a38]]="pauta.narration.mode === 'tts'"
                [class.text-[#0a0d12]]="pauta.narration.mode === 'tts'"
                [class.text-slate-300]="pauta.narration.mode !== 'tts'"
              >
                Voz do sistema (pt-BR)
              </button>
              <button
                type="button"
                (click)="setNarrationMode(pauta.id, 'clipchamp')"
                class="rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap"
                [class.bg-[#e59a38]]="pauta.narration.mode === 'clipchamp'"
                [class.text-[#0a0d12]]="pauta.narration.mode === 'clipchamp'"
                [class.text-slate-300]="pauta.narration.mode !== 'clipchamp'"
              >
                Fluxo assistido Clipchamp
              </button>
            </div>
          </div>

          @if (pauta.narration.mode === 'tts') {
            <div class="mt-4 rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <app-narration-voice-picker />
            </div>
            <div class="mt-4">
              <p class="mt-2 text-[11px] text-slate-500">
                Esta é a voz que vai para o MP4 renderizado no servidor. A prévia do navegador
                (SpeechSynthesis) não é usada no arquivo final.
              </p>
            </div>
            <div class="mt-4">
              <app-kokoro-voice-studio />
            </div>
            @if (speech.lastAudioError()) {
              <p class="mt-2 text-xs text-red-300">{{ speech.lastAudioError() }}</p>
            }
          } @else {
            <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4 space-y-2.5">
                <div class="text-xs font-semibold text-slate-200">1. Copiar texto para o Clipchamp Windows</div>
                <p class="text-xs text-slate-400">
                  Abra o Microsoft Clipchamp → Gravar e criar → Texto para fala (Português - Brasil), cole o roteiro abaixo e exporte o áudio WAV ou MP3.
                </p>
                <button
                  type="button"
                  (click)="copyNarrationText()"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5"
                >
                  <mat-icon class="text-[15px]">content_copy</mat-icon>
                  <span>{{ copiedScript() ? 'Texto copiado' : 'Copiar narração completa' }}</span>
                </button>
              </div>

              <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4 space-y-2.5">
                <div class="text-xs font-semibold text-slate-200">2. Importar áudio exportado (WAV/MP3)</div>
                <input
                  type="file"
                  accept="audio/wav,audio/mpeg,audio/mp3,audio/*"
                  (change)="onClipchampAudioSelected(pauta.id, $event)"
                  class="block w-full text-xs text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-100 hover:file:bg-white/20"
                />
                @if (speech.importedAudioName()) {
                  <p class="text-xs text-emerald-400 font-mono-tabular">
                    Carregado: {{ speech.importedAudioName() }} ({{ speech.importedAudioDuration() }}s)
                  </p>
                }
                @if (speech.lastAudioError()) {
                  <p class="text-xs text-red-300">{{ speech.lastAudioError() }}</p>
                }
              </div>
            </div>
          }
        </section>
      </div>
    } @else {
      <div class="rounded-xl border border-white/10 bg-[#111620] p-12 text-center">
        <p class="text-sm text-slate-300">Selecione uma pauta para configurar mídia e narração.</p>
      </div>
    }
  `,
})
export class MediaVoiceView {
  readonly store = inject(StudioStore);
  readonly speech = inject(SpeechPreview);
  readonly goToStudio = output<void>();

  readonly provider = signal<'wikimedia' | 'internet_archive'>('wikimedia');
  readonly mediaKind = signal<'image' | 'video'>('image');
  readonly autoMaxPerScene = signal<number>(1);
  readonly autoKindPref = signal<'both' | 'image' | 'video'>('both');
  readonly selectedSceneId = signal<string>('');
  readonly searchResults = signal<MediaAsset[]>([]);
  readonly mediaError = signal<string | null>(null);
  readonly copiedScript = signal(false);

  readonly mediaQueryControl = new FormControl('', { nonNullable: true });

  readonly activeSceneId = computed(() => {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    const current = this.selectedSceneId();
    if (current && scenes.some((s) => s.id === current)) return current;
    return scenes[0]?.id ?? '';
  });

  readonly activeScene = computed(() => {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    return scenes.find((s) => s.id === this.activeSceneId()) ?? null;
  });

  readonly activeSceneOrder = computed(() => this.activeScene()?.order ?? 1);

  readonly articleMedia = computed<MediaAsset[]>(
    () => this.store.activePauta()?.dossier.articleMedia ?? [],
  );

  sceneAssets(scene: ScriptScene): MediaAsset[] {
    return getSceneMediaList(scene);
  }

  isAssetInActiveScene(assetId: string): boolean {
    return getSceneMediaList(this.activeScene()).some((a) => a.id === assetId);
  }

  selectScene(sceneId: string, suggestedQuery: string): void {
    this.selectedSceneId.set(sceneId);
    if (suggestedQuery) {
      this.mediaQueryControl.setValue(suggestedQuery);
    }
  }

  onAutoMaxChange(ev: Event): void {
    const val = Number((ev.target as HTMLSelectElement).value);
    this.autoMaxPerScene.set(val >= 1 && val <= 4 ? val : 2);
  }

  onAutoKindChange(ev: Event): void {
    const val = (ev.target as HTMLSelectElement).value;
    if (val === 'image' || val === 'video' || val === 'both') {
      this.autoKindPref.set(val);
    }
  }

  async runAutoFillAll(pautaId: string): Promise<void> {
    await this.store.autoFillMediaFromNames(pautaId, {
      maxPerScene: this.autoMaxPerScene(),
      kindPreference: this.autoKindPref(),
    });
  }

  /** Descarta a mídia de todas as cenas e busca de novo. */
  async refillAll(pautaId: string): Promise<void> {
    await this.store.refillAllScenesMedia(pautaId, {
      maxPerScene: this.autoMaxPerScene(),
      kindPreference: this.autoKindPref(),
    });
    this.selectedSceneId.set('');
    this.searchResults.set([]);
  }

  async runAutoFillScene(pautaId: string, sceneId: string): Promise<void> {
    this.selectedSceneId.set(sceneId);
    await this.store.autoFillMediaFromNames(pautaId, {
      sceneId,
      maxPerScene: this.autoMaxPerScene(),
      kindPreference: this.autoKindPref(),
    });
  }

  async searchEntityName(sceneId: string, entityName: string): Promise<void> {
    this.selectedSceneId.set(sceneId);
    this.mediaQueryControl.setValue(entityName);
    await this.runMediaSearch();
  }

  async runMediaSearch(): Promise<void> {
    const q =
      this.mediaQueryControl.value.trim() ||
      this.store.activePauta()?.script?.scenes[0]?.visualQueryEn ||
      this.store.activePauta()?.title ||
      '';
    if (!q) return;

    this.mediaError.set(null);
    const res = await this.store.searchMedia(q, this.provider(), this.mediaKind());
    this.searchResults.set(res.assets);
    if (res.error) {
      this.mediaError.set(res.error);
    } else if (!res.assets.length) {
      this.mediaError.set('Nenhum ativo com licença compatível encontrado para esses termos.');
    }
  }

  attachToActiveScene(pautaId: string, asset: MediaAsset): void {
    const sceneId = this.activeSceneId();
    if (!sceneId) return;
    this.store.addSceneMedia(pautaId, sceneId, asset);
  }

  removeAsset(pautaId: string, sceneId: string, assetId: string): void {
    this.store.removeSceneMediaAsset(pautaId, sceneId, assetId);
  }

  removeDetectedName(ev: Event, pautaId: string, sceneId: string, entity: string): void {
    ev.stopPropagation();
    this.store.removeSceneDetectedEntity(pautaId, sceneId, entity);
  }

  moveAsset(pautaId: string, sceneId: string, assetId: string, delta: -1 | 1): void {
    this.store.moveSceneMediaAsset(pautaId, sceneId, assetId, delta);
  }

  clearSceneMedia(ev: Event, pautaId: string, sceneId: string): void {
    ev.stopPropagation();
    this.store.clearAllSceneMedia(pautaId, sceneId);
  }

  setNarrationMode(pautaId: string, mode: 'tts' | 'clipchamp'): void {
    this.store.updateNarrationState(pautaId, {
      mode,
      audioReady: mode === 'tts' ? true : Boolean(this.speech.importedAudioName()),
    });
  }

  onVoiceChange(pautaId: string, ev: Event): void {
    const voiceName = (ev.target as HTMLSelectElement).value;
    this.speech.selectedVoiceName.set(voiceName);
    this.store.updateNarrationState(pautaId, { voiceName, audioReady: true });
  }

  testVoice(pautaId: string): void {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    if (!scenes.length) return;
    this.store.updateNarrationState(pautaId, {
      mode: 'tts',
      voiceName: this.speech.selectedVoiceName(),
      audioReady: true,
    });
    this.speech.playScenesTts(scenes, 0, 1.0);
  }

  async copyNarrationText(): Promise<void> {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    const text = scenes
      .map((s) => s.narration.normalize('NFC').trim())
      .filter(Boolean)
      .join('\n\n');
    if (!text) return;
    await navigator.clipboard.writeText(text);
    this.copiedScript.set(true);
    setTimeout(() => this.copiedScript.set(false), 2000);
  }

  async onClipchampAudioSelected(pautaId: string, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const info = await this.speech.loadLocalAudioFile(file);
      this.store.updateNarrationState(pautaId, {
        mode: 'clipchamp',
        audioFileName: info.name,
        audioDurationSec: info.durationSec,
        audioReady: true,
      });
    } catch {
      // Error surfaced via speech.lastAudioError
    }
  }
}
