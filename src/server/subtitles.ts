/**
 * As legendas chegam do cliente com tempos baseados nas durações planejadas das
 * cenas. Quando a narração gerada no servidor alonga uma cena (para não cortar
 * a fala), os tempos precisam ser remapeados, senão a legenda atrasa.
 */

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function parseTime(value: string): number | null {
  const match = value.trim().match(TIME_RE);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function formatTime(seconds: number, separator: string): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

export function retimeSubtitles(
  content: string,
  originalDurations: number[],
  effectiveDurations: number[],
): string {  if (originalDurations.length !== effectiveDurations.length) return content;

  const unchanged = originalDurations.every(
    (value, idx) => Math.abs(value - effectiveDurations[idx]) < 0.05,
  );
  if (unchanged) return content;

  const originalStarts: number[] = [];
  const effectiveStarts: number[] = [];
  let originalCursor = 0;
  let effectiveCursor = 0;
  for (let i = 0; i < originalDurations.length; i++) {
    originalStarts.push(originalCursor);
    effectiveStarts.push(effectiveCursor);
    originalCursor += originalDurations[i];
    effectiveCursor += effectiveDurations[i];
  }
  const totalOriginal = originalCursor;

  const sceneFor = (seconds: number): number => {
    if (totalOriginal <= 0) return 0;
    const clamped = Math.min(Math.max(0, seconds), totalOriginal - 0.001);
    for (let i = originalStarts.length - 1; i >= 0; i--) {
      if (clamped >= originalStarts[i]) return i;
    }
    return 0;
  };

  const remap = (seconds: number): number => {
    const scene = sceneFor(seconds);
    const originalDuration = originalDurations[scene];
    const effectiveDuration = effectiveDurations[scene];
    const offset = Math.max(0, Math.min(originalDuration, seconds - originalStarts[scene]));
    const ratio = originalDuration > 0 ? effectiveDuration / originalDuration : 1;
    return effectiveStarts[scene] + offset * ratio;
  };

  const isVtt = /^WEBVTT/m.test(content);
  const separator = isVtt ? '.' : ',';

  return content
    .split(/\r?\n/)
    .map((line) => {
      const arrow = line.match(/^(\s*)(.+?)\s*-->\s*(.+?)(\s*)$/);
      if (!arrow) return line;
      const start = parseTime(arrow[2]);
      const end = parseTime(arrow[3]);
      if (start === null || end === null) return line;
      const newStart = remap(start);
      const newEnd = Math.max(newStart + 0.2, remap(end));
      return `${arrow[1]}${formatTime(newStart, separator)} --> ${formatTime(newEnd, separator)}${arrow[4]}`;
    })
    .join('\n');
}

/**
 * Converte SRT em WebVTT para arquivar as duas versões no pacote da pauta
 * (spec §4.12). O YouTube aceita SRT, mas VTT é o padrão de player web.
 */
export function srtToVtt(srt: string): string {
  const blocks = srt
    .replace(/\r\n/g, '\n')
    .replace(/\uFEFF/g, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const cues = blocks
    .map((block) => {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0]?.trim() ?? '')) lines.shift();
      return lines.join('\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    })
    .filter(Boolean);

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Legenda karaoke (ASS) — palavra a palavra, para reter atenção
// ---------------------------------------------------------------------------

export interface KaraokeOptions {
  fontSize?: number;
  marginV?: number;
  /** Quantas palavras cabem por bloco (2–4). */
  maxWordsPerChunk?: number;
  /** Cor de destaque da palavra atual, em &HAABBGGRR. */
  highlightColor?: string;
  baseColor?: string;
}

interface SrtCue {
  start: number;
  end: number;
  text: string;
}

function parseSrtCues(content: string): SrtCue[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const cues: SrtCue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;

    const timeLine = lines.find((line) => line.includes('-->'));
    if (!timeLine) continue;

    const [rawStart, rawEnd] = timeLine.split('-->');
    const start = parseTime(rawStart ?? '');
    const end = parseTime(rawEnd ?? '');
    if (start === null || end === null || end <= start) continue;

    const text = lines
      .slice(lines.indexOf(timeLine) + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;

    cues.push({ start, end, text });
  }
  return cues;
}

function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function escapeAssText(value: string): string {
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Converte o SRT em ASS com destaque palavra a palavra.
 *
 * O tempo de cada palavra é proporcional ao seu tamanho dentro do cue — não há
 * timestamp de palavra no TTS, e a proporção erra pouco para narração corrida.
 * O vídeo queima este ASS; o SRT/VTT continuam no pacote e no YouTube.
 */
export function buildKaraokeAss(content: string, options: KaraokeOptions = {}): string {
  const fontSize = options.fontSize ?? 58;
  const marginV = options.marginV ?? 250;
  const maxWords = Math.max(1, Math.min(4, options.maxWordsPerChunk ?? 3));
  const highlight = options.highlightColor ?? '&H00389AE5'; // âmbar do canal
  const base = options.baseColor ?? '&H00FFFFFF';

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Kara,Arial,${fontSize},${base},${highlight},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events: string[] = [];

  for (const cue of parseSrtCues(content)) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const weights = words.map((word) => word.length + 1);
    const totalWeight = weights.reduce((acc, value) => acc + value, 0) || 1;
    const duration = cue.end - cue.start;

    // Divide em blocos de 2–4 palavras (quebra também em pontuação forte).
    const chunks: Array<{ from: number; to: number }> = [];
    let from = 0;
    for (let i = 0; i < words.length; i++) {
      const isLast = i === words.length - 1;
      const endsSentence = /[.!?…]$/.test(words[i]);
      if (isLast || i - from + 1 >= maxWords || (endsSentence && i - from + 1 >= 2)) {
        chunks.push({ from, to: i });
        from = i + 1;
      }
    }
    if (from < words.length) chunks.push({ from, to: words.length - 1 });

    let cursor = cue.start;
    for (const chunk of chunks) {
      const chunkWords = words.slice(chunk.from, chunk.to + 1);
      const chunkWeight = weights.slice(chunk.from, chunk.to + 1).reduce((a, b) => a + b, 0);
      const chunkDuration = (chunkWeight / totalWeight) * duration;

      let wordCursor = cursor;
      for (let w = 0; w < chunkWords.length; w++) {
        const wordDuration = (weights[chunk.from + w] / chunkWeight) * chunkDuration;
        const line = chunkWords
          .map((word, index) =>
            index === w ? `{\\c${highlight}}${escapeAssText(word)}{\\c${base}}` : escapeAssText(word),
          )
          .join(' ');

        events.push(
          `Dialogue: 0,${assTime(wordCursor)},${assTime(wordCursor + wordDuration)},Kara,,0,0,0,,${line}`,
        );
        wordCursor += wordDuration;
      }
      cursor += chunkDuration;
    }
  }

  return `${header}\n${events.join('\n')}\n`;
}
