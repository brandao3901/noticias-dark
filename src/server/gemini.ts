import { GoogleGenAI, Modality, Type } from '@google/genai';
import type {
  DossierSourceItem,
  EditableScript,
  GeminiUrlContextResult,
  ScriptVersionMode,
} from '../app/models/studio.models';
import { isSocialXHost } from './ssrf-guard';

const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

/**
 * Resolvido em tempo de execucao, nao no topo do modulo: `src/server.ts` carrega
 * o `.env` depois que os imports ja foram avaliados, entao uma constante de modulo
 * leria o ambiente antes da chave/modelo existirem.
 */
export function activeGeminiModel(): string {
  return (process.env['GEMINI_MODEL'] ?? '').trim() || DEFAULT_GEMINI_MODEL;
}

// Modelos maiores entram em 503 ("high demand") com frequencia; os "lite"
// continuam respondendo. A cadeia tenta o modelo configurado e cai para estes.
const FALLBACK_GEMINI_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];

function geminiModelChain(): string[] {
  const primary = activeGeminiModel();
  return [primary, ...FALLBACK_GEMINI_MODELS.filter((m) => m !== primary)];
}

function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|UNAVAILABLE|overloaded|high demand/i.test(msg);
}

/**
 * Executa a chamada no modelo configurado e, se ele estiver sobrecarregado (503),
 * tenta os fallbacks em sequencia. 429 (cota) nao entra aqui: continua pausando.
 */
async function withGeminiModelFallback<T>(
  run: (model: string) => Promise<T>,
): Promise<{ value: T; model: string }> {
  const chain = geminiModelChain();
  let lastError: unknown = null;

  for (let i = 0; i < chain.length; i++) {
    try {
      const value = await run(chain[i]);
      return { value, model: chain[i] };
    } catch (err) {
      lastError = err;
      if (!isModelUnavailable(err)) throw err;
      if (i < chain.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * (i + 1)));
      }
    }
  }

  throw lastError;
}

let quotaPausedUntilMs = 0;
const urlContextCache = new Map<string, { ts: number; result: GeminiUrlContextResult }>();

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env['GEMINI_API_KEY']?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    // A API v1 (padrao do SDK) nao conhece aliases como `*-flash-lite-latest`
    // nem a ferramenta urlContext; a v1beta expoe os dois.
    httpOptions: {
      apiVersion: 'v1beta',
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}


/**
 * Chamada genérica de JSON no Gemini.
 *
 * Reaproveita cliente, cadeia de modelos e a pausa de cota já existentes, para
 * que Radar e Motor de Retenção não dupliquem tratamento de erro.
 */
