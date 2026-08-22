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
describe user-visible behavior rather than commit mechanics. The highest
fragment type determines the semantic-release version.
