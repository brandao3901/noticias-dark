import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { PublishMetadata } from '../models/studio.models';
import { RenderQueue, type PublishJobResultView } from '../services/render-queue';
import { StudioStore } from '../services/studio-store';

interface PlatformReadiness {
  ready: boolean;
  configured?: boolean;
  audited?: boolean;
  reason?: string;
}

interface YoutubeStatusView {
  configured: boolean;
  connected: boolean;
  channelTitle: string | null;
  channelId: string | null;
  scopes: string[];
  privacyDefault: 'public' | 'unlisted' | 'private';
  monetary: boolean;
  redirectUri?: string;
  clientId?: string | null;
  expectedChannelId?: string | null;
  channelMatchesExpected?: boolean | null;
}

interface StatusPayload {
  youtube: YoutubeStatusView;
  tiktok: PlatformReadiness;
  instagram: PlatformReadiness;
  quota: { used: number; limit: number; remainingForUploads: number; day: string };
}

interface AnalyticsView {
  views: number;
  averageViewDurationSec: number;
  averageViewPercentage: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  startDate: string;
  endDate: string;
}

interface CommentView {
  id: string;
  author: string;
  text: string;
  publishedAt: string;
  likeCount: number;
  replies: Array<{ id: string; author: string; text: string; publishedAt: string }>;
}

/**
 * Publicação: metadados editáveis, envio para o YouTube, agendamento,
 * desempenho e comentários. TikTok/Instagram aparecem com o motivo do bloqueio
 * quando o app ainda não foi aprovado nas plataformas.
 */
