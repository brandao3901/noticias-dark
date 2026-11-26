import { existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

/**
 * Frame do modo "cartões": identidade da Brasa (preto + brasa/âmbar).
 *
 * Estrutura: chip do canal, bloco tipográfico de impacto, cartão da matéria com
 * a passagem marcada e faixa inferior com manchete + fonte. Sem avatar.
 *
 * Todo texto é medido antes de desenhar — largura estimada em Arial Bold e
 * fonte reduzida até caber na margem. Nada é cortado na borda.
 */

const W = 1080;
const H = 1920;
const MARGIN = 56;
const CONTENT_W = W - MARGIN * 2;

// Paleta da marca
const BG = '#0a0d12';
const EMBER = '#e59a38';
const INK = '#0a0d12';
const TEXT = '#f4f7fb';
const MUTED = '#9fb0c7';
const PAPER = '#f7f5ef';

/** Arial Bold caixa alta: ~0,62em por caractere. */
const WIDTH_RATIO = 0.68;

export interface NewsCardBeat {
  pill?: string;
  line?: string;
  word?: string;
  action?: string;
}

export interface NewsCardInput {
  channelLabel: string;
  beat: NewsCardBeat;
  source?: {
    domain: string;
    title: string;
    excerpt: string;
    publishedAt?: string;
  };
  headline: string;
  sourcesLine: string;
  focus?: 'type' | 'card';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textWidth(text: string, fontSize: number): number {
  // +1px por caractere cobre o letter-spacing usado nas etiquetas.
  return Math.round(text.length * fontSize * WIDTH_RATIO) + text.length;
}

/** Reduz a fonte até o texto caber na largura pedida. */
function fitSize(text: string, maxWidth: number, preferred: number, min = 16): number {
  let size = preferred;
  while (size > min && textWidth(text, size) > maxWidth) size -= 1;
  return size;
}

function wrap(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * WIDTH_RATIO)));
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Etiqueta âmbar com texto escuro, centralizada em `centerX`. */
function pill(text: string, centerX: number, y: number, preferred = 38): string {
  const label = text.toUpperCase();
  const fontSize = fitSize(label, CONTENT_W - 44, preferred, 18);
  const width = Math.min(CONTENT_W, textWidth(label, fontSize) + 44);
  const height = Math.round(fontSize * 1.9);
  return [
    `<rect x="${Math.round(centerX - width / 2)}" y="${y}" width="${width}" height="${height}" rx="8" fill="${EMBER}"/>`,
    `<text x="${centerX}" y="${y + Math.round(height * 0.67)}" text-anchor="middle" font-family="Arial" font-size="${fontSize}" font-weight="700" letter-spacing="1" fill="${INK}">${escapeXml(label)}</text>`,
  ].join('');
}

