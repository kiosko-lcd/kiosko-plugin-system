/**
 * This computer: a shared `vitals` source (CPU, cores, load, memory,
 * temperature, disk, uptime) for any widget to draw, and a system health
 * card with disks, the CPU temperature's last hour and failed units.
 */
import { definePlugin } from '@kiosko/sdk';
import { health } from './health.ts';
import { vitals } from './vitals.ts';

export { health, vitals };
export type { SystemSnapshot } from './vitals.ts';
export type { Health, Disk } from './health.ts';

export default definePlugin({
  id: 'system',
  name: { en: 'System', es: 'Sistema' },
  version: '0.2.1',
  sdk: '^0.2.0',
  permissions: { exec: ['systemctl'], files: ['/proc', '/sys'] },
  description: { en: 'Machine vitals as a shared source, and a system health card.', es: 'Los vitales de la máquina como fuente compartida, y una tarjeta de salud del sistema.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'cpu',
  widgets: [health],
  sources: [vitals],
  templates: [
    {
      id: 'monitor',
      name: { en: 'System monitor', es: 'Monitor del sistema' },
      icon: 'cpu',
      wide: [
        { x: 0, y: 0, w: 3 / 5, h: 1, widgets: ['vitals/vitals'], chrome: 'bare' },
        { x: 3 / 5, y: 0, w: 2 / 5, h: 1, widgets: ['health'] },
      ],
      square: [
        { x: 0, y: 0, w: 1, h: 1 / 2, widgets: ['vitals/vitals'], chrome: 'bare' },
        { x: 0, y: 1 / 2, w: 1, h: 1 / 2, widgets: ['health'] },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 7 / 24, widgets: ['vitals/vitals'], chrome: 'bare' },
        { x: 0, y: 7 / 24, w: 1, h: 5 / 12, widgets: ['health'] },
        { x: 0, y: 17 / 24, w: 1, h: 7 / 24, widgets: ['gpu/cards', 'usage/rail'] },
      ],
    },
  ],
});
