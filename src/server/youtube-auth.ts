import { existsSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * OAuth 2.0 do YouTube feito à mão.
 *
 * Sem SDK: o fluxo aqui é pequeno (consentimento → código → refresh token) e o
 * projeto inteiro já fala `fetch` puro com Google, Wikimedia e portais. A conta
 * conectada fica em um arquivo local, fora do git.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

const BASE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  // Necessário para thumbnails.set e captions.insert.
  'https://www.googleapis.com/auth/youtube.force-ssl',
  // Métricas do vídeo (critério 14 da spec).
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

/** Receita estimada exige escopo monetário — opcional, pedido só se habilitado. */
const MONETARY_SCOPE = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';

export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  privacyDefault: 'public' | 'unlisted' | 'private';
  monetary: boolean;
}

export function youtubeConfig(): YoutubeConfig | null {
  const clientId = process.env['YOUTUBE_CLIENT_ID']?.trim();
  const clientSecret = process.env['YOUTUBE_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return null;

  const privacy = (process.env['YOUTUBE_PRIVACY_DEFAULT'] ?? 'unlisted').trim();
  return {
    clientId,
    clientSecret,
    redirectUri:
      process.env['YOUTUBE_REDIRECT_URI']?.trim() ||
      'http://127.0.0.1:3000/api/youtube/auth/callback',
    privacyDefault: privacy === 'public' || privacy === 'private' ? privacy : 'unlisted',
    monetary: process.env['YOUTUBE_MONETARY_SCOPE'] === '1',
  };
}

/** URI que o Google Cloud precisa ter cadastrada (mostrada no guia). */
export function youtubeRedirectUri(): string {
  return (
    process.env['YOUTUBE_REDIRECT_URI']?.trim() ||
    'http://127.0.0.1:3000/api/youtube/auth/callback'
  );
}

function envPath(): string {
  return resolve(process.cwd(), '.env');
}

function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const needsBreak = content.length > 0 && !content.endsWith('\n');
  return `${content}${needsBreak ? '\n' : ''}${line}\n`;
}

/**
 * Grava client id/secret no `.env` e aplica em `process.env` na mesma hora —
 * assim o usuário não precisa reiniciar o servidor nem editar arquivo à mão.
 * O arquivo `.env` é local e está no .gitignore.
 */
export async function saveYoutubeCredentials(params: {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<void> {
  const clientId = params.clientId.trim();
  const clientSecret = params.clientSecret.trim();
  const redirectUri = (params.redirectUri ?? '').trim() || youtubeRedirectUri();

  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(
      'O Client ID do Google termina em ".apps.googleusercontent.com". Copie o valor inteiro em Credenciais.',
    );
  }
  if (clientSecret.length < 10) {
    throw new Error('O Client Secret parece incompleto (ele costuma ter ~35 caracteres).');
  }

  const path = envPath();
  let content = '';
  if (existsSync(path)) {
    content = await readFile(path, 'utf8');
  }

  content = upsertEnvLine(content, 'YOUTUBE_CLIENT_ID', clientId);
  content = upsertEnvLine(content, 'YOUTUBE_CLIENT_SECRET', clientSecret);
  if (!/^YOUTUBE_REDIRECT_URI=.*$/m.test(content)) {
    content = upsertEnvLine(content, 'YOUTUBE_REDIRECT_URI', redirectUri);
  }

  await writeFile(path, content, 'utf8');

  process.env['YOUTUBE_CLIENT_ID'] = clientId;
  process.env['YOUTUBE_CLIENT_SECRET'] = clientSecret;
  if (!process.env['YOUTUBE_REDIRECT_URI']) {
    process.env['YOUTUBE_REDIRECT_URI'] = redirectUri;
  }
  cached = null;
  channelCache = null;
}

/** Salva só o Client ID (público) — útil antes de ter o secret em mãos. */
export async function saveYoutubeClientId(clientIdRaw: string): Promise<string> {
  const clientId = clientIdRaw.trim();
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(
      'O Client ID do Google termina em ".apps.googleusercontent.com". Copie o valor inteiro em Credenciais.',
    );
  }

  const path = envPath();
  let content = existsSync(path) ? await readFile(path, 'utf8') : '';
  content = upsertEnvLine(content, 'YOUTUBE_CLIENT_ID', clientId);
  await writeFile(path, content, 'utf8');

  process.env['YOUTUBE_CLIENT_ID'] = clientId;
  cached = null;
  channelCache = null;
  return clientId;
}

