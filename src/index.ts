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
  version: '0.2.0',
  description: { en: 'Machine vitals as a shared source, and a system health card.', es: 'Los vitales de la máquina como fuente compartida, y una tarjeta de salud del sistema.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'cpu',
  widgets: [health],
  sources: [vitals],
});
