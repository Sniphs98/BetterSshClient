import type { ProbeOutput } from '../probe.js';
import type { ServiceProvider } from './types.js';

/** Node.js service provider. Ported from
 *  crates/omnyssh-core/src/ssh/services/nodejs.rs. */
export const nodejsProvider: ServiceProvider = {
  kind: 'nodejs',

  detect(probeOutput: ProbeOutput): boolean {
    const processes = probeOutput.getSection('PROCESS');
    if (processes === undefined) return false;
    return processes.includes('node ') || processes.includes('/node');
  },

  quickMetrics(): [] {
    return [];
  }
};
