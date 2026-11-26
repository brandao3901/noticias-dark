/**
 * Avatar apresentador fictício, em SVG, gerado no servidor.
 *
 * Porte fiel do componente `presenter-avatar.ts`: a prévia do navegador e o
 * arquivo MP4 precisam mostrar o mesmo personagem, com a mesma boca e as mesmas
 * expressões. O fundo é transparente (o overlay aplica o enquadramento).
 */

export type AvatarExpression = 'neutral' | 'alert' | 'explaining' | 'closing';

export interface AvatarSvgOptions {
  jawOpen: number;
  expression: AvatarExpression;
  /** No PiP o avatar fica sobre um cartao arredondado, como na previa do app. */
  framed?: boolean;
}

const BROWS: Record<AvatarExpression, { left: string; right: string }> = {
  neutral: { left: 'M84 107 Q98 103 110 107', right: 'M130 107 Q142 103 156 107' },
  alert: { left: 'M84 106 Q98 100 110 108', right: 'M130 108 Q142 100 156 106' },
  explaining: { left: 'M84 105 Q98 99 110 104', right: 'M130 104 Q142 99 156 105' },
  closing: { left: 'M84 107 Q98 103 110 107', right: 'M130 107 Q142 103 156 107' },
};

const TILT: Record<AvatarExpression, number> = {
  neutral: 0,
  alert: 1.5,
  explaining: -2,
  closing: 0,
};

export function buildAvatarSvg({ jawOpen, expression, framed = false }: AvatarSvgOptions): string {
  const opening = Math.max(0, Math.min(1, jawOpen));
  const mouthOpeningPx = 1.5 + opening * 11.5;
  const speaking = opening > 0.02;

  const bob = speaking ? -Math.min(2.5, opening * 3) : 0;
  const tilt = TILT[expression];
  const torsoShift = speaking ? -Math.min(1, opening * 1.4) : 0;
  const brows = BROWS[expression];

  const mouth =
    mouthOpeningPx <= 2.2
      ? `<path d="M104 162 Q120 166 136 162" stroke="#6b342e" stroke-width="3" stroke-linecap="round" fill="none"/>`
      : `<ellipse cx="120" cy="163" rx="15" ry="${mouthOpeningPx.toFixed(2)}" fill="#3a1414" stroke="#85433b" stroke-width="2"/>${
          mouthOpeningPx > 4
            ? `<rect x="109" y="${(163 - mouthOpeningPx + 1).toFixed(2)}" width="22" height="3" rx="1.5" fill="#f1f5f9"/>`
            : ''
        }`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" width="240" height="300">
  <defs>
    <linearGradient id="cdSuitGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="cdSkinGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e7bfa2"/>
      <stop offset="100%" stop-color="#cfa07f"/>
    </linearGradient>
  </defs>

  ${framed ? '<rect x="4" y="4" width="232" height="292" rx="26" fill="#0f1520" fill-opacity="0.9" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>' : ''}

  <g transform="translate(0, ${torsoShift.toFixed(2)})">
    <path d="M36 300 C38 232, 68 206, 120 206 C172 206, 202 232, 204 300 Z" fill="url(#cdSuitGrad)" stroke="#334155" stroke-width="1.5"/>
    <polygon points="98,208 120,256 142,208" fill="#e2e8f0"/>
    <polygon points="116,220 124,220 126,280 120,290 114,280" fill="#e59a38"/>
    <path d="M98 208 L80 248 L106 266 Z" fill="#172030"/>
    <path d="M142 208 L160 248 L134 266 Z" fill="#172030"/>
    <rect x="104" y="176" width="32" height="38" rx="12" fill="#c79473"/>
  </g>

  <g transform="translate(0, ${bob.toFixed(2)}) rotate(${tilt}, 120, 160)">
    <ellipse cx="70" cy="130" rx="8" ry="14" fill="#c79473"/>
    <ellipse cx="170" cy="130" rx="8" ry="14" fill="#c79473"/>
    <rect x="72" y="68" width="96" height="122" rx="44" fill="url(#cdSkinGrad)"/>
    <path d="M70 112 C68 68, 92 48, 122 48 C154 48, 174 70, 170 112 C164 88, 146 76, 118 76 C94 76, 78 88, 70 112 Z" fill="#1e2430"/>
    <path d="${brows.left}" stroke="#1e2430" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path d="${brows.right}" stroke="#1e2430" stroke-width="4" stroke-linecap="round" fill="none"/>
    <ellipse cx="98" cy="122" rx="7" ry="6" fill="#f8fafc"/>
    <ellipse cx="142" cy="122" rx="7" ry="6" fill="#f8fafc"/>
    <circle cx="98" cy="122" r="3.6" fill="#111827"/>
    <circle cx="142" cy="122" r="3.6" fill="#111827"/>
    <circle cx="99.5" cy="120.5" r="1.2" fill="#ffffff"/>
    <circle cx="143.5" cy="120.5" r="1.2" fill="#ffffff"/>
    <rect x="82" y="111" width="32" height="22" rx="6" fill="none" stroke="#94a3b8" stroke-width="1.8"/>
    <rect x="126" y="111" width="32" height="22" rx="6" fill="none" stroke="#94a3b8" stroke-width="1.8"/>
    <line x1="114" y1="121" x2="126" y2="121" stroke="#94a3b8" stroke-width="1.8"/>
    <path d="M120 124 L116 144 L124 146" stroke="#b58363" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    ${mouth}
  </g>

  <circle cx="136" cy="236" r="3.5" fill="#334155" stroke="#94a3b8" stroke-width="1"/>
</svg>`;
}
