import { describe, expect, it } from 'vitest';

import type { ConnectionImportEntryDto } from '$lib/bindings';
import { chooseAll, choicesProblem, entryNotes, importSummary, initialChoices, toDecisions } from './connectionImport';

function entry(name: string, overrides: Partial<ConnectionImportEntryDto> = {}): ConnectionImportEntryDto {
  return {
    key: name,
    name,
    detail: `root@${name}:22`,
    conflict: false,
    suggestedName: name,
    defaultAction: 'rename',
    onePassword: false,
    references: [],
    passwordOmitted: false,
    keyOmitted: false,
    usedBy: [],
    ...overrides
  };
}

describe('initialChoices', () => {
  it('has a choice for each conflict only, preset to the suggestion', () => {
    const choices = initialChoices([
      entry('web', { conflict: true, suggestedName: 'web (2)' }),
      entry('db'),
      entry('bastion', { conflict: true, suggestedName: 'bastion (2)', defaultAction: 'overwrite' })
    ]);
    expect(choices).toEqual({
      web: { action: 'rename', name: 'web (2)' },
      bastion: { action: 'overwrite', name: 'bastion (2)' }
    });
  });
});

describe('chooseAll', () => {
  it('switches every choice and keeps the typed names', () => {
    const out = chooseAll({ a: { action: 'rename', name: 'x' }, b: { action: 'overwrite', name: 'y' } }, 'overwrite');
    expect(out).toEqual({ a: { action: 'overwrite', name: 'x' }, b: { action: 'overwrite', name: 'y' } });
  });
});

describe('choicesProblem', () => {
  const entries = [entry('web', { conflict: true }), entry('db')];

  it('accepts sensible choices', () => {
    expect(choicesProblem(entries, { web: { action: 'rename', name: 'web 2' } }, 'host')).toBeNull();
    expect(choicesProblem(entries, { web: { action: 'overwrite', name: '' } }, 'host')).toBeNull();
  });

  it('needs a new, different and unused name for a rename', () => {
    expect(choicesProblem(entries, { web: { action: 'rename', name: ' ' } }, 'host')).toMatch(/Enter a new name/);
    expect(choicesProblem(entries, { web: { action: 'rename', name: 'web' } }, 'host')).toMatch(/different name/);
    expect(choicesProblem(entries, { web: { action: 'rename', name: 'db' } }, 'host')).toMatch(/Two hosts/);
  });

  it('lets profiles share a name', () => {
    expect(choicesProblem(entries, { web: { action: 'rename', name: 'db' } }, 'profile')).toBeNull();
  });
});

describe('toDecisions', () => {
  it('sends the trimmed name only for a rename', () => {
    expect(toDecisions({ a: { action: 'overwrite', name: 'x' }, b: { action: 'rename', name: ' y ' } })).toEqual({
      a: { action: 'overwrite' },
      b: { action: 'rename', name: 'y' }
    });
  });
});

describe('importSummary', () => {
  it('counts what came in', () => {
    expect(importSummary({ hosts: 1, profiles: 2 })).toBe('Imported 2 profiles and 1 SSH host.');
    expect(importSummary({ hosts: 3, profiles: 0 })).toBe('Imported 3 SSH hosts.');
  });
});

describe('entryNotes', () => {
  it('says what is left to do', () => {
    expect(entryNotes(entry('a', { onePassword: true, usedBy: ['web'] }))).toEqual(['1Password', 'used by web']);
    expect(entryNotes(entry('a', { passwordOmitted: true }))).toEqual(['enter the password after importing']);
    expect(entryNotes(entry('a', { keyOmitted: true }))).toEqual(['signs in with your SSH agent or ~/.ssh key']);
  });
});
