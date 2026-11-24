import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { StudioStore } from '../services/studio-store';

@Component({
  selector: 'app-dossier-view',
  imports: [ReactiveFormsModule, MatIconModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.activePauta(); as pauta) {
      <div class="space-y-6">
        <!-- Cabeçalho da Pauta e Sinais Editoriais -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span class="font-medium text-[#e59a38]">{{ pauta.editorial }}</span>
                <span aria-hidden="true">·</span>
                <span>Estágio: {{ pauta.stage }}</span>
                <span aria-hidden="true">·</span>
                <span class="font-mono-tabular">Atualizado {{ pauta.updatedAt | date: 'dd/MM HH:mm' }}</span>
              </div>
              <h1 class="mt-1.5 text-xl font-semibold text-slate-50">
                {{ pauta.title }}
              </h1>
              <a
                [href]="pauta.url"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-1 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 break-all"
              >
                <mat-icon class="text-[14px]">link</mat-icon>
                <span>{{ pauta.url }}</span>
              </a>
            </div>

            <div class="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                (click)="rerunResearch(pauta.id)"
                [disabled]="store.researchBusy()"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">sync</mat-icon>
                <span>{{ store.researchBusy() ? 'Consultando...' : 'Atualizar dossiê' }}</span>
              </button>
              <button
                type="button"
                (click)="goToScript.emit()"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[#e59a38] px-4 py-2 text-xs font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[16px]">edit_note</mat-icon>
                <span>Ir para roteiro</span>
              </button>
            </div>
          </div>

          <!-- Sinais mensuráveis (Critério 13, sem pontuação fabricada) -->
          <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="text-xs text-slate-400">Domínios independentes</div>
              <div class="mt-1 text-lg font-semibold font-mono-tabular text-slate-100">
                {{ store.activeEditorialSignals().independentSourceCount }}
              </div>
            </div>
            <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="text-xs text-slate-400">GDELT (últimos 3 dias)</div>
              <div class="mt-1 text-lg font-semibold font-mono-tabular text-slate-100">
                {{ pauta.dossier.gdeltArticles.length }} matérias
              </div>
            </div>
            <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="text-xs text-slate-400">Feeds RSS correspondentes</div>
              <div class="mt-1 text-lg font-semibold font-mono-tabular text-slate-100">
                {{ pauta.dossier.rssMatches.length }} registros
              </div>
            </div>
            <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-3.5">
              <div class="text-xs text-slate-400">Corroboração mínima</div>
              <div class="mt-1 text-sm font-medium text-slate-200">
                {{ store.activeEditorialSignals().isSingleSource ? 'Fonte única (cautela)' : 'Múltiplas fontes' }}
              </div>
            </div>
          </div>

          <!-- Campo de tema manual (útil especialmente para links do X ou paywall) -->
          <div class="mt-4 flex flex-wrap items-end gap-3">
            <div class="min-w-[260px] flex-1">
              <label for="topic-override" class="block text-xs font-medium text-slate-300">
                Termo de busca para GDELT e feeds RSS (opcional)
              </label>
              <input
                id="topic-override"
                type="text"
                [formControl]="topicOverrideControl"
                placeholder="Ajuste palavras-chave do assunto e clique em Pesquisar..."
                class="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0d12] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#e59a38] focus:outline-none"
              />
            </div>
            <button
              type="button"
              (click)="researchWithTopic(pauta.id)"
              [disabled]="store.researchBusy()"
              class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <mat-icon class="text-[16px]">search</mat-icon>
              <span>Pesquisar com este termo</span>
            </button>
          </div>
        </section>

        <!-- Aviso obrigatório de limites da verificação (RF-14 / Seção 21) -->
        <div class="rounded-xl border border-amber-500/25 bg-amber-950/20 px-4 py-3 text-xs leading-relaxed text-amber-100/90">
          Cobertura jornalística recente, repercussão em feeds ou ausência de resultados no GDELT não confirmam nem refutam uma alegação. Mantenha atribuição de fontes e revisão humana antes de gerar vídeo.
        </div>

        <!-- Extração da Matéria Original -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-slate-100">Página de origem informada</h2>
            @if (pauta.dossier.primaryExtraction; as ext) {
              <span class="text-xs font-mono-tabular text-slate-400">
                Estado: {{ ext.status }} · {{ ext.fetchedAt | date: 'dd/MM HH:mm' }}
              </span>
            }
          </div>

          @if (pauta.dossier.primaryExtraction; as ext) {
            @if (ext.limitationNote) {
              <div class="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/25 p-3 text-xs text-amber-200">
                {{ ext.limitationNote }}
              </div>
            }
            @if (ext.excerpt) {
              <div class="mt-3 rounded-lg border border-white/10 bg-[#0a0d12] p-4 text-xs leading-relaxed text-slate-300 whitespace-pre-line max-h-64 overflow-y-auto">
                {{ ext.excerpt }}
              </div>
            }
          } @else {
            <p class="mt-2 text-xs text-slate-400">
              Clique em "Atualizar dossiê" para tentar extrair título, descrição e trechos públicos desta URL.
            </p>
          }
        </section>

        <!-- GDELT DOC 2.0 + Feeds RSS -->
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
            <div class="flex items-center justify-between gap-2 border-b border-white/10 pb-3">
              <h2 class="text-base font-semibold text-slate-100">GDELT DOC 2.0 (últimos 3 dias)</h2>
              <span class="text-xs text-slate-400 font-mono-tabular">
                {{ pauta.dossier.gdeltStatus }} · até 10 itens
              </span>
            </div>

            @if (pauta.dossier.gdeltMessage) {
              <p class="mt-3 text-xs text-amber-300">{{ pauta.dossier.gdeltMessage }}</p>
            }

            @if (pauta.dossier.gdeltArticles.length === 0) {
              <p class="mt-3 text-xs text-slate-400">
                Nenhum resultado GDELT registrado para esta consulta.
              </p>
            } @else {
              <ul class="mt-3 divide-y divide-white/10">
                @for (art of pauta.dossier.gdeltArticles; track art.id) {
                  <li class="py-3">
                    <div class="flex items-center gap-2 text-xs text-slate-400">
                      <span class="font-medium text-slate-200">{{ art.domain }}</span>
                      <span aria-hidden="true">·</span>
                      <span class="font-mono-tabular">{{ art.seenDate | date: 'dd/MM HH:mm' }}</span>
                    </div>
                    <a
                      [href]="art.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="mt-1 block text-xs font-medium text-slate-100 hover:text-[#e59a38]"
                    >
                      {{ art.title }}
                    </a>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
            <div class="flex items-center justify-between gap-2 border-b border-white/10 pb-3">
              <h2 class="text-base font-semibold text-slate-100">Feeds RSS públicos relacionados</h2>
              <span class="text-xs text-slate-400 font-mono-tabular">
                {{ pauta.dossier.rssRespondedCount }}/{{ pauta.dossier.rssTotalCount }} feeds
              </span>
            </div>

            @if (pauta.dossier.rssMatches.length === 0) {
              <p class="mt-3 text-xs text-slate-400">
                Nenhuma correspondência direta nos feeds RSS públicos nesta consulta.
              </p>
            } @else {
              <ul class="mt-3 divide-y divide-white/10">
                @for (item of pauta.dossier.rssMatches; track item.id) {
                  <li class="py-3">
                    <div class="flex items-center gap-2 text-xs text-slate-400">
                      <span class="font-medium text-slate-200">{{ item.outlet }}</span>
                      <span aria-hidden="true">·</span>
                      <span>{{ item.editorial }}</span>
                      <span aria-hidden="true">·</span>
                      <span class="font-mono-tabular">{{ item.publishedAt | date: 'dd/MM HH:mm' }}</span>
                    </div>
                    <a
                      [href]="item.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="mt-1 block text-xs font-medium text-slate-100 hover:text-[#e59a38]"
                    >
                      {{ item.title }}
                    </a>
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <!-- Síntese Gemini URL Context (Faixa Gratuita, sem Google Search Grounding) -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div>
              <h2 class="text-base font-semibold text-slate-100">
                Comparação complementar Gemini URL Context
              </h2>
              <p class="mt-0.5 text-xs text-slate-400">
                Lê exclusivamente URLs públicas encontradas no dossiê (exclui X/Twitter e fontes autenticadas; Google Search Grounding desativado na faixa gratuita).
              </p>
            </div>
            <span class="text-xs font-mono-tabular text-slate-400">
              Modelo: {{ store.configStatus().activeModel }}
            </span>
          </div>

          @if (pauta.dossier.geminiContext; as gctx) {
            @if (gctx.status === 'ok') {
              <div class="mt-4 space-y-4">
                <p class="text-sm leading-relaxed text-slate-200">{{ gctx.summary }}</p>

                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4">
                    <h3 class="text-xs font-semibold text-emerald-400">Fatos apoiados nas URLs recuperadas</h3>
                    <ul class="mt-2 space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                      @for (fact of gctx.supportedFacts; track fact) {
                        <li>{{ fact }}</li>
                      }
                    </ul>
                  </div>

                  <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4">
                    <h3 class="text-xs font-semibold text-amber-400">Incertezas e limitações</h3>
                    <ul class="mt-2 space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                      @for (unc of gctx.uncertainties; track unc) {
                        <li>{{ unc }}</li>
                      }
                    </ul>
                  </div>
                </div>

                @if (gctx.retrievedUrls.length > 0) {
                  <div class="text-xs text-slate-400">
                    URLs recuperadas pelo URL Context:
                    @for (u of gctx.retrievedUrls; track u; let last = $last) {
                      <a [href]="u" target="_blank" rel="noopener noreferrer" class="underline hover:text-slate-200">{{ u }}</a>{{ last ? '' : ' · ' }}
                    }
                  </div>
                }
              </div>
            } @else {
              <div class="mt-4 rounded-lg border border-white/10 bg-[#0a0d12] p-4 text-xs text-slate-300">
                {{ gctx.message || 'Síntese URL Context indisponível nesta execução. Os resultados públicos originais acima seguem preservados.' }}
              </div>
            }
          } @else {
            <p class="mt-3 text-xs text-slate-400">
              Execute "Atualizar dossiê" para comparar as URLs públicas recuperadas via Gemini URL Context.
            </p>
          }
        </section>

        <!-- Lista consolidada de IDs de fonte -->
        <section class="rounded-xl border border-white/10 bg-[#111620] p-6">
          <h2 class="text-base font-semibold text-slate-100">
            Fontes indexadas para referência no roteiro ({{ pauta.dossier.sources.length }})
          </h2>
          @if (pauta.dossier.sources.length === 0) {
            <p class="mt-2 text-xs text-slate-400">
              Nenhuma fonte catalogada ainda. Pesquise a pauta acima.
            </p>
          } @else {
            <div class="mt-3 overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-white/10 text-slate-400">
                  <tr>
                    <th class="py-2 pr-3 font-medium">ID</th>
                    <th class="py-2 pr-3 font-medium">Origem</th>
                    <th class="py-2 pr-3 font-medium">Título</th>
                    <th class="py-2 text-right font-medium">Consultado em</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  @for (src of pauta.dossier.sources; track src.id) {
                    <tr class="hover:bg-white/[0.02]">
                      <td class="py-2.5 pr-3 font-mono-tabular font-semibold text-[#e59a38]">{{ src.id }}</td>
                      <td class="py-2.5 pr-3 text-slate-300">{{ src.label }}</td>
                      <td class="py-2.5 pr-3">
                        <a [href]="src.url" target="_blank" rel="noopener noreferrer" class="text-slate-100 hover:underline">
                          {{ src.title }}
                        </a>
                      </td>
                      <td class="py-2.5 text-right font-mono-tabular text-slate-400">
                        {{ src.consultedAt | date: 'dd/MM HH:mm' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </div>
    } @else {
      <div class="rounded-xl border border-white/10 bg-[#111620] p-12 text-center">
        <p class="text-sm text-slate-300">Nenhuma pauta selecionada no momento.</p>
        <p class="mt-1 text-xs text-slate-400">
          Cadastre uma URL ou escolha uma notícia na aba Descoberta para montar o dossiê.
        </p>
      </div>
    }
  `,
})
export class DossierView {
  readonly store = inject(StudioStore);
  readonly goToScript = output<void>();
  readonly topicOverrideControl = new FormControl('', { nonNullable: true });

  async rerunResearch(pautaId: string): Promise<void> {
    await this.store.researchPauta(pautaId);
  }

  async researchWithTopic(pautaId: string): Promise<void> {
    const q = this.topicOverrideControl.value.trim();
    if (!q) return;
    this.store.updatePautaTitle(pautaId, q);
    await this.store.researchPauta(pautaId, q);
  }
}
