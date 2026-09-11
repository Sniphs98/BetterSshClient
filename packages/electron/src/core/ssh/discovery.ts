import type { CoreEvent } from '../../event.js';
import { generateQuickScanScript, ProbeOutput } from './probe.js';
import { detectServicesWithMetrics } from './services/registry.js';
import type { SshSession } from './session.js';

/**
 * Service discovery orchestrator ("Quick Scan"). Ported from
 * crates/omnyssh-core/src/ssh/discovery.rs.
 *
 * Runs once per connection (called from pool.ts, without blocking the
 * metrics loop): executes the probe script (a single SSH command), detects
 * services from its output, and reports both a partial OS-info metrics
 * patch and the detected-services event. Fast (~2-3s).
 */
export async function quickScan(session: SshSession, hostName: string, emit: (event: CoreEvent) => void): Promise<void> {
  const output = await session.runCommand(generateQuickScanScript());
  const probeOutput = ProbeOutput.parse(output);

  const services = detectServicesWithMetrics(probeOutput);

  // A partial metrics patch with just OS info; the renderer's merge logic
  // (mergeMetrics in stores/metrics.ts) preserves the other fields.
  const osInfo = probeOutput.parseOsInfo();
  if (osInfo !== undefined) {
    emit({ type: 'metricsUpdate', hostName, metrics: { osInfo, lastUpdated: Date.now() } });
  }

  emit({ type: 'discoveryQuickScanDone', hostName, services });
}
