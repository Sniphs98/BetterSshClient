<!--
The PR title becomes the release note when this is squash-merged, and decides the
version bump (see CONTRIBUTING.md → Releases). Use a Conventional Commit:
  feat(scope): …   → minor release      fix(scope): … / perf: … → patch release
  docs/test/chore/refactor/ci: …       → no release
  feat!: … or a "BREAKING CHANGE:" footer → major release
-->

## What and why

<!-- The problem, and how this solves it. Link the issue if there is one: "Closes #123". -->

## How it was tested

<!-- What you ran or clicked through. New behaviour should come with a test. -->

## Checklist

- [ ] PR title is a Conventional Commit (it decides the release)
- [ ] `npm run check` and `npm test` pass
- [ ] Tests added or updated for the change
- [ ] README updated if the change is user-visible
