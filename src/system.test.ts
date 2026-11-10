import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaseContext } from '@kiosko/sdk';
import { demoHealth, diskMounts, pushHistory, warnings } from './health.ts';
import { bytes, coreUsage, memAvailable, parseProcStat, readDisk, readHwmon, readThermalZone, sampleFromCpus } from './sensors.ts';
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
  const fmt = createBaseContext({ now: 0, locale: 'es' }).fmt;
  assert.equal(fmt.duration(929804 * 1000), '10 d 18 h', 'uptime');
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
  pushHistory(h, 3_700_000, 60, 3_600_000);
  assert.deepEqual(h, [[3_700_000, 60]], 'older than what is kept is dropped');
  pushHistory(h, 3_700_000 + 2 * 3_600_000, 61);
  assert.equal(h.length, 2, 'four hours kept by default, for any historyMs');

  const th = { diskWarn: 90, diskAlert: 95, tempWarn: 65, tempAlert: 80 };
  const data = { ...demoHealth(0), disks: [{ mount: '/home', size: 100, free: 7 }, { mount: '/', size: 100, free: 50 }], cpu: { temp: 92, crit: 100 } };
  assert.deepEqual(warnings(data, th).map((w) => w.key), ['disk', 'temp']);
  assert.deepEqual(warnings(data, th, 'alert').map((w) => w.key), ['temp'], 'a disk at 93 % is amber, not red');
  assert.deepEqual(warnings({ ...data, disks: [], cpu: { temp: 70, crit: null } }, th), [], 'an amber CPU is any long build');
  assert.deepEqual(warnings({ ...data, disks: [], cpu: null, failed: ['backup'] }, th, 'alert').map((w) => w.key), ['units']);
});

test('health: keeps the tile only on red, and only if the user turns it on', () => {
  const w = plugin.widgets!.find((x) => x.id === 'health')!;
  assert.equal(w.takeOver, false);
  const options = { ...w.options!.default, onlyWhenWarning: false };
  const st = (data: unknown) => ({ options, data, sources: {}, now: 0, working: true }) as never;
  const calm = demoHealth(0);
  assert.equal(w.urgent!(st(calm)), false);
  assert.equal(w.urgent!(st({ ...calm, disks: [{ mount: '/', size: 100, free: 3 }] })), true, 'no longer tied to onlyWhenWarning');
  assert.equal('takeOver' in (w.options as { props: object }).props, false);
});

test('health: disks as a list with "+N more"; temperature amber and red', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { THEMES } = await import('@kiosko/sdk');
  const kit = await import('@loksly/lcd-canvas-kit');
  const w = plugin.widgets!.find((x) => x.id === 'health')!;
  const theme = THEMES[0]!;
  const GB = 1e9;
  const disks = ['/', '/home', '/data', '/backup', '/media/a', '/media/b'].map((mount) => ({ mount, size: 1000 * GB, free: 400 * GB }));
  const paint = (options: Record<string, unknown>, data: object, h = 440) => {
    const texts: { text: string; color?: string }[] = [];
    const spy = { ...kit, drawTracked: (g: never, text: string, x: number, y: number, o: { color?: string }) => (texts.push({ text, ...(o?.color ? { color: o.color } : {}) }), (kit.drawTracked as (...a: unknown[]) => number)(g, text, x, y, o)) };
    const g = createCanvas(600, h).getContext('2d');
    w.render(g as never, { ...createBaseContext({ now: 0, locale: 'en' }), options: { ...w.options!.default, ...options }, data, sources: {}, working: true, box: { x: 0, y: 0, w: 600, h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas }, preview: true } as never);
    return texts;
  };
  const many = { ...demoHealth(0), disks };
  assert.ok(!paint({}, many).some((x) => x.text.startsWith('+')), 'six disks fit a tall tile (no longer cut at four)');
  assert.ok(paint({ rows: 3 }, many).some((x) => x.text === '+3 more'), 'three rows: three disks and "+3 more"');
  assert.ok(paint({}, many, 100).some((x) => /^\+\d+ more$/.test(x.text)), 'a short tile says how many are left out');
  const big = (temp: number) => paint({ tempWarn: 65, tempAlert: 80 }, { ...demoHealth(0), cpu: { temp, crit: 100 } }).find((x) => x.text === `${temp}°`)!.color;
  assert.equal(big(60), theme.colors.ok);
  assert.equal(big(70), theme.colors.warn);
  assert.equal(big(85), theme.colors.alert);
  assert.ok(paint({ historyMs: 5_400_000 }, demoHealth(0)).some((x) => x.text.startsWith('max 1 h 30')));
  assert.ok(paint({ historyMs: 3_600_000 }, demoHealth(0)).some((x) => x.text.startsWith('max 1 h 7')), 'a whole hour, without " 00"');
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
