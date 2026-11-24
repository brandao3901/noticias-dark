import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-presenter-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="relative flex items-end justify-center overflow-hidden select-none"
      [class.w-full]="mode() === 'full'"
      [class.h-full]="mode() === 'full'"
      [class.w-28]="mode() === 'pip'"
      [class.h-36]="mode() === 'pip'"
      [class.rounded-xl]="mode() === 'pip'"
      [class.border]="mode() === 'pip'"
      [class.border-white/20]="mode() === 'pip'"
      [class.bg-[#0f1520]/90]="mode() === 'pip'"
      [class.shadow-lg]="mode() === 'pip'"
    >
      <svg
        viewBox="0 0 240 300"
        class="h-full w-full max-h-full"
        aria-label="Avatar apresentador fictício do Canal Dark"
        role="img"
      >
        <defs>
          <linearGradient id="cdSuitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1e293b" />
            <stop offset="100%" stop-color="#0f172a" />
          </linearGradient>
          <linearGradient id="cdSkinGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e7bfa2" />
            <stop offset="100%" stop-color="#cfa07f" />
          </linearGradient>
          <linearGradient id="cdBackdropGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1d283a" stop-opacity="0.45" />
            <stop offset="100%" stop-color="#090d14" stop-opacity="0.1" />
          </linearGradient>
        </defs>

        @if (mode() === 'full') {
          <circle cx="120" cy="135" r="95" fill="url(#cdBackdropGlow)" />
        }

        <!-- Torso / Blazer -->
        <g [attr.transform]="torsoTransform()">
          <path
            d="M36 300 C38 232, 68 206, 120 206 C172 206, 202 232, 204 300 Z"
            fill="url(#cdSuitGrad)"
            stroke="#334155"
            stroke-width="1.5"
          />
          <!-- Camisa e lapela -->
          <polygon points="98,208 120,256 142,208" fill="#e2e8f0" />
          <polygon points="116,220 124,220 126,280 120,290 114,280" fill="#e59a38" />
          <path d="M98 208 L80 248 L106 266 Z" fill="#172030" />
          <path d="M142 208 L160 248 L134 266 Z" fill="#172030" />
          <!-- Pescoço -->
          <rect x="104" y="176" width="32" height="38" rx="12" fill="#c79473" />
        </g>

        <!-- Cabeça -->
        <g [attr.transform]="headTransform()">
          <!-- Orelhas -->
          <ellipse cx="70" cy="130" rx="8" ry="14" fill="#c79473" />
          <ellipse cx="170" cy="130" rx="8" ry="14" fill="#c79473" />

          <!-- Rosto -->
          <rect x="72" y="68" width="96" height="122" rx="44" fill="url(#cdSkinGrad)" />

          <!-- Cabelo curto estilizado -->
          <path
            d="M70 112 C68 68, 92 48, 122 48 C154 48, 174 70, 170 112 C164 88, 146 76, 118 76 C94 76, 78 88, 70 112 Z"
            fill="#1e2430"
          />

          <!-- Sobrancelhas conforme expressão -->
          <path
            [attr.d]="leftBrowPath()"
            stroke="#1e2430"
            stroke-width="4"
            stroke-linecap="round"
            fill="none"
          />
          <path
            [attr.d]="rightBrowPath()"
            stroke="#1e2430"
            stroke-width="4"
            stroke-linecap="round"
            fill="none"
          />

          <!-- Olhos -->
          <ellipse cx="98" cy="122" rx="7" ry="6" fill="#f8fafc" />
          <ellipse cx="142" cy="122" rx="7" ry="6" fill="#f8fafc" />
          <circle cx="98" cy="122" r="3.6" fill="#111827" />
          <circle cx="142" cy="122" r="3.6" fill="#111827" />
          <circle cx="99.5" cy="120.5" r="1.2" fill="#ffffff" />
          <circle cx="143.5" cy="120.5" r="1.2" fill="#ffffff" />

          <!-- Óculos discretos de bancada -->
          <rect
            x="82"
            y="111"
            width="32"
            height="22"
            rx="6"
            fill="none"
            stroke="#94a3b8"
            stroke-width="1.8"
          />
          <rect
            x="126"
            y="111"
            width="32"
            height="22"
            rx="6"
            fill="none"
            stroke="#94a3b8"
            stroke-width="1.8"
          />
          <line x1="114" y1="121" x2="126" y2="121" stroke="#94a3b8" stroke-width="1.8" />

          <!-- Nariz -->
          <path
            d="M120 124 L116 144 L124 146"
            stroke="#b58363"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />

          <!-- Boca animada por jawOpen (0..1) -->
          <g>
            @if (mouthOpeningPx() <= 2.2) {
              <path
                d="M104 162 Q120 166 136 162"
                stroke="#6b342e"
                stroke-width="3"
                stroke-linecap="round"
                fill="none"
              />
            } @else {
              <ellipse
                cx="120"
                cy="163"
                rx="15"
                [attr.ry]="mouthOpeningPx()"
                fill="#3a1414"
                stroke="#85433b"
                stroke-width="2"
              />
              @if (mouthOpeningPx() > 4) {
                <rect x="109" [attr.y]="163 - mouthOpeningPx() + 1" width="22" height="3" rx="1.5" fill="#f1f5f9" />
              }
            }
          </g>
        </g>

        <!-- Microfone de lapela -->
        <circle cx="136" cy="236" r="3.5" fill="#334155" stroke="#94a3b8" stroke-width="1" />
      </svg>

      @if (mode() === 'pip') {
        <span class="absolute bottom-1 left-1.5 text-[9px] font-mono-tabular text-slate-300/80">
          Avatar fictício
        </span>
      }
    </div>
  `,
})
export class PresenterAvatar {
  readonly jawOpen = input<number>(0);
  readonly isSpeaking = input<boolean>(false);
  readonly mode = input<'full' | 'pip'>('full');
  readonly expression = input<'neutral' | 'alert' | 'explaining' | 'closing'>('neutral');

  readonly mouthOpeningPx = computed(() => {
    const clamped = Math.max(0, Math.min(1, this.jawOpen()));
    return 1.5 + clamped * 11.5;
  });

  readonly headTransform = computed(() => {
    const expr = this.expression();
    const tilt = expr === 'explaining' ? -2 : expr === 'alert' ? 1.5 : 0;
    const bob = this.isSpeaking() ? -Math.min(2.5, this.jawOpen() * 3) : 0;
    return `translate(0, ${bob.toFixed(1)}) rotate(${tilt}, 120, 160)`;
  });

  readonly torsoTransform = computed(() => {
    const shift = this.isSpeaking() ? -Math.min(1, this.jawOpen() * 1.4) : 0;
    return `translate(0, ${shift.toFixed(1)})`;
  });

  readonly leftBrowPath = computed(() => {
    const expr = this.expression();
    if (expr === 'alert') return 'M84 106 Q98 100 110 108';
    if (expr === 'explaining') return 'M84 105 Q98 99 110 104';
    return 'M84 107 Q98 103 110 107';
  });

  readonly rightBrowPath = computed(() => {
    const expr = this.expression();
    if (expr === 'alert') return 'M130 108 Q142 100 156 106';
    if (expr === 'explaining') return 'M130 104 Q142 99 156 105';
    return 'M130 107 Q142 103 156 107';
  });
}
