import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoHealth, diskMounts, pushHistory, warnings } from './health.ts';
import { bytes, coreUsage, memAvailable, parseProcStat, readDisk, readHwmon, readThermalZone, sampleFromCpus, since } from './sensors.ts';
import { readVitals, resetCpuSampling } from './vitals.ts';
import plugin from './index.ts';

test('cpu: per-core usage as a delta of /proc/stat or os.cpus() counters', () => {
  const a = parseProcStat('cpu  10 0 10 80 0 0 0 0\ncpu0 5 0 5 40 0 0 0 0\ncpu1 5 0 5 40 0 0 0 0\nintr 1 2 3\n')!;
  const b = parseProcStat('cpu  60 0 10 130 0 0 0 0\ncpu0 55 0 5 40 0 0 0 0\ncpu1 5 0 5 90 0 0 0 0\n')!;
  assert.deepEqual(a.total, [50, 50]);
  assert.deepEqual(coreUsage(a, b), [1, 0]);
  assert.equal(coreUsage(a, { total: [1], idle: [1] }), null, 'different core count');
  assert.deepEqual(coreUsage(a, a), [0, 0], 'no time elapsed, no rate');
  assert.equal(parseProcStat('nothing'), null);
  const t = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  const c0 = sampleFromCpus([t(100, 100)])!, c1 = sampleFromCpus([t(130, 170)])!;
  assert.ok(Math.abs(coreUsage(c0, c1)![0]! - 0.3) < 1e-9);
  assert.equal(sampleFromCpus([]), null);
});

test('temperatures from hwmon and thermal zones', () => {
  const root = mkdtempSync(join(tmpdir(), 'hwmon-'));
  const sensor = (dir: string, name: string, temp: number, crit?: number) => {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'name'), `${name}\n`);
    writeFileSync(join(root, dir, 'temp1_input'), `${temp}\n`);
    if (crit) writeFileSync(join(root, dir, 'temp1_crit'), `${crit}\n`);
  };
  sensor('hwmon0', 'acpitz', 27800);
  sensor('hwmon1', 'nvme', 41850);
  sensor('hwmon2', 'nvme', 47850);
  sensor('hwmon6', 'coretemp', 92000, 100000);
  assert.deepEqual(readHwmon(root), { cpu: { temp: 92, crit: 100 }, nvme: 47.85 });
  assert.deepEqual(readHwmon(join(root, 'missing')), { cpu: null, nvme: null });

  const th = mkdtempSync(join(tmpdir(), 'thermal-'));
  const zone = (dir: string, type: string, temp: number) => {
    mkdirSync(join(th, dir));
    writeFileSync(join(th, dir, 'type'), `${type}\n`);
    writeFileSync(join(th, dir, 'temp'), `${temp}\n`);
  };
  zone('thermal_zone0', 'acpitz', 30000);
  assert.equal(readThermalZone(th), 30, 'acpitz only when nothing better');
  zone('thermal_zone1', 'x86_pkg_temp', 64000);
  assert.equal(readThermalZone(th), 64);
  assert.equal(readThermalZone(join(th, 'missing')), undefined);
});

test('memory, sizes and durations', () => {
  assert.equal(memAvailable('MemTotal: 65408852 kB\nMemAvailable:   44442036 kB\n'), 44442036 * 1024);
  assert.equal(memAvailable('nothing'), null);
  assert.equal(bytes(10_882_990_080), '11 GB');
  assert.equal(bytes(1_200_000_000_000, 'es'), '1,2 TB');
  assert.equal(bytes(1_200_000_000_000, 'en'), '1.2 TB');
  assert.equal(since(929804), '10 d 18 h');
  assert.equal(since(5 * 3600 + 100), '5 h');
  assert.equal(since(700), '11 min');
});

test('health: disk mounts of /proc/mounts, temperature history and warnings', () => {
  const mounts = [
    '/dev/nvme0n1p2 / ext4 rw 0 0',
    'proc /proc proc rw 0 0',
    '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
    '/dev/nvme0n1p3 /home ext4 rw 0 0',
    '/dev/loop3 /snap/core/1 squashfs ro 0 0',
    '/dev/nvme1n1p1 /data ext4 rw 0 0',
    '/dev/nvme1n1p1 /var/lib/docker ext4 rw 0 0',
    '/dev/sda1 /mnt/my\\040disk ext4 rw 0 0',
  ].join('\n');
  assert.deepEqual(diskMounts(mounts), ['/', '/home', '/data', '/mnt/my disk']);

  const h: [number, number][] = [];
  pushHistory(h, 0, 50);
  pushHistory(h, 5_000, 51);
  assert.equal(h.length, 1, 'not more than one reading every 10 s');
  pushHistory(h, 3_700_000, 60);
  assert.deepEqual(h, [[3_700_000, 60]], 'older than an hour is dropped');

  const th = { diskWarn: 90, diskAlert: 95, tempWarn: 80 };
  const data = { ...demoHealth(0), disks: [{ mount: '/home', size: 100, free: 5 }, { mount: '/', size: 100, free: 50 }], cpu: { temp: 92, crit: 100 } };
  assert.deepEqual(warnings(data, th).map((w) => w.key), ['disk', 'temp']);
  assert.deepEqual(warnings({ ...data, disks: [], cpu: { temp: 50, crit: null } }, th), []);
  assert.deepEqual(warnings({ ...data, disks: [], cpu: null, failed: ['backup'] }, th).map((w) => w.key), ['units']);
});

test('vitals: the first read waits for a second sample; a missing disk path is fine', async () => {
  resetCpuSampling();
  const snap = await readVitals({ diskPath: '/no/such/path/ever', firstSampleMs: 120 });
  assert.equal(snap.disk, undefined);
  assert.ok(snap.mem && snap.mem.total > 0 && snap.mem.used >= 0);
  assert.ok(typeof snap.uptime === 'number');
  assert.ok(snap.cores && snap.cores.length > 0, 'per-core usage on the first read');
  for (const c of snap.cores!) assert.ok(c >= 0 && c <= 1, `usage within 0..1, was ${c}`);
  assert.ok(snap.cpuUsage! >= 0 && snap.cpuUsage! <= 1);
  const again = await readVitals({ diskPath: '/' });
  assert.ok(again.disk && again.disk.total > 0 && again.disk.path === '/');
  assert.ok(await readDisk('/'));
});

test('plugin: the vitals source and the health card have demo data', () => {
  assert.equal(plugin.id, 'system');
  const src = plugin.sources?.find((s) => s.id === 'vitals');
  assert.ok(src?.read && src.demo && src.intervalMs === 5000);
  const demo = src.demo!({ now: 0, locale: "en" }) as { cores?: number[]; disk?: unknown };
  assert.ok(demo.cores?.length && demo.disk);
  const health = plugin.widgets?.find((w) => w.id === 'health');
  assert.ok(health?.icon && health.category === 'system' && health.demo!({ options: health.options!.default, now: 0, locale: "en" }).data);
});
