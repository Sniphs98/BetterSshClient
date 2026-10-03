import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The steps of opening an SSH connection, reported as they're reached so a terminal
 * tab can show where a slow or failing connection is (see TerminalView's connecting
 * screen): reading 1Password, each jump host, reaching the server, checking its host
 * key, signing in, and opening the shell.
 *
 * Carried in an AsyncLocalStorage rather than as a parameter through every function on
 * the way (the shared-connection pool, the jump chain, `authenticate`): whoever starts
 * the connection wraps it in `withConnectProgress`, everything below reports with
 * `reportConnectStage`. Without a listener, reporting does nothing.
 */
export type SshConnectStage =
  | { stage: 'onePassword' }
  | { stage: 'jump'; host: string }
  | { stage: 'reach' }
  | { stage: 'hostKey' }
  | { stage: 'signIn' }
  | { stage: 'shell' };

type Reporter = (stage: SshConnectStage) => void;

const current = new AsyncLocalStorage<Reporter>();

/** Runs `work` with `report` hearing every step it reaches. */
export function withConnectProgress<T>(report: Reporter, work: () => Promise<T>): Promise<T> {
  return current.run(report, work);
}

/** Reports a step to whoever is listening, if anyone. */
export function reportConnectStage(stage: SshConnectStage): void {
  current.getStore()?.(stage);
}

/** The listener right now — for callbacks that run outside this call's async context
 *  (ssh2's host-key check runs from socket events), captured before they're set up. */
export function connectReporter(): Reporter {
  const report = current.getStore();
  return report ?? (() => {});
}

/** Runs `work` without reporting — for a jump host's own connection, whose reaching,
 *  host key and sign-in aren't the target's steps (its `jump` step covers it). */
export function withoutConnectProgress<T>(work: () => Promise<T>): Promise<T> {
  return current.run(() => {}, work);
}