@Component({
  selector: 'app-publish-panel',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pauta(); as p) {
      <div class="rounded-lg border border-white/10 bg-[#0a0d12] p-4 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-xs font-semibold text-slate-100">
            <mat-icon class="text-[17px] text-[#e59a38]">smart_display</mat-icon>
            <span>Publicar no YouTube</span>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-[11px]">
            @if (status(); as st) {
              @if (st.youtube.connected) {
                <span
                  class="rounded px-2 py-0.5"
                  [class.bg-emerald-500/15]="!channelMismatch()"
                  [class.text-emerald-300]="!channelMismatch()"
                  [class.bg-red-500/15]="channelMismatch()"
                  [class.text-red-300]="channelMismatch()"
                  [title]="st.youtube.channelId ?? ''"
                >
                  {{ st.youtube.channelTitle }} ·
                  {{ channelMismatch() ? 'conta errada' : 'conectado' }}
                </span>
              } @else {
                <span class="rounded bg-amber-500/15 px-2 py-0.5 text-amber-200">
                  YouTube não conectado
                </span>
              }
              <span class="rounded border border-white/15 px-2 py-0.5 font-mono-tabular text-slate-300">
                cota {{ st.quota.used }}/{{ st.quota.limit }} · {{ st.quota.remainingForUploads }} envios
              </span>
            }
            <button
              type="button"
              (click)="connect()"
              class="rounded border border-white/15 px-2 py-0.5 text-slate-200 hover:bg-white/10"
            >
              @if (status()?.youtube?.connected) {
                Reconectar
              } @else if (status()?.youtube?.configured) {
                Conectar YouTube
              } @else {
                Configurar YouTube
              }
            </button>
            @if (status()?.youtube?.connected) {
              <button
                type="button"
                (click)="channelFixed() ? clearChannel() : fixChannel()"
                [disabled]="busy()"
                class="rounded border px-2 py-0.5 disabled:opacity-40"
                [class.border-emerald-500/40]="channelFixed()"
                [class.text-emerald-300]="channelFixed()"
                [class.border-white/15]="!channelFixed()"
                [class.text-slate-200]="!channelFixed()"
                title="Quando fixado, o app recusa publicar em qualquer outro canal"
              >
                {{ channelFixed() ? 'Canal fixado ✓' : 'Fixar este canal' }}
              </button>
            }
          </div>

          @if (channelMismatch()) {
            <div class="space-y-1 rounded-lg border border-red-500/40 bg-red-950/20 p-3 text-[11px] text-red-100">
              <div class="flex items-center gap-2 font-semibold">
                <mat-icon class="text-[16px]">block</mat-icon>
                <span>Publicação bloqueada: a conta conectada não é a do canal fixado</span>
              </div>
              <p>
                Conectado agora: <strong>{{ status()?.youtube?.channelTitle }}</strong>
                ({{ status()?.youtube?.channelId }})
              </p>
              <p>Canal fixado: <strong>{{ status()?.youtube?.expectedChannelId }}</strong></p>
              <p>
                Reconecte entrando com a conta dona do canal fixado — ou clique em
                <em>Canal fixado ✓</em> para liberar e fixar o canal atual.
              </p>
            </div>
          }
        </div>

        @if (status(); as st) {
          @if (!st.youtube.configured) {
            <div class="space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-amber-100">
                  Conectar o YouTube — uma vez, ~5 min
                </span>
                <button
                  type="button"
                  (click)="toggleGuide()"
                  class="text-[10px] text-amber-200 underline"
                >
                  {{ guideOpen() ? 'ocultar passos' : 'ver passos' }}
                </button>
              </div>

              @if (guideOpen()) {
                <ol class="ml-4 list-decimal space-y-1 text-[11px] leading-relaxed text-amber-100/90">
                  <li>
                    <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer" class="underline">Crie um projeto</a>
                    no Google Cloud (qualquer nome).
                  </li>
                  <li>
                    <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer" class="underline">Ative a YouTube Data API v3</a>.
                  </li>
                  <li>
                    <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener noreferrer" class="underline">Tela de consentimento</a>:
                    tipo <strong>Externo</strong>, preencha nome e e-mail e adicione seu e-mail em <strong>Usuários de teste</strong>.
                    <p class="mt-1 text-[10px] text-red-300">
                      Se ao autorizar aparecer <strong>403: access_denied</strong>, é porque a conta usada
                      não está em <em>Usuários de teste</em> — adicione o e-mail exato dela lá e tente de novo.
                    </p>
                  </li>
                  <li>
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" class="underline">Credenciais</a> →
                    <strong>Criar credenciais</strong> → <strong>ID do cliente OAuth</strong> → tipo <strong>Aplicativo para computador</strong>
                    <span class="text-amber-200/80">(atalho: esse tipo não pede URI nenhuma — pule o passo 5)</span>
                    ou <strong>Aplicativo da Web</strong>.
                  </li>
                  <li>
                    <strong>Só no tipo Aplicativo da Web.</strong> Existem duas caixas e elas não são
                    iguais:
                    <div class="mt-1.5 space-y-1.5 rounded border border-amber-400/30 bg-black/20 p-2">
                      <div>
                        <div class="text-[10px] font-semibold text-amber-100">URIs de redirecionamento autorizados</div>
                        <div class="mt-0.5 flex items-center gap-2">
                          <code class="flex-1 truncate rounded bg-black/40 px-2 py-1 text-[10px] text-emerald-200">{{ redirectUri() }}</code>
                          <button type="button" (click)="copyRedirect()" class="rounded border border-white/15 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-white/10">copiar</button>
                        </div>
                      </div>
                      <div>
                        <div class="text-[10px] font-semibold text-amber-100">Origens JavaScript autorizadas (opcional)</div>
                        <div class="mt-0.5 flex items-center gap-2">
                          <code class="flex-1 truncate rounded bg-black/40 px-2 py-1 text-[10px] text-slate-300">{{ originUri() }}</code>
                          <button type="button" (click)="copyOrigin()" class="rounded border border-white/15 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-white/10">copiar</button>
                        </div>
                      </div>
                    </div>
                    <p class="mt-1 text-[10px] text-red-300">
                      Se o Google disser "URI de origem inválida: não é permitido caminho", você colou o
                      callback na caixa de <em>origens JavaScript</em> — ela aceita só o domínio, sem
                      <code>/api/...</code> e sem barra no fim. E não repita a mesma URI em duas linhas.
                    </p>
                  </li>
                  <li>Copie o <strong>Client ID</strong> e o <strong>Client Secret</strong> e cole abaixo.</li>
                </ol>
              }

              <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  [value]="setupClientId()"
                  (input)="onSetupId($event)"
                  placeholder="Client ID (…apps.googleusercontent.com)"
                  class="rounded border border-white/10 bg-[#111620] px-2.5 py-1.5 text-[11px] text-slate-100 focus:border-[#e59a38] focus:outline-none"
                />
                <input
                  [value]="setupClientSecret()"
                  (input)="onSetupSecret($event)"
                  type="password"
                  placeholder="Client Secret"
                  class="rounded border border-white/10 bg-[#111620] px-2.5 py-1.5 text-[11px] text-slate-100 focus:border-[#e59a38] focus:outline-none"
                />
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  (click)="saveCredentials()"
                  [disabled]="savingSetup()"
                  class="rounded bg-[#e59a38] px-3 py-1.5 text-[11px] font-semibold text-[#0a0d12] hover:bg-[#f0aa4b] disabled:opacity-40"
                >
                  {{ savingSetup() ? 'Salvando…' : 'Salvar e conectar' }}
                </button>
                <span class="text-[10px] text-amber-200/80">
                  Grava no .env local (fora do git) e já abre a autorização.
                </span>
              </div>

              @if (setupError(); as message) {
                <p class="text-[11px] text-red-300">{{ message }}</p>
              }
            </div>
          }
          <div class="flex flex-wrap gap-2 text-[11px]">
            <span
              class="rounded border px-2 py-0.5"
              [class.border-emerald-500/40]="st.tiktok.ready"
              [class.text-emerald-300]="st.tiktok.ready"
              [class.border-white/15]="!st.tiktok.ready"
              [class.text-slate-400]="!st.tiktok.ready"
              [title]="st.tiktok.reason ?? ''"
            >
              TikTok: {{ st.tiktok.ready ? 'pronto' : 'bloqueado' }}
            </span>
            <span
              class="rounded border px-2 py-0.5"
              [class.border-emerald-500/40]="st.instagram.ready"
              [class.text-emerald-300]="st.instagram.ready"
              [class.border-white/15]="!st.instagram.ready"
              [class.text-slate-400]="!st.instagram.ready"
              [title]="st.instagram.reason ?? ''"
            >
              Instagram: {{ st.instagram.ready ? 'pronto' : 'bloqueado' }}
            </span>
          </div>
        }

        <!-- Metadados do post -->
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <label class="text-[11px] font-medium text-slate-300">Título ({{ title().length }}/100)</label>
            <button
              type="button"
              (click)="generateMetadata()"
              [disabled]="busy()"
              class="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              <mat-icon class="text-[14px]">auto_fix_high</mat-icon>
              <span>{{ busy() ? 'Gerando…' : 'Sugerir com IA' }}</span>
            </button>
          </div>
          <input
            [value]="title()"
            (input)="onTitle($event)"
            maxlength="100"
            class="w-full rounded-lg border border-white/10 bg-[#111620] px-3 py-2 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
          />

          @if (alternatives().length) {
            <div class="flex flex-wrap gap-1.5">
              @for (alt of alternatives(); track alt) {
                <button
                  type="button"
                  (click)="useAlternative(alt)"
                  class="rounded border border-white/10 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-white/10 hover:text-slate-200"
                >
                  {{ alt }}
                </button>
              }
            </div>
          }

          <label class="block text-[11px] font-medium text-slate-300">
            Legenda / descrição ({{ description().length }}/5000)
          </label>
          <textarea
            [value]="description()"
            (input)="onDescription($event)"
            rows="8"
            class="w-full rounded-lg border border-white/10 bg-[#111620] px-3 py-2 text-[11px] leading-relaxed text-slate-100 focus:border-[#e59a38] focus:outline-none"
          ></textarea>

          <label class="block text-[11px] font-medium text-slate-300">
            Tags (separadas por vírgula)
          </label>
          <input
            [value]="tagsText()"
            (input)="onTags($event)"
            class="w-full rounded-lg border border-white/10 bg-[#111620] px-3 py-2 text-xs text-slate-100 focus:border-[#e59a38] focus:outline-none"
          />
        </div>

        <!-- Privacidade, agendamento e direitos -->
        <div class="flex flex-wrap items-center gap-3 text-[11px]">
          <label class="flex items-center gap-1.5 text-slate-300">
            Privacidade
            <select
              [value]="privacy()"
              (change)="onPrivacy($event)"
              class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="unlisted">Não listado</option>
              <option value="public">Público</option>
              <option value="private">Privado</option>
            </select>
          </label>

          <label class="flex items-center gap-1.5 text-slate-300">
            Agendar
            <input
              type="datetime-local"
              [value]="scheduleAt()"
              (input)="onScheduleAt($event)"
              class="rounded border border-white/15 bg-[#111620] px-2 py-1 text-[11px] text-slate-200"
            />
          </label>
        </div>

        @if (hasThirdParty()) {
          <label class="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-950/20 p-2 text-[11px] text-amber-100">
            <input type="checkbox" [checked]="confirmRights()" (change)="toggleRights()" class="mt-0.5" />
            <span>
              A pauta usa imagem publicada pelo veículo. Confirmo que tenho direito de uso para publicar como público.
            </span>
          </label>
        }

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            (click)="publishNow()"
            [disabled]="!canPublish()"
            class="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40"
          >
            <mat-icon class="text-[16px]">upload</mat-icon>
            <span>{{ scheduled() ? 'Agendar publicação' : 'Publicar no YouTube' }}</span>
          </button>
          @if (needsApproval()) {
            <span class="text-[11px] text-amber-200">
              Aprove a pauta (botão <strong>Aprovar</strong> acima) para liberar a publicação.
            </span>
          } @else {
            <span class="text-[11px] text-slate-500">
              {{ scheduled() ? 'O YouTube publica sozinho na hora marcada.' : 'Envio imediato, sem automação.' }}
            </span>
          }
        </div>

        @if (error(); as message) {
          <p class="rounded border border-red-500/30 bg-red-950/20 px-2.5 py-1.5 text-[11px] text-red-200">{{ message }}</p>
        }

        @if (lastPublish(); as result) {
          <div class="rounded border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-[11px] text-emerald-100 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <mat-icon class="text-[15px]">check_circle</mat-icon>
              <span>Publicado em {{ result.platforms.join(', ') }}.</span>
              @if (result.youtubeUrl) {
                <a [href]="result.youtubeUrl" target="_blank" rel="noopener noreferrer" class="underline">Abrir no YouTube</a>
              }
            </div>
            @for (skip of result.skipped; track skip.platform) {
              <div class="text-amber-200">Ignorado {{ skip.platform }}: {{ skip.reason }}</div>
            }
            @for (warning of result.warnings; track warning) {
              <div class="text-amber-200">{{ warning }}</div>
            }
          </div>
        }

        <!-- Desempenho e comentários do vídeo publicado -->
        @if (p.youtube?.videoId) {
          <div class="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
            <a
              [href]="p.youtube!.url"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"
            >
              <mat-icon class="text-[14px]">open_in_new</mat-icon>
              <span>Ver no YouTube</span>
            </a>
            <button
              type="button"
              (click)="swapThumbnail()"
              [disabled]="busy()"
              class="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-40"
              title="Troca a capa pelo thumbnail.jpg do pacote. Teste A/B real só no YouTube Studio."
            >
              <mat-icon class="text-[14px]">image</mat-icon>
              <span>Trocar capa</span>
            </button>
            <a
              [href]="'/api/projects/' + p.id + '/file/publish.json'"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"
            >
              <mat-icon class="text-[14px]">description</mat-icon>
              <span>publish.json</span>
            </a>
          </div>

          <div class="grid grid-cols-1 gap-3 border-t border-white/10 pt-3 md:grid-cols-2">
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-slate-200">Desempenho</span>
                <button
                  type="button"
                  (click)="pullAnalytics()"
                  [disabled]="busy()"
                  class="rounded border border-white/15 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
                >
                  Puxar números
                </button>
              </div>
              @if (analytics(); as a) {
                <div class="grid grid-cols-2 gap-1.5 text-[11px] text-slate-300">
                  <span>Views: <strong class="font-mono-tabular text-slate-100">{{ a.views }}</strong></span>
                  <span>Retenção: <strong class="font-mono-tabular text-slate-100">{{ a.averageViewPercentage }}%</strong></span>
                  <span>Média: <strong class="font-mono-tabular text-slate-100">{{ a.averageViewDurationSec }}s</strong></span>
                  <span>Likes: <strong class="font-mono-tabular text-slate-100">{{ a.likes }}</strong></span>
                  <span>Comentários: <strong class="font-mono-tabular text-slate-100">{{ a.comments }}</strong></span>
                  <span>Inscritos: <strong class="font-mono-tabular text-slate-100">+{{ a.subscribersGained }}</strong></span>
                </div>
                <p class="text-[10px] text-slate-500">{{ a.startDate }} → {{ a.endDate }}</p>
              } @else {
                <p class="text-[11px] text-slate-500">Sem dados carregados.</p>
              }
            </div>

            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-slate-200">Comentários</span>
                <button
                  type="button"
                  (click)="loadComments()"
                  [disabled]="commentsLoading()"
                  class="rounded border border-white/15 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
                >
                  {{ commentsLoading() ? 'Carregando…' : 'Carregar' }}
                </button>
              </div>
              @if (commentsDisabled()) {
                <p class="text-[11px] text-slate-500">Comentários desativados neste vídeo.</p>
              }
              @for (comment of comments(); track comment.id) {
                <div class="rounded border border-white/10 p-2 text-[11px] text-slate-300 space-y-1">
                  <div class="text-slate-400">
                    <strong class="text-slate-200">{{ comment.author }}</strong> · {{ comment.likeCount }} curtidas
                  </div>
                  <p class="text-slate-100">{{ comment.text }}</p>
                  @for (reply of comment.replies; track reply.id) {
                    <p class="border-l border-white/15 pl-2 text-slate-400">
                      <strong>{{ reply.author }}:</strong> {{ reply.text }}
                    </p>
                  }
                  <div class="flex items-center gap-1.5">
                    <input
                      [value]="replyDraft()[comment.id] ?? ''"
                      (input)="onReplyDraft(comment.id, $event)"
                      placeholder="Responder…"
                      class="flex-1 rounded border border-white/10 bg-[#111620] px-2 py-1 text-[11px] text-slate-100"
                    />
                    <button
                      type="button"
                      (click)="reply(comment.id)"
                      [disabled]="busy() || !(replyDraft()[comment.id] ?? '').trim()"
                      class="rounded bg-white/10 px-2 py-1 text-[10px] text-slate-100 hover:bg-[#e59a38] hover:text-[#0a0d12] disabled:opacity-40"
                    >
                      Enviar
                    </button>
                  </div>
                </div>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class PublishPanel {
  readonly store = inject(StudioStore);
  private readonly queue = inject(RenderQueue);

  readonly pauta = this.store.activePauta;

  readonly status = signal<StatusPayload | null>(null);
  readonly title = signal('');
  readonly description = signal('');
  readonly tagsText = signal('');
  readonly alternatives = signal<string[]>([]);
  readonly privacy = signal<'public' | 'unlisted' | 'private'>('unlisted');
  readonly scheduleAt = signal('');
  readonly confirmRights = signal(false);
  readonly hasThirdParty = signal(false);
  readonly error = signal<string | null>(null);
  readonly lastPublish = signal<PublishJobResultView | null>(null);
  readonly busy = signal(false);
  readonly analytics = signal<AnalyticsView | null>(null);
  readonly comments = signal<CommentView[]>([]);
  readonly commentsDisabled = signal(false);
  readonly commentsLoading = signal(false);
  readonly replyDraft = signal<Record<string, string>>({});

  readonly scheduled = computed(() => this.scheduleAt().trim().length > 0);

  /** Conta conectada divergente do canal fixado: publicação bloqueada. */
  readonly channelMismatch = computed(
    () => this.status()?.youtube.channelMatchesExpected === false,
  );
  readonly channelFixed = computed(() => Boolean(this.status()?.youtube.expectedChannelId));

  // Configuração do OAuth (colar credenciais direto no painel)
  readonly guideOpen = signal(true);
  readonly setupClientId = signal('');
  readonly setupClientSecret = signal('');
  readonly savingSetup = signal(false);
  readonly setupError = signal<string | null>(null);
  readonly redirectUri = signal('http://127.0.0.1:3000/api/youtube/auth/callback');
  readonly canPublish = computed(
    () =>
      !this.busy() &&
      this.title().trim().length >= 3 &&
      this.title().length <= 100 &&
      (this.status()?.youtube.connected ?? false) &&
      !this.channelMismatch() &&
      this.pauta()?.stage === 'APPROVED',
  );

  /** Aprovação é pré-requisito da publicação, não da conexão do canal. */
  readonly needsApproval = computed(() => this.pauta()?.stage !== 'APPROVED');

  private handledJobId: string | null = null;
  private loadedForPauta: string | null = null;

  constructor() {
    // Ao trocar de pauta: carrega status, pré-preenche metadados determinísticos.
    effect(() => {
      const pauta = this.pauta();
      if (!pauta) return;
      if (this.loadedForPauta === pauta.id) return;
      this.loadedForPauta = pauta.id;
      this.lastPublish.set(null);
      this.analytics.set(null);
      this.comments.set([]);
      this.confirmRights.set(false);
      void this.refreshStatus();
      void this.prefillMetadata(pauta.id);
    });

    // Voltou da janela de consentimento do Google: atualiza o status.
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => void this.refreshStatus());
    }

    // Fim do job de publicação: atualiza a pauta e mostra o resultado.
    effect(() => {
      const pauta = this.pauta();
      if (!pauta) return;
      for (const job of this.queue.jobs()) {
        if (job.kind !== 'publish' || job.pautaId !== pauta.id) continue;
        if (job.id === this.handledJobId) continue;

        if (job.status === 'done' && job.result) {
          this.handledJobId = job.id;
          const result = job.result as PublishJobResultView;
          this.lastPublish.set(result);
          this.error.set(null);
          this.store.markPublished(
            pauta.id,
            result.youtubeVideoId && result.youtubeUrl
              ? {
                  videoId: result.youtubeVideoId,
                  url: result.youtubeUrl,
                  privacyStatus: this.privacy(),
                  publishedAt: new Date().toISOString(),
                  thumbnailSet: true,
                  captionsSet: true,
                }
              : null,
          );
        } else if (job.status === 'failed') {
          this.handledJobId = job.id;
          this.error.set(job.error ?? 'A publicação falhou.');
        }
      }
    });
  }

  /** Fixa o canal conectado como destino obrigatório. */
  async fixChannel(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await fetch('/api/youtube/expected-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Falha ao fixar o canal (HTTP ${res.status}).`);
      await this.refreshStatus();
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao fixar o canal.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Remove a trava (volta a aceitar qualquer conta conectada). */
  async clearChannel(): Promise<void> {
    this.busy.set(true);
    try {
      await fetch('/api/youtube/expected-channel', { method: 'DELETE' });
      await this.refreshStatus();
    } catch {
      // Silencioso: o status continua mostrando o canal fixado.
    } finally {
      this.busy.set(false);
    }
  }

  async refreshStatus(): Promise<void> {
    try {
      const res = await fetch('/api/youtube/status');
      if (!res.ok) return;
      const data = (await res.json()) as StatusPayload;
      this.status.set(data);
      if (data.youtube.redirectUri) this.redirectUri.set(data.youtube.redirectUri);
      // Client ID salvo no .env: pré-preenche para faltar só o secret.
      if (data.youtube.clientId && !this.setupClientId()) {
        this.setupClientId.set(data.youtube.clientId);
      }
      if (!this.scheduled()) this.privacy.set(data.youtube.privacyDefault ?? 'unlisted');
    } catch {
      // Silencioso: a interface mostra "não conectado".
    }
  }

  toggleGuide(): void {
    this.guideOpen.update((value) => !value);
  }

  onSetupId(event: Event): void {
    this.setupClientId.set((event.target as HTMLInputElement).value.trim());
  }

  onSetupSecret(event: Event): void {
    this.setupClientSecret.set((event.target as HTMLInputElement).value.trim());
  }

  async copyRedirect(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.redirectUri());
    } catch {
      this.setupError.set(`Copie manualmente: ${this.redirectUri()}`);
    }
  }

  async copyOrigin(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.originUri());
    } catch {
      this.setupError.set(`Copie manualmente: ${this.originUri()}`);
    }
  }

  /** Origem para a caixa "Origens JavaScript" (sem caminho). */
  readonly originUri = computed(() => {
    try {
      return new URL(this.redirectUri()).origin;
    } catch {
      return 'http://127.0.0.1:3000';
    }
  });

  /** Salva Client ID/Secret no .env (via servidor) e já abre o consentimento. */
  async saveCredentials(): Promise<void> {
    this.savingSetup.set(true);
    this.setupError.set(null);

    try {
      const res = await fetch('/api/youtube/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.setupClientId(),
          clientSecret: this.setupClientSecret(),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        redirectUri?: string;
      };

      if (!res.ok) throw new Error(data.error ?? `Falha ao salvar (HTTP ${res.status}).`);
      if (data.redirectUri) this.redirectUri.set(data.redirectUri);

      await this.refreshStatus();
      this.guideOpen.set(false);
      window.open('/api/youtube/auth/start', '_blank', 'width=520,height=680');
    } catch (err) {
      this.setupError.set(err instanceof Error ? err.message : 'Erro ao salvar as credenciais.');
    } finally {
      this.savingSetup.set(false);
    }
  }

  private async prefillMetadata(pautaId: string): Promise<void> {
    try {
      const res = await fetch('/api/publish/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pautaId, useGemini: false }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        metadata: PublishMetadata;
        hasThirdPartyMedia: boolean;
      };
      this.applyMetadata(data.metadata);
      this.hasThirdParty.set(data.hasThirdPartyMedia);
    } catch {
      // Sem pré-preenchimento: o usuário pode digitar.
    }
  }

  private applyMetadata(metadata: PublishMetadata): void {
    this.title.set(metadata.title);
    this.description.set(metadata.description);
    this.tagsText.set(metadata.tags.join(', '));
    this.alternatives.set(metadata.titleAlternatives ?? []);
  }

  async generateMetadata(): Promise<void> {
    const pauta = this.pauta();
    if (!pauta) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await fetch('/api/publish/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pautaId: pauta.id, useGemini: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        metadata?: PublishMetadata;
        hasThirdPartyMedia?: boolean;
        error?: string;
      };
      if (!res.ok || !data.metadata) {
        throw new Error(data.error ?? `Falha ao gerar metadados (HTTP ${res.status}).`);
      }
      this.applyMetadata(data.metadata);
      this.hasThirdParty.set(Boolean(data.hasThirdPartyMedia));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao gerar metadados.');
    } finally {
      this.busy.set(false);
    }
  }

  connect(): void {
    const youtube = this.status()?.youtube;
    // Sem credenciais, o caminho é o guia — abrir o consentimento daria erro do Google.
    if (!youtube?.configured) {
      this.guideOpen.set(true);
      return;
    }

    window.open('/api/youtube/auth/start', '_blank', 'width=520,height=680');
    // O callback grava o token; ao voltar o foco, o painel se atualiza.
    setTimeout(() => void this.refreshStatus(), 4000);
    setTimeout(() => void this.refreshStatus(), 20000);
  }

  private currentMetadata(): PublishMetadata {
    return {
      title: this.title().trim(),
      description: this.description(),
      tags: this.tagsText()
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      categoryId: '25',
      madeForKids: false,
      containsSyntheticMedia: true,
      titleAlternatives: this.alternatives(),
      generatedBy: 'deterministico',
    };
  }

  async publishNow(): Promise<void> {
    const pauta = this.pauta();
    if (!pauta) return;
    this.busy.set(true);
    this.error.set(null);

    try {
      const scheduleIso = this.scheduleAt().trim();
      const payload = {
        pautaId: pauta.id,
        platforms: ['youtube'],
        metadata: this.currentMetadata(),
        privacyStatus: this.privacy(),
        confirmRights: this.confirmRights(),
        publishAt: scheduleIso ? new Date(scheduleIso).toISOString() : undefined,
      };

      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Falha ao publicar (HTTP ${res.status}).`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao publicar.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Troca a capa do vídeo já publicado (auxílio manual; não é A/B de verdade). */
  async swapThumbnail(): Promise<void> {
    const pauta = this.pauta();
    if (!pauta) return;
    this.busy.set(true);
    try {
      const res = await fetch('/api/youtube/thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pautaId: pauta.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; note?: string };
      if (!res.ok) throw new Error(data.error ?? `Falha ao trocar a capa (HTTP ${res.status}).`);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao trocar a capa.');
    } finally {
      this.busy.set(false);
    }
  }

  async pullAnalytics(): Promise<void> {    const pauta = this.pauta();
    if (!pauta) return;
    this.busy.set(true);
    try {
      const res = await fetch(`/api/youtube/analytics?pautaId=${encodeURIComponent(pauta.id)}`);
      const data = (await res.json().catch(() => ({}))) as {
        analytics?: AnalyticsView;
        error?: string;
      };
      if (!res.ok || !data.analytics) {
        throw new Error(data.error ?? `Sem dados (HTTP ${res.status}).`);
      }
      this.analytics.set(data.analytics);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao puxar números.');
    } finally {
      this.busy.set(false);
    }
  }

  async loadComments(): Promise<void> {
    const pauta = this.pauta();
    if (!pauta) return;
    this.commentsLoading.set(true);
    try {
      const res = await fetch(`/api/youtube/comments?pautaId=${encodeURIComponent(pauta.id)}`);
      const data = (await res.json().catch(() => ({}))) as {
        enabled?: boolean;
        items?: CommentView[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Falha ao carregar (HTTP ${res.status}).`);
      this.comments.set(data.items ?? []);
      this.commentsDisabled.set(data.enabled === false);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao carregar comentários.');
    } finally {
      this.commentsLoading.set(false);
    }
  }

  async reply(commentId: string): Promise<void> {
    const text = (this.replyDraft()[commentId] ?? '').trim();
    if (!text) return;
    this.busy.set(true);
    try {
      const res = await fetch('/api/youtube/comments/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: commentId, text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Falha ao responder (HTTP ${res.status}).`);
      this.replyDraft.update((draft) => ({ ...draft, [commentId]: '' }));
      await this.loadComments();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Erro ao responder.');
    } finally {
      this.busy.set(false);
    }
  }

  onReplyDraft(commentId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.replyDraft.update((draft) => ({ ...draft, [commentId]: value }));
  }

  onTitle(event: Event): void {
    this.title.set((event.target as HTMLInputElement).value);
  }

  onDescription(event: Event): void {
    this.description.set((event.target as HTMLTextAreaElement).value);
  }

  onTags(event: Event): void {
    this.tagsText.set((event.target as HTMLInputElement).value);
  }

  onPrivacy(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.privacy.set(value === 'public' || value === 'private' ? value : 'unlisted');
  }

  onScheduleAt(event: Event): void {
    this.scheduleAt.set((event.target as HTMLInputElement).value);
  }

  toggleRights(): void {
    this.confirmRights.update((value) => !value);
  }

  useAlternative(title: string): void {
    this.title.set(title);
  }
}