export async function runGeminiJson<T>(params: {
  prompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; data?: T; model?: string; message?: string }> {
  if (quotaPausedUntilMs > Date.now()) {
    return { ok: false, message: 'Gemini pausado por cota; tente novamente em alguns minutos.' };
  }

  const ai = getGeminiClient();
  if (!ai) return { ok: false, message: 'GEMINI_API_KEY ausente no .env.' };

  try {
    const { value, model } = await withGeminiModelFallback((candidate) =>
      ai.models.generateContent({
        model: candidate,
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: params.schema,
          temperature: params.temperature ?? 0.4,
        },
      }),
    );
    const text = (value.text ?? '').trim();
    if (!text) return { ok: false, model, message: 'Gemini devolveu resposta vazia.' };
    return { ok: true, data: JSON.parse(text) as T, model };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isQuotaOrRateError(err)) {
      quotaPausedUntilMs = Date.now() + 5 * 60_000;
      return { ok: false, message: 'Cota do Gemini estourada; pausado por 5 minutos.' };
    }
    return { ok: false, message };
  }
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
    activeModel: activeGeminiModel(),
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
      model: activeGeminiModel(),
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
      model: activeGeminiModel(),
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
      model: activeGeminiModel(),
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
    const { value: response, model: usedUrlContextModel } = await withGeminiModelFallback((model) =>
      ai.models.generateContent({
        model,
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
      }),
    );

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
      model: usedUrlContextModel,
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
        model: activeGeminiModel(),
        summary: '',
        supportedFacts: [],
        uncertainties: [],
        retrievedUrls: [],
        filteredOutCount,
        checkedAt,
        message: 'Limite da cota gratuita Gemini atingido (429). Chamadas pausadas por 60s; os resultados públicos continuam visíveis.',
      };
    }

    if (isModelUnavailable(err)) {
      return {
        status: 'error',
        model: activeGeminiModel(),
        summary: '',
        supportedFacts: [],
        uncertainties: [],
        retrievedUrls: [],
        filteredOutCount,
        checkedAt,
        message:
          'Modelo Gemini sobrecarregado (503 UNAVAILABLE). Tente novamente em alguns segundos ou defina outro GEMINI_MODEL no .env.',
      };
    }

    return {
      status: isAuthError(err) ? 'unconfigured' : 'error',
      model: activeGeminiModel(),
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

  // Meta editorial por modo:
  //  - rapido: o formato que retém. Fato + desfecho em ~40 s, sem gordura.
  //  - short:  versão intermediária (~50 s) para pauta com mais contexto.
  //  - expanded: 60-75 s, quando a pauta realmente pede espaço.
  const MIN_WORDS = params.mode === 'rapido' ? 100 : params.mode === 'short' ? 90 : 150;
  // Modelos seguem melhor "X palavras por cena" do que um total solto.
  const sceneGuide =
    params.mode === 'rapido'
      ? '4 cenas, cada uma com 25 a 30 palavras de narração (total de 100 a 125 palavras, 38 a 48 segundos)'
      : params.mode === 'short'
        ? '6 cenas, cada uma com 15 a 20 palavras de narração (total de 90 a 120 palavras, 45 a 58 segundos)'
        : '6 cenas, cada uma com 26 a 32 palavras de narração (total de 156 a 192 palavras, 60 a 75 segundos)';

  const evidenceBlock = params.sources
    .map(
      (s) =>
        `[${s.id}] (${s.kind} · ${s.domain} · ${s.publishedAt})\nTítulo: ${s.title}\nURL: ${s.url}\nTrecho: ${s.excerpt.slice(0, 700)}`,
    )
    .join('\n\n');

  const buildPrompt = (correction?: string): string =>
    [
      `Redija um roteiro jornalístico em português do Brasil para YouTube Shorts (9:16) do canal "Canal Dark".`,
      `Editoria: ${params.editorial}. Assunto base: "${params.title}".`,
      `EXTENSÃO OBRIGATÓRIA: ${sceneGuide}. Narração com menos de ${MIN_WORDS} palavras é inválida.`,
      ``,
      `Regras editoriais obrigatórias:`,
      `1. Utilize EXCLUSIVAMENTE fatos presentes nas fontes numeradas abaixo. Nunca invente números, datas, citações ou causas.`,
      `2. Cada cena deve listar em sourceIds apenas os IDs exatos das fontes que sustentam as afirmações daquela cena.`,
      `3. Apresente o fato principal logo no gancho inicial e explique por que importa, sem sensacionalismo nem suspense enganoso.`,
      `4. Se houver apenas uma fonte ou pontos em aberto, registre claramente em uncertaintyNote e na narração.`,
      `5. Forneça termos de busca visual em português (visualQueryPt) e inglês (visualQueryEn) para acervos gratuitos (Wikimedia Commons / Internet Archive).`,
      `6. GANCHO (hook): no máximo 14 palavras — pergunta direta ou fato de impacto. A PRIMEIRA cena começa pelo hook, sem contextualização formal ("o ator fez um balanço..." é proibido).`,
      `7. FECHAMENTO (closing): uma pergunta curta e direta ao público, convidando a comentar (ex.: "Você acha que ele deve continuar nas novelas?").`,
      `8. Título sugerido: no máximo 90 caracteres, com o fato principal; sem "clique", sem caixa alta.`,
      `9. Sem chamadas de áudio/vídeo ("veja o vídeo", "assista"), sem "inscreva-se" dentro da narração — isso vai na tela, não na locução.`,
      ``,
      correction ? `CORREÇÃO NECESSÁRIA: ${correction}\n` : '',
      params.geminiContextSummary ? `Síntese URL Context: ${params.geminiContextSummary}\n` : '',
      `=== DOSSIÊ DE FONTES PERMITIDAS ===`,
      evidenceBlock,
    ].join('\n');

  const scriptConfig = {
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
  };

  interface RawScript {
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
  }

  const requestScript = async (
    correction?: string,
  ): Promise<{ raw: RawScript; usedModel: string }> => {
    const { value: response, model: usedModel } = await withGeminiModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: buildPrompt(correction),
        config: scriptConfig,
      }),
    );
    return { raw: JSON.parse((response.text ?? '{}').trim()) as RawScript, usedModel };
  };

  const countNarrationWords = (raw: RawScript): number =>
    (raw.scenes ?? [])
      .map((scene) => scene.narration ?? '')
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;

  const toScript = (raw: RawScript, usedModel: string): EditableScript => {
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

    return {
      mode: params.mode,
      suggestedTitle: (raw.suggestedTitle ?? params.title).trim(),
      hook: (raw.hook ?? '').trim(),
      uncertaintyNote: (raw.uncertaintyNote ?? '').trim(),
      closing: (raw.closing ?? '').trim(),
      scenes: scenes.map((s) => ({ ...s })),
      modelUsed: usedModel,
      generatedAt: nowIso,
      lastEditedAt: nowIso,
      promptNoticeAccepted: true,
    };
  };

  try {
    let { raw, usedModel } = await requestScript();
    let words = countNarrationWords(raw);

    // O modelo leve às vezes entrega menos do que o pedido. Uma única correção
    // (nunca um laço) costuma resolver — e é o que garante o minuto mínimo.
    if (words < MIN_WORDS) {
      try {
        const retry = await requestScript(
          `A versão anterior tinha ${words} palavras no total. Reescreva com ${sceneGuide}. ` +
            'Mantenha somente fatos das fontes, sem repetir frases nem inventar dados.',
        );
        const retryWords = countNarrationWords(retry.raw);
        if (retryWords > words) {
          raw = retry.raw;
          usedModel = retry.usedModel;
          words = retryWords;
        }
      } catch {
        // Se a correção falhar, entregamos a primeira versão: o QC sinaliza a duração.
      }
    }

    return { status: 'ok', script: toScript(raw, usedModel) };
  } catch (err) {
    if (isQuotaOrRateError(err)) {
      quotaPausedUntilMs = Date.now() + 60 * 1000;
      return {
        status: 'quota_paused',
        message: 'Limite gratuito do Gemini atingido (429). Aguarde 60 segundos antes de tentar novamente.',
      };
    }

    if (isModelUnavailable(err)) {
      return {
        status: 'error',
        message:
          'Modelo Gemini sobrecarregado (503 UNAVAILABLE) mesmo depois do fallback. Tente novamente em alguns segundos ou ajuste GEMINI_MODEL no .env.',
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

// ---------------------------------------------------------------------------
// Metadados de publicacao (titulo, gancho para descricao, tags)
// ---------------------------------------------------------------------------

export interface PublishMetadataSuggestion {
  title: string;
  titleAlternatives: string[];
  descriptionIntro: string;
  tags: string[];
}

/**
 * Pede ao Gemini um titulo mais honesto, 3 alternativas, uma abertura de
 * descricao e tags. Retorna null quando nao ha chave, cota pausada ou falha —
 * nesse caso o chamador usa a base deterministica.
 */
export async function suggestPublishMetadataWithGemini(params: {
  headline: string;
  editorial: string;
  hook: string;
  narrationSample: string;
  sources: string[];
}): Promise<PublishMetadataSuggestion | null> {
  if (quotaPausedUntilMs > Date.now()) return null;

  const ai = getGeminiClient();
  if (!ai) return null;

  const prompt = [
    'Prepare os metadados de publicacao de um YouTube Short jornalistico em portugues do Brasil.',
    `Editoria: ${params.editorial}.`,
    `Titulo do roteiro: "${params.headline}".`,
    params.hook ? `Gancho ja escrito: "${params.hook}".` : '',
    params.narrationSample ? `Trecho da narracao: "${params.narrationSample}".` : '',
    params.sources.length ? `Fontes: ${params.sources.join(' | ')}.` : '',
    '',
    'Regras:',
    '- title: no maximo 90 caracteres, com o fato principal; sem CAIXA ALTA inteira, sem emoji, sem "clique aqui".',
    '- titleAlternatives: 3 variacoes igualmente honestas, cada uma com no maximo 90 caracteres.',
    '- descriptionIntro: 2 frases (maximo 280 caracteres) resumindo o que o video mostra, sem repetir o titulo ao pe da letra.',
    '- tags: de 10 a 15 termos curtos (ate 30 caracteres cada), sem "#", misturando tema, pessoas citadas e editoria.',
    '- Nao invente fatos, numeros ou nomes que nao estejam no material recebido.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { value: response } = await withGeminiModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction:
            'Voce escreve metadados de YouTube para um canal jornalistico. Sem clickbait enganoso: o titulo precisa ser sustentado pelo video.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              titleAlternatives: { type: Type.ARRAY, items: { type: Type.STRING } },
              descriptionIntro: { type: Type.STRING },
              tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['title', 'titleAlternatives', 'descriptionIntro', 'tags'],
          },
        },
      }),
    );

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      title?: string;
      titleAlternatives?: unknown[];
      descriptionIntro?: string;
      tags?: unknown[];
    };

    return {
      title: String(raw.title ?? '').trim(),
      titleAlternatives: Array.isArray(raw.titleAlternatives)
        ? raw.titleAlternatives.map((value) => String(value)).filter(Boolean)
        : [],
      descriptionIntro: String(raw.descriptionIntro ?? '').trim(),
      tags: Array.isArray(raw.tags) ? raw.tags.map((value) => String(value)).filter(Boolean) : [],
    };
  } catch (err) {
    if (isQuotaOrRateError(err)) quotaPausedUntilMs = Date.now() + 60_000;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini TTS — narracao neural usando a cota gratuita da mesma chave
// ---------------------------------------------------------------------------

const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
/** Modelos tentados se o principal sumir/estiver sobrecarregado. */
const TTS_FALLBACK_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];

