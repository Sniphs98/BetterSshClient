// Run with: node --test "scripts/*.test.mjs"
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bumpFor, bumpVersion, decide, parseCommit, releaseNotes } from './next-version.mjs';

describe('parseCommit', () => {
  it('reads type, scope and summary', () => {
    assert.deepEqual(parseCommit('feat(sftp): drag and drop'), {
      type: 'feat',
      scope: 'sftp',
      breaking: false,
      summary: 'drag and drop'
    });
  });

  it('spots a breaking change by `!` or by footer', () => {
    assert.equal(parseCommit('feat!: new config format').breaking, true);
    assert.equal(parseCommit('fix(ssh): x\n\nBREAKING CHANGE: hosts.toml moved').breaking, true);
  });

  it('is not fooled by merge commits or free text', () => {
    assert.equal(parseCommit('Merge pull request #1 from Sniphs98/feat/x'), undefined);
    assert.equal(parseCommit('add icons'), undefined);
  });
});

describe('bumpFor', () => {
  it('takes the largest bump any commit calls for', () => {
    assert.equal(bumpFor(['fix: a', 'perf: b']), 'patch');
    assert.equal(bumpFor(['fix: a', 'feat: b']), 'minor');
    assert.equal(bumpFor(['feat: a', 'refactor!: b']), 'major');
  });

  it('releases nothing for docs, tests, chores and merges', () => {
    assert.equal(bumpFor(['docs: readme', 'test: more', 'chore(deps): bump', 'ci: x', 'Merge branch main']), undefined);
  });
});

describe('bumpVersion', () => {
  it('resets the lower parts', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  });
});

describe('decide', () => {
  it('bumps from the last release tag', () => {
    assert.deepEqual(decide({ lastTag: 'v1.1.2', packageVersion: '1.1.2', messages: ['feat: x'] }), {
      release: true,
      version: '1.2.0',
      bump: 'minor'
    });
  });

  it('ignores a package.json version that is behind the tag (only CI bumps it)', () => {
    assert.equal(decide({ lastTag: 'v1.4.0', packageVersion: '1.1.2', messages: ['fix: x'] }).version, '1.4.1');
  });

  it('does not release when nothing user-facing changed', () => {
    assert.deepEqual(decide({ lastTag: 'v1.1.2', packageVersion: '1.1.2', messages: ['docs: x'] }), {
      release: false,
      version: '1.1.2'
    });
  });

  it('lets a version set by hand ahead of the last tag win', () => {
    assert.deepEqual(decide({ lastTag: 'v1.1.2', packageVersion: '2.0.0', messages: ['docs: x'] }), {
      release: true,
      version: '2.0.0',
      bump: 'manual'
    });
  });

  it('releases the package.json version as-is when there is no tag yet', () => {
    assert.equal(decide({ lastTag: undefined, packageVersion: '0.1.0', messages: ['feat: x'] }).version, '0.1.0');
    assert.equal(decide({ lastTag: undefined, packageVersion: '0.1.0', messages: ['chore: x'] }).release, false);
  });
});

describe('releaseNotes', () => {
  it('groups user-facing commits and drops the rest', () => {
    const notes = releaseNotes(['feat(sftp): parallel batches', 'fix: crash', 'docs: readme', 'perf: faster', 'feat!: new format'], {
      previousTag: 'v1.1.2',
      version: '2.0.0',
      repo: 'o/r'
    });
    assert.match(notes, /### ⚠️ Breaking changes\n\n- new format/);
    assert.match(notes, /### Features\n\n- \*\*sftp:\*\* parallel batches/);
    assert.match(notes, /### Bug fixes\n\n- crash/);
    assert.match(notes, /### Performance\n\n- faster/);
    assert.doesNotMatch(notes, /readme/);
    assert.match(notes, /compare\/v1\.1\.2\.\.\.v2\.0\.0/);
  });
});
