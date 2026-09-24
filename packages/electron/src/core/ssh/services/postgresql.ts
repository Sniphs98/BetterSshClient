import type { ProbeOutput } from '../probe.js';
import type { ServiceProvider } from './types.js';

/** PostgreSQL service provider. Ported from
 *  crates/omnyssh-core/src/ssh/services/postgresql.rs. */
export const postgresqlProvider: ServiceProvider = {
  kind: 'postgresql',

  detect(probeOutput: ProbeOutput): boolean {
    if (probeOutput.getSection('SERVICES')?.includes('postgresql') ?? false) return true;
    const listen = probeOutput.getSection('LISTEN');
    return listen !== undefined && (listen.includes(':5432') || listen.includes('5432'));
  },

  quickMetrics(): [] {
    return [];
  }
};