/** Pausa propria do TTS: 429 aqui nao deve bloquear a geracao de roteiro. */
let ttsPausedUntilMs = 0;

export function activeTtsModel(): string {
  return (process.env['GEMINI_TTS_MODEL'] ?? '').trim() || DEFAULT_TTS_MODEL;
}

export function geminiTtsStatus(): {
  configured: boolean;
  model: string;
  paused: boolean;
  pausedUntil?: string;
} {
  const paused = ttsPausedUntilMs > Date.now();
  return {
    configured: Boolean(process.env['GEMINI_API_KEY']?.trim()),
    model: activeTtsModel(),
    paused,
    pausedUntil: paused ? new Date(ttsPausedUntilMs).toISOString() : undefined,
  };
}

export type NarrationStyle = 'ancora' | 'explicativo' | 'urgente' | 'leve' | 'neutro';

/**
 * Instrucoes em ingles funcionam melhor no TTS do Gemini, independente do
 * idioma do texto. Se a instrucao comecar a ser lida em voz alta, desligue com
 * TTS_STYLE_INSTRUCTIONS=0 no .env.
 */
const STYLE_INSTRUCTIONS: Record<NarrationStyle, string> = {
  ancora:
    'Read as a Brazilian television news anchor: calm, authoritative, measured pace, clear articulation.',
  explicativo:
    'Read as an explanatory narrator: warm, didactic, slightly slower, as if teaching a viewer.',
  urgente:
    'Read as an urgent breaking-news bulletin: energetic, serious, slightly faster.',
  leve: 'Read in a light, conversational tone: friendly, relaxed, natural.',
  neutro: '',
};