export function buildNewsCardSvg(input: NewsCardInput): string {
  const parts: string[] = [];

  // Fundo + brilho de brasa no rodapé (identidade do canal)
  parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  parts.push(
    `<defs><radialGradient id="ember" cx="50%" cy="84%" r="60%">
       <stop offset="0%" stop-color="${EMBER}" stop-opacity="0.28"/>
       <stop offset="55%" stop-color="${EMBER}" stop-opacity="0.07"/>
       <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
     </radialGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#ember)"/>`,
  );

  // Chip do canal (topo esquerdo) — fonte reduz até caber
  const chipText = (input.channelLabel.split('·')[0] ?? input.channelLabel).trim().toUpperCase().slice(0, 28);
  const chipSize = fitSize(chipText, CONTENT_W - 60, 26, 15);
  const chipWidth = textWidth(chipText, chipSize) + 40;
  parts.push(
    `<rect x="${MARGIN}" y="52" width="${chipWidth}" height="54" rx="8" fill="${EMBER}"/>`,
    `<text x="${MARGIN + 20}" y="88" font-family="Arial" font-size="${chipSize}" font-weight="700" letter-spacing="1" fill="${INK}">${escapeXml(chipText)}</text>`,
  );

  const focus = input.focus ?? 'type';
  const showType = focus === 'type';

  // ---- Bloco tipográfico -------------------------------------------------
  let typeBottom = 240;
  if (!showType && input.beat.word) {
    // Foco no cartão: uma palavra grande no topo evita o frame vazio.
    const wordText = input.beat.word.toUpperCase();
    const wordSize = fitSize(wordText, CONTENT_W, 72, 40);
    parts.push(
      `<text x="${W / 2}" y="300" text-anchor="middle" font-family="Arial" font-size="${wordSize}" font-weight="700" letter-spacing="-1" fill="${TEXT}">${escapeXml(wordText)}</text>`,
    );
    typeBottom = 320;
  }
  if (showType) {
    let y = 330;
    if (input.beat.pill) {
      parts.push(pill(input.beat.pill, W / 2, y, 38));
      y += 96;
    }
    if (input.beat.line) {
      const lineText = input.beat.line.toUpperCase();
      const lineSize = fitSize(lineText, CONTENT_W, 48, 24);
      parts.push(
        `<text x="${W / 2}" y="${y + 42}" text-anchor="middle" font-family="Arial" font-size="${lineSize}" font-weight="700" letter-spacing="2" fill="${MUTED}">${escapeXml(lineText)}</text>`,
      );
      y += 74;
    }
    if (input.beat.word) {
      const wordText = input.beat.word.toUpperCase();
      const wordSize = fitSize(wordText, CONTENT_W, 118, 60);
      for (const line of wrap(wordText, wordSize, CONTENT_W).slice(0, 2)) {
        parts.push(
          `<text x="${W / 2}" y="${y + 104}" text-anchor="middle" font-family="Arial" font-size="${wordSize}" font-weight="700" letter-spacing="-1" fill="${TEXT}">${escapeXml(line)}</text>`,
        );
        y += 118;
      }
      y += 10;
    }
    if (input.beat.action) {
      parts.push(pill(input.beat.action, W / 2, y + 10, 36));
      y += 104;
    }
    typeBottom = y;
  }

  // ---- Cartão da matéria (altura calculada, centralizado) ----------------
  const cardX = showType ? 70 : 44;
  const cardW = showType ? W - 140 : W - 88;
  const innerX = cardX + 44;
  const innerW = cardW - 88;
  const cardBody: string[] = [];
  // Coordenadas relativas ao topo do cartão (o grupo desloca depois).
  let cursorY = 66;

  if (input.source) {
    cardBody.push(
      `<text x="${innerX}" y="${cursorY}" font-family="Arial" font-size="22" font-weight="700" fill="#8a8377">${escapeXml(`MATÉRIA · ${input.source.domain}`.toUpperCase())}</text>`,
    );
    cursorY += 46;

    const titleSize = focus === 'card' ? 42 : 34;
    for (const line of wrap(input.source.title, titleSize, innerW).slice(0, 3)) {
      cardBody.push(
        `<text x="${innerX}" y="${cursorY}" font-family="Arial" font-size="${titleSize}" font-weight="700" fill="#12100c">${escapeXml(line)}</text>`,
      );
      cursorY += Math.round(titleSize * 1.24);
    }
    cursorY += 26;

    const excerptSize = focus === 'card' ? 32 : 28;
    const lineHeight = Math.round(excerptSize * 1.42);
    const highlightText = (input.source.excerpt || '').split(/(?<=[.!?])\s+/)[0] ?? '';
    const restText = (input.source.excerpt || '').slice(highlightText.length).trim();

    const highlightLines = wrap(highlightText, excerptSize, innerW).slice(0, focus === 'card' ? 6 : 4);
    const highlightHeight = highlightLines.length * lineHeight + 18;
    cardBody.push(
      `<rect x="${innerX - 12}" y="${cursorY - excerptSize}" width="${innerW + 24}" height="${highlightHeight}" rx="6" fill="${EMBER}" fill-opacity="0.34"/>`,
    );
    for (const line of highlightLines) {
      cardBody.push(
        `<text x="${innerX}" y="${cursorY}" font-family="Arial" font-size="${excerptSize}" font-weight="700" fill="#12100c">${escapeXml(line)}</text>`,
      );
      cursorY += lineHeight;
    }
    cursorY += 18;

    if (restText) {
      for (const line of wrap(restText, excerptSize, innerW).slice(0, focus === 'card' ? 6 : 3)) {
        cardBody.push(
          `<text x="${innerX}" y="${cursorY}" font-family="Arial" font-size="${excerptSize}" fill="#232019">${escapeXml(line)}</text>`,
        );
        cursorY += lineHeight;
      }
    }
  }

  const cardHeight = Math.max(240, cursorY + 44);
  const barTopForCard = H - 210;
  const availableTop = typeBottom + 30;
  const availableBottom = barTopForCard - 36;
  // Centraliza o cartão no espaço que sobra: sem vazio grande em cima ou embaixo.
  const cardTop =
    availableTop + Math.max(0, (availableBottom - availableTop - cardHeight) / 2);

  parts.push(
    `<g transform="translate(0, ${Math.round(cardTop)})">`,
    `<rect x="${cardX}" y="0" width="${cardW}" height="${cardHeight}" rx="26" fill="${PAPER}"/>`,
    `<rect x="${cardX}" y="0" width="${cardW}" height="8" rx="4" fill="${EMBER}"/>`,
    ...cardBody,
    '</g>',
  );

  // ---- Faixa inferior: manchete + fonte ----------------------------------
  const barHeight = 176;
  const barTop = H - 210;
  parts.push(
    `<rect x="0" y="${barTop}" width="${W}" height="${barHeight}" fill="#000000" fill-opacity="0.80"/>`,
    `<rect x="0" y="${barTop}" width="12" height="${barHeight}" fill="${EMBER}"/>`,
  );

  const headlineText = input.headline.toUpperCase();
  const headlineSize = fitSize(headlineText, W - MARGIN * 2 - 40, 44, 30);
  const headlineLines = wrap(headlineText, headlineSize, W - MARGIN * 2 - 40).slice(0, 2);
  let barY = barTop + 60;
  for (const line of headlineLines) {
    parts.push(
      `<text x="${MARGIN + 28}" y="${barY}" font-family="Arial" font-size="${headlineSize}" font-weight="700" fill="${TEXT}">${escapeXml(line)}</text>`,
    );
    barY += Math.round(headlineSize * 1.14);
  }

  const sourcesText = input.sourcesLine.toUpperCase();
  const sourcesSize = fitSize(sourcesText, W - MARGIN * 2 - 40, 26, 16);
  parts.push(
    `<text x="${MARGIN + 28}" y="${barTop + barHeight - 26}" font-family="Arial" font-size="${sourcesSize}" font-weight="700" letter-spacing="1" fill="${EMBER}">${escapeXml(sourcesText)}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

// Carregar as fontes do sistema a cada cartão custava ~40% do tempo do painel.
const FONT_FILES = ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'].filter((path) =>
  existsSync(path),
);
const FONT_OPTIONS = FONT_FILES.length
  ? { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Arial' }
  : { loadSystemFonts: true, defaultFontFamily: 'Arial' };

export function renderNewsCard(input: NewsCardInput): Buffer {
  const svg = buildNewsCardSvg(input);
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: FONT_OPTIONS,
  })
    .render()
    .asPng();
}

/** Beats determinísticos de uma cena (sem depender de IA). */
export function buildSceneBeats(params: {
  narration: string;
  editorial: string;
  domain?: string;
  entity?: string;
}): NewsCardBeat[] {
  const sentences = params.narration
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 8);

  const first = sentences[0] ?? params.narration;
  const words = first.split(/\s+/).filter(Boolean);

  const word =
    (params.entity || '').toUpperCase().slice(0, 22) ||
    words.slice(0, 3).join(' ').toUpperCase().slice(0, 22);

  const STOP = new Set(['O', 'A', 'OS', 'AS', 'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'QUE', 'PARA', 'COM', 'UM', 'UMA']);
  // A etiqueta final vem da segunda frase: evita repetir a palavra grande.
  const actionSource = sentences[1] ?? '';
  const actionWords = actionSource
    .toUpperCase()
    .replace(/[.,;:]$/, '')
    .split(/\s+/)
    .filter(Boolean);
  while (actionWords.length > 1 && STOP.has(actionWords[actionWords.length - 1])) actionWords.pop();
  const action = actionWords.slice(0, 4).join(' ').slice(0, 30);

  const beat: NewsCardBeat = {
    pill: params.domain ? `SEGUNDO ${params.domain.toUpperCase()}` : 'APURAÇÃO',
    line: params.editorial.toUpperCase().slice(0, 28),
    word,
  };
  if (action) beat.action = action;

  const beats: NewsCardBeat[] = [beat];
  if (sentences.length > 1) beats.push({});
  return beats;
}
