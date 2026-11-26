import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { ScriptScene, ScriptVersionMode } from '../models/studio.models';
import { StudioStore, extractOrderedEntityNames } from '../services/studio-store';

@Component({
  selector: 'app-script-view',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.activePauta(); as pauta) {
      <div class="space-y-6">
        <!-- Barra de Geração Gemini e Controle de Cota Gratuita -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div>
              <h1 class="text-xl font-semibold text-slate-50">Roteiro em cenas com vínculo de fontes</h1>
              <p class="mt-1 text-xs leading-relaxed text-slate-400">
                Antes de gerar, o trecho da matéria e as evidências do dossiê são enviados exclusivamente ao Gemini ({{ store.configStatus().activeModel }}). O roteiro permanece editável e nunca é publicado automaticamente.
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                (click)="store.toggleGeminiProvider()"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">{{ store.geminiDisabledByUser() ? 'toggle_off' : 'toggle_on' }}</mat-icon>
                <span>{{ store.geminiDisabledByUser() ? 'Gemini pausado' : 'Gemini ativo (faixa gratuita)' }}</span>
              </button>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-4">
            <!-- Seletor de versão: rápido (retém), curto ou expandido -->
            <div class="flex items-center gap-1 rounded-lg bg-[#0a0d12] p-1 border border-white/10">
              <button
                type="button"
                (click)="selectedMode.set('rapido')"
                class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                [class.bg-[#e59a38]]="selectedMode() === 'rapido'"
                [class.text-[#0a0d12]]="selectedMode() === 'rapido'"
                [class.text-slate-300]="selectedMode() !== 'rapido'"
                title="4 cenas, 100–125 palavras, ~40 s: melhor retenção"
              >
                Rápido (38–48 s)
              </button>
              <button
                type="button"
                (click)="selectedMode.set('short')"
                class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                [class.bg-[#e59a38]]="selectedMode() === 'short'"
                [class.text-[#0a0d12]]="selectedMode() === 'short'"
                [class.text-slate-300]="selectedMode() !== 'short'"
              >
                Curto (45–58 s)
              </button>
              <button
                type="button"
                (click)="selectedMode.set('expanded')"
                class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                [class.bg-[#e59a38]]="selectedMode() === 'expanded'"
                [class.text-[#0a0d12]]="selectedMode() === 'expanded'"
                [class.text-slate-300]="selectedMode() !== 'expanded'"
              >
                Monetizável (60–75 s)
              </button>
            </div>

            <div class="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                (click)="store.createBlankManualScript(pauta.id, selectedMode())"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">note_add</mat-icon>
                <span>Criar roteiro manual</span>
              </button>
              <button
                type="button"
                (click)="store.buildDraftFromDossier(pauta.id, selectedMode())"
                class="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors"
                [class.bg-[#e59a38]]="!store.configStatus().geminiConfigured || store.geminiDisabledByUser()"
                [class.text-[#0a0d12]]="!store.configStatus().geminiConfigured || store.geminiDisabledByUser()"
                [class.hover:bg-[#f0aa4b]]="!store.configStatus().geminiConfigured || store.geminiDisabledByUser()"
                [class.border]="store.configStatus().geminiConfigured && !store.geminiDisabledByUser()"
                [class.border-white/15]="store.configStatus().geminiConfigured && !store.geminiDisabledByUser()"
                [class.text-slate-200]="store.configStatus().geminiConfigured && !store.geminiDisabledByUser()"
                [class.hover:bg-white/5]="store.configStatus().geminiConfigured && !store.geminiDisabledByUser()"
              >
                <mat-icon class="text-[16px]">playlist_add_check</mat-icon>
                <span>Montar rascunho do dossiê</span>
              </button>
              @if (store.configStatus().geminiConfigured) {
                <button
                  type="button"
                  (click)="store.generateScriptWithGemini(pauta.id, selectedMode())"
                  [disabled]="store.scriptBusy() || store.geminiDisabledByUser()"
                  class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-45 whitespace-nowrap shrink-0"
                >
                  <mat-icon class="text-[16px]">auto_stories</mat-icon>
                  <span>{{ store.scriptBusy() ? 'Gerando com Gemini...' : 'Gerar roteiro com Gemini' }}</span>
                </button>
              }
            </div>
          </div>

          @if (!store.configStatus().geminiConfigured) {
            <div class="mt-4 rounded-lg border border-white/10 bg-[#0a0d12] px-4 py-3 text-xs text-slate-300">
              Geração automática por IA Gemini indisponível neste servidor no momento. Use <strong>Montar rascunho do dossiê</strong> para estruturar as cenas diretamente a partir das fontes apuradas, ou edite manualmente e teste a prévia 9:16.
            </div>
          }
          @if (store.configStatus().geminiQuotaPaused) {
            <div class="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">
              Chamadas Gemini em pausa temporária após limite 429 para respeitar a cota gratuita. Use "Montar rascunho do dossiê" ou edite manualmente enquanto aguarda.
            </div>
          }
        </section>

        @if (pauta.script; as script) {
          <!-- Métricas de leitura e ações -->
          <section class="rounded-xl border border-white/10 bg-[#111620] p-6 space-y-5">
            <div class="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
              <div class="flex flex-wrap items-center gap-4 text-xs text-slate-300 font-mono-tabular">
                <span>{{ totalWords() }} palavras</span>
                <span aria-hidden="true">·</span>
                <span>~{{ estimatedSeconds() }}s a 130 pal/min</span>
                <span aria-hidden="true">·</span>
                <span>{{ script.scenes.length }} cenas</span>
                <span aria-hidden="true">·</span>
                <span class="text-slate-400">Modelo: {{ script.modelUsed }}</span>
              </div>

              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  (click)="addScene(pauta.id)"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
                >
                  <mat-icon class="text-[16px]">add</mat-icon>
                  <span>Adicionar cena</span>
                </button>
                <button
                  type="button"
                  (click)="goToMedia.emit()"
                  class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-4 py-1.5 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] whitespace-nowrap shrink-0"
                >
                  <mat-icon class="text-[16px]">perm_media</mat-icon>
                  <span>Selecionar mídia e voz</span>
                </button>
              </div>
            </div>

            <!-- Campos gerais do roteiro -->
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label class="block text-xs font-medium text-slate-300">Título sugerido do Short</label>
                <input
                  type="text"
                  [value]="script.suggestedTitle"
                  (input)="updateTopField(pauta.id, 'suggestedTitle', $event)"
                  class="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2 text-sm text-slate-100 focus:border-[#e59a38] focus:outline-none"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-300">Ressalva de incerteza / apuração</label>
                <input
                  type="text"
                  [value]="script.uncertaintyNote"
                  (input)="updateTopField(pauta.id, 'uncertaintyNote', $event)"
                  placeholder="Registre limites ou pontos sem confirmação..."
                  class="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
                />
              </div>
            </div>

            <!-- Lista de cenas editáveis -->
            <div class="space-y-4">
              @for (scene of script.scenes; track scene.id) {
                <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4 space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-3 text-xs font-mono-tabular">
                      <span class="font-semibold text-[#e59a38]">Cena {{ scene.order }}</span>
                      <label class="inline-flex items-center gap-1.5 text-slate-400">
                        <span>Duração (s):</span>
                        <input
                          type="number"
                          min="3"
                          max="25"
                          [value]="scene.durationSec"
                          (input)="updateSceneNumber(pauta.id, scene.id, 'durationSec', $event)"
                          class="w-16 rounded border border-white/10 bg-[#111620] px-2 py-1 text-xs text-slate-100 font-mono-tabular focus:border-[#e59a38] focus:outline-none"
                        />
                      </label>
                      <label class="inline-flex items-center gap-1.5 text-slate-400">
                        <span>Avatar:</span>
                        <select
                          [value]="scene.avatarMode"
                          (change)="updateSceneSelect(pauta.id, scene.id, 'avatarMode', $event)"
                          class="rounded border border-white/10 bg-[#111620] px-2 py-1 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
                        >
                          <option value="full">Tela cheia</option>
                          <option value="pip">PiP sobre mídia</option>
                          <option value="hidden">Oculto (B-roll)</option>
                        </select>
                      </label>
                      <label class="inline-flex items-center gap-1.5 text-slate-400">
                        <span>Expressão:</span>
                        <select
                          [value]="scene.avatarExpression"
                          (change)="updateSceneSelect(pauta.id, scene.id, 'avatarExpression', $event)"
                          class="rounded border border-white/10 bg-[#111620] px-2 py-1 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
                        >
                          <option value="neutral">Neutra</option>
                          <option value="explaining">Explicativa</option>
                          <option value="alert">Alerta</option>
                          <option value="closing">Encerramento</option>
                        </select>
                      </label>
                    </div>

                    <button
                      type="button"
                      (click)="removeScene(pauta.id, scene.id)"
                      [disabled]="script.scenes.length <= 1"
                      class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-400 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-30"
                    >
                      <mat-icon class="text-[15px]">delete_outline</mat-icon>
                      <span>Remover</span>
                    </button>
                  </div>

                  <div>
                    <label class="block text-xs text-slate-400">Texto da narração (pt-BR)</label>
                    <textarea
                      rows="2"
                      [value]="scene.narration"
                      (input)="updateSceneText(pauta.id, scene.id, 'narration', $event)"
                      class="mt-1 w-full rounded-lg border border-white/10 bg-[#111620] px-3 py-2 text-sm leading-relaxed text-slate-100 focus:border-[#e59a38] focus:outline-none"
                    ></textarea>
                  </div>

                  <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <div>
                      <label class="block text-xs text-slate-400">Busca visual (PT)</label>
                      <input
                        type="text"
                        [value]="scene.visualQueryPt"
                        (input)="updateSceneText(pauta.id, scene.id, 'visualQueryPt', $event)"
                        class="mt-1 w-full rounded border border-white/10 bg-[#111620] px-2.5 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label class="block text-xs text-slate-400">Busca visual (EN)</label>
                      <input
                        type="text"
                        [value]="scene.visualQueryEn"
                        (input)="updateSceneText(pauta.id, scene.id, 'visualQueryEn', $event)"
                        class="mt-1 w-full rounded border border-white/10 bg-[#111620] px-2.5 py-1.5 text-xs text-slate-200 focus:border-[#e59a38] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label class="block text-xs text-slate-400">Notas de pronúncia</label>
                      <input
                        type="text"
                        [value]="scene.pronunciationNotes"
                        (input)="updateSceneText(pauta.id, scene.id, 'pronunciationNotes', $event)"
                        placeholder="Siglas, nomes próprios..."
                        class="mt-1 w-full rounded border border-white/10 bg-[#111620] px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-[#e59a38] focus:outline-none"
                      />
                    </div>
                  </div>

                  @if (scene.detectedEntities?.length) {
                    <div class="flex flex-wrap items-center gap-2 pt-0.5">
                      <span class="text-[11px] text-slate-400">Nomes na ordem do roteiro:</span>
                      @for (entity of scene.detectedEntities!; track entity) {
                        <div class="relative inline-flex items-center">
                          <span class="rounded border border-white/10 bg-[#111620] pl-2.5 pr-3.5 py-0.5 text-[11px] text-slate-200">
                            {{ entity }}
                          </span>
                          <button
                            type="button"
                            [attr.aria-label]="'Remover nome ' + entity"
                            title="Remover nome sugerido"
                            (click)="store.removeSceneDetectedEntity(pauta.id, scene.id, entity)"
                            class="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/15 bg-[#1a2232] text-slate-300 hover:border-red-400 hover:bg-red-950 hover:text-red-200"
                          >
                            <mat-icon class="!h-[10px] !w-[10px] !text-[10px] !leading-[10px]">close</mat-icon>
                          </button>
                        </div>
                      }
                    </div>
                  }

                  <!-- Vínculo obrigatório de fontes do dossiê -->
                  <div class="pt-1">
                    <div class="text-xs text-slate-400 mb-1.5">
                      Fontes vinculadas nesta cena ({{ scene.sourceIds.length }} selecionadas):
                    </div>
                    @if (pauta.dossier.sources.length === 0) {
                      <p class="text-xs text-red-300">
                        Nenhuma fonte disponível no dossiê para vincular.
                      </p>
                    } @else {
                      <div class="flex flex-wrap gap-1.5">
                        @for (src of pauta.dossier.sources; track src.id) {
                          <button
                            type="button"
                            (click)="toggleSceneSource(pauta.id, scene.id, src.id)"
                            [title]="src.title"
                            class="rounded-md border px-2.5 py-1 text-xs font-mono-tabular transition-colors whitespace-nowrap shrink-0"
                            [class.border-[#e59a38]]="scene.sourceIds.includes(src.id)"
                            [class.bg-[#e59a38]/15]="scene.sourceIds.includes(src.id)"
                            [class.text-[#f5c273]]="scene.sourceIds.includes(src.id)"
                            [class.border-white/10]="!scene.sourceIds.includes(src.id)"
                            [class.text-slate-400]="!scene.sourceIds.includes(src.id)"
                          >
                            {{ src.id }} · {{ src.domain }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          </section>
        } @else {
          <div class="rounded-xl border border-white/10 bg-[#111620] p-10 text-center">
            <p class="text-sm text-slate-300">Nenhum roteiro criado para esta pauta ainda.</p>
            <p class="mt-1 text-xs text-slate-400">
              Use "Montar rascunho do dossiê"{{ store.configStatus().geminiConfigured ? ', "Gerar roteiro com Gemini"' : '' }} ou "Criar roteiro manual" acima.
            </p>
          </div>
        }
      </div>
    } @else {
      <div class="rounded-xl border border-white/10 bg-[#111620] p-12 text-center">
        <p class="text-sm text-slate-300">Selecione uma pauta na fila ou cadastre uma nova URL.</p>
      </div>
    }
  `,
})
export class ScriptView {
  readonly store = inject(StudioStore);
  readonly goToMedia = output<void>();
  readonly selectedMode = signal<ScriptVersionMode>('rapido');

  readonly totalWords = computed(() => {
    const scenes = this.store.activePauta()?.script?.scenes ?? [];
    return scenes
      .map((s) => s.narration.trim())
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
  });

  readonly estimatedSeconds = computed(() => Math.round((this.totalWords() / 130) * 60));

  updateTopField(pautaId: string, field: 'suggestedTitle' | 'uncertaintyNote', ev: Event): void {
    const val = (ev.target as HTMLInputElement).value;
    this.store.updateScript(pautaId, (sc) => ({ ...sc, [field]: val }));
  }

  updateSceneText(
    pautaId: string,
    sceneId: string,
    field: 'narration' | 'visualQueryPt' | 'visualQueryEn' | 'pronunciationNotes',
    ev: Event,
  ): void {
    const val = (ev.target as HTMLInputElement | HTMLTextAreaElement).value;
    const pautaTitle = this.store.activePauta()?.title ?? '';
    this.store.updateScript(pautaId, (sc) => ({
      ...sc,
      scenes: sc.scenes.map((item) => {
        if (item.id !== sceneId) return item;
        if (field !== 'narration') {
          return { ...item, [field]: val };
        }
        const ignored = new Set((item.ignoredEntities ?? []).map((x) => x.trim().toLowerCase()));
        const ordered = extractOrderedEntityNames(val, pautaTitle).filter(
          (name) => !ignored.has(name.trim().toLowerCase()),
        );
        return {
          ...item,
          narration: val,
          detectedEntities: ordered,
        };
      }),
    }));
  }

  updateSceneNumber(pautaId: string, sceneId: string, field: 'durationSec', ev: Event): void {
    const parsed = Number((ev.target as HTMLInputElement).value);
    const val = Number.isFinite(parsed) ? Math.max(3, Math.min(30, parsed)) : 6;
    this.store.updateScript(pautaId, (sc) => ({
      ...sc,
      scenes: sc.scenes.map((item) => (item.id === sceneId ? { ...item, [field]: val } : item)),
    }));
  }

  updateSceneSelect(
    pautaId: string,
    sceneId: string,
    field: 'avatarMode' | 'avatarExpression',
    ev: Event,
  ): void {
    const val = (ev.target as HTMLSelectElement).value;
    this.store.updateScript(pautaId, (sc) => ({
      ...sc,
      scenes: sc.scenes.map((item) =>
        item.id === sceneId
          ? {
              ...item,
              [field]: val as ScriptScene['avatarMode'] & ScriptScene['avatarExpression'],
            }
          : item,
      ),
    }));
  }

  toggleSceneSource(pautaId: string, sceneId: string, sourceId: string): void {
    this.store.updateScript(pautaId, (sc) => ({
      ...sc,
      scenes: sc.scenes.map((item) => {
        if (item.id !== sceneId) return item;
        const exists = item.sourceIds.includes(sourceId);
        return {
          ...item,
          sourceIds: exists
            ? item.sourceIds.filter((id) => id !== sourceId)
            : [...item.sourceIds, sourceId],
        };
      }),
    }));
  }

  addScene(pautaId: string): void {
    this.store.updateScript(pautaId, (sc) => {
      const nextOrder = sc.scenes.length + 1;
      const newScene: ScriptScene = {
        id: `scene-${Date.now()}-${nextOrder}`,
        order: nextOrder,
        durationSec: 6,
        narration: '',
        pronunciationNotes: '',
        visualQueryPt: sc.scenes[0]?.visualQueryPt ?? 'notícia Brasil',
        visualQueryEn: sc.scenes[0]?.visualQueryEn ?? 'news editorial',
        avatarMode: 'pip',
        avatarExpression: 'explaining',
        sourceIds: sc.scenes[0]?.sourceIds ?? [],
        isDocumentaryMedia: false,
      };
      return { ...sc, scenes: [...sc.scenes, newScene] };
    });
  }

  removeScene(pautaId: string, sceneId: string): void {
    this.store.updateScript(pautaId, (sc) => {
      const remaining = sc.scenes
        .filter((item) => item.id !== sceneId)
        .map((item, idx) => ({ ...item, order: idx + 1 }));
      return { ...sc, scenes: remaining };
    });
  }
}
