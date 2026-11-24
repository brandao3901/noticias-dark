import { GoogleGenAI, Type } from '@google/genai';
import type {
  DossierSourceItem,
  EditableScript,
  GeminiUrlContextResult,
  ScriptVersionMode,
} from '../app/models/studio.models';
import { isSocialXHost } from './ssrf-guard';

const ACTIVE_GEMINI_MODEL = 'gemini-4-hydrogen';

let quotaPausedUntilMs = 0;
const urlContextCache = new Map<string, { ts: number; result: GeminiUrlContextResult }>();

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env['GEMINI_API_KEY']?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getGeminiStatus(): {
  geminiConfigured: boolean;
  geminiQuotaPaused: boolean;
  geminiCooldownUntil?: string;
  activeModel: string;
} {
  const now = Date.now();
  const paused = quotaPausedUntilMs > now;
  return {
    geminiConfigured: Boolean(process.env['GEMINI_API_KEY']?.trim()),
    geminiQuotaPaused: paused,
    geminiCooldownUntil: paused ? new Date(quotaPausedUntilMs).toISOString() : undefined,
    activeModel: ACTIVE_GEMINI_MODEL,
  };
}

function isQuotaOrRateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg);
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /400|403|API_KEY_INVALID|PERMISSION_DENIED|invalid api key/i.test(msg);
}

function filterPublicCandidateUrls(urls: string[]): { allowed: string[]; filteredOutCount: number } {
  const allowed: string[] = [];
  let filteredOutCount = 0;
  const seen = new Set<string>();

  for (const raw of urls) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        filteredOutCount++;
        continue;
      }
      const host = parsed.hostname.toLowerCase();
      if (
        isSocialXHost(host) ||
        host.includes('instagram.com') ||
        host.includes('facebook.com') ||
        host.includes('tiktok.com') ||
        host.includes('login.') ||
        host.includes('accounts.')
      ) {
        filteredOutCount++;
        continue;
      }
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        allowed.push(normalized);
      }
    } catch {
      filteredOutCount++;
    }
  }

  return { allowed: allowed.slice(0, 20), filteredOutCount };
}

export async function runGeminiUrlContextAnalysis(
  topic: string,
  candidateUrls: string[],
): Promise<GeminiUrlContextResult> {
  const checkedAt = new Date().toISOString();
  const { allowed, filteredOutCount } = filterPublicCandidateUrls(candidateUrls);

  if (!allowed.length) {
    return {
      status: 'skipped',
      model: ACTIVE_GEMINI_MODEL,
      summary: 'Nenhuma URL pública elegível disponível para comparação com URL Context.',
      supportedFacts: [],
      uncertainties: [],
      retrievedUrls: [],
      filteredOutCount,
      checkedAt,
    };
  }

  if (quotaPausedUntilMs > Date.now()) {
    return {
      status: 'quota_paused',
      model: ACTIVE_GEMINI_MODEL,
      summary: '',
      supportedFacts: [],
      uncertainties: [],
      retrievedUrls: [],
      filteredOutCount,
      checkedAt,
      message: 'Chamadas Gemini em pausa temporária após limite de cota (429). Os resultados públicos originais permanecem disponíveis.',
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    return {
      status: 'unconfigured',
      model: ACTIVE_GEMINI_MODEL,
      summary: '',
      supportedFacts: [],
      uncertainties: [],
      retrievedUrls: [],
      filteredOutCount,
      checkedAt,
      message:
        'Síntese Gemini URL Context indisponível neste servidor no momento. Os resultados públicos originais permanecem disponíveis.',
    };
  }

  const cacheKey = `${topic.toLowerCase()}::${allowed.join('|')}`;
  const cached = urlContextCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    return cached.result;
  }

  const prompt = [
    `Você é um editor de apuração jornalística em português do Brasil.`,
    `Tema da pauta: "${topic}".`,
    `Leia e compare exclusivamente o conteúdo das seguintes URLs públicas usando a ferramenta URL Context:`,
    ...allowed.map((u, idx) => `${idx + 1}. ${u}`),
    ``,
    `Retorne um JSON válido com os campos:`,
    `- summary: síntese objetiva em 2-4 frases do que as fontes recuperadas confirmam.`,
    `- supportedFacts: lista de até 6 fatos concretos com datas/números presentes nas páginas recuperadas.`,
    `- uncertainties: lista de até 4 divergências, pontos sem confirmação ou limitações de acesso.`,
    `Não invente fatos nem cite URLs que não tenham sido recuperadas pela ferramenta.`,
  ].join('\n');

  try {
    // Section 21: Use URL Context ONLY (free tier eligible), never googleSearch grounding
    const response = await ai.models.generateContent({
      model: ACTIVE_GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ urlContext: {} }],
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            supportedFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
            uncertainties: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['summary', 'supportedFacts', 'uncertainties'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      summary?: string;
      supportedFacts?: string[];
      uncertainties?: string[];
    };

    // Extract actually retrieved URLs from urlContextMetadata if present
    const candidate = response.candidates?.[0] as unknown as Record<string, unknown> | undefined;
    const urlMeta = candidate?.['urlContextMetadata'] as
      | { urlMetadata?: Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }> }
      | undefined;

    const retrievedUrls: string[] = [];
    if (Array.isArray(urlMeta?.urlMetadata)) {
      for (const entry of urlMeta.urlMetadata) {
        if (
          entry.retrievedUrl &&
          allowed.includes(entry.retrievedUrl) &&
          (!entry.urlRetrievalStatus || /SUCCESS/i.test(entry.urlRetrievalStatus))
        ) {
          retrievedUrls.push(entry.retrievedUrl);
        }
      }
    }

    const result: GeminiUrlContextResult = {
      status: 'ok',
      model: ACTIVE_GEMINI_MODEL,
      summary: parsed.summary ?? '',
      supportedFacts: Array.isArray(parsed.supportedFacts) ? parsed.supportedFacts : [],
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
      retrievedUrls: retrievedUrls.length ? retrievedUrls : [],
      filteredOutCount,
      checkedAt,
    };

    urlContextCache.set(cacheKey, { ts: Date.now(), result });
    return result;
  } catch (err) {
    if (isQuotaOrRateError(err)) {
      quotaPausedUntilMs = Date.now() + 60 * 1000;
      return {
        status: 'quota_paused',
        model: ACTIVE_GEMINI_MODEL,
        summary: '',
        supportedFacts: [],
        uncertainties: [],
        retrievedUrls: [],
        filteredOutCount,
        checkedAt,
        message: 'Limite da cota gratuita Gemini atingido (429). Chamadas pausadas por 60s; os resultados públicos continuam visíveis.',
      };
    }

    return {
      status: isAuthError(err) ? 'unconfigured' : 'error',
      model: ACTIVE_GEMINI_MODEL,
      summary: '',
      supportedFacts: [],
      uncertainties: [],
      retrievedUrls: [],
      filteredOutCount,
      checkedAt,
      message: isAuthError(err)
        ? 'Credencial Gemini ausente ou recusada pelo servidor.'
        : err instanceof Error
          ? err.message
          : 'Falha ao executar URL Context no Gemini.',
    };
  }
}

