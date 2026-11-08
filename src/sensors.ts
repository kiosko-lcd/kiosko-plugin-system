/**
 * Readers of the machine's vitals, straight from `/proc`, `/sys` and `os`.
 * Nothing here throws: on a system that isn't Linux (or in a trimmed
 * container) whatever can't be read is left undefined and the cards simply
 * don't paint it. CPU usage falls back to `os.cpus()` times on macOS and
 * Windows; temperatures are Linux only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, platform, totalmem } from 'node:os';

/** Cumulative CPU counters per core. */
export interface CpuSample {
  /** Total ticks per core. */
  total: number[];
  /** Idle ticks (idle + iowait) per core. */
  idle: number[];
}

/** Per-core counters of `/proc/stat` (the `cpuN` lines). */
export function parseProcStat(text: string): CpuSample | null {
  const total: number[] = [];
  const idle: number[] = [];
  for (const line of text.split('\n')) {
    if (!/^cpu\d+ /.test(line)) continue;
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    // Fields: user nice system idle iowait irq softirq steal ...
    total.push(n.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0));
    idle.push((n[3] ?? 0) + (n[4] ?? 0));
  }
  return total.length ? { total, idle } : null;
}

/** The same counters from `os.cpus()` (macOS, Windows). */
export function sampleFromCpus(list: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuSample | null {
  if (!list.length) return null;
  return {
    total: list.map(({ times: t }) => t.user + t.nice + t.sys + t.idle + t.irq),
    idle: list.map(({ times: t }) => t.idle),
  };
}

/** Usage per core between two samples, 0..1; null if they don't match. */
export function coreUsage(prev: CpuSample, next: CpuSample): number[] | null {
  if (prev.total.length !== next.total.length) return null;
  return next.total.map((tot, i) => {
    const dTotal = tot - prev.total[i]!;
    const dIdle = next.idle[i]! - prev.idle[i]!;
    // No time elapsed, no rate.
    return dTotal > 0 ? Math.min(1, Math.max(0, 1 - dIdle / dTotal)) : 0;
  });
}

/**
 * A CPU sample. On Linux from /proc/stat and not `os.cpus()`, which reads
 * every core's frequency from /sys, waking sleeping cores and blocking for
 * ~250 ms.
 */
export async function readCpuSample(): Promise<CpuSample | null> {
  if (platform() === 'linux') {
    try {
      return parseProcStat(await readFile('/proc/stat', 'utf8'));
    } catch {
      // Fall through to os.cpus().
    }
  }
  try {
    return sampleFromCpus(cpus());
  } catch {
    return null;
  }
}

function readNum(path: string): number | null {
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const CPU_HWMON = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal', 'soc_thermal'];

export interface Temps {
  /** CPU package degrees and its critical point if the sensor gives one. */
  cpu: { temp: number; crit: number | null } | null;
  /** The hottest NVMe drive. */
  nvme: number | null;
}

/** Temperatures from /sys/class/hwmon: the CPU (coretemp, k10temp…) and the hottest NVMe. */
export function readHwmon(root = '/sys/class/hwmon'): Temps {
  let cpu: Temps['cpu'] = null;
  let nvme: number | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return { cpu, nvme };
  }
  for (const h of names) {
    let name = '';
    try {
      name = readFileSync(`${root}/${h}/name`, 'utf8').trim();
    } catch {
      continue;
    }
    const t = readNum(`${root}/${h}/temp1_input`);
    if (t === null) continue;
    if (!cpu && CPU_HWMON.includes(name)) {
      const crit = readNum(`${root}/${h}/temp1_crit`);
      cpu = { temp: t / 1000, crit: crit ? crit / 1000 : null };
    } else if (name === 'nvme') nvme = Math.max(nvme ?? -Infinity, t / 1000);
  }
  return { cpu, nvme };
}

/** CPU package temperature from the thermal zones; `x86_pkg_temp` is the real one. */
export function readThermalZone(root = '/sys/class/thermal'): number | undefined {
  const preferred = ['x86_pkg_temp', 'coretemp', 'cpu-thermal', 'cpu_thermal', 'soc-thermal'];
  let fallback: number | undefined;
  let zones: string[];
  try {
    zones = readdirSync(root).filter((z) => z.startsWith('thermal_zone'));
  } catch {
    return undefined;
  }
  for (const zone of zones) {
    let type: string;
    try {
      type = readFileSync(`${root}/${zone}/type`, 'utf8').trim();
    } catch {
      continue;
    }
    const milli = readNum(`${root}/${zone}/temp`);
    if (milli === null) continue;
    if (preferred.includes(type)) return milli / 1000;
    // `acpitz` is usually the case, not the die: only if nothing better.
    fallback ??= milli / 1000;
  }
  return fallback;
}

/** CPU temperature in °C: hwmon first, then thermal zones. Linux only. */
export function readCpuTemp(hwmonRoot?: string, thermalRoot?: string): number | undefined {
  return readHwmon(hwmonRoot).cpu?.temp ?? readThermalZone(thermalRoot);
}

/** MemAvailable of /proc/meminfo, in bytes. */
export function memAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/** Used and total memory. "Used" leaves out caches on Linux (MemAvailable). */
export async function readMemory(): Promise<{ used: number; total: number }> {
  const total = totalmem();
  let avail: number | null = null;
  if (platform() === 'linux') {
    try {
      avail = memAvailable(await readFile('/proc/meminfo', 'utf8'));
    } catch {
      // Use os.freemem().
    }
  }
  return { used: total - (avail ?? freemem()), total };
}

/** Size and free space of the filesystem holding `path`, in bytes. */
export async function readDisk(path: string): Promise<{ used: number; total: number; free: number } | undefined> {
  try {
    const s = await statfs(path);
    const total = Number(s.blocks) * Number(s.bsize);
    // `bavail` is what a normal user can still use; `bfree` counts root's reserve.
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return undefined;
    return { used: total - free, total, free };
  } catch {
    return undefined;
  }
}

/** The root of the system disk: `/`, or `C:\` on Windows. */
export const SYSTEM_ROOT = platform() === 'win32' ? 'C:\\' : '/';

/** "11 GB", "850 MB", "1.2 TB" (decimal comma in Spanish). */
export function bytes(n: number, locale = 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  const v = n < 10 && i > 0 ? n.toFixed(1) : String(Math.round(n));
  return `${/^es(?:$|[-_])/i.test(locale) ? v.replace('.', ',') : v} ${units[i]}`;
}

/** "3 d 4 h", "5 h", "12 min". */
export function since(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  return h > 0 ? `${h} h` : `${Math.floor(seconds / 60)} min`;
}