/** Remove as credenciais do `.env` e da memória (trocar de conta/projeto). */
export async function clearYoutubeCredentials(): Promise<void> {
  delete process.env['YOUTUBE_CLIENT_ID'];
  delete process.env['YOUTUBE_CLIENT_SECRET'];

  const path = envPath();
  if (existsSync(path)) {
    const content = await readFile(path, 'utf8');
    const cleaned = content
      .replace(/^YOUTUBE_CLIENT_ID=.*$/m, 'YOUTUBE_CLIENT_ID=')
      .replace(/^YOUTUBE_CLIENT_SECRET=.*$/m, 'YOUTUBE_CLIENT_SECRET=');
    await writeFile(path, cleaned, 'utf8');
  }

  cached = null;
  channelCache = null;
}

export function youtubeScopes(): string[] {
  const config = youtubeConfig();
  return config?.monetary ? [...BASE_SCOPES, MONETARY_SCOPE] : [...BASE_SCOPES];
}

function tokenPath(): string {
  return process.env['CANAL_DARK_YOUTUBE_TOKEN']?.trim() || resolve(process.cwd(), '.youtube-token.json');
}

interface StoredToken {
  refreshToken: string;
  scope?: string;
  obtainedAt: string;
}

interface CachedAccess {
  token: string;
  expiresAt: number;
  scope: string;
}

let cached: CachedAccess | null = null;

