# Contributing

Thanks for helping. Issues and pull requests are welcome in English or Spanish.

## Before you start

- **Never paste tokens**, credentials, Keychain dumps or the contents of `.claudeway-refresh.json` in issues, PRs or logs.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.
- For larger changes, open an issue first so we can agree on the approach. The scope is intentionally small: no
  multi-account, proxy, routing, telemetry or background refresh.

## Setup

**Node `24.12+` · pnpm `10.32.1` · OpenCode V2 `2.0.29`**

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run lint
```

Regular tests never read real credentials or call Anthropic. Do not add tests that do. The live verifier
(`scripts/verify-live.mjs`) is opt-in and must stay out of `pnpm test`.

## Pull requests

- Keep changes focused and add a test for new behavior.
- Update `README.md`, `README.es.md` or `docs/` when behavior changes.
- `pnpm test` and `pnpm run lint` must pass.

## Releases (maintainers)

Bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The `Release` workflow tests and stages the version on npm through trusted publishing. A maintainer then approves it
with 2FA on npmjs.com (package → Staged) before it becomes public, with provenance.
