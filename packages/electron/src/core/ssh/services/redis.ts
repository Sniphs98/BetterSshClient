import type { ProbeOutput } from '../probe.js';
import type { ServiceProvider } from './types.js';

/** Redis service provider. Ported from
 *  crates/omnyssh-core/src/ssh/services/redis.rs. */
export const redisProvider: ServiceProvider = {
  kind: 'redis',

  detect(probeOutput: ProbeOutput): boolean {
    const listen = probeOutput.getSection('LISTEN');
    if (listen !== undefined && (listen.includes(':6379') || listen.includes('6379'))) return true;
    const processes = probeOutput.getSection('PROCESS');
    return processes !== undefined && (processes.includes('redis-server') || processes.includes('redis'));
  },

  quickMetrics(): [] {
    return [];
  }
};
