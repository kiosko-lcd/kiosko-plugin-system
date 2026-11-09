/**
 * The `vitals` source: CPU usage (overall and per core), load, memory, CPU
 * temperature, the disk of a chosen path and uptime, read every few seconds
 * and shared by every widget that asks for `system/vitals`.
 */
import { availableParallelism, loadavg, platform, uptime } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineSource, t } from '@kiosko/sdk';
import { coreUsage, readCpuSample, readCpuTemp, readDisk, readMemory, SYSTEM_ROOT, type CpuSample } from './sensors.ts';

/**
 * Machine vitals. Every field is optional: they come from /proc, /sys and
 * `os`, which aren't the same everywhere, and what can't be read isn't painted.
 */
export interface SystemSnapshot {
  /** CPU package temperature, °C. */
  cpuTemp?: number;
  /** Overall CPU usage, 0..1. */
  cpuUsage?: number;
  /** Usage per core, 0..1. */
  cores?: number[];
  /** 1-minute load already divided by the number of cores (0..1+). Absent on Windows. */
  load?: number;
  /** Memory in bytes. */
  mem?: { used: number; total: number };
  /** The watched disk, in bytes. */
  disk?: { used: number; total: number; path: string };
  /** Seconds since boot. */
  uptime?: number;
}

/**
 * The previous CPU sample: counters are cumulative, so usage is a delta
 * between two readings. The source polls every few seconds, so the last
 * reading serves as the reference.
 */
let previous: CpuSample | null = null;

/** Forgets the previous CPU sample (tests). */
export function resetCpuSampling(): void {
  previous = null;
}

export interface ReadOptions {
  diskPath: string;
  /** Without a previous sample, wait this long for a second one instead of giving up per-core usage. */
  firstSampleMs?: number;
  signal?: AbortSignal;
}

export async function readVitals(o: ReadOptions): Promise<SystemSnapshot> {
  const snap: SystemSnapshot = {};
  const temp = readCpuTemp();
  if (temp !== undefined) snap.cpuTemp = temp;
  const n = availableParallelism();
  // Windows has no load average: os.loadavg() is always zeros there.
  if (platform() !== 'win32') snap.load = loadavg()[0]! / n;
  snap.uptime = uptime();
  snap.mem = await readMemory();
  const disk = o.diskPath ? await readDisk(o.diskPath) : undefined;
  if (disk) snap.disk = { used: disk.used, total: disk.total, path: o.diskPath };

  let sample = await readCpuSample();
  if (sample && !previous && (o.firstSampleMs ?? 0) > 0) {
    // First reading: no delta yet. Take a second one shortly after (async,
    // nothing blocks) so the first frame already has per-core bars.
    previous = sample;
    try {
      await sleep(o.firstSampleMs, undefined, o.signal ? { signal: o.signal } : undefined);
    } catch {
      return snap;
    }
    sample = await readCpuSample();
  }
  if (sample) {
    const per = previous ? coreUsage(previous, sample) : null;
    if (per?.length) {
      snap.cores = per;
      snap.cpuUsage = per.reduce((a, b) => a + b, 0) / per.length;
    }
    previous = sample;
  }
  // Still no delta (counters unreadable): estimate overall usage from the load.
  if (snap.cpuUsage === undefined && snap.load !== undefined) snap.cpuUsage = Math.min(1, snap.load);
  return snap;
}

/** Fixed vitals for the gallery. The disk is at 91 % on purpose: the one vital lit. */
export function demoVitals(): SystemSnapshot {
  return {
    cpuTemp: 71,
    cpuUsage: 0.23,
    cores: [0.62, 0.18, 0.41, 0.07, 0.93, 0.12, 0.05, 0.33, 0.28, 0.02, 0.51, 0.09, 0.16, 0.04, 0.71, 0.11],
    load: 0.23,
    mem: { used: 26 * 1024 ** 3, total: 62 * 1024 ** 3 },
    disk: { used: 240 * 1024 ** 3, total: 265 * 1024 ** 3, path: '/data' },
    uptime: 836 * 3600,
  };
}

export const vitals = defineSource({
  id: 'vitals',
  name: { en: 'Machine vitals', es: 'Vitales de la máquina' },
  description: {
    en: 'CPU usage per core, load, memory, CPU temperature (Linux), disk usage and uptime of this computer.',
    es: 'Uso de CPU por núcleo, carga, memoria, temperatura de la CPU (Linux), ocupación del disco y tiempo encendido de este ordenador.',
  },
  options: t.object({
    diskPath: t.string({ default: SYSTEM_ROOT, format: 'path', risk: 'path', label: { en: 'Disk to watch', es: 'Disco a vigilar' }, help: { en: 'Any path on it, e.g. / or /home.', es: 'Cualquier ruta suya, p. ej. / o /home.' } }),
  }),
  intervalMs: 5000,
  read: ({ options, signal }) => readVitals({ diskPath: options.diskPath, firstSampleMs: 250, signal }),
  demo: () => demoVitals(),
});
