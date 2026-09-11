import type { ProbeOutput } from '../probe.js';
import type { ServiceProvider } from './types.js';

/** Nginx service provider. Ported from
 *  crates/omnyssh-core/src/ssh/services/nginx.rs. */
export const nginxProvider: ServiceProvider = {
  kind: 'nginx',

  detect(probeOutput: ProbeOutput): boolean {
    return (probeOutput.getSection('SERVICES')?.includes('nginx') ?? false) || (probeOutput.getSection('PROCESS')?.includes('nginx') ?? false);
  },

  quickMetrics(): [] {
    return [];
  }
};
