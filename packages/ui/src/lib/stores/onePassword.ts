import type { OnePasswordStatusDto } from '$lib/bindings';

// Whether the 1Password CLI is installed, as last checked — so reopening a host or
// remote desktop form doesn't run `op --version` every time. Only an "installed"
// answer is kept: after installing, the next form checks again by itself.
let installed: OnePasswordStatusDto | null = null;

export function cachedOnePasswordStatus(): OnePasswordStatusDto | null {
  return installed;
}

export function rememberOnePasswordStatus(status: OnePasswordStatusDto): void {
  installed = status.installed ? status : null;
}
