/**
 * DTOs crossing the IPC boundary. Ported from crates/omnyssh-gui/src/dto.rs.
 * Secret fields (`password`, key material) never appear on an outbound DTO.
 */

import type { Host, HostSource, MonitorMode } from './core/ssh/client.js';
import { normalizeMonitorMode } from './core/ssh/client.js';
import type { Snippet } from './core/config/snippets.js';
import type { Automation, AutomationKind, Flow, FlowParam, FlowParamKind, NodeResult, NodeStatus } from './core/automation/types.js';
import type { ConnectionStatus, Metrics } from './event.js';
import type { ProcessInfo } from './core/ssh/metrics.js';
import type { DetectedService, ServiceKind, ServiceMetric } from './core/ssh/services/types.js';

export type HostSourceDto = 'sshConfig' | 'manual';
export type MonitorModeDto = 'ssh' | 'tcpPort';

export interface HostDto {
  name: string;
  hostname: string;
  user: string;
  port: number;
  tags: string[];
  notes?: string;
  source: HostSourceDto;
  hasKey: boolean;
  passwordAuthDisabled?: boolean;
  monitoring: MonitorModeDto;
  monitorPort?: number;
  defaultPath?: string;
}

/** Inbound host form payload for `save_host`. Always builds a manual `Host`:
 *  editing an SSH-config import saves a copy that shadows it. `password`/
 *  `identityFile` arrive here but never travel back out on `HostDto`. */
export interface HostInputDto {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  password?: string;
  proxyJump?: string;
  tags: string[];
  notes?: string;
  monitoring?: MonitorModeDto;
  monitorPort?: number;
  defaultPath?: string;
}

function sourceToDto(source: HostSource): HostSourceDto {
  return source === 'ssh_config' ? 'sshConfig' : 'manual';
}

function sourceFromDto(source: HostSourceDto): HostSource {
  return source === 'sshConfig' ? 'ssh_config' : 'manual';
}

export function monitorModeToDto(mode: MonitorMode): MonitorModeDto {
  return mode === 'tcp_port' ? 'tcpPort' : 'ssh';
}

export function monitorModeFromDto(mode: MonitorModeDto): MonitorMode {
  return normalizeMonitorMode(mode === 'tcpPort' ? 'tcp_port' : 'ssh');
}

/** Maps a full `Host` (secrets included) to the DTO the frontend sees. */
export function hostToDto(host: Host): HostDto {
  return {
    name: host.name,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    tags: host.tags,
    notes: host.notes,
    source: sourceToDto(host.source),
    hasKey: host.identityFile !== undefined,
    passwordAuthDisabled: host.passwordAuthDisabled,
    monitoring: monitorModeToDto(host.monitoring),
    monitorPort: host.monitorPort,
    defaultPath: host.defaultPath
  };
}

/** Builds a brand-new manual `Host` from an inbound form payload (no prior
 *  record to preserve fields from — see `upsertHost` in ipc/hosts.ts for the
 *  edit-in-place path, which layers this over the existing record). */
export function hostFromInputDto(input: HostInputDto): Host {
  return {
    name: input.name,
    hostname: input.hostname,
    user: input.user,
    port: input.port,
    identityFile: input.identityFile,
    password: input.password,
    proxyJump: input.proxyJump,
    tags: input.tags,
    notes: input.notes,
    source: 'manual',
    monitoring: input.monitoring !== undefined ? monitorModeFromDto(input.monitoring) : 'ssh',
    monitorPort: input.monitorPort,
    defaultPath: input.defaultPath
  };
}

export type SnippetScopeDto = 'global' | 'host';

export interface SnippetDto {
  name: string;
  command: string;
  scope: SnippetScopeDto;
  host?: string;
  tags?: string[];
  params?: string[];
}

export function snippetToDto(snippet: Snippet): SnippetDto {
  return snippet;
}

export function snippetFromDto(dto: SnippetDto): Snippet {
  return dto;
}

export type AutomationKindDto = AutomationKind;

export interface AutomationDto {
  id: string;
  name: string;
  kind: AutomationKindDto;
  command: string;
  timeoutSecs: number;
}

export function automationToDto(automation: Automation): AutomationDto {
  return automation;
}

export function automationFromDto(dto: AutomationDto): Automation {
  return dto;
}

export interface FlowNodeDto {
  id: string;
  automationId: string;
  label: string;
  continueOnError: boolean;
  position?: { x: number; y: number };
}

export interface FlowEdgeDto {
  from: string;
  to: string;
}

export type FlowParamKindDto = FlowParamKind;

export interface FlowParamDto {
  name: string;
  kind: FlowParamKindDto;
  label?: string;
  default?: string;
}

export function flowParamToDto(param: FlowParam): FlowParamDto {
  return param;
}

export function flowParamFromDto(dto: FlowParamDto): FlowParam {
  return dto;
}

export interface FlowDto {
  name: string;
  params: FlowParamDto[];
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
}

export function flowToDto(flow: Flow): FlowDto {
  return flow;
}

export function flowFromDto(dto: FlowDto): Flow {
  return dto;
}

export type NodeStatusDto = NodeStatus;

export interface NodeResultDto {
  nodeId: string;
  label: string;
  status: NodeStatusDto;
  output: string;
  error?: string;
  durationMs: number;
}

export function nodeResultToDto(result: NodeResult): NodeResultDto {
  return result;
}

export interface CommandError {
  message: string;
}

export function toCommandError(err: unknown): CommandError {
  return { message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Connection status / metrics / services (Phase 2)
// ---------------------------------------------------------------------------

export type ConnectionStatusDto = { kind: 'unknown' } | { kind: 'connecting' } | { kind: 'connected' } | { kind: 'failed'; message: string };

export function connectionStatusToDto(status: ConnectionStatus): ConnectionStatusDto {
  return status;
}

export interface ProcessDto {
  name: string;
  cpuPercent: number;
  memPercent: number;
}

function processToDto(p: ProcessInfo): ProcessDto {
  return { name: p.name, cpuPercent: p.cpuPercent, memPercent: p.memPercent };
}

export interface MetricsDto {
  cpuPercent?: number;
  ramPercent?: number;
  diskPercent?: number;
  uptime?: string;
  loadAvg?: string;
  osInfo?: string;
  topProcesses: ProcessDto[];
  ageSeconds: number;
}

/** Flattens `Metrics.lastUpdated` (an epoch-ms timestamp) to `ageSeconds`,
 *  mirroring the Rust DTO's `Instant.elapsed()` flattening at emit time. */
export function metricsToDto(metrics: Metrics): MetricsDto {
  return {
    cpuPercent: metrics.cpuPercent,
    ramPercent: metrics.ramPercent,
    diskPercent: metrics.diskPercent,
    uptime: metrics.uptime,
    loadAvg: metrics.loadAvg,
    osInfo: metrics.osInfo,
    topProcesses: (metrics.topProcesses ?? []).map(processToDto),
    ageSeconds: Math.max(0, Math.round((Date.now() - metrics.lastUpdated) / 1000))
  };
}

export type ServiceKindDto = ServiceKind;

export interface ServiceMetricDto {
  name: string;
  value: number;
}

function serviceMetricToDto(m: ServiceMetric): ServiceMetricDto {
  return m;
}

export interface ServiceDto {
  kind: ServiceKindDto;
  metrics: ServiceMetricDto[];
}

export function serviceToDto(service: DetectedService): ServiceDto {
  return { kind: service.kind, metrics: service.metrics.map(serviceMetricToDto) };
}
