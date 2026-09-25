import { writable } from 'svelte/store';
import type { PluginCommandDto, PluginShowText } from '$lib/bindings';

// The commands running plugins added to the command palette — replaced wholesale on
// every `plugin-commands-changed` event, and seeded once at startup (a plugin can
// register before the event bridge is listening).
export const pluginCommands = writable<PluginCommandDto[]>([]);

// Text a plugin asked to show (`bssh.ui.showText`), or null once dismissed.
export const pluginText = writable<PluginShowText | null>(null);
