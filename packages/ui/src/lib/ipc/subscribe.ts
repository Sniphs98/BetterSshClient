// Single bootstrap subscribing every backend event into the stores
// (tech-gui.md §3.5). Returns a disposer that drops all listeners; if any
// listen fails, already-registered listeners are disposed so none leak.

import { events } from '$lib/bindings';

type UnlistenFn = () => void;
import {
  applyAutomationCompleted,
  applyAutomationFailed,
  applyAutomationStarted,
  applyAutomationNodeResult,
  applyAutomationNodeStarted,
  applyError,
  applyFilePreview,
  applyHostStatusChanged,
  applyHostsLoaded,
  applyKeySetupComplete,
  applyKeySetupFailed,
  applyKeySetupProgress,
  applyKeySetupRollback,
  applyMetricsUpdated,
  applyServicesDetected,
  applyServicesFailed,
  applyUpdateAvailable,
  applySftpConnected,
  applySftpDirListed,
  applySftpDisconnected,
  applySftpOpDone,
  applyTerminalExited,
  applyTransferProgress
} from './router';

export async function startEventBridge(): Promise<() => void> {
  const offs: UnlistenFn[] = [];
  try {
    offs.push(await events.hostsLoaded.listen((e) => applyHostsLoaded(e.payload)));
    offs.push(await events.hostStatusChanged.listen((e) => applyHostStatusChanged(e.payload)));
    offs.push(await events.metricsUpdated.listen((e) => applyMetricsUpdated(e.payload)));
    offs.push(await events.servicesDetected.listen((e) => applyServicesDetected(e.payload)));
    offs.push(await events.servicesFailed.listen((e) => applyServicesFailed(e.payload)));
    offs.push(await events.terminalExited.listen((e) => applyTerminalExited(e.payload.sessionId)));
    offs.push(await events.sftpConnected.listen((e) => applySftpConnected(e.payload)));
    offs.push(await events.sftpDirListed.listen((e) => applySftpDirListed(e.payload)));
    offs.push(await events.sftpOpDone.listen((e) => applySftpOpDone(e.payload)));
    offs.push(await events.sftpDisconnected.listen((e) => applySftpDisconnected(e.payload)));
    offs.push(await events.filePreview.listen((e) => applyFilePreview(e.payload)));
    offs.push(await events.transferProgress.listen((e) => applyTransferProgress(e.payload)));
    offs.push(await events.keySetupProgress.listen((e) => applyKeySetupProgress(e.payload)));
    offs.push(await events.keySetupComplete.listen((e) => applyKeySetupComplete(e.payload)));
    offs.push(await events.keySetupFailed.listen((e) => applyKeySetupFailed(e.payload)));
    offs.push(await events.keySetupRollback.listen((e) => applyKeySetupRollback(e.payload)));
    offs.push(await events.updateAvailable.listen((e) => applyUpdateAvailable(e.payload)));
    offs.push(await events.automationStarted.listen((e) => applyAutomationStarted(e.payload)));
    offs.push(await events.automationNodeStarted.listen((e) => applyAutomationNodeStarted(e.payload)));
    offs.push(await events.automationNodeResult.listen((e) => applyAutomationNodeResult(e.payload)));
    offs.push(await events.automationCompleted.listen((e) => applyAutomationCompleted(e.payload)));
    offs.push(await events.automationFailed.listen((e) => applyAutomationFailed(e.payload)));
    offs.push(await events.error.listen((e) => applyError(e.payload.message)));
  } catch (err) {
    offs.forEach((off) => off());
    throw err;
  }
  return () => offs.forEach((off) => off());
}
