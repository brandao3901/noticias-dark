import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { SpeechPreview } from '../services/speech-preview';
import { RenderQueue } from '../services/render-queue';
import type { RenderJobResultView } from '../services/render-queue';
import { StudioStore, getSceneMediaList, splitTextIntoSubtitleCues } from '../services/studio-store';
import { PresenterAvatar } from './presenter-avatar';
import { PublishPanel } from './publish-panel';
import { NarrationVoicePicker } from './narration-voice-picker';

@Component({
  selector: 'app-studio-qc-view',
  imports: [ReactiveFormsModule, MatIconModule, DatePipe, PresenterAvatar, PublishPanel, NarrationVoicePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.activePauta(); as pauta) {
      <div class="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <!-- Coluna Esquerda: Prévia Vertical 9:16 com Avatar Apresentador -->
        <section class="xl:col-span-5 rounded-xl border border-white/10 bg-[#111620] p-6 flex flex-col items-center">
          <div class="w-full flex items-center justify-between gap-2 pb-4 border-b border-white/10">
            <div>
              <h1 class="text-lg font-semibold text-slate-50">Prévia vertical 9:16</h1>
              <p class="text-xs text-slate-400">1080×1920 · Avatar fictício sincronizado à fala</p>
            </div>
            <span class="text-xs font-mono-tabular text-slate-300">
              Cena {{ currentSceneOrder() }}/{{ pauta.script?.scenes?.length ?? 0 }}
            </span>
          </div>

          <!-- Palco 9:16 -->
          <div class="relative mt-5 w-full max-w-[300px] aspect-[9/16] rounded-2xl border border-white/15 bg-[#07090e] overflow-hidden shadow-lg">
            @if (activeScene(); as scene) {
              <!-- Mídia de apoio licenciada ao fundo (alterna automaticamente quando houver múltiplos ativos) -->
              @if (currentSceneAsset(); as asset) {
                @if (asset.kind === 'video' && (asset.mediaUrl.endsWith('.mp4') || asset.mediaUrl.endsWith('.webm'))) {
                  <video
                    [src]="asset.mediaUrl"
                    [poster]="asset.thumbUrl"
                    autoplay
                    loop
                    muted
                    playsinline
                    class="absolute inset-0 h-full w-full object-cover"
                  ></video>
                } @else {
                  <img
                    [src]="asset.thumbUrl"
                    [alt]="asset.title"
                    referrerpolicy="no-referrer"
                    class="absolute inset-0 h-full w-full object-cover"
                  />
                }
                <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/45"></div>
              } @else {
                <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,#1c2538_0%,#080b10_75%)]"></div>
                <img
                  src="/assets/studio-fallback-bg.jpg"
                  alt="Cenário padrão do estúdio Canal Dark"
                  class="absolute inset-0 h-full w-full object-cover"
                />
                <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/45"></div>
              }

              <!-- Faixa discreta de identificação do canal -->
              <div class="pointer-events-none absolute top-3 left-3 right-3 z-10 flex items-center justify-between text-[10px] font-mono-tabular text-slate-200/90">
                <span class="font-semibold tracking-wider">{{ channelLabel() }}</span>
                <span>{{ pauta.editorial }}</span>
              </div>

              <!-- Avatar apresentador (Full ou PiP sem cobrir legenda) -->
              @if (effectiveAvatarMode() === 'full') {
                <div class="pointer-events-none absolute inset-x-0 top-10 bottom-20 z-10 flex items-end justify-center">
                  <app-presenter-avatar
                    mode="full"
                    [jawOpen]="speech.jawOpen()"
                    [isSpeaking]="speech.isPlaying()"
                    [expression]="scene.avatarExpression"
                  />
                </div>
              } @else if (effectiveAvatarMode() === 'pip') {
                <div class="pointer-events-none absolute top-11 right-3 z-10">
                  <app-presenter-avatar
                    mode="pip"
                    [jawOpen]="speech.jawOpen()"
                    [isSpeaking]="speech.isPlaying()"
                    [expression]="scene.avatarExpression"
                  />
                </div>
              }

              <!-- Legenda compacta estilo Shorts em zona segura (sincronizada por trecho, sem corte) -->
              <div class="pointer-events-none absolute inset-x-3 bottom-8 z-20 flex justify-center">
                <div class="max-w-[92%] rounded-md bg-black/85 px-2.5 py-1.5 text-center shadow">
                  <p class="text-[11px] font-semibold leading-snug text-white break-words">
                    {{ currentSubtitleCue() }}
                  </p>
                </div>
              </div>

              <!-- Créditos do ativo e aviso de mídia ilustrativa -->
              <div class="pointer-events-none absolute inset-x-3 bottom-2 z-10 flex items-center justify-between text-[8.5px] text-slate-300/80">
                <span class="truncate">
                  @if (currentSceneAsset(); as asset) {
                    {{ scene.isDocumentaryMedia ? 'Registro' : 'Ilustração' }}{{ activeSceneAssets().length > 1 ? ' (' + (activeMediaIndex() + 1) + '/' + activeSceneAssets().length + ')' : '' }}: {{ asset.attributionText }}
                  } @else {
                    Cenário de estúdio padrão · avatar fictício
                  }
                </span>
              </div>
            } @else {
              <div class="flex h-full items-center justify-center p-6 text-center text-xs text-slate-400">
                Crie um roteiro na aba Roteiro para visualizar a prévia vertical 9:16.
              </div>
            }
          </div>

          <!-- Controles de reprodução -->
          <div class="mt-5 w-full max-w-[300px] space-y-3">
            <div class="flex items-center justify-center gap-2">
              @if (!speech.isPlaying()) {
                <button
                  type="button"
                  (click)="playPreview()"
                  [disabled]="!pauta.script?.scenes?.length"
                  class="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-40 whitespace-nowrap"
                >
                  <mat-icon class="text-[16px]">play_arrow</mat-icon>
                  <span>
                    {{ pauta.narration.mode === 'clipchamp' && speech.importedAudioName() ? 'Reproduzir áudio Clipchamp' : 'Reproduzir narração pt-BR' }}
                  </span>
                </button>
              } @else {
                <button
                  type="button"
                  (click)="speech.stop()"
                  class="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-950/50 whitespace-nowrap"
                >
                  <mat-icon class="text-[16px]">stop</mat-icon>
                  <span>Interromper fala</span>
                </button>
              }
            </div>

            @if (pauta.narration.mode === 'tts' && !speech.hasPtBrVoice()) {
              <p class="rounded-lg border border-amber-500/30 bg-amber-950/20 px-2.5 py-2 text-[11px] text-amber-200">
                Este navegador não possui voz nativa pt-BR instalada; para leitura perfeita dos acentos, use o Microsoft Edge ou importe o áudio do Clipchamp.
              </p>
            }

            <!-- Navegação entre múltiplas mídias e trechos de legenda da cena atual -->
            @if (activeSceneAssets().length > 1 || sceneSubtitleCues().length > 1) {
              <div class="space-y-1.5">
                @if (activeSceneAssets().length > 1) {
                  <div class="flex items-center justify-between rounded-lg border border-white/10 bg-[#0a0d12] px-2.5 py-1.5 text-[11px] font-mono-tabular text-slate-300">
                    <button
                      type="button"
                      (click)="stepSceneMedia(-1)"
                      class="rounded p-0.5 hover:bg-white/10 text-slate-300"
                      title="Mídia anterior"
                    >
                      <mat-icon class="text-[16px]">chevron_left</mat-icon>
                    </button>
                    <span>
                      Mídia {{ activeMediaIndex() + 1 }}/{{ activeSceneAssets().length }} · {{ currentSceneAsset()?.kind === 'video' ? 'Vídeo' : 'Foto' }}
                    </span>
                    <button
                      type="button"
                      (click)="stepSceneMedia(1)"
                      class="rounded p-0.5 hover:bg-white/10 text-slate-300"
                      title="Próxima mídia"
                    >
                      <mat-icon class="text-[16px]">chevron_right</mat-icon>
                    </button>
                  </div>
                }
                @if (sceneSubtitleCues().length > 1) {
                  <div class="flex items-center justify-between rounded-lg border border-white/10 bg-[#0a0d12] px-2.5 py-1 text-[10px] font-mono-tabular text-slate-400">
                    <button
                      type="button"
                      (click)="stepSubtitleCue(-1)"
                      class="rounded p-0.5 hover:bg-white/10 text-slate-300"
                      title="Trecho anterior da legenda"
                    >
                      <mat-icon class="text-[15px]">chevron_left</mat-icon>
                    </button>
                    <span>
                      Legenda {{ activeSubtitleIndex() + 1 }}/{{ sceneSubtitleCues().length }}
                    </span>
                    <button
                      type="button"
                      (click)="stepSubtitleCue(1)"
                      class="rounded p-0.5 hover:bg-white/10 text-slate-300"
                      title="Próximo trecho da legenda"
                    >
                      <mat-icon class="text-[15px]">chevron_right</mat-icon>
                    </button>
                  </div>
                }
              </div>
            }

            <!-- Linha do tempo de cenas clicável -->
            @if (pauta.script?.scenes?.length) {
              <div class="flex flex-wrap gap-1.5 justify-center">
                @for (sc of pauta.script!.scenes; track sc.id; let idx = $index) {
                  <button
                    type="button"
                    (click)="selectPreviewScene(idx)"
                    class="rounded px-2 py-1 text-[11px] font-mono-tabular transition-colors"
                    [class.bg-[#e59a38]]="speech.currentSceneIndex() === idx"
                    [class.text-[#0a0d12]]="speech.currentSceneIndex() === idx"
                    [class.bg-[#0a0d12]]="speech.currentSceneIndex() !== idx"
                    [class.text-slate-300]="speech.currentSceneIndex() !== idx"
                  >
                    C{{ sc.order }} ({{ sc.durationSec }}s)
                  </button>
                }
              </div>
            }
          </div>
        </section>

        <!-- Coluna Direita: Controle de Qualidade, Aprovação Humana e Exportação -->
        <div class="xl:col-span-7 space-y-6">
          <!-- Relatório de Controle de Qualidade (QC) -->
          <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div>
                <h2 class="text-lg font-semibold text-slate-100">Controle de qualidade (QC)</h2>
                <p class="text-xs text-slate-400">
                  Verifica fontes vinculadas, direitos de mídia, duração e bloqueio de publicação automática.
                </p>
              </div>
              <button
                type="button"
                (click)="store.recomputeQc(pauta.id)"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[15px]">fact_check</mat-icon>
                <span>Reavaliar QC</span>
              </button>
            </div>

            @if (pauta.qc; as qc) {
              <ul class="mt-4 divide-y divide-white/10">
                @for (item of qc.items; track item.id) {
                  <li class="flex items-start justify-between gap-3 py-3">
                    <div class="min-w-0 flex-1">
                      <div class="text-xs font-semibold text-slate-100">{{ item.label }}</div>
                      <p class="mt-0.5 text-xs text-slate-400">{{ item.detail }}</p>
                    </div>
                    <span
                      class="inline-flex items-center gap-1 text-xs font-medium shrink-0"
                      [class.text-red-400]="item.severity === 'blocking'"
                      [class.text-amber-300]="item.severity === 'warning'"
                      [class.text-emerald-400]="item.severity === 'pass'"
                    >
                      <mat-icon class="text-[15px]">
                        {{ item.severity === 'blocking' ? 'block' : item.severity === 'warning' ? 'warning_amber' : 'check_circle' }}
                      </mat-icon>
                      <span>
                        {{ item.severity === 'blocking' ? 'Bloqueante' : item.severity === 'warning' ? 'Aviso' : 'Aprovado' }}
                      </span>
                    </span>
                  </li>
                }
              </ul>
            }
          </section>

          <!-- Aprovação Humana (RF-12) -->
          <section class="rounded-xl border border-white/10 bg-[#111620] p-6 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="text-lg font-semibold text-slate-100">Revisão e aprovação humana</h2>
              @if (pauta.stage === 'APPROVED') {
                <span class="text-xs font-medium text-emerald-400 font-mono-tabular">
                  Aprovado em {{ pauta.approvedAt | date: 'dd/MM/yyyy HH:mm' }}
                </span>
              } @else if (pauta.stage === 'REJECTED') {
                <span class="text-xs font-medium text-red-400">Rejeitado na revisão</span>
              }
            </div>

            <p class="text-xs text-slate-400">
              Publicação automática permanece desativada nesta versão. Revise fontes, adequação editorial e manifesto de direitos antes de liberar o pacote.
            </p>

            <div>
              <label for="approval-note" class="block text-xs font-medium text-slate-300">
                Observações do revisor humano
              </label>
              <textarea
                id="approval-note"
                rows="2"
                [formControl]="approvalNoteControl"
                placeholder="Ex.: Conferido contra GDELT e fonte primária; áudio pt-BR e créditos validados."
                class="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
              ></textarea>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <button
                type="button"
                (click)="decide(pauta.id, 'APPROVED')"
                [disabled]="pauta.qc?.hasBlockingErrors"
                class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">verified</mat-icon>
                <span>Aprovar pacote final</span>
              </button>
              <button
                type="button"
                (click)="decide(pauta.id, 'REJECTED')"
                class="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-4 py-2 text-xs font-medium text-red-200 hover:bg-red-950/40 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">cancel</mat-icon>
                <span>Rejeitar pauta</span>
              </button>
            </div>

            @if (pauta.stage === 'APPROVED') {
              <div class="rounded-lg border border-emerald-500/40 bg-emerald-950/25 p-4 space-y-3">
                <div class="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                  <mat-icon class="text-[17px]">download_for_offline</mat-icon>
                  <span>Pacote final aprovado e liberado para download</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    (click)="renderAndDownloadMp4()"
                    [disabled]="renderingMp4() || !pauta.script?.scenes?.length"
                    class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-3.5 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-50 whitespace-nowrap"
                  >
                    <mat-icon class="text-[16px]">movie</mat-icon>
                    <span>{{ renderingMp4() ? 'Renderizando MP4...' : 'Baixar vídeo 9:16 (.MP4)' }}</span>
                  </button>
                  <button
                    type="button"
                    (click)="downloadSubtitles('srt')"
                    [disabled]="!pauta.script?.scenes?.length"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-white/15 whitespace-nowrap"
                  >
                    <mat-icon class="text-[15px]">subtitles</mat-icon>
                    <span>Baixar .SRT</span>
                  </button>
                  <button
                    type="button"
                    (click)="downloadSubtitles('vtt')"
                    [disabled]="!pauta.script?.scenes?.length"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-white/15 whitespace-nowrap"
                  >
                    <mat-icon class="text-[15px]">closed_caption</mat-icon>
                    <span>Baixar .VTT</span>
                  </button>
                  <button
                    type="button"
                    (click)="downloadManifest()"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-white/15 whitespace-nowrap"
                  >
                    <mat-icon class="text-[15px]">description</mat-icon>
                    <span>Baixar manifesto .JSON</span>
                  </button>
                  <button
                    type="button"
                    (click)="downloadScriptText()"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-white/15 whitespace-nowrap"
                  >
                    <mat-icon class="text-[15px]">article</mat-icon>
                    <span>Baixar roteiro .TXT</span>
                  </button>
                </div>
                @if (renderMp4Error()) {
                  <p class="text-xs text-red-300">{{ renderMp4Error() }}</p>
                }
                <p class="text-[11px] text-slate-400">
                  Dica: Para incluir narração profissional no vídeo MP4, importe o arquivo de áudio WAV/MP3 na aba <strong>Mídia e Voz</strong> (seção <em>Fluxo assistido Clipchamp</em>) antes de baixar. A voz do navegador é apenas para teste local em tempo real.
                </p>
              </div>
            }

            <!-- Publicação: conexão da conta, metadados, envio e desempenho.
                 A conexão é da conta, então aparece em qualquer estágio; só o
                 ato de publicar exige pauta aprovada. -->
            <app-publish-panel />
          </section>

          <!-- Pacote de Exportação (MP4, SRT, VTT, Manifesto JSON e Comando FFmpeg 1080x1920) -->
          <section class="rounded-xl border border-white/10 bg-[#111620] p-6 space-y-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-100">Pacote de saída e renderização FFmpeg</h2>
              <p class="mt-0.5 text-xs text-slate-400">
                Baixe o vídeo 9:16 renderizado (1080×1920), as legendas sincronizadas, o roteiro completo e o manifesto auditável de fontes/licenças.
              </p>
            </div>

            <!-- O que entra no arquivo final -->
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-lg border border-white/10 bg-[#0a0d12] px-3.5 py-3">
              <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  [checked]="autoNarration()"
                  (change)="toggleAutoNarration()"
                  class="h-3.5 w-3.5 accent-[#e59a38]"
                />
                <span class="font-medium">Narração pt-BR neural</span>
              </label>

              @if (autoNarration()) {
                <app-narration-voice-picker />

                <div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
                  <label class="inline-flex cursor-pointer items-center gap-2">
                    <span>Formato</span>
                    <select
                      [value]="pauta.narration.videoMode ?? 'fotos'"
                      (change)="onVideoMode($event)"
                      class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-[11px] text-slate-200"
                    >
                      <option value="fotos">Fotos (Ken Burns)</option>
                      <option value="documento">Documento (print da fonte)</option>
                      <option value="cards">Cartões (tipografia + matéria)</option>
                    </select>
                  </label>
                  <label class="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      [checked]="dynamicsAlta()"
                      (change)="toggleDynamics()"
                      class="h-3.5 w-3.5 accent-[#e59a38]"
                    />
                    <span title="Cortes a cada ~2,8 s, câmera variada e transições">
                      Dinâmica alta (corte a cada ~2,8 s)
                    </span>
                  </label>
                  <label class="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      [checked]="karaoke()"
                      (change)="toggleKaraoke()"
                      class="h-3.5 w-3.5 accent-[#e59a38]"
                    />
                    <span title="Destaque palavra a palavra no vídeo">Legenda karaokê</span>
                  </label>
                </div>
              }

              <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  [checked]="avatarInVideo()"
                  (change)="toggleAvatarInVideo()"
                  class="h-3.5 w-3.5 accent-[#e59a38]"
                />
                <span class="font-medium">Avatar no vídeo</span>
              </label>

              <span class="text-[11px] text-slate-500">
                @if (autoNarration()) {
                  a voz é gerada no servidor e o avatar sincroniza a boca com ela
                } @else {
                  sem narração nova: usa o áudio importado do Clipchamp, se houver
                }
              </span>
            </div>

            <!-- Fila de render: o trabalho roda no servidor e o progresso vem por SSE -->
            @if (queue.activeJob(); as job) {
              <div class="rounded-lg border border-[#e59a38]/35 bg-[#e59a38]/[0.06] p-3.5 space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span class="font-medium text-slate-100">
                    {{ job.mode === 'preview' ? 'Prévia' : 'Pacote final' }} · {{ job.stage }}
                  </span>
                  <div class="flex items-center gap-2">
                    <span class="font-mono-tabular text-slate-300">{{ job.pct }}%</span>
                    <button
                      type="button"
                      (click)="cancelRender()"
                      class="rounded border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/10"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
                <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    class="h-full rounded-full bg-[#e59a38] transition-all duration-300"
                    [style.width.%]="job.pct"
                  ></div>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                  <span>{{ job.message }}</span>
                  <span class="font-mono-tabular">
                    {{ queue.activeCount() }} na fila · {{ job.label }}
                  </span>
                </div>
              </div>
            }

            <div class="flex flex-wrap gap-2.5">
              <button
                type="button"
                (click)="renderAndDownloadMp4('final')"
                [disabled]="renderingMp4() || !pauta.script?.scenes?.length"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-3.5 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-45 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">movie</mat-icon>
                <span>{{ renderingMp4() ? 'Renderizando MP4...' : 'Gerar pacote final (.MP4)' }}</span>
              </button>
              <button
                type="button"
                (click)="renderAndDownloadMp4('preview')"
                [disabled]="renderingMp4() || !pauta.script?.scenes?.length"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">visibility</mat-icon>
                <span>Renderizar prévia</span>
              </button>
              <button
                type="button"
                (click)="downloadSubtitles('srt')"
                [disabled]="!pauta.script?.scenes?.length"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">subtitles</mat-icon>
                <span>Baixar legendas .SRT</span>
              </button>
              <button
                type="button"
                (click)="downloadSubtitles('vtt')"
                [disabled]="!pauta.script?.scenes?.length"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">closed_caption</mat-icon>
                <span>Baixar legendas .VTT</span>
              </button>
              <button
                type="button"
                (click)="downloadManifest()"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">description</mat-icon>
                <span>Baixar manifesto-direitos.json</span>
              </button>
              <button
                type="button"
                (click)="downloadScriptText()"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 whitespace-nowrap"
              >
                <mat-icon class="text-[16px]">article</mat-icon>
                <span>Baixar roteiro .TXT</span>
              </button>
            </div>
            @if (renderMp4Error()) {
              <p class="text-xs text-red-300">{{ renderMp4Error() }}</p>
            }
            @if (gateMessage(); as gate) {
              <div class="rounded-lg border border-amber-500/35 bg-amber-950/25 px-3.5 py-2.5 text-xs text-amber-200">
                {{ gate }}
              </div>
            }

            @if (pauta.render || lastRenderInfo(); as info) {
              <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
                <div class="flex flex-wrap items-start gap-3">
                  @if (pauta.render?.thumbnailUrl || info?.thumbnailUrl) {
                    <img
                      [src]="pauta.render?.thumbnailUrl || info?.thumbnailUrl"
                      alt="Capa do vídeo renderizado"
                      class="h-24 w-[54px] rounded border border-white/10 object-cover"
                    />
                  }
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold text-slate-100">
                      Pacote arquivado
                      @if ((pauta.render?.mode || info?.mode) === 'preview') {
                        <span class="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                          prévia
                        </span>
                      }
                    </div>
                    <div class="mt-0.5 text-[11px] text-slate-400 font-mono-tabular">
                      {{ pauta.render?.seconds ?? info?.seconds }}s
                      @if ((pauta.render?.mode || info?.mode) === 'final') {
                        <span> · liberado para publicação</span>
                      }
                      @if ((pauta.render?.seconds ?? info?.seconds ?? 0) < 60) {
                        <span class="text-amber-300"> · abaixo de 1 minuto</span>
                      }
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <a
                        [href]="pauta.render?.videoUrl || info?.videoUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/5"
                      >
                        <mat-icon class="text-[14px]">play_circle</mat-icon>
                        <span>Abrir vídeo</span>
                      </a>
                      <button
                        type="button"
                        (click)="downloadRenderedVideo()"
                        class="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/5"
                      >
                        <mat-icon class="text-[14px]">download</mat-icon>
                        <span>Baixar .MP4</span>
                      </button>
                      <a
                        [href]="'/api/projects/' + pauta.id + '/file/manifesto-direitos.json'"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/5"
                      >
                        <mat-icon class="text-[14px]">description</mat-icon>
                        <span>Manifesto</span>
                      </a>
                      <a
                        [href]="'/api/projects/' + pauta.id + '/file/legendas.srt'"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/5"
                      >
                        <mat-icon class="text-[14px]">subtitles</mat-icon>
                        <span>.SRT</span>
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            }

            <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="flex items-center justify-between gap-2 mb-2">
                <span class="text-xs font-medium text-slate-300">Comando FFmpeg 9:16 (1080×1920 · 30fps · H.264/AAC)</span>
                <button
                  type="button"
                  (click)="copyFfmpegCommand()"
                  class="text-xs text-[#e59a38] hover:underline"
                >
                  {{ copiedFfmpeg() ? 'Copiado' : 'Copiar comando' }}
                </button>
              </div>
              <pre class="overflow-x-auto text-[11px] font-mono-tabular text-slate-300 leading-relaxed">{{ ffmpegCommand() }}</pre>
            </div>
          </section>
        </div>
      </div>
    } @else {
      <div class="rounded-xl border border-white/10 bg-[#111620] p-12 text-center">
        <p class="text-sm text-slate-300">Selecione uma pauta para visualizar a prévia 9:16 e executar o QC.</p>
      </div>
    }
  `,
})
export class StudioQcView {
  readonly store = inject(StudioStore);
  readonly speech = inject(SpeechPreview);

  readonly approvalNoteControl = new FormControl('', { nonNullable: true });
  readonly copiedFfmpeg = signal(false);
  readonly queue = inject(RenderQueue);
  readonly renderMp4Error = signal<string | null>(null);
  readonly gateMessage = signal<string | null>(null);
  readonly lastRenderInfo = signal<{
    seconds: number;
    rate: number;
    videoUrl: string;
    thumbnailUrl: string | null;
    mode: 'final' | 'preview';
    files: string[];
  } | null>(null);
  private handledJobId: string | null = null;

  /** Há render desta pauta na fila ou rodando? */
  readonly renderingMp4 = computed(() => {
    const job = this.queue.activeJob();
    return Boolean(job && job.pautaId === this.store.activePauta()?.id);
  });
  readonly mediaSlotIndex = signal(0);
  readonly subtitleCueIndex = signal(0);

  /** Narracao neural gerada no servidor (substitui a voz do navegador no MP4). */
  /** Mesma tarja que o render grava no vídeo (vem do servidor). */
  readonly channelLabel = computed(
    () => this.store.configStatus()?.channelLabel || 'NOTÍCIAS NA BRASA · APRESENTADOR VIRTUAL',
  );

  readonly dynamicsAlta = computed(() => this.store.activePauta()?.narration.dynamics !== 'normal');
  readonly karaoke = computed(() => this.store.activePauta()?.narration.captions !== 'classica');

  toggleDynamics(): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    this.store.updateNarrationState(pauta.id, {
      dynamics: this.dynamicsAlta() ? 'normal' : 'alta',
    });
  }

  toggleKaraoke(): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    this.store.updateNarrationState(pauta.id, {
      captions: this.karaoke() ? 'classica' : 'karaoke',
    });
  }

  onVideoMode(event: Event): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    const value = (event.target as HTMLSelectElement).value;
    this.store.updateNarrationState(pauta.id, {
      videoMode: value === 'documento' ? 'documento' : 'fotos',
    });
  }

  readonly autoNarration = signal(true);
  readonly avatarInVideo = signal(true);

  toggleAutoNarration(): void {
    this.autoNarration.update((value) => !value);
  }

  toggleAvatarInVideo(): void {
    this.avatarInVideo.update((value) => !value);
  }

  readonly activeScene = computed(() => {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    const idx = Math.min(this.speech.currentSceneIndex(), Math.max(0, scenes.length - 1));
    return scenes[idx] ?? null;
  });

  readonly activeSceneAssets = computed(() => getSceneMediaList(this.activeScene()));

  /**
   * Mesma regra do render: a foto do fato manda. Sem imagem, apresentador em
   * tela cheia; com imagem, ele sai de cena (só volta no fechamento, em PiP).
   */
  readonly effectiveAvatarMode = computed<'full' | 'pip' | 'hidden'>(() => {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    const scene = this.activeScene();
    if (!scene) return 'hidden';
    if (scene.avatarMode === 'hidden') return 'hidden';

    const hasVisual = this.activeSceneAssets().length > 0;
    if (!hasVisual) return 'full';

    const isLast = scenes[scenes.length - 1]?.id === scene.id;
    return isLast ? 'pip' : 'hidden';
  });

  readonly sceneSubtitleCues = computed(() => {
    const text = this.activeScene()?.narration ?? '';
    return splitTextIntoSubtitleCues(text, 40);
  });

  private readonly mediaSwitchThresholds = computed(() => {
    const assets = this.activeSceneAssets();
    const total = assets.length;
    if (total <= 1) return [0];

    const scene = this.activeScene();
    const narration = (scene?.narration ?? '').toLowerCase();
    const entities = scene?.detectedEntities ?? [];
    const len = Math.max(1, narration.length);

    const thresholds: number[] = [0];
    for (let i = 1; i < total; i++) {
      const fallback = i / total;
      const entity = entities[i]?.toLowerCase() ?? '';
      const pos = entity && narration.includes(entity) ? narration.indexOf(entity) / len : -1;
      const candidate = pos > 0 ? pos : fallback;
      const minAllowed = thresholds[i - 1] + 0.12;
      thresholds.push(Math.min(0.92, Math.max(minAllowed, candidate)));
    }
    return thresholds;
  });

  readonly activeMediaIndex = computed(() => {
    const total = this.activeSceneAssets().length;
    if (total <= 1) return 0;

    if (!this.speech.isPlaying()) {
      return this.mediaSlotIndex() % total;
    }

    const progress = this.speech.sceneProgress();
    const thresholds = this.mediaSwitchThresholds();
    let activeIdx = 0;
    for (let i = 1; i < thresholds.length; i++) {
      if (progress >= thresholds[i]) {
        activeIdx = i;
      }
    }
    return activeIdx;
  });

  readonly currentSceneAsset = computed(() => {
    const list = this.activeSceneAssets();
    if (!list.length) return null;
    return list[this.activeMediaIndex()] ?? list[0] ?? null;
  });

  readonly activeSubtitleIndex = computed(() => {
    const cues = this.sceneSubtitleCues();
    const total = cues.length;
    if (total <= 1) return 0;

    if (!this.speech.isPlaying()) {
      return this.subtitleCueIndex() % total;
    }

    const progress = this.speech.sceneProgress();
    const totalChars = Math.max(1, cues.reduce((sum, c) => sum + c.length, 0));
    let accum = 0;
    for (let i = 0; i < cues.length; i++) {
      accum += cues[i].length / totalChars;
      if (progress < accum || i === cues.length - 1) {
        return i;
      }
    }
    return cues.length - 1;
  });

  readonly currentSubtitleCue = computed(() => {
    const cues = this.sceneSubtitleCues();
    return cues[this.activeSubtitleIndex()] ?? 'Sem texto nesta cena';
  });

  readonly currentSceneOrder = computed(() => this.activeScene()?.order ?? 0);

  readonly ffmpegCommand = computed(() => {
    const pauta = this.store.activePauta();
    const audioFile = pauta?.narration.audioFileName || 'narracao_clipchamp_ptbr.wav';
    return `ffmpeg -y -i fundo_vertical.mp4 -i "${audioFile}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,subtitles=legendas.srt:force_style='Alignment=2,MarginV=75,FontSize=11'" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest short_final_9x16.mp4`;
  });

  constructor() {
    effect(() => {
      // Reinicia deslocamento manual apenas ao trocar de cena ou iniciar reprodução
      this.speech.currentSceneIndex();
      this.speech.isPlaying();
      this.mediaSlotIndex.set(0);
      this.subtitleCueIndex.set(0);
    });

    // Reage ao fim do job da fila: grava o pacote na pauta e mostra o resultado.
    effect(() => {
      const pauta = this.store.activePauta();
      if (!pauta) return;

      for (const job of this.queue.jobs()) {
        if (job.pautaId !== pauta.id || job.id === this.handledJobId) continue;
        // Publicação é tratada no próprio painel de publicação.
        if (job.kind !== 'render') continue;

        if (job.status === 'done' && job.result) {
          const result = job.result as RenderJobResultView;
          this.handledJobId = job.id;
          this.store.markRendered(pauta.id, {
            seconds: result.seconds,
            videoUrl: result.videoUrl,
            thumbnailUrl: result.thumbnailUrl,
            mode: result.mode,
          });
          this.lastRenderInfo.set({
            seconds: result.seconds,
            rate: result.narrationRate,
            videoUrl: result.videoUrl,
            thumbnailUrl: result.thumbnailUrl,
            mode: result.mode,
            files: result.files,
          });
        } else if (job.status === 'failed') {
          this.handledJobId = job.id;
          this.renderMp4Error.set(job.error ?? 'O render falhou na fila.');
        } else if (job.status === 'cancelled') {
          this.handledJobId = job.id;
        }
      }
    });
  }

  cancelRender(): void {
    const job = this.queue.activeJob();
    if (job) void this.queue.cancel(job.id);
  }

  selectPreviewScene(idx: number): void {
    this.speech.currentSceneIndex.set(idx);
    this.speech.sceneProgress.set(0);
    this.mediaSlotIndex.set(0);
    this.subtitleCueIndex.set(0);
  }

  stepSceneMedia(delta: -1 | 1): void {
    const total = this.activeSceneAssets().length;
    if (total <= 1) return;
    this.mediaSlotIndex.update((n) => (n + delta + total) % total);
  }

  stepSubtitleCue(delta: -1 | 1): void {
    const total = this.sceneSubtitleCues().length;
    if (total <= 1) return;
    this.subtitleCueIndex.update((n) => (n + delta + total) % total);
  }

  playPreview(): void {
    const pauta = this.store.activePauta();
    const scenes = pauta?.script?.scenes ?? [];
    if (!scenes.length) return;
    if (pauta?.narration.mode === 'clipchamp' && this.speech.importedAudioName()) {
      this.speech.playImportedAudio(scenes);
    } else {
      this.speech.playScenesTts(scenes, 0, pauta?.narration.rate ?? 1.0);
    }
  }

  decide(pautaId: string, decision: 'APPROVED' | 'REJECTED'): void {
    this.store.approveOrRejectPauta(pautaId, decision, this.approvalNoteControl.value);
  }

  downloadSubtitles(format: 'srt' | 'vtt'): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    const content = this.store.buildSubtitles(pauta, format);
    this.triggerDownload(`legendas_${pauta.id}.${format}`, content, 'text/plain;charset=utf-8');
  }

  downloadManifest(): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    const json = this.store.buildRightsManifest(pauta);
    this.triggerDownload(`manifesto-direitos_${pauta.id}.json`, json, 'application/json;charset=utf-8');
  }

  downloadScriptText(): void {
    const pauta = this.store.activePauta();
    if (!pauta) return;
    const txt = this.store.buildScriptAndDescriptionText(pauta);
    this.triggerDownload(`roteiro-descricao_${pauta.id}.txt`, txt, 'text/plain;charset=utf-8');
  }

  async renderAndDownloadMp4(mode: 'final' | 'preview' = 'final'): Promise<void> {
    const pauta = this.store.activePauta();
    if (!pauta?.script?.scenes?.length) return;

    this.renderMp4Error.set(null);
    this.gateMessage.set(null);

    try {
      const srtContent = this.store.buildSubtitles(pauta, 'srt');
      const audioBase64 =
        pauta.narration.mode === 'clipchamp' ? await this.speech.getImportedAudioBase64() : undefined;

      // O servidor decide o gate (aprovação + QC) lendo o disco: a pauta precisa
      // estar salva antes de pedir o pacote final.
      const saved = await this.store.flushProject(pauta.id);
      if (!saved) {
        throw new Error(
          'Não foi possível salvar a pauta no disco antes do render. Verifique se o servidor está no ar.',
        );
      }

      const payload = {
        pautaId: pauta.id,
        mode,
        scenes: pauta.script.scenes.map((sc) => ({
          durationSec: sc.durationSec,
          narration: sc.narration,
          avatarMode: this.avatarInVideo() ? sc.avatarMode : 'hidden',
          avatarExpression: sc.avatarExpression,
          mediaItems: getSceneMediaList(sc).map((m) => ({
            kind: m.kind,
            mediaUrl: m.mediaUrl,
            thumbUrl: m.thumbUrl,
          })),
        })),
        srtContent,
        audioBase64,
        narration: {
          enabled: !audioBase64 && this.autoNarration(),
          engine: pauta.narration.engine,
          voice: pauta.narration.voiceName || undefined,
          style: pauta.narration.style,
          rate: pauta.narration.rate,
          // Piso só no modo "monetizável"; rápido/curto respiram sozinhos.
          minSeconds: pauta.script?.mode === 'expanded' ? 62 : 0,
          fallbackToEdge: true,
        },
        dynamics: pauta.narration.dynamics ?? 'alta',
        captions: pauta.narration.captions ?? 'karaoke',
        editorial: pauta.editorial,
        videoMode: pauta.narration.videoMode ?? 'fotos',
        sources: (pauta.dossier?.sources ?? []).slice(0, 3).map((source) => ({
          title: source.title,
          domain: source.domain,
          url: source.url,
          excerpt: source.excerpt,
          publishedAt: source.publishedAt,
        })),
        // Gancho na tela nos 2 primeiros segundos: o hook do roteiro.
        headline: (pauta.script?.hook || pauta.script?.suggestedTitle || '').trim().slice(0, 140),
        closingText: (pauta.script?.closing || '').trim() || undefined,
        artifacts: {
          manifestJson: this.store.buildRightsManifest(pauta),
          scriptText: this.store.buildScriptAndDescriptionText(pauta),
          qcReport: pauta.qc ?? null,
        },
      };

      await this.queue.enqueue(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado ao enfileirar o render.';
      if (/aprovação|bloqueantes|salva no disco/i.test(message)) {
        this.gateMessage.set(message);
      } else {
        this.renderMp4Error.set(message);
      }
    }
  }

  /** Baixa o pacote já arquivado no servidor (não re-renderiza). */
  async downloadRenderedVideo(): Promise<void> {
    const pauta = this.store.activePauta();
    const videoUrl = pauta?.render?.videoUrl;
    if (!videoUrl) return;
    try {
      const res = await fetch(videoUrl);
      if (!res.ok) throw new Error(`Falha ao buscar o vídeo (HTTP ${res.status}).`);
      this.triggerBlobDownload(`short_${pauta.id}.mp4`, await res.blob());
    } catch (err) {
      this.renderMp4Error.set(err instanceof Error ? err.message : 'Erro ao baixar o vídeo.');
    }
  }

  async copyFfmpegCommand(): Promise<void> {
    await navigator.clipboard.writeText(this.ffmpegCommand());
    this.copiedFfmpeg.set(true);
    setTimeout(() => this.copiedFfmpeg.set(false), 2000);
  }

  private triggerDownload(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    this.triggerBlobDownload(filename, blob);
  }

  private triggerBlobDownload(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
