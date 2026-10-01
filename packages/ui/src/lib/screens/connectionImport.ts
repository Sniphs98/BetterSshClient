// The import dialog's state for SSH-host and RDP-profile files: an overwrite-or-rename
// choice per entry whose name is taken. Pure, so it's tested without the DOM; the main
// process checks the final names against what's on disk again (connectionBundles.ts).
import type {
  ConnectionImportActionDto,
  ConnectionImportEntryDto,
  ConnectionImportResultDto
} from '$lib/bindings';

export type ImportChoice = { action: 'overwrite' | 'rename'; name: string };
export type ImportChoices = Record<string, ImportChoice>;

/** A choice for every conflicting entry: its default action, and the free name the
 *  main process suggested for a rename. */
export function initialChoices(entries: ConnectionImportEntryDto[]): ImportChoices {
  const out: ImportChoices = {};
  for (const e of entries) {
    if (e.conflict) out[e.key] = { action: e.defaultAction, name: e.suggestedName };
  }
  return out;
}

/** Sets every choice to `action` ("for all"), keeping the typed rename names. */
export function chooseAll(choices: ImportChoices, action: ImportChoice['action']): ImportChoices {
  return Object.fromEntries(Object.entries(choices).map(([key, c]) => [key, { ...c, action }]));
}

/** What's wrong with the renames, or `null`: each needs a name, and no two entries of
 *  the file may end up under the same one. `entries` are of one kind (hosts or
 *  profiles); `what` names that kind in the message. */
export function choicesProblem(entries: ConnectionImportEntryDto[], choices: ImportChoices, what: string): string | null {
  const finalNames = new Map<string, string>();
  for (const e of entries) {
    const c = choices[e.key];
    const name = c?.action === 'rename' ? c.name.trim() : e.name;
    if (name === '') return `Enter a new name for the ${what} “${e.name}”.`;
    if (c?.action === 'rename' && name === e.name) return `Pick a different name for the ${what} “${e.name}”, or overwrite it.`;
    const other = finalNames.get(name);
    // Profiles may share a name; hosts may not.
    if (other !== undefined && what === 'host') return `Two hosts would be called “${name}”.`;
    finalNames.set(name, e.name);
  }
  return null;
}

/** The decisions `apply_connection_import` takes for one kind of entry. */
export function toDecisions(choices: ImportChoices): Record<string, ConnectionImportActionDto> {
  return Object.fromEntries(
    Object.entries(choices).map(([key, c]) => [
      key,
      c.action === 'overwrite' ? { action: 'overwrite' } : { action: 'rename', name: c.name.trim() }
    ])
  );
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Imported 2 profiles and 1 SSH host." */
export function importSummary(result: ConnectionImportResultDto): string {
  const parts: string[] = [];
  if (result.profiles > 0) parts.push(count(result.profiles, 'profile', 'profiles'));
  if (result.hosts > 0) parts.push(count(result.hosts, 'SSH host', 'SSH hosts'));
  return parts.length === 0 ? 'Nothing to import.' : `Imported ${parts.join(' and ')}.`;
}

/** The notes shown under an entry: what the user still has to do for it. */
export function entryNotes(entry: ConnectionImportEntryDto): string[] {
  const notes: string[] = [];
  if (entry.onePassword) notes.push('1Password');
  if (entry.passwordOmitted) notes.push('enter the password after importing');
  if (entry.keyOmitted && !entry.onePassword && !entry.passwordOmitted) {
    notes.push('signs in with your SSH agent or ~/.ssh key');
  }
  if (entry.usedBy.length > 0) notes.push(`used by ${entry.usedBy.join(', ')}`);
  return notes;
}