export async function readStoredToken(): Promise<StoredToken | null> {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredToken>;
    if (!parsed.refreshToken) return null;
    return {
      refreshToken: parsed.refreshToken,
      scope: parsed.scope,
      obtainedAt: parsed.obtainedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeStoredToken(token: StoredToken): Promise<void> {
  const path = tokenPath();
  await writeFile(path, JSON.stringify(token, null, 2), 'utf8');
  // Best-effort no Windows; em Unix restringe a leitura ao dono.
  await chmod(path, 0o600).catch(() => undefined);
  cached = null;
  channelCache = null;
}

export async function clearStoredToken(): Promise<void> {
  cached = null;
  channelCache = null;
  await rm(tokenPath(), { force: true }).catch(() => undefined);
}

export function buildConsentUrl(state: string): string | null {
  const config = youtubeConfig();
  if (!config) return null;

  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', youtubeScopes().join(' '));
  // offline + consent garantem refresh_token mesmo em reconexão.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(
  code: string,
): Promise<{ refreshToken: string; scope: string }> {
  const config = youtubeConfig();
  if (!config) throw new Error('Credenciais do YouTube não configuradas.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.refresh_token) {
    throw new Error(
      data.error_description ??
        data.error ??
        `Google recusou a autorização (HTTP ${res.status}). O consentimento precisa incluir access_type=offline.`,
    );
  }

  cached = {
    token: data.access_token ?? '',
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope ?? youtubeScopes().join(' '),
  };

  return { refreshToken: data.refresh_token, scope: data.scope ?? youtubeScopes().join(' ') };
}

/**
 * Access token válido, renovando pelo refresh token quando necessário.
 * `null` significa "precisa conectar de novo" — o chamador mostra o botão.
 */
export async function getAccessToken(force = false): Promise<{ token: string; scope: string } | null> {
  if (!force && cached && cached.expiresAt - 60_000 > Date.now()) {
    return { token: cached.token, scope: cached.scope };
  }

  const config = youtubeConfig();
  const stored = await readStoredToken();
  if (!config || !stored) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };

  if (!res.ok || !data.access_token) {
    // invalid_grant = token revogado/expirado (modo "Em teste" expira em 7 dias).
    if (data.error === 'invalid_grant') await clearStoredToken();
    return null;
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope ?? stored.scope ?? youtubeScopes().join(' '),
  };

  return { token: cached.token, scope: cached.scope };
}

export async function youtubeFetch(
  path: string,
  init: RequestInit = {},
  base = API_BASE,
): Promise<Response> {
  const access = await getAccessToken();
  if (!access) {
    throw new Error('YouTube não conectado. Use "Conectar YouTube" para autorizar a conta.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${access.token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function youtubeUploadFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return youtubeFetch(path, init, UPLOAD_BASE);
}

export interface YoutubeStatus {
  configured: boolean;
  connected: boolean;
  channelTitle: string | null;
  channelId: string | null;
  scopes: string[];
  privacyDefault: 'public' | 'unlisted' | 'private';
  tokenPath: string;
  monetary: boolean;
  /** Client ID é público; serve para pré-preencher o formulário do painel. */
  clientId: string | null;
  /** Canal fixado para publicação (trava de segurança). */
  expectedChannelId: string | null;
  /**
   * true = conectado no canal fixado; false = conta errada (publicação
   * bloqueada); null = nenhum canal fixado.
   */
  channelMatchesExpected: boolean | null;
}

/**
 * Canal em que a publicação DEVE cair. Quando definido, qualquer outra conta
 * conectada é recusada antes do upload — evita postar no canal pessoal por
 * engano (o token é da conta Google, não do canal).
 */
export function expectedChannelId(): string | null {
  return process.env['YOUTUBE_EXPECTED_CHANNEL_ID']?.trim() || null;
}

export async function saveExpectedChannelId(channelId: string | null): Promise<void> {
  const value = (channelId ?? '').trim();
  const path = envPath();
  let content = existsSync(path) ? await readFile(path, 'utf8') : '';

  if (/^YOUTUBE_EXPECTED_CHANNEL_ID=.*$/m.test(content)) {
    content = content.replace(/^YOUTUBE_EXPECTED_CHANNEL_ID=.*$/m, `YOUTUBE_EXPECTED_CHANNEL_ID=${value}`);
  } else {
    content = upsertEnvLine(content, 'YOUTUBE_EXPECTED_CHANNEL_ID', value);
  }
  await writeFile(path, content, 'utf8');

  if (value) {
    process.env['YOUTUBE_EXPECTED_CHANNEL_ID'] = value;
  } else {
    delete process.env['YOUTUBE_EXPECTED_CHANNEL_ID'];
  }
}

let channelCache: { at: number; info: { id: string; title: string } | null } | null = null;

export async function getChannelInfo(
  force = false,
): Promise<{ id: string; title: string } | null> {
  if (!force && channelCache && Date.now() - channelCache.at < 10 * 60_000) {
    return channelCache.info;
  }

  const access = await getAccessToken().catch(() => null);
  if (!access) return null;

  try {
    const res = await youtubeFetch('/channels?part=snippet&mine=true');
    if (!res.ok) {
      channelCache = { at: Date.now(), info: null };
      return null;
    }
    const data = (await res.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
    };
    const item = data.items?.[0];
    const info = item?.id ? { id: item.id, title: item.snippet?.title ?? '(sem nome)' } : null;
    channelCache = { at: Date.now(), info };
    return info;
  } catch {
    return null;
  }
}

export async function youtubeStatus(): Promise<YoutubeStatus> {
  const config = youtubeConfig();
  const stored = await readStoredToken();
  const channel = stored && config ? await getChannelInfo() : null;
  const expected = expectedChannelId();

  return {
    configured: Boolean(config),
    // "Conectado" só quando o token renova e o canal responde.
    connected: Boolean(channel),
    channelTitle: channel?.title ?? null,
    channelId: channel?.id ?? null,
    scopes: stored?.scope ? stored.scope.split(' ') : [],
    privacyDefault: config?.privacyDefault ?? 'unlisted',
    tokenPath: tokenPath(),
    monetary: Boolean(config?.monetary),
    clientId: process.env['YOUTUBE_CLIENT_ID']?.trim() || null,
    expectedChannelId: expected,
    channelMatchesExpected: expected && channel ? channel.id === expected : null,
  };
}
