import { writable } from 'svelte/store';
import type { RemoteDesktopConnectionDto } from '$lib/bindings';

// Saved RDP/VNC connection profiles, mirroring `remote-desktop.toml` (mirrors
// `stores/snippets.ts`'s shape). Refreshed from `list_remote_desktop_connections`
// after every mutation so it never drifts from the on-disk source of truth.
export const remoteDesktopConnections = writable<RemoteDesktopConnectionDto[]>([]);
