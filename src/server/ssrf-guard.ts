import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  't.co',
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

export interface SafeUrlCheckResult {
  allowed: boolean;
  isSocialX: boolean;
  parsed?: URL;
  reason?: string;
}

export function isSocialXHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_X_HOSTS.has(lower) || lower.endsWith('.x.com') || lower.endsWith('.twitter.com');
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIPv4(mapped)) return isPrivateOrReservedIpv4(mapped);
  }
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (normalized.startsWith('ff')) return true;
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateOrReservedIpv4(ip);
  if (kind === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

export async function validateSafePublicUrl(rawUrl: string): Promise<SafeUrlCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { allowed: false, isSocialX: false, reason: 'URL inválida.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      isSocialX: false,
      reason: 'Apenas esquemas http e https são permitidos.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { allowed: false, isSocialX: false, reason: 'Domínio ausente na URL.' };
  }

  if (isSocialXHost(hostname)) {
    return {
      allowed: false,
      isSocialX: true,
      parsed,
      reason:
        'Links do X/Twitter não são abertos ou raspados. Informe o assunto ou cole o link de uma matéria pública.',
    };
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    return {
      allowed: false,
      isSocialX: false,
      reason: 'Destinos de rede locais ou internos são bloqueados.',
    };
  }

  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      return {
        allowed: false,
        isSocialX: false,
        reason: 'Endereços IP privados ou de loopback são bloqueados.',
      };
    }
    return { allowed: true, isSocialX: false, parsed };
  }

  try {
    const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!resolved.length) {
      return {
        allowed: false,
        isSocialX: false,
        reason: 'Não foi possível resolver o domínio informado.',
      };
    }
    for (const entry of resolved) {
      if (isBlockedIpAddress(entry.address)) {
        return {
          allowed: false,
          isSocialX: false,
          reason: 'O domínio resolve para faixa de rede privada ou local bloqueada.',
        };
      }
    }
  } catch {
    return {
      allowed: false,
      isSocialX: false,
      reason: 'Falha ao resolver DNS do domínio informado.',
    };
  }

  return { allowed: true, isSocialX: false, parsed };
}

export async function safeFetchWithRedirectGuard(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  error?: string;
  isSocialX?: boolean;
}> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 1_500_000;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= 3; hop++) {
    const check = await validateSafePublicUrl(currentUrl);
    if (!check.allowed || !check.parsed) {
      return {
        ok: false,
        status: 400,
        finalUrl: currentUrl,
        contentType: '',
        body: '',
        error: check.reason ?? 'URL bloqueada pela validação de segurança.',
        isSocialX: check.isSocialX,
      };
    }

    let response: Response;
    try {
      response = await fetch(check.parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': 'CanalDarkEditorial/0.1 (+https://canaldark.local)',
          Accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        },
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        body: '',
        error: err instanceof Error ? err.message : 'Timeout ou erro de rede ao acessar a página.',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          ok: false,
          status: response.status,
          finalUrl: currentUrl,
          contentType: '',
          body: '',
          error: 'Redirecionamento sem cabeçalho Location.',
        };
      }
      currentUrl = new URL(location, check.parsed).toString();
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        finalUrl: currentUrl,
        contentType,
        body: text.slice(0, maxBytes),
      };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const merged = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const headerCharsetMatch = contentType.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
    let detectedCharset = headerCharsetMatch?.[1]?.trim().toLowerCase() ?? '';
    if (!detectedCharset) {
      const asciiProbe = new TextDecoder('latin1').decode(merged.subarray(0, 2048));
      const metaMatch =
        asciiProbe.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/i) ??
        asciiProbe.match(/<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_-]+)["']/i);
      detectedCharset = metaMatch?.[1]?.trim().toLowerCase() ?? 'utf-8';
    }
    if (detectedCharset === 'iso-8859-1' || detectedCharset === 'latin1' || detectedCharset === 'latin-1') {
      detectedCharset = 'windows-1252';
    }

    let body: string;
    try {
      body = new TextDecoder(detectedCharset, { fatal: false }).decode(merged);
    } catch {
      body = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    }

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: currentUrl,
      contentType,
      body,
    };
  }

  return {
    ok: false,
    status: 310,
    finalUrl: currentUrl,
    contentType: '',
    body: '',
    error: 'Limite de redirecionamentos excedido.',
  };
}
