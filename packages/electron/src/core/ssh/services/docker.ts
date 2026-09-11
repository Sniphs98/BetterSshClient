import type { ProbeOutput } from '../probe.js';
import { metricInt, type ServiceMetric, type ServiceProvider } from './types.js';

/** Docker service provider. Ported from
 *  crates/omnyssh-core/src/ssh/services/docker.rs. */
export const dockerProvider: ServiceProvider = {
  kind: 'docker',

  detect(probeOutput: ProbeOutput): boolean {
    return probeOutput.hasSection('DOCKER');
  },

  /** Extracts container counts from the Quick Scan `docker ps` output
   *  (`ID\tNames\tStatus\tImage` per line) so the card shows them immediately. */
  quickMetrics(probeOutput: ProbeOutput): ServiceMetric[] {
    const dockerOutput = probeOutput.getSection('DOCKER');
    if (dockerOutput === undefined) return [];

    const lines = dockerOutput.split('\n');
    const total = lines.length;
    const running = lines.filter((line) => {
      const parts = line.split('\t');
      return parts.length >= 3 && parts[2].includes('Up');
    }).length;

    return [metricInt('containers_total', total), metricInt('containers_running', running)];
  }
};
