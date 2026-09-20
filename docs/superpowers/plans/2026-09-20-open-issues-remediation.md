# Open Issues Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every currently open issue in the repository (#65 through #72) with focused regression coverage and documentation updates.

**Architecture:** Keep filesystem authorization at the tool boundary, make the JSONL store lifecycle state machine explicit, preserve late web instructions as metadata through the normal scripted phase, and keep CLI process ownership in the parent. Expand existing gates to cover the shipped scripts instead of creating a second lint/type-check path.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Biome, TypeBox, JSONL persistence, browser starter JavaScript, Markdown/VitePress docs.

**Spec:** GitHub issues #65, #66, #67, #68, #69, #70, #71, and #72 in `echoVic/blade-agent-sdk`.

## Global Constraints

- Preserve the public SDK API and existing browser/server entrypoint boundaries.
- Do not weaken sandbox defaults or silently broaden an authorized filesystem root.
- Add a regression test for each behavior change before changing its implementation.
- Keep the working tree free of generated build output and dependency lockfile churn.
- Run focused tests after each task, then the full type-check, lint, and test suites.

### Task 1: Contain Bash working directories in authorized roots (#65)

**Files:**
- Modify: `src/tools/builtin/shell/bash.ts`
- Modify: `src/sandbox/SandboxExecutor.ts` only if the existing policy API needs a defensive assertion
- Test: `src/tools/builtin/shell/__tests__/bash.test.ts`

- [x] Add a test that supplies a session filesystem root and an outside `cwd`, then asserts the Bash tool returns a validation error without invoking the sandbox or shell runner.
- [x] Add a test that supplies an in-root `cwd` and asserts the resolved path is passed to execution unchanged.
- [x] Route `cwd` through the same `resolveAuthorizedFilesystemPath` helper used by file/search tools, preserving missing-path behavior and the session root error message.
- [x] Run `pnpm vitest run src/tools/builtin/shell/__tests__/bash.test.ts`.

### Task 2: Type-check and lint `scripts/` (#66)

**Files:**
- Modify: `tsconfig.json`
- Modify: `biome.json`
- Modify: any files reported by the newly expanded gates under `scripts/` and `scripts/__tests__/`

- [x] Extend the TypeScript include list to `scripts/**/*.ts` and the Biome include list to `scripts/**/*.ts` while retaining the existing source exclusions.
- [x] Run `pnpm type-check` and record every newly exposed diagnostic.
- [x] Fix each diagnostic with narrow type annotations or test helper corrections, without changing runtime behavior.
- [x] Run `pnpm lint` and resolve every script finding.

### Task 3: Harden JSONL server-store replay and lifecycle diagnostics (#67)

**Files:**
- Modify: `src/server/JsonlAgentServerStore.ts`
- Test: `src/server/__tests__/JsonlAgentServerStore.test.ts`

- [x] Add a restart test that initializes a store, appends enough entries to trigger compaction, closes it, initializes a second store, and asserts the compacted state and journal cursor are replayed.
- [x] Change journal parsing to report an explicit unknown-version error distinct from an unknown-entry-kind error.
- [x] Make `initialize()` and `close()` serialize their lifecycle transition so a close during initialization cannot publish a ready handle or leak the file descriptor.
- [x] Strengthen the corrupt-journal test to assert the original bytes remain unchanged after initialization fails.
- [x] Run `pnpm vitest run src/server/__tests__/JsonlAgentServerStore.test.ts`.

### Task 4: Verify built-in-tool opt-out at execution (#68)

**Files:**
- Modify: `src/session/__tests__/SessionBuiltinTools.test.ts`
- Modify: the smallest runtime guard file only if the new test exposes an execution leak

- [x] Drive a server-hosted Session with `builtinTools` omitted and a provider response containing a `Glob` call.
- [x] Assert the emitted tool result is an error naming the unavailable tool, and assert no filesystem search ran.
- [x] Run `pnpm vitest run src/session/__tests__/SessionBuiltinTools.test.ts`.

### Task 5: Correct scripted web-provider accuracy (#69 and #70)

**Files:**
- Modify: `examples/web-agent-server/DemoProvider.mjs`
- Test: `examples/web-agent-server/DemoProvider.test.mjs`

- [x] Expand `UNPINNED_RANGE` to recognize `1.x`, `2.x.x`, wildcard, comparator, tilde, caret, and `latest` ranges while leaving exact versions classified as pinned.
- [x] Add word boundaries to the English continuation alternatives so “discontinue” does not request continuation while preserving the Chinese phrases.
- [x] Preserve the tool error type in `toolResults()` and use that typed value to decide whether a retry was caused by steering interruption.
- [x] Carry a late first-message security intent through the normal `Glob` → `Read` → `Bash` phase, then append the security section using the completed dependency evidence.
- [x] Add tests for wildcard ranges, “discontinue”, non-interruption errors, and a late security instruction that retains dependency counts.
- [x] Run `pnpm vitest run examples/web-agent-server/DemoProvider.test.mjs`.

### Task 6: Make CLI auto-start safe for noninteractive and signal paths (#71)

**Files:**
- Modify: `src/cli/create-blade-agent.ts`
- Modify: `src/cli/createBladeAgent.ts`
- Test: `src/cli/__tests__/createBladeAgent.test.ts`

- [x] Require both stdin and stdout TTYs and no `CI` environment before auto-starting the generated web server.
- [x] Register SIGINT and SIGTERM handlers that forward the signal to the child process, await its exit, and restore the parent handler afterward.
- [x] Add tests for stdout-only TTY, CI, and signal forwarding/child cleanup.
- [x] Run `pnpm vitest run src/cli/__tests__/createBladeAgent.test.ts`.

### Task 7: Document the `fs-native-extensions` peer for server pairing (#72)

**Files:**
- Modify: `docs/server-runtime.md`
- Modify: `docs/en/server-runtime.md`
- Test: `scripts/__tests__/documentation-parity.test.ts` only if parity fixtures require an update

- [x] Add `fs-native-extensions@1.5.0` to both server-runtime pairing examples and explain that it is required by the cross-process advisory lock.
- [x] Improve the lock-load error to name the missing peer if the existing error path can do so without exposing secrets.
- [x] Run the documentation parity test and inspect both rendered snippets.

### Task 8: Full verification and release-readiness report

**Files:**
- Modify: none beyond the tasks above

- [x] Run `pnpm type-check`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm test`.
- [x] Run `pnpm build` and the relevant entrypoint/example verification scripts.
- [x] Run `git diff --check` and `git status --short --branch`, then report any environment-limited checks separately.
