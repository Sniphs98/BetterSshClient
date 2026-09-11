import type { ProbeOutput } from '../probe.js';
import { dockerProvider } from './docker.js';
import { nginxProvider } from './nginx.js';
import { nodejsProvider } from './nodejs.js';
import { postgresqlProvider } from './postgresql.js';
import { redisProvider } from './redis.js';
import type { DetectedService, ServiceKind, ServiceProvider } from './types.js';

/** Service registry. Ported from
 *  crates/omnyssh-core/src/ssh/services/mod.rs's `ServiceRegistry`. Only
 *  these 5 core services are supported. */
const PROVIDERS: ServiceProvider[] = [dockerProvider, nginxProvider, postgresqlProvider, redisProvider, nodejsProvider];

export function detectServices(probeOutput: ProbeOutput): ServiceKind[] {
  return PROVIDERS.filter((p) => p.detect(probeOutput)).map((p) => p.kind);
}

export function getProvider(kind: ServiceKind): ServiceProvider | undefined {
  return PROVIDERS.find((p) => p.kind === kind);
}

/** The detected services plus their quick-scan metrics, in registry order. */
export function detectServicesWithMetrics(probeOutput: ProbeOutput): DetectedService[] {
  return PROVIDERS.filter((p) => p.detect(probeOutput)).map((p) => ({ kind: p.kind, metrics: p.quickMetrics(probeOutput) }));
}