export async function generateStructuredShortScript(params: {
  title: string;
  editorial: string;
  mode: ScriptVersionMode;
  sources: DossierSourceItem[];
  geminiContextSummary?: string;
}): Promise<{
  status: 'ok' | 'unconfigured' | 'quota_paused' | 'error';
  script?: EditableScript;
  message?: string;
}> {
  if (quotaPausedUntilMs > Date.now()) {
    return {
      status: 'quota_paused',
      message: 'Chamadas Gemini pausadas temporariamente após 429 para respeitar a cota gratuita.',
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    return {
      status: 'unconfigured',
      message: 'IA Gemini indisponível neste servidor no momento. Use "Montar rascunho do dossiê" ou "Criar roteiro manual".',
    };
  }

  if (!params.sources.length) {
    return {
      status: 'error',
      message: 'Adicione ou pesquise pelo menos uma fonte pública no dossiê antes de gerar o roteiro.',
    };
  }

  const allowedSourceIds = new Set(params.sources.map((s) => s.id));
  const wordGuide =
    params.mode === 'short'
      ? '90 a 140 palavras no total da narração (duração alvo 45–60 segundos, 5 a 7 cenas de 5–8s)'
      : '180 a 230 palavras no total da narração (duração alvo 90–140 segundos, 8 a 11 cenas de 7–12s)';

  const evidenceBlock = params.sources
    .map(
      (s) =>
        `[${s.id}] (${s.kind} · ${s.domain} · ${s.publishedAt})\nTítulo: ${s.title}\nURL: ${s.url}\nTrecho: ${s.excerpt.slice(0, 700)}`,
    )
    .join('\n\n');

  const prompt = [
    `Redija um roteiro jornalístico em português do Brasil para YouTube Shorts (9:16) do canal "Canal Dark".`,
    `Editoria: ${params.editorial}. Assunto base: "${params.title}".`,
    `Extensão obrigatória: ${wordGuide}.`,
    ``,
    `Regras editoriais obrigatórias:`,
    `1. Utilize EXCLUSIVAMENTE fatos presentes nas fontes numeradas abaixo. Nunca invente números, datas, citações ou causas.`,
    `2. Cada cena deve listar em sourceIds apenas os IDs exatos das fontes que sustentam as afirmações daquela cena.`,
    `3. Apresente o fato principal logo no gancho inicial e explique por que importa, sem sensacionalismo nem suspense enganoso.`,
    `4. Se houver apenas uma fonte ou pontos em aberto, registre claramente em uncertaintyNote e na narração.`,
    `5. Forneça termos de busca visual em português (visualQueryPt) e inglês (visualQueryEn) para acervos gratuitos (Wikimedia Commons / Internet Archive).`,
    ``,
    params.geminiContextSummary ? `Síntese URL Context: ${params.geminiContextSummary}\n` : '',
    `=== DOSSIÊ DE FONTES PERMITIDAS ===`,
    evidenceBlock,
  ].join('\n');

  try {
    const response = await ai.models.generateContent({
      model: ACTIVE_GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction:
          'Você é um roteirista jornalístico rigoroso. Retorne apenas JSON compatível com o schema, em português do Brasil claro para narração falada.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedTitle: { type: Type.STRING },
            hook: { type: Type.STRING },
            uncertaintyNote: { type: Type.STRING },
            closing: { type: Type.STRING },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  durationSec: { type: Type.INTEGER },
                  narration: { type: Type.STRING },
                  pronunciationNotes: { type: Type.STRING },
                  visualQueryPt: { type: Type.STRING },
                  visualQueryEn: { type: Type.STRING },
                  avatarMode: { type: Type.STRING },
                  avatarExpression: { type: Type.STRING },
                  sourceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: [
                  'durationSec',
                  'narration',
                  'visualQueryPt',
                  'visualQueryEn',
                  'avatarMode',
                  'avatarExpression',
                  'sourceIds',
                ],
              },
            },
          },
          required: ['suggestedTitle', 'hook', 'uncertaintyNote', 'closing', 'scenes'],
        },
      },
    });

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      suggestedTitle?: string;
      hook?: string;
      uncertaintyNote?: string;
      closing?: string;
      scenes?: Array<{
        durationSec?: number;
        narration?: string;
        pronunciationNotes?: string;
        visualQueryPt?: string;
        visualQueryEn?: string;
        avatarMode?: string;
        avatarExpression?: string;
        sourceIds?: string[];
      }>;
    };

    const nowIso = new Date().toISOString();
    const scenes = (raw.scenes ?? []).map((sc, idx) => {
      // Section 20 & 21: Filter sourceIds strictly against dossier evidence
      const filteredSourceIds = (sc.sourceIds ?? []).filter((id) => allowedSourceIds.has(id));
      const modeVal = sc.avatarMode === 'pip' || sc.avatarMode === 'hidden' ? sc.avatarMode : 'full';
      const exprVal =
        sc.avatarExpression === 'alert' ||
        sc.avatarExpression === 'explaining' ||
        sc.avatarExpression === 'closing'
          ? sc.avatarExpression
          : 'neutral';

      return {
        id: `scene-${idx + 1}`,
        order: idx + 1,
        durationSec: Math.max(3, Math.min(18, Number(sc.durationSec) || 6)),
        narration: (sc.narration ?? '').trim(),
        pronunciationNotes: (sc.pronunciationNotes ?? '').trim(),
        visualQueryPt: (sc.visualQueryPt ?? params.title).trim(),
        visualQueryEn: (sc.visualQueryEn ?? 'news broadcast city').trim(),
        avatarMode: modeVal,
        avatarExpression: exprVal,
        sourceIds: filteredSourceIds,
        isDocumentaryMedia: false,
      } as const;
    });

    const script: EditableScript = {
      mode: params.mode,
      suggestedTitle: (raw.suggestedTitle ?? params.title).trim(),
      hook: (raw.hook ?? '').trim(),
      uncertaintyNote: (raw.uncertaintyNote ?? '').trim(),
      closing: (raw.closing ?? '').trim(),
      scenes: scenes.map((s) => ({ ...s })),
      modelUsed: ACTIVE_GEMINI_MODEL,
      generatedAt: nowIso,
      lastEditedAt: nowIso,
      promptNoticeAccepted: true,
    };

    return { status: 'ok', script };
  } catch (err) {
    if (isQuotaOrRateError(err)) {
      quotaPausedUntilMs = Date.now() + 60 * 1000;
      return {
        status: 'quota_paused',
        message: 'Limite gratuito do Gemini atingido (429). Aguarde 60 segundos antes de tentar novamente.',
      };
    }

    return {
      status: isAuthError(err) ? 'unconfigured' : 'error',
      message: isAuthError(err)
        ? 'Credencial Gemini ausente ou recusada pelo servidor.'
        : err instanceof Error
          ? err.message
          : 'Erro ao gerar roteiro via Gemini.',
    };
  }
}