export function narrationStyleInstruction(style?: string): string {
  if (process.env['TTS_STYLE_INSTRUCTIONS'] === '0') return '';
  const key = (style ?? 'neutro').toLowerCase() as NarrationStyle;
  return STYLE_INSTRUCTIONS[key] ?? '';
}

export interface GeminiSpeechResult {
  pcm: Buffer;
  sampleRate: number;
  model: string;
  voice: string;
  mimeType: string;
}

/**
 * Sintetiza fala em pt-BR e devolve PCM 16-bit mono (a taxa vem do mimeType,
 * normalmente 24 kHz). O chamador grava WAV e reamostra para 16 kHz.
 */
export async function synthesizeSpeechWithGemini(params: {
  text: string;
  voice?: string;
  style?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<GeminiSpeechResult> {
  const text = (params.text ?? '').trim();
  if (text.length < 2) throw new Error('Texto vazio para o Gemini TTS.');

  if (ttsPausedUntilMs > Date.now()) {
    throw new Error(
      'Gemini TTS pausado por cota (429). O restante do vídeo cai na voz reserva do Edge.',
    );
  }

  const ai = getGeminiClient();
  if (!ai) throw new Error('GEMINI_API_KEY ausente: Gemini TTS indisponível.');

  const voice = (params.voice ?? process.env['GEMINI_TTS_VOICE'] ?? 'Kore').trim() || 'Kore';
  const instruction = narrationStyleInstruction(params.style);
  const contents = instruction ? `${instruction}\n\n${text}` : text;
  const timeoutMs = Math.max(10_000, params.timeoutMs ?? 120_000);

  const primary = params.model?.trim() || activeTtsModel();
  const chain = [primary, ...TTS_FALLBACK_MODELS.filter((model) => model !== primary)];
  let lastError: unknown = null;

  for (const model of chain) {
    try {
      const request = ai.models.generateContent({
        model,
        contents,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            languageCode: process.env['GEMINI_TTS_LANGUAGE'] ?? 'pt-BR',
          },
        },
      });

      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Gemini TTS não respondeu em ${Math.round(timeoutMs / 1000)}s.`)),
          timeoutMs,
        );
        request.finally(() => clearTimeout(timer)).catch(() => undefined);
      });

      const response = await Promise.race([request, timeout]);
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const audioPart = parts.find((part) => part.inlineData?.data);
      const base64 = audioPart?.inlineData?.data;

      if (!base64) {
        throw new Error('Gemini TTS respondeu sem áudio (verifique o modelo escolhido).');
      }

      const mimeType = audioPart?.inlineData?.mimeType ?? 'audio/L16;codec=pcm;rate=24000';
      const rateMatch = /rate=(\d+)/.exec(mimeType);
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 24_000;

      return { pcm: Buffer.from(base64, 'base64'), sampleRate, model, voice, mimeType };
    } catch (err) {
      lastError = err;

      if (isQuotaOrRateError(err)) {
        ttsPausedUntilMs = Date.now() + 60_000;
        throw new Error('Limite do Gemini TTS atingido (429). Aguardando ou usando a voz reserva.');
      }

      // Modelo ausente/sobrecarregado: tenta o proximo da cadeia.
      if (isModelUnavailable(err) || /404|not found/i.test(err instanceof Error ? err.message : '')) {
        continue;
      }

      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha ao sintetizar com Gemini TTS.');
}
