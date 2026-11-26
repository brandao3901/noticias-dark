import { Resvg } from '@resvg/resvg-js';

/**
 * "Página" da matéria, desenhada em SVG e rasterizada para PNG.
 *
 * Formato de referência (canais de notícia em Shorts): a fonte na tela, com
 * rolagem lenta, em vez de foto solta. Capturar o site real exigiria navegador
 * headless (dependência nova, paywall, layout que muda) — a página sintética dá
 * o mesmo efeito visual e é estável.
 */

const WIDTH = 1080;
const PADDING = 64;
const INNER_WIDTH = WIDTH - PADDING * 2;

/** Largura média de caractere em Arial, como fração do corpo da fonte. */
const CHAR_RATIO = 0.52;

export interface DocumentPageInput {
  domain: string;
  title: string;
  excerpt: string;
  url: string;
  publishedAt?: string;
  /** Frase a destacar (marca-texto). Sem ela, usa a primeira frase. */
  highlight?: string;
}

export interface DocumentPageRendered {
  png: Buffer;
  width: number;
  height: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, fontSize: number, maxWidth = INNER_WIDTH): string[] {
  const maxChars = Math.max(12, Math.floor(maxWidth / (fontSize * CHAR_RATIO)));
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function firstSentence(text: string): string {
  const match = /^(.{20,220}?[.!?])\s/.exec(text);
  return (match?.[1] ?? text).trim();
}

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }).format(date);
}

interface Block {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  gapAfter: number;
  kind: 'title' | 'meta' | 'paragraph' | 'highlight' | 'quote' | 'footer';
}

