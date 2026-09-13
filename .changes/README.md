# Changelog Fragments

Every releasable pull request must add one or more JSON files to this directory.
The release workflow consumes the files, updates both changelogs, and deletes the
fragments in the generated release commit.

```json
{
  "type": "feature",
  "en": "Add interruptible and steerable session inputs.",
  "zh-CN": "新增可中断、可转向的 Session 输入控制面。"
}
```

Allowed `type` values:

- `breaking` → major
- `feature` → minor
- `fix` / `performance` / `refactor` / `docs` → patch

Use a unique kebab-case filename. Both language fields are required and must
describe user-visible behavior rather than commit mechanics. The fragment type
picks the changelog section only.

The released version comes from the tag: pushing `v<major>.<minor>.<patch>`
publishes exactly that version, and the release commit on `main` consumes every
fragment in this directory. Pushing to `main` alone releases nothing.
