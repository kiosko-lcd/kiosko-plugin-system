/**
 * System health: how full the disks are, the CPU temperature (with its last
 * hour as a line, because peaks can't be seen at a glance), load, memory,
 * uptime and failed systemd units. Inspired by MMM-SystemStats; everything
 * comes from the machine itself, no network.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { availableParallelism, loadavg, platform, uptime } from 'node:os';
import { promisify } from 'node:util';
import { defineWidget, t, type Localized } from '@kiosko/sdk';
import { bytes, readDisk, readHwmon, readMemory, readThermalZone, since, SYSTEM_ROOT } from './sensors.ts';

const run = promisify(execFile);

export interface Disk {
  mount: string;
  size: number;
  free: number;
}

export interface Health {
  disks: Disk[];
  /** CPU degrees and its critical point, if the sensor gives one. */
  cpu: { temp: number; crit: number | null } | null;
  /** The hottest NVMe drive. */
  nvme: number | null;
  /** Temperatures of the last hour: [instant, degrees]. */
  history: [number, number][];
  /** 1-minute load average (not divided by cores); null on Windows. */
  load: number | null;
  cores: number;
  memUsed: number;
  memTotal: number;
  uptime: number;
  failed: string[];
}

const DISK_FS = new Set(['ext4', 'ext3', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs3', 'fuseblk', 'apfs', 'bcachefs']);

/** Disk mount points of /proc/mounts, one per device. */
export function diskMounts(procMounts: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of procMounts.split('\n')) {
    const [dev, mount, fs] = line.split(' ');
    if (!dev || !mount || !fs || !DISK_FS.has(fs) || !dev.startsWith('/dev/') || seen.has(dev)) continue;
    if (/^\/(boot|snap|run|var\/snap)(\/|$)/.test(mount)) continue;
    seen.add(dev);
    out.push(mount.replace(/\\040/g, ' '));
  }
  return out;
}

async function failedUnits(): Promise<string[]> {
  if (platform() !== 'linux') return [];
  const out: string[] = [];
  for (const scope of [[], ['--user']]) {
    try {
      const { stdout } = await run('systemctl', [...scope, '--failed', '--no-legend', '--plain', '--no-pager'], { timeout: 5000 });
      for (const line of stdout.split('\n')) {
        const unit = line.trim().split(/\s+/)[0];
        if (unit) out.push(unit.replace(/\.service$/, ''));
      }
    } catch {
      // No systemd (or no user bus): nothing to count.
    }
  }
  return out;
}

export interface Thresholds {
  diskWarn: number;
  diskAlert: number;
  tempWarn: number;
}

/** What crosses its threshold, most serious first. */
export function warnings(h: Health, th: Thresholds): { key: 'disk' | 'temp' | 'units'; text: Localized }[] {
  const out: { key: 'disk' | 'temp' | 'units'; text: Localized }[] = [];
  for (const d of h.disks) if (100 - (d.free / d.size) * 100 >= th.diskWarn) out.push({ key: 'disk', text: { en: `${d.mount} full`, es: `${d.mount} lleno` } });
  if (h.cpu && h.cpu.temp >= th.tempWarn) out.push({ key: 'temp', text: { en: 'CPU hot', es: 'CPU caliente' } });
  if (h.failed.length) out.push({ key: 'units', text: { en: 'failed units', es: 'unidades caídas' } });
  return out;
}

const HOUR = 3_600_000;
/** The last hour of CPU temperatures, kept across fetches. */
const history: [number, number][] = [];

/** Adds a reading (not more than one every 10 s) and drops what's older than an hour. */
export function pushHistory(h: [number, number][], now: number, temp: number): [number, number][] {
  if (!h.length || now - h[h.length - 1]![0] >= 10_000) h.push([now, temp]);
  while (h.length && h[0]![0] < now - HOUR) h.shift();
  return h;
}

export function demoHealth(now: number): Health {
  const hist: [number, number][] = [];
  for (let i = 0; i <= 60; i++) {
    // A calm hour with a build twenty minutes ago.
    const bump = Math.exp(-(((i - 40) / 4) ** 2)) * 22;
    hist.push([now - (60 - i) * 60_000, 54 + 4 * Math.sin(i / 5) + bump]);
  }
  const GB = 1e9;
  return {
    disks: [
      { mount: '/', size: 512 * GB, free: 188 * GB },
      { mount: '/home', size: 1000 * GB, free: 92 * GB },
      { mount: '/data', size: 2000 * GB, free: 1060 * GB },
    ],
    cpu: { temp: 61, crit: 100 },
    nvme: 44,
    history: hist,
    load: 3.2,
    cores: 16,
    memUsed: 26 * GB,
    memTotal: 64 * GB,
    uptime: 10 * 86400 + 18 * 3600,
    failed: [],
  };
}

export const health = defineWidget({
  id: 'health',
  name: { en: 'System health', es: 'Salud del PC' },
  description: {
    en: 'Disk usage, CPU temperature over the last hour, load, memory, uptime and failed systemd units of this computer.',
    es: 'Ocupación de los discos, temperatura de la CPU en la última hora, carga, memoria, tiempo encendido y unidades de systemd caídas de este ordenador.',
  },
  icon: 'activity',
  category: 'system',
  tags: ['disk', 'temperature', 'systemd'],
  size: { min: { w: 280, h: 140 }, preferred: { w: 600, h: 440 } },
  options: t.object({
    mounts: t.list(t.string({ format: 'path', risk: 'path', placeholder: '/home' }), { label: { en: 'Disks (mount points)', es: 'Discos (puntos de montaje)' }, help: { en: 'Empty = every mounted disk (Linux) or the system disk.', es: 'Vacío = todos los discos montados (Linux) o el del sistema.' } }),
    diskWarn: t.integer({ default: 90, min: 50, max: 100, unit: '%', label: { en: 'Disk warning at', es: 'Aviso de disco desde' } }),
    diskAlert: t.integer({ default: 95, min: 50, max: 100, unit: '%', label: { en: 'Disk alert at', es: 'Alerta de disco desde' } }),
    tempWarn: t.integer({ default: 80, min: 40, max: 110, unit: '°C', label: { en: 'Hot CPU at', es: 'CPU caliente desde' } }),
    onlyWhenWarning: t.boolean({ label: { en: 'Only when something is wrong', es: 'Sólo si algo va mal' }, help: { en: 'Takes its turn only while a disk or the CPU crosses its threshold, or a unit has failed.', es: 'Sólo entra en el turno si un disco o la CPU pasan de su umbral, o hay una unidad caída.' } }),
    systemd: t.boolean({ default: true, advanced: true, label: { en: 'Check failed systemd units', es: 'Mirar las unidades de systemd caídas' } }),
  }),
  intervalMs: 30_000,
  async fetch({ options, now }): Promise<Health> {
    let mounts = options.mounts.filter((m) => m.trim());
    if (!mounts.length && platform() === 'linux') {
      try {
        mounts = diskMounts(await readFile('/proc/mounts', 'utf8'));
      } catch {
        // No /proc: the system disk below.
      }
    }
    if (!mounts.length) mounts = [SYSTEM_ROOT];
    const disks: Disk[] = [];
    for (const mount of mounts) {
      const d = await readDisk(mount);
      // A mount point that's gone: left out.
      if (d) disks.push({ mount, size: d.total, free: d.free });
    }
    const temps = readHwmon();
    const zone = temps.cpu ? undefined : readThermalZone();
    const cpu = temps.cpu ?? (zone !== undefined ? { temp: zone, crit: null } : null);
    if (cpu) pushHistory(history, now, cpu.temp);
    const mem = await readMemory();
    return {
      disks,
      cpu,
      nvme: temps.nvme,
      history: cpu ? [...history] : [],
      load: platform() === 'win32' ? null : loadavg()[0]!,
      cores: availableParallelism(),
      memUsed: mem.used,
      memTotal: mem.total,
      uptime: uptime(),
      failed: options.systemd ? await failedUnits() : [],
    };
  },
  visible: ({ options, data }) => Boolean(data) && (!options.onlyWhenWarning || warnings(data!, options).length > 0),
  urgent: ({ options, data }) => Boolean(data && options.onlyWhenWarning && warnings(data, { ...options, diskWarn: options.diskAlert }).length > 0),
  render(g, { options, data, now, box, theme, kit, locale, t: tr }) {
    if (!data) return;
    const { colors, fonts } = theme;
    const level = (pct: number) => (pct >= options.diskAlert ? colors.alert : pct >= options.diskWarn ? colors.warn : colors.ok);
    const k = Math.max(0.42, Math.min(1.3, box.h / 362, box.w / 400));

    // Bottom: load, memory, NVMe and uptime; failed units above, in red.
    const fs = Math.round(Math.max(11, 24 * k));
    const footY = box.y + box.h - fs * 0.3;
    let bottom = footY - fs * 1.2;
    const loadCol = data.load === null ? colors.inkDim : data.load >= data.cores ? colors.alert : data.load >= data.cores * 0.7 ? colors.warn : colors.inkDim;
    const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    const parts: [string, string][] = [
      ...(data.load !== null ? [[`${tr({ en: 'load', es: 'carga' })} ${num(data.load)}`, loadCol] as [string, string]] : []),
      [`RAM ${Math.round((data.memUsed / data.memTotal) * 100)} %`, colors.inkDim],
      ...(data.nvme !== null ? [[`NVMe ${Math.round(data.nvme)}°`, colors.inkDim] as [string, string]] : []),
      [`${tr({ en: 'up', es: 'encendido' })} ${since(data.uptime)}`, colors.inkDim],
    ];
    // What doesn't fit is dropped, from the end (the least important last).
    let x = box.x;
    for (const [s, col] of parts) {
      if (x + kit.measureTracked(g, s, { size: fs, family: fonts.sans }) > box.x + box.w) break;
      x += kit.drawTracked(g, s, x, footY, { size: fs, family: fonts.sans, color: col }) + fs;
    }
    if (data.failed.length) {
      const s = `${tr({ en: 'failed', es: 'caídas' })}: ${data.failed.join(', ')}`;
      kit.drawTracked(g, kit.truncate(g, s, box.w, { size: fs, family: fonts.sans }), box.x, bottom, { size: fs, family: fonts.sans, color: colors.alert });
      bottom -= fs * 1.3;
    }

    // CPU: big degrees and, beside them, the last hour with its peak. On
    // wide, short tiles it goes to the right of the disks instead of below.
    const wide = box.w >= box.h * 2.4 && box.w >= 480;
    const area = { x: box.x, y: box.y, w: box.w, h: bottom - box.y };
    let diskArea = { ...area };
    let tempArea: typeof area | null = null;
    if (data.cpu) {
      if (wide) {
        const tw = Math.round(area.w * 0.4);
        tempArea = { x: area.x + area.w - tw, y: area.y, w: tw, h: area.h };
        diskArea = { ...area, w: area.w - tw - fs };
      } else {
        const th = Math.round(Math.min(area.h * 0.38, 96 * k + 10));
        tempArea = { x: area.x, y: area.y + area.h - th, w: area.w, h: th };
        diskArea = { ...area, h: area.h - th - 6 };
      }
    }
    // Disk rows, sized first so the temperature can sit closer to them on tall tiles.
    const nDisks = Math.min(data.disks.length, 4);
    const rowH = nDisks ? Math.min(50 * Math.max(k, 0.75), diskArea.h / nDisks) : 0;
    const rows = nDisks ? Math.max(1, Math.min(data.disks.length, Math.floor(diskArea.h / rowH + 0.1))) : 0;
    if (tempArea && !wide) {
      // Split the slack between the disks and the temperature evenly.
      const slack = diskArea.h - rows * rowH;
      if (slack > 0) tempArea = { ...tempArea, y: tempArea.y - slack / 2 };
    }
    if (data.cpu && tempArea) {
      const tA = tempArea;
      const temp = data.cpu.temp;
      const col = temp >= options.tempWarn ? colors.alert : temp >= options.tempWarn - 15 ? colors.warn : colors.ok;
      const big = Math.round(Math.min(tA.h * 0.82, 76 * k * (wide ? 1.2 : 1)));
      const ty = wide ? tA.y + (tA.h + big * 0.72) / 2 : tA.y + tA.h - big * 0.12;
      const tw = kit.drawTracked(g, `${Math.round(temp)}°`, tA.x, ty, { size: big, family: fonts.sans, color: col });
      kit.drawTracked(g, 'CPU', tA.x + tw + big * 0.12, ty - big * 0.5, { size: Math.round(big * 0.32), family: fonts.sans, color: colors.inkDim });
      const sx = tA.x + tw + big * 0.85, sw = tA.x + tA.w - sx;
      const sh = Math.min(tA.h * 0.62, 56 * k), sy = ty - sh;
      const hist = data.history;
      if (hist.length > 1 && sw > 40) {
        const lo = 30, hi = Math.max(data.cpu.crit ?? 100, ...hist.map(([, v]) => v));
        g.strokeStyle = colors.surfaceEdge;
        g.lineWidth = 1;
        g.beginPath();
        const wy = sy + sh - ((options.tempWarn - lo) / (hi - lo)) * sh;
        g.moveTo(sx, wy);
        g.lineTo(sx + sw, wy);
        g.stroke();
        g.strokeStyle = col;
        g.lineWidth = Math.max(1.5, 2.5 * k);
        g.beginPath();
        hist.forEach(([at, v], i) => {
          const px = sx + sw - Math.min(1, (now - at) / HOUR) * sw;
          const py = sy + sh - ((Math.max(lo, v) - lo) / (hi - lo)) * sh;
          if (i) g.lineTo(px, py);
          else g.moveTo(px, py);
        });
        g.stroke();
        const max = Math.max(...hist.map(([, v]) => v));
        const ms = Math.round(Math.max(10, 20 * k));
        kit.drawTracked(g, `${tr({ en: 'max 1 h', es: 'máx. 1 h' })} ${Math.round(max)}°`, sx + sw, sy - ms * 0.4, { size: ms, family: fonts.sans, color: max >= options.tempWarn ? colors.alert : colors.inkDim, align: 'right' });
      }
    }

    // Disks: name, bar, percentage and what's left.
    if (!rows) return;
    const dA = diskArea;
    const ds = Math.round(Math.max(11, Math.min(24, rowH * 0.48)));
    const mono = { size: ds, family: fonts.mono };
    const pctO = { size: Math.round(ds * 1.15), family: fonts.sans };
    const freeO = { size: Math.round(ds * 0.85), family: fonts.sans };
    const freeWord = tr({ en: 'free', es: 'libres' });
    const shown = data.disks.slice(0, rows);
    const nameW = Math.min(dA.w * 0.3, Math.max(...shown.map((d) => kit.measureTracked(g, d.mount, mono))) + ds * 0.6);
    const pctW = kit.measureTracked(g, '100 %', pctO) + ds * 0.4;
    const freeTexts = shown.map((d) => `${bytes(d.free, locale)} ${freeWord}`);
    const freeW = Math.max(...freeTexts.map((s) => kit.measureTracked(g, s, freeO))) + ds * 0.6;
    const withFree = dA.w - nameW - pctW - freeW >= dA.w * 0.25;
    const barX = dA.x + nameW, barW = dA.w - nameW - pctW - (withFree ? freeW : 0);
    shown.forEach((d, i) => {
      const y = dA.y + i * rowH + rowH * 0.72;
      const pct = 100 - (d.free / d.size) * 100;
      const col = level(pct);
      kit.drawTracked(g, kit.truncate(g, d.mount, nameW - ds * 0.5, mono), dA.x, y, { ...mono, color: colors.ink });
      const bh = Math.round(rowH * 0.42);
      g.fillStyle = colors.surfaceEdge;
      g.fillRect(barX, y - bh, barW, bh);
      g.fillStyle = col;
      g.fillRect(barX, y - bh, (barW * Math.min(100, Math.max(0, pct))) / 100, bh);
      kit.drawTracked(g, `${Math.round(pct)} %`, barX + barW + pctW, y, { ...pctO, color: col, align: 'right' });
      if (withFree) kit.drawTracked(g, freeTexts[i]!, dA.x + dA.w, y, { ...freeO, color: colors.inkDim, align: 'right' });
    });
  },
  demo: ({ now }) => ({ data: demoHealth(now) }),
});