export function buildDocumentPageSvg(
  input: DocumentPageInput,
  options: { scale?: number; insetTop?: number } = {},
): { svg: string; height: number; contentHeight: number } {
  const scale = Math.max(0.8, Math.min(1.6, options.scale ?? 1));
  // Faixa escura no topo onde entra a tarja do canal.
  const insetTop = Math.max(0, Math.round(options.insetTop ?? 0));
  const titleSize = Math.round(54 * scale);
  const bodySize = Math.round(30 * scale);
  const highlightSize = bodySize;

  const titleLines = wrapText(input.title || 'Sem título', titleSize);
  const paragraphs = (input.excerpt || '')
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30);

  const highlightText = (input.highlight?.trim() || firstSentence(input.excerpt || '')).trim();
  const highlightIndex = paragraphs.findIndex((paragraph) =>
    highlightText && paragraph.toLowerCase().includes(highlightText.slice(0, 24).toLowerCase()),
  );

  const blocks: Block[] = [
    {
      lines: titleLines,
      fontSize: titleSize,
      lineHeight: Math.round(titleSize * 1.18),
      gapAfter: Math.round(34 * scale),
      kind: 'title',
    },
  ];

  const body = paragraphs.slice(0, 8);
  body.forEach((paragraph, index) => {
    const isHighlight = index === highlightIndex || (highlightIndex < 0 && index === 1);
    const text = isHighlight && highlightText ? highlightText : paragraph;
    blocks.push({
      lines: wrapText(text, isHighlight ? highlightSize : bodySize),
      fontSize: isHighlight ? highlightSize : bodySize,
      lineHeight: Math.round((isHighlight ? highlightSize : bodySize) * 1.46),
      gapAfter: Math.round(26 * scale),
      kind: isHighlight ? 'highlight' : 'paragraph',
    });
  });

  // Pull quote: preenche a sobra da folha com a frase-chave em destaque, em vez
  // de esticar a tipografia do corpo.
  const contentSoFar =
    Math.round(132 * scale) +
    blocks.reduce((acc, block) => acc + block.lines.length * block.lineHeight + block.gapAfter, 0) +
    Math.round(150 * scale);
  const leftover = 1920 - contentSoFar;
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? '';
  const quoteText =
    lastParagraph && lastParagraph !== highlightText ? lastParagraph : '';
  if (leftover > 360 && quoteText) {
    const quoteSize = Math.round(42 * scale);
    const quoteLines = wrapText(quoteText, quoteSize);
    const quoteHeight = quoteLines.length * Math.round(quoteSize * 1.3);
    const spacer = Math.max(30, leftover - quoteHeight - Math.round(90 * scale));
    blocks.push({
      lines: [],
      fontSize: quoteSize,
      lineHeight: spacer,
      gapAfter: 0,
      kind: 'paragraph',
    });
    blocks.push({
      lines: quoteLines,
      fontSize: quoteSize,
      lineHeight: Math.round(quoteSize * 1.3),
      gapAfter: 0,
      kind: 'quote',
    });
  }

  const footerDate =
    (input.domain || '').replace(/^www\./, '').length > 16 ? formatDate(input.publishedAt) : '';
  const footerLines = wrapText(
    `${input.url}${footerDate ? ` · ${footerDate}` : ''}`,
    Math.round(22 * scale),
  );
  blocks.push({
    lines: footerLines,
    fontSize: Math.round(22 * scale),
    lineHeight: Math.round(30 * scale),
    gapAfter: 0,
    kind: 'footer',
  });

  const headerHeight = Math.round(132 * scale);
  const bodyHeight = blocks.reduce(
    (acc, block) => acc + block.lines.length * block.lineHeight + block.gapAfter,
    0,
  );
  const contentHeight = headerHeight + bodyHeight + Math.round(150 * scale) + insetTop;
  const height = Math.max(1920, Math.round(contentHeight));

  const parts: string[] = [];
  parts.push(`<rect width="${WIDTH}" height="${height}" fill="#0a0d12"/>`);
  // "Folha" clara, com sombra sutil nas bordas.
  parts.push(
    `<rect x="28" y="${28 + insetTop}" width="${WIDTH - 56}" height="${height - 56 - insetTop}" rx="18" fill="#f7f5ef"/>`,
    `<rect x="28" y="${28 + insetTop}" width="${WIDTH - 56}" height="10" rx="5" fill="#e59a38"/>`,
  );

  // Cabeçalho: veículo em âmbar. Domínio comprido empurra a data para o rodapé.
  const rawDomain = (input.domain || 'fonte').replace(/^www\./, '').toUpperCase();
  const domain = rawDomain.length > 22 ? rawDomain.slice(0, 21) + '…' : rawDomain;
  const dateLabel = formatDate(input.publishedAt);
  const dateInHeader = Boolean(dateLabel) && domain.length <= 16;

  parts.push(
    `<text x="${PADDING}" y="${28 + insetTop + Math.round(86 * scale)}" font-family="Arial" font-size="${Math.round(28 * scale)}" font-weight="700" letter-spacing="2" fill="#b06512">${escapeXml(domain)}</text>`,
  );
  if (dateInHeader) {
    parts.push(
      `<text x="${WIDTH - PADDING}" y="${28 + insetTop + Math.round(86 * scale)}" text-anchor="end" font-family="Arial" font-size="${Math.round(20 * scale)}" fill="#8a8377">${escapeXml(dateLabel)}</text>`,
    );
  }
  parts.push(
    `<rect x="${PADDING}" y="${28 + insetTop + Math.round(112 * scale)}" width="${INNER_WIDTH}" height="2" fill="#dcd6c8"/>`,
  );

  let cursorY = 28 + insetTop + headerHeight + Math.round(40 * scale);
  for (const block of blocks) {
    const color =
      block.kind === 'title'
        ? '#12100c'
        : block.kind === 'quote'
          ? '#12100c'
          : block.kind === 'footer'
            ? '#8a8377'
          : block.kind === 'meta'
            ? '#5c564b'
            : '#232019';

    if (block.kind === 'quote') {
      const barHeight = block.lines.length * block.lineHeight;
      parts.push(
        `<rect x="${PADDING - 18}" y="${cursorY - block.fontSize}" width="10" height="${barHeight}" rx="5" fill="#e59a38"/>`,
      );
    }

    if (block.kind === 'highlight') {
      const boxHeight = block.lines.length * block.lineHeight + 16;
      parts.push(
        `<rect x="${PADDING - 14}" y="${cursorY - block.fontSize}" width="${INNER_WIDTH + 28}" height="${boxHeight}" rx="6" fill="#f3c069" fill-opacity="0.55"/>`,
      );
    }

    for (const line of block.lines) {
      parts.push(
        `<text x="${PADDING}" y="${cursorY}" font-family="Arial" font-size="${block.fontSize}" font-weight="${block.kind === 'title' || block.kind === 'quote' ? 700 : 400}" fill="${color}">${escapeXml(line)}</text>`,
      );
      cursorY += block.lineHeight;
    }
    cursorY += block.gapAfter;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${parts.join('')}</svg>`;
  return { svg, height, contentHeight: Math.round(contentHeight) };
}

/**
 * Rasteriza a página. Texto curto ganha escala para a folha não ficar vazia;
 * texto longo cresce em altura (é o que permite a rolagem).
 */
export function renderDocumentPage(
  input: DocumentPageInput,
  options: { insetTop?: number } = {},
): DocumentPageRendered {
  const insetTop = Math.max(0, Math.round(options.insetTop ?? 0));
  let scale = 1;
  let built = buildDocumentPageSvg(input, { scale, insetTop });

  // Texto curto: sobe a escala até a folha ficar preenchida.
  while (built.contentHeight < 1800 && scale < 1.45) {
    const next = Number((scale + 0.1).toFixed(2));
    const candidate = buildDocumentPageSvg(input, { scale: next, insetTop });
    if (candidate.contentHeight > 2000) break;
    scale = next;
    built = candidate;
  }

  const png = new Resvg(built.svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  })
    .render()
    .asPng();

  return { png, width: WIDTH, height: built.height };
}
