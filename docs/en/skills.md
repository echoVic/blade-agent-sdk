# Skills

Skills are reusable instruction packages stored in a directory with a `SKILL.md` file and optional assets.

## Project layout

When a Session has a filesystem `cwd`, project Skills are discovered under:

```text
<cwd>/skills/
  deploy/
    SKILL.md
    scripts/
      deploy.sh
    references/
    templates/
```

The public `SessionOptions` API does not currently expose user-level directories or additional Skill sources. Applications that need those sources must integrate discovery explicitly.

::: warning Multiple workspaces
The Skill registry is currently process-global and caches its first
initialization. Do not assume separate Skill directories for Sessions with
different `cwd` values in one process; use process isolation when that boundary
is required.
:::

## SKILL.md

```markdown
---
name: deploy-staging
description: Deploy the current application to staging
allowed-tools: [Bash, Read, Glob]
disallowed-tools: [Write]
user-invocable: true
argument-hint: "<environment>"
model: inherit
scope: turn
when_to_use: "Use when a user requests a staging deployment"
---

# Deploy to Staging

1. Run tests: !`npm test`
2. Build: !`npm run build`
3. Deploy: !`./scripts/deploy.sh staging`
```

## Frontmatter

| Field | Type | Meaning |
|-------|------|---------|
| `name` | `string` | Required kebab-case identifier, at most 64 characters |
| `description` | `string` | Required activation description, at most 1024 characters |
| `allowed-tools` | `string[]` | Tool allowlist while active |
| `disallowed-tools` | `string[]` | Tool deny list while active |
| `version` | `string` | Skill version |
| `argument-hint` | `string` | UI hint for arguments |
| `user-invocable` | `boolean` | Discovery metadata for application-driven invocation |
| `disable-model-invocation` | `boolean` | Hide from model-driven discovery |
| `model` | `string` | Model override or `inherit` |
| `effort` | `number` | Model effort override |
| `scope` | `turn \| session` | Runtime effect lifetime; defaults to `session` |
| `paths` | `string \| string[]` | Path activation conditions |
| `shell` | `boolean \| string[] \| object` | Inline shell policy |
| `hooks` | `object[]` | Runtime hooks registered on activation |
| `when_to_use` | `string` | Additional activation guidance |
| `license` | `string` | License metadata |
| `compatibility` | `string` | Runtime prerequisites |
| `metadata` | `JsonObject` | Application metadata |

`tags` is not a supported top-level field.

## Runtime effects

Activating a Skill can:

- limit or deny tools;
- override the model and effort;
- register runtime hooks;
- contribute runtime context.

The default scope is `session`, so effects remain active until the Session ends. Set `scope: turn` to clean them up at the end of the current turn.

## Inline commands

The inline form `` !`command` `` marks shell work embedded in the instructions. Whether it may execute depends on the Skill source policy, tool permissions, and runtime environment.

## Asset directories

The loader discovers:

- `scripts/`
- `references/`
- `templates/`

The Skill receives an asset manifest so its instructions can refer to these files without embedding them in `SKILL.md`.

## Activation

1. Session discovers project Skill metadata.
2. The built-in `Skill` tool exposes eligible entries to the model.
3. Full instructions are loaded only when selected.
4. Runtime effects are applied at the declared scope.
5. The Agent follows the instructions and uses allowed assets.

`user-invocable` is metadata for a host application. The SDK does not implement slash-command routing such as `/deploy-staging`; a CLI or UI must map that input to Skill activation.

## User-only metadata

```markdown
---
name: setup-env
description: Initialize the local development environment
user-invocable: true
disable-model-invocation: true
scope: turn
---

# Initialize

!`npm install`
!`cp .env.example .env`
!`npm run db:migrate`
```

This hides the Skill from model invocation while allowing a host application to present it to users.

## Security

Skills are executable instructions, not passive documentation. Treat their source as code:

- review `SKILL.md` and scripts before enabling them;
- restrict tools with `allowed-tools` and `disallowed-tools`;
- use `scope: turn` unless a persistent runtime change is intended;
- apply permission and sandbox controls to inline commands;
- do not assume metadata alone enforces a host-application policy.
