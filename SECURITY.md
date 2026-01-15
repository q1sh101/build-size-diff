# Security

## Reporting Vulnerabilities

Found a security issue? Please report it privately:

- **Email:** atomx101@outlook.com
- **GitHub:** [Security Advisories](https://github.com/q1sh101/build-size-diff/security/advisories/new)

Don't open public issues for security vulnerabilities. I'll respond within 48 hours and work on a fix based on severity.

---

## Security Model

### Build Command Safety

**Default behavior (safe):**

```yaml
build-command: 'npm run build' # Executes directly, no shell
```

**With shell features (requires opt-in):**

```yaml
build-command: 'npm run build && echo done'
allow-unsafe-build: true # Explicitly enables shell execution
```

The action blocks shell commands by default. If your command needs pipes (`|`), redirects (`>`), or chaining (`&&`), you must set `allow-unsafe-build: true`.

### Trigger Safety

**✅ Safe: `pull_request`**

- Workflow file comes from base branch
- Build runs on PR code, but workflow definition is trusted

**❌ Unsafe: `pull_request_target`**

- Runs workflow from base branch with write permissions
- Checks out PR code (including from forks)
- Creates pwn request vulnerability if not carefully designed

This action blocks `pull_request_target` by default. Override with `allow-unsafe-build: true` only if you understand the risks.

Reference: [Preventing pwn requests](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)

### Fork PRs

Fork PRs are blocked because:

- They can't access baseline artifacts (requires `actions: read` on base repo)
- Using `pull_request_target` to work around this is a security risk

**Workaround:** Contributors can open same-repo PRs from branches instead of forks.

---

## Implementation Security

**Path Traversal Protection:**
Zip extraction validates paths to prevent `../../etc/passwd` attacks.

**Zip Bomb Protection:**
Enforces max unzipped size (200MB) to prevent DoS via decompression bombs.

**Dependency Bundling:**
Dependencies are bundled with `@vercel/ncc` - no runtime `npm install` on user machines.

---

## Questions?

Security concerns or questions about the security model? Open a discussion or email atomx101@outlook.com.

Built for developers who care about performance.

**Built by [Giorgi Kishmareia](https://github.com/q1sh101)** · [Theatom.me](https://theatom.me)
