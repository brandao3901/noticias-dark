import type { MediaAsset, PautaRecord, PublishMetadata, ScriptScene } from '../app/models/studio.models';
import { suggestPublishMetadataWithGemini } from './gemini';

/**
 * Metadados do post (título, descrição, tags).
 *
 * A base é **determinística** — funciona sem Gemini, sem cota e sem inventar
 * nada: as fontes e os créditos saem do próprio dossiê/manifesto. O Gemini, se
 * disponível, só melhora o gancho, o título e as tags; a validação é sempre a
 * mesma e o resultado é editável antes de publicar.
 */

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_TOTAL_MAX = 500;
export const TAG_MAX = 30;
export const CAPTION_MAX = 2200;

const CATEGORY_BY_EDITORIAL: Record<string, string> = {
  Brasil: '25',
  Economia: '25',
  Tecnologia: '28',
  Esportes: '17',
  Entretenimento: '24',
  Celebridades: '24',
  Todas: '25',
};

/** Mídias de uma cena (espelha `getSceneMediaList` do store, sem importar Angular). */
function sceneMediaList(scene: ScriptScene | undefined): MediaAsset[] {
  if (!scene) return [];
  if (Array.isArray(scene.mediaAssets) && scene.mediaAssets.length > 0) return scene.mediaAssets;
  return scene.mediaAsset ? [scene.mediaAsset] : [];
}

function clamp(value: string, max: number): string {
  const clean = value.replace(/\r\n/g, '\n').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function hashtag(text: string): string {
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '');
  return clean ? `#${clean}` : '';
}

function uniqueMedia(pauta: PautaRecord): MediaAsset[] {
  const seen = new Set<string>();
  const list: MediaAsset[] = [];
  for (const scene of pauta.script?.scenes ?? []) {
    for (const asset of sceneMediaList(scene)) {
      if (seen.has(asset.mediaUrl)) continue;
      seen.add(asset.mediaUrl);
      list.push(asset);
    }
  }
  return list;
}

function buildTags(pauta: PautaRecord): string[] {
  const raw: string[] = [pauta.editorial, 'noticias', 'shorts'];
  for (const scene of pauta.script?.scenes ?? []) {
    for (const entity of scene.detectedEntities ?? []) raw.push(entity);
  }
  raw.push(pauta.title.split(/\s+/).slice(0, 3).join(' '));

  const tags: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const candidate of raw) {
    const tag = candidate.replace(/\s+/g, ' ').trim().slice(0, TAG_MAX);
    const key = tag.toLowerCase();
    if (tag.length < 2 || seen.has(key)) continue;
    seen.add(key);
    // YouTube soma os caracteres separados por vírgula; margem de segurança.
    if (total + tag.length + 2 > TAGS_TOTAL_MAX) break;
    total += tag.length + 2;
    tags.push(tag);
  }
  return tags;
}

function buildDescription(pauta: PautaRecord, intro?: string): string {
  const lines: string[] = [];
  const opening =
    intro?.trim() ||
    pauta.script?.hook?.trim() ||
    pauta.script?.scenes?.[0]?.narration?.trim() ||
    pauta.title;
  lines.push(clamp(opening, 400), '');

  lines.push('Fontes consultadas:');
  const sources = pauta.dossier?.sources ?? [];
  if (sources.length === 0) {
    lines.push('• Nenhuma fonte registrada no dossiê.');
  } else {
    for (const src of sources.slice(0, 8)) {
      lines.push(`• ${src.title} (${src.domain}) — ${src.url}`);
    }
  }

  const media = uniqueMedia(pauta);
  if (media.length > 0) {
    lines.push('', 'Créditos de mídia:');
    for (const asset of media.slice(0, 8)) {
      const licence = asset.licenseName ? ` — ${asset.licenseName}` : '';
      lines.push(`• ${asset.attributionText}${licence} — ${asset.pageUrl}`);
    }
  }

  if (pauta.script?.uncertaintyNote?.trim()) {
    lines.push('', `Ressalva de apuração: ${pauta.script.uncertaintyNote.trim()}`);
  }

  lines.push(
    '',
    'Vídeo produzido com apoio de IA generativa; o apresentador é um avatar fictício.',
    '',
    ['#Shorts', '#Noticias', hashtag(pauta.editorial)].filter(Boolean).join(' '),
  );

  return clamp(lines.join('\n'), DESCRIPTION_MAX);
}

