// Loading and talking to IronRDP's web client, kept apart from RdpView.svelte so the
// error handling is unit-testable. The RDP backend is ~6 MB of inlined WebAssembly:
// it's only fetched the first time a remote desktop is opened in the app.

import type { UserInteraction } from '@devolutions/iron-remote-desktop';

export type IronUserInteraction = UserInteraction;

type IronRdpModule = typeof import('@devolutions/iron-remote-desktop-rdp');

let loading: Promise<IronRdpModule> | undefined;

/** Registers `<iron-remote-desktop>` and loads + initialises the RDP backend, once. */
export function loadIronRdp(): Promise<IronRdpModule> {
  loading ??= (async () => {
    await import('@devolutions/iron-remote-desktop');
    const rdp = await import('@devolutions/iron-remote-desktop-rdp');
    await rdp.init('WARN');
    return rdp;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

/** IronRDP's error kinds (`IronErrorKind`), which a failed connect rejects with. */
const enum Kind {
  General = 0,
  WrongPassword = 1,
  LogonFailure = 2,
  AccessDenied = 3,
  RDCleanPath = 4,
  ProxyConnect = 5,
  NegotiationFailure = 6
}

function ironKind(err: unknown): Kind | undefined {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (typeof kind !== 'function') return undefined;
  try {
    return (kind as () => Kind).call(err);
  } catch {
    return undefined;
  }
}

/**
 * What to tell the user about a failed connection. `gatewayFailure` is the main
 * process's own account of the handshake (unreachable server, changed certificate…),
 * which the web client only sees as an error code — it wins when there is one.
 */
export function explainRdpError(err: unknown, gatewayFailure?: string): string {
  if (gatewayFailure) return gatewayFailure.charAt(0).toUpperCase() + gatewayFailure.slice(1) + '.';
  switch (ironKind(err)) {
    case Kind.WrongPassword:
    case Kind.LogonFailure:
      return 'The username or password was not accepted.';
    case Kind.AccessDenied:
      return 'The server refused this user (not allowed to sign in remotely?).';
    case Kind.NegotiationFailure:
      return "The server asked for something the built-in viewer can't do. Try opening it in the Remote Desktop app.";
    case Kind.ProxyConnect:
    case Kind.RDCleanPath:
      return 'Could not reach the server.';
    default: {
      const backtrace = (err as { backtrace?: () => string } | null)?.backtrace;
      if (typeof backtrace === 'function') {
        try {
          return backtrace.call(err).split('\n')[0] || 'The connection failed.';
        } catch {
          // fall through
        }
      }
      return err instanceof Error ? err.message : 'The connection failed.';
    }
  }
}
