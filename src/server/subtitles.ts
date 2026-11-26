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