export function buildDeterministicMetadata(pauta: PautaRecord): PublishMetadata {
  const title = clamp(
    (pauta.script?.suggestedTitle || pauta.title || 'Notícia').replace(/\s+/g, ' '),
    TITLE_MAX,
  );

  return {
    title,
    description: buildDescription(pauta),
    tags: buildTags(pauta),
    categoryId: CATEGORY_BY_EDITORIAL[pauta.editorial] ?? '25',
    madeForKids: false,
    containsSyntheticMedia: true,
    titleAlternatives: [],
    generatedBy: 'deterministico',
  };
}

/**
 * Metadados finais: base determinística + enriquecimento opcional do Gemini.
 * Se o Gemini falhar ou devolver algo inválido, a base determinística fica.
 */
export async function buildPublishMetadata(
  pauta: PautaRecord,
  options: { useGemini?: boolean } = {},
): Promise<PublishMetadata> {
  const base = buildDeterministicMetadata(pauta);
  if (!options.useGemini) return base;

  const suggestion = await suggestPublishMetadataWithGemini({
    headline: pauta.script?.suggestedTitle || pauta.title,
    editorial: pauta.editorial,
    hook: pauta.script?.hook ?? '',
    narrationSample: (pauta.script?.scenes ?? [])
      .map((scene) => scene.narration)
      .join(' ')
      .slice(0, 1800),
    sources: (pauta.dossier?.sources ?? []).slice(0, 6).map((src) => `${src.title} (${src.domain})`),
  }).catch(() => null);

  if (!suggestion) return base;

  const title = clamp(
    (suggestion.title || base.title).replace(/\s+/g, ' '),
    TITLE_MAX,
  );
  const alternatives = (suggestion.titleAlternatives ?? [])
    .map((value) => clamp(String(value).replace(/\s+/g, ' '), TITLE_MAX))
    .filter((value) => value.length > 8 && value.toLowerCase() !== title.toLowerCase())
    .slice(0, 3);

  const enriched: PublishMetadata = {
    ...base,
    title,
    description: buildDescription(pauta, suggestion.descriptionIntro),
    tags: (suggestion.tags ?? []).length > 0 ? normalizeTags(suggestion.tags, base.tags) : base.tags,
    titleAlternatives: alternatives,
    generatedBy: 'gemini',
  };

  return validateMetadata(enriched).length === 0 ? enriched : base;
}

function normalizeTags(candidates: string[], fallback: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const candidate of [...candidates, ...fallback]) {
    const tag = String(candidate).replace(/\s+/g, ' ').trim().slice(0, TAG_MAX);
    const key = tag.toLowerCase();
    if (tag.length < 2 || seen.has(key)) continue;
    seen.add(key);
    if (total + tag.length + 2 > TAGS_TOTAL_MAX) break;
    total += tag.length + 2;
    tags.push(tag);
  }
  return tags;
}

/** Erros que impedem a publicação. Vazio = metadados válidos. */
export function validateMetadata(meta: PublishMetadata): string[] {
  const errors: string[] = [];

  const title = (meta.title ?? '').trim();
  if (title.length < 3) errors.push('Título precisa de pelo menos 3 caracteres.');
  if (title.length > TITLE_MAX) errors.push(`Título passa de ${TITLE_MAX} caracteres.`);
  if (/[\n\r]/.test(title)) errors.push('Título não pode ter quebra de linha.');

  const description = meta.description ?? '';
  if (description.length > DESCRIPTION_MAX) {
    errors.push(`Descrição passa de ${DESCRIPTION_MAX} caracteres.`);
  }

  const tags = meta.tags ?? [];
  const total = tags.reduce((acc, tag) => acc + tag.length + 2, 0);
  if (total > TAGS_TOTAL_MAX) errors.push(`Tags somam ${total} caracteres (limite ${TAGS_TOTAL_MAX}).`);
  if (tags.some((tag) => tag.length > TAG_MAX)) {
    errors.push(`Cada tag precisa ter até ${TAG_MAX} caracteres.`);
  }
  if (tags.some((tag) => /[<>]/.test(tag))) errors.push('Tags não podem ter "<" ou ">".');

  if (!/^\d+$/.test(meta.categoryId ?? '')) errors.push('Categoria do YouTube inválida.');

  return errors;
}

/** Texto do post para plataformas que usam uma única legenda (TikTok/Instagram). */
export function platformCaption(meta: PublishMetadata): string {
  const text = `${meta.title}\n\n${meta.description}`;
  return text.length <= CAPTION_MAX ? text : `${text.slice(0, CAPTION_MAX - 1).trimEnd()}…`;
}
