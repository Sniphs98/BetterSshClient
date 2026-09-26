// How the dashboard groups its host cards: one accordion section per folder (a host's
// `folder`), alphabetical, then the hosts in none. The fixed "This computer" section
// for local shells sits above all of them (Dashboard.svelte) and isn't a folder.
// Pure, so it's testable without the component.

/** The key the "no folder" section is remembered under (collapsed or not). */
export const NO_FOLDER_KEY = 'hosts';
/** The key of the fixed local-shells section. */
export const LOCAL_KEY = 'local';

export interface CardSection<C> {
  /** Stable, for remembering whether it's collapsed: `folder:<name>` or `hosts`. */
  key: string;
  title: string;
  /** The folder a card dropped here moves to; '' for "no folder". */
  folder: string;
  cards: C[];
}

function folderOf(host: { folder?: string | null }): string {
  return host.folder?.trim() ?? '';
}

/** The folders in use, sorted the way their sections are. */
export function folderNames(hosts: Array<{ folder?: string | null }>): string[] {
  const names = new Set(hosts.map(folderOf).filter(Boolean));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** `cards` in their sections, in the order shown; a section with no cards is left out.
 *  The hosts without a folder are "Hosts" when there are no folders at all, and
 *  "Other hosts" beneath them when there are. */
export function groupCards<C extends { host: { folder?: string | null } }>(cards: C[]): CardSection<C>[] {
  const folders = folderNames(cards.map((c) => c.host));
  const sections: CardSection<C>[] = folders.map((name) => ({
    key: `folder:${name}`,
    title: name,
    folder: name,
    cards: cards.filter((c) => folderOf(c.host) === name)
  }));
  const loose = cards.filter((c) => folderOf(c.host) === '');
  if (loose.length > 0) {
    sections.push({ key: NO_FOLDER_KEY, title: folders.length > 0 ? 'Other hosts' : 'Hosts', folder: '', cards: loose });
  }
  return sections;
}
