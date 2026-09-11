import type { ProbeOutput } from '../probe.js';

/** Only 5 core services are supported. Ported from
 *  crates/omnyssh-core/src/event.rs's `ServiceKind`. */
export type ServiceKind = 'docker' | 'nginx' | 'postgresql' | 'redis' | 'nodejs';

/** A metric collected from a specific service. `MetricValue` is
 *  integer-only in the Rust source, so this is a plain `number`. */
export interface ServiceMetric {
  name: string;
  value: number;
}

export interface DetectedService {
  kind: ServiceKind;
  metrics: ServiceMetric[];
}

export function metricInt(name: string, value: number): ServiceMetric {
  return { name, value };
}

/** Service-specific detection from probe output. Ported from
 *  crates/omnyssh-core/src/ssh/services/mod.rs's `ServiceProvider` trait. */
export interface ServiceProvider {
  kind: ServiceKind;
  /** Quick check: is this service present, from the already-fetched probe
   *  output? Called during Quick Scan — no extra SSH round trip. */
  detect(probeOutput: ProbeOutput): boolean;
  /** Extracts basic metrics from the same probe output. Empty by default. */
  quickMetrics(probeOutput: ProbeOutput): ServiceMetric[];
}
