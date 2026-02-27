# Contributing to Blade Agent SDK

Thank you for your interest in contributing to Blade Agent SDK! This document provides guidelines and standards for contributing to this project.

## Code Standards

### TypeScript Strict Mode

This project enforces strict TypeScript configuration. All contributions must adhere to these rules:

#### No `any` Type

**Using `any` is strictly prohibited.** This rule is enforced at both compile-time and lint-time.

```typescript
// ❌ Bad
function process(data: any) { ... }
const result: any = fetchData();
let value; // implicit any

// ✅ Good
function process(data: unknown) { ... }
function process<T>(data: T) { ... }
const result: ResponseType = fetchData();
let value: string;
```

**Alternatives to `any`:**

| Instead of `any` | Use |
|------------------|-----|
| Unknown input type | `unknown` |
| Generic data | `<T>` generics |
| Object with unknown keys | `Record<string, unknown>` |
| JSON data | `JsonValue` from `types/common.ts` |
| Function parameters | Specific types or generics |

#### Strict Null Checks

Always handle potential `undefined` and `null` values explicitly:

```typescript
// ❌ Bad
const name = user.profile.name;

// ✅ Good
const name = user?.profile?.name ?? 'Anonymous';
```

### Linting

Run linting before submitting:

```bash
bun run lint
```

Fix auto-fixable issues:

```bash
bun run lint:fix
```

### Type Checking

Ensure your code passes type checking:

```bash
bun run type-check
```

## Development Workflow

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/blade-agent-sdk.git
cd blade-agent-sdk
bun install
```

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 3. Make Changes

- Write clean, typed code
- Follow existing code style and patterns
- Add tests for new functionality

### 4. Test Your Changes

```bash
bun test
```

### 5. Verify Code Quality

```bash
bun run type-check
bun run lint
```

### 6. Commit and Push

Write clear, descriptive commit messages:

```bash
git commit -m "feat: add new feature description"
git push origin feature/your-feature-name
```

### 7. Create Pull Request

Open a PR against the `main` branch with:
- Clear description of changes
- Reference to related issues
- Screenshots/examples if applicable

## Pull Request Checklist

Before submitting a PR, ensure:

- [ ] Code compiles without errors (`bun run type-check`)
- [ ] All tests pass (`bun test`)
- [ ] Linting passes (`bun run lint`)
- [ ] No `any` types introduced
- [ ] New features have tests
- [ ] Documentation updated if needed

## Code Review

All PRs require review before merging. Reviewers will check:

1. **Type Safety**: No `any`, proper typing throughout
2. **Code Quality**: Clean, readable, maintainable code
3. **Tests**: Adequate test coverage
4. **Documentation**: Clear comments where necessary

## Questions?

If you have questions, please open an issue or discussion on GitHub.
