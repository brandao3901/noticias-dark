import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AutopilotConfig,
  PublishMetadata,
  PublishPlatform,
  ScheduleEntry,
} from '../app/models/studio.models';
import { pacificDay } from './publish-quota';
import { projectsRoot } from './projects';

/**
 * Agendamento e autopilot.
 *
 * O YouTube agenda sozinho via `publishAt`; aqui ficam as publicações que o
 * próprio app precisa disparar (e o autopilot). Autopilot **nunca** gera,
 * roteiriza ou aprova: só publica pauta que já está `APPROVED`.
 */

const SCHEDULE_FILE = (): string => join(projectsRoot(), '.schedule.json');
const AUTOPILOT_FILE = (): string => join(projectsRoot(), '.autopilot.json');
const AUTOPILOT_STATE_FILE = (): string => join(projectsRoot(), '.autopilot-state.json');

const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  requireApproval: true,
  maxPerDay: 1,
  platforms: ['youtube'],
};

export async function listSchedule(): Promise<ScheduleEntry[]> {
  const path = SCHEDULE_FILE();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ScheduleEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSchedule(entries: ScheduleEntry[]): Promise<void> {
  await writeFile(SCHEDULE_FILE(), JSON.stringify(entries, null, 2), 'utf8');
}

export async function addSchedule(input: {
  pautaId: string;
  platforms: PublishPlatform[];
  whenIso: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  metadata: PublishMetadata;
}): Promise<ScheduleEntry> {
  const entries = await listSchedule();
  const entry: ScheduleEntry = {
    id: `sched-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
    pautaId: input.pautaId,
    platforms: input.platforms.length ? input.platforms : ['youtube'],
    whenIso: input.whenIso,
    privacyStatus: input.privacyStatus,
    metadata: input.metadata,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
  };
  entries.push(entry);
  await writeSchedule(entries);
  return entry;
}

export async function cancelSchedule(id: string): Promise<boolean> {
  const entries = await listSchedule();
  const entry = entries.find((item) => item.id === id);
  if (!entry || entry.status !== 'scheduled') return false;
  entry.status = 'cancelled';
  entry.finishedAt = new Date().toISOString();
  await writeSchedule(entries);
  return true;
}

export async function finishSchedule(
  id: string,
  status: 'done' | 'failed',
  error?: string,
): Promise<void> {
  const entries = await listSchedule();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  entry.status = status;
  entry.finishedAt = new Date().toISOString();
  if (error) entry.error = error;
  await writeSchedule(entries);
}

export async function readAutopilot(): Promise<AutopilotConfig> {
  const path = AUTOPILOT_FILE();
  if (!existsSync(path)) return { ...DEFAULT_AUTOPILOT };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AutopilotConfig>;
    return {
      ...DEFAULT_AUTOPILOT,
      ...parsed,
      // Nunca permitir desligar o portão humano.
      requireApproval: true,
    };
  } catch {
    return { ...DEFAULT_AUTOPILOT };
  }
}

export async function writeAutopilot(patch: Partial<AutopilotConfig>): Promise<AutopilotConfig> {
  const current = await readAutopilot();
  const next: AutopilotConfig = {
    ...current,
    ...patch,
    requireApproval: true,
    maxPerDay: Math.max(1, Math.min(10, Math.round(patch.maxPerDay ?? current.maxPerDay))),
    platforms: patch.platforms?.length ? patch.platforms : current.platforms,
  };
  await writeFile(AUTOPILOT_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

interface AutopilotState {
  day: string;
  count: number;
}

export async function autopilotPublishedToday(): Promise<number> {
  const path = AUTOPILOT_STATE_FILE();
  if (!existsSync(path)) return 0;
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as AutopilotState;
    return state.day === pacificDay() ? state.count : 0;
  } catch {
    return 0;
  }
}

export async function noteAutopilotPublish(): Promise<void> {
  const day = pacificDay();
  const count = (await autopilotPublishedToday()) + 1;
  await writeFile(AUTOPILOT_STATE_FILE(), JSON.stringify({ day, count }), 'utf8');
}

export interface SchedulerHooks {
  /** Dispara uma entrada agendada (normalmente enfileirando a publicação). */
  runEntry: (entry: ScheduleEntry) => Promise<void>;
  /** Roda uma varredura do autopilot (se ligado). */
  runAutopilot: () => Promise<void>;
}

const running = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

// Sobrevive ao reload de módulo do dev-server: sem isso, cada rebuild criaria
// mais um timer e o autopilot poderia publicar em duplicidade.
const STARTED_KEY = Symbol.for('canalDark.scheduler.started');
type GlobalWithFlag = typeof globalThis & { [STARTED_KEY]?: boolean };

async function tick(hooks: SchedulerHooks): Promise<void> {
  const now = Date.now();
  const entries = await listSchedule();

  for (const entry of entries) {
    if (entry.status !== 'scheduled') continue;
    const when = new Date(entry.whenIso).getTime();
    if (!Number.isFinite(when) || when > now) continue;
    if (running.has(entry.id)) continue;

    running.add(entry.id);
    void hooks
      .runEntry(entry)
      .catch(() => undefined)
      .finally(() => running.delete(entry.id));
  }

  const config = await readAutopilot();
  if (config.enabled) {
    await hooks.runAutopilot().catch(() => undefined);
  }
}

/** Varredura de 1 minuto. Idempotente: chamar duas vezes não duplica o timer. */
export function startScheduler(hooks: SchedulerHooks): void {
  const globalRef = globalThis as GlobalWithFlag;
  if (globalRef[STARTED_KEY]) return;
  globalRef[STARTED_KEY] = true;

  // Primeira varredura depois de 15 s (deixa o servidor terminar de subir).
  setTimeout(() => {
    void tick(hooks);
  }, 15_000);

  timer = setInterval(() => {
    void tick(hooks);
  }, 60_000);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  delete (globalThis as GlobalWithFlag)[STARTED_KEY];
}
