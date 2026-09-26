import { describe, expect, it } from 'vitest';

import { folderNames, groupCards } from './dashboardSections';

const card = (name: string, folder?: string) => ({ host: { name, folder } });

describe('groupCards', () => {
  it('puts each folder in its own section, alphabetically, and the rest last', () => {
    const sections = groupCards([card('web-1', 'Kunde A'), card('test'), card('nas', 'homelab'), card('db-1', 'Kunde A')]);
    expect(sections.map((s) => [s.title, s.folder, s.cards.map((c) => c.host.name)])).toEqual([
      ['homelab', 'homelab', ['nas']],
      ['Kunde A', 'Kunde A', ['web-1', 'db-1']],
      ['Other hosts', '', ['test']]
    ]);
  });

  it('calls the one section "Hosts" when there are no folders, and leaves out empty ones', () => {
    expect(groupCards([card('a'), card('b', '  ')]).map((s) => [s.key, s.title])).toEqual([['hosts', 'Hosts']]);
    expect(groupCards([card('nas', 'homelab')]).map((s) => s.key)).toEqual(['folder:homelab']);
    expect(groupCards([])).toEqual([]);
  });
});

describe('folderNames', () => {
  it('lists each folder in use once, sorted without regard to case', () => {
    expect(folderNames([{ folder: 'b' }, { folder: 'A' }, { folder: 'b' }, {}, { folder: null }])).toEqual(['A', 'b']);
  });
});
