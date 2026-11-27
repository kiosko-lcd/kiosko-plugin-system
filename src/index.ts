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
  name: { en: 'System', es: 'Sistema', de: 'System', 'zh-Hant': '系統', 'zh-Hans': '系统' },
  version: '0.2.3',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  permissions: { exec: ['systemctl'], files: ['/proc', '/sys'] },
  description: { en: 'Machine vitals as a shared source, and a system health card.', es: 'Los vitales de la máquina como fuente compartida, y una tarjeta de salud del sistema.', de: 'Die Vitalwerte des Rechners als gemeinsame Datenquelle und eine Übersicht zum Systemzustand.', 'zh-Hant': '以共用資料來源提供本機的各項指標，並附系統健康卡片。', 'zh-Hans': '以共享数据源提供本机各项指标，并附系统健康卡片。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'cpu',
  widgets: [health],
  sources: [vitals],
  templates: [
    {
      id: 'monitor',
      name: { en: 'System monitor', es: 'Monitor del sistema', de: 'Systemmonitor', 'zh-Hant': '系統監控', 'zh-Hans': '系统监控' },
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
