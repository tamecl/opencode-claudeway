<div align="center">

# Claudeway

**Your Claude Code session, inside OpenCode.**

Unofficial integration with on-demand OAuth renewal. No API key.

Claudeway is an open-source OpenCode V2 plugin that lets you use your Claude Pro or Max subscription (via Claude Code credentials) instead of an Anthropic API key.

[![CI](https://img.shields.io/github/actions/workflow/status/tamecl/opencode-claudeway/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tamecl/opencode-claudeway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tamelabs/opencode-claudeway?style=flat-square)](https://www.npmjs.com/package/@tamelabs/opencode-claudeway)
[![OpenCode 2.0.29](https://img.shields.io/badge/OpenCode-2.0.29-24292f?style=flat-square)](https://opencode.ai/v2/docs/plugins)
[![Status: experimental](https://img.shields.io/badge/status-experimental-d29922?style=flat-square)](docs/compatibility.md)
[![MIT License](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)

[Español](README.es.md) · [Install](#install) · [Renewal](#automatic-renewal) · [Security](#security-and-limits) · [FAQ](#faq) · [Development](#development) · [Agent guide](installation.md)

</div>

> [!WARNING]
> **Experimental, unofficial, use at your own risk.** OAuth renewal is still under
> review. OpenCode `2.0.29` cannot yet guarantee that redirects are blocked on the
> first native request. Using subscription credentials in unofficial clients may be
> restricted by Anthropic's terms and could stop working at any time.

## What it does

| Feature | How it works |
| :--- | :--- |
| **Your existing subscription** | Uses Claude Code OAuth, not an API-key connection. |
| **On-demand renewal** | Renews when you use the model: no timers, no helper CLI generations. |
| **Native integration** | Explicitly enabled in OpenCode V2; your other connections stay untouched. |

## Install

You need **OpenCode V2** (tested with `2.0.29`) and an existing Claude Code
session. The package is published on npm as `@tamelabs/opencode-claudeway`,
Tame's official npm account.

### With an agent

Paste this line into OpenCode:

```text
Install the opencode-claudeway plugin and configure it by following: https://raw.githubusercontent.com/tamecl/opencode-claudeway/main/installation.md
```

The [agent guide](installation.md) installs and checks the plugin without reading
credentials or calling Anthropic. Activating the account is left to you.

### Manually

```sh
opencode plugin add @tamelabs/opencode-claudeway
opencode plugin list
```

OpenCode installs the dependencies and adds the plugin to its **global**
configuration. No cloning, pnpm or build step required.

Then, inside OpenCode:

1. **`/connect`** → Anthropic → **Claude Code credentials (Claudeway)**.
2. Keep the Claudeway account active.
3. **`/models`** → pick your Claude model.

<p align="center">
  <img src="docs/assets/model-picker.png" width="640" alt="OpenCode V2 model picker showing Claude Fable 5.1, Haiku 5.5, Opus 5.5 and Sonnet 5.5 available through Claudeway with a Claude subscription">
</p>

> [!IMPORTANT]
> Connecting or using Claudeway may renew tokens and update Claude Code's
> credential source. Do not copy tokens by hand or choose the API-key method.
> Loading the plugin alone does not connect any account.

<details>
<summary><strong>Update, pin a version, install from Git or restart the service</strong></summary>

To update only this plugin:

```sh
opencode plugin update @tamelabs/opencode-claudeway
```

To pin a version, use `@tamelabs/opencode-claudeway@0.1.0`. To try the main
branch without npm:

```sh
opencode plugin add 'git+https://github.com/tamecl/opencode-claudeway.git#main'
```

If you already installed it from Git, SSH or a local path, remove that entry
before adding the npm one; do not keep two copies.

If the plugin does not show as active, you can restart the service. This may
interrupt other sessions:

```sh
opencode service restart
opencode plugin list
```

</details>

<details>
<summary><strong>Alternative: load the local directory</strong></summary>

After installing the repository's dependencies, add its path to the V2
configuration of the project where you want to try it:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-claudeway"]
}
```

Then enable Claudeway through `/connect`, as in the manual install.
Use the local directory **or** the published package, not both.

</details>

## Automatic renewal

When you connect Claudeway or request a model, it renews if **five minutes or
less** of validity remain. Otherwise it makes no extra calls or writes.

- **Coordination:** a shared Promise and a file lock coordinate Claudeway
  processes. The source is re-read before renewing and before writing.
- **Persistence:** keeps scopes and other metadata, updates the same source and
  returns the grant to V2's OAuth callback. Files are replaced atomically with
  private permissions.
- **Recovery:** `.claudeway-refresh.json` holds new tokens only while a write is
  pending, with POSIX `0600` permissions. Afterwards only a receipt with hashes
  remains, no tokens. **Do not share it or delete it blindly.**
- **Bounded failures:** the OAuth request has a fixed destination, a timeout and
  blocked redirects. Transient rejections get a cooldown; terminal ones ask you to
  re-authenticate. An uncertain result never replays the old refresh token.

Claude Code is not required to honor our lock. Re-reads reduce races but cannot
guarantee absolute exclusion against other clients, nor recovery after a crash
before the OAuth response is persisted.

### Dedicated token (avoids clashes with Claude Code)

Claudeway and Claude Code share a rotating refresh token, so they can collide
when renewing (symptom: *OAuth renewal is rate-limited*). To avoid it, store a
separate year-long token (`claude setup-token`) in the `Claudeway-token` Keychain
item (macOS) or in `~/.claude/.claudeway-token` with `0600` permissions (Linux).
When present, Claudeway uses it as-is: it **never reads or renews** Claude Code's
credentials. A 401 means you need to repeat `setup-token`. Steps in
[installation.md](installation.md#optional-dedicated-token-no-renewal-conflicts-with-claude-code).
Not supported on Windows.

## Security and limits

### What has been verified

| Path | Current evidence |
| :--- | :--- |
| Real generation with a subscription | **Working** on OpenCode `2.0.29`, no API key. |
| JS implementation and renewal | Verified with fixtures and the V2 host SDK; **no real renewal** at this stage. |
| macOS | Real generation with Haiku 5.5, Sonnet 5.5 and Opus 5.5. Local tests run; Keychain mocked. |
| Linux (Ubuntu) | Real generation with Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1. Real renewal and automated tests pending. |
| Windows | Pending. Renewal is disabled until private ACLs are verified. |

### Limits you should know

- **Redirects:** the host may follow the first request and resend the body.
  Blocking redirects in OAuth or in the verifier does not fix that transport.
- **Instruction priority:** compatibility moves instructions from `system` to the
  first user message, lowering their priority. That is not equivalent to keeping
  them in `system`; OpenCode's permission checks are unchanged.
- **Keychain:** updates longer than `security -i`'s safe line (4094 bytes) are
  rejected, never truncated.
- **Single source:** honors `CLAUDE_CONFIG_DIR`; does not discover other accounts.
  On macOS the file is used only if the matching Keychain item does not exist.
- **No secret logging:** never logs tokens, prompts or error bodies. Keychain
  writes go through stdin, never arguments or environment.
- **Limited scope:** no multi-account, routing, proxy, telemetry or background
  refresh. The fallback for known 400/429 errors removes only betas that are
  present, with up to two retries; it does not recover 401 errors.

Renewal modifies the selected Claude Code source, not `auth.json`.
Using subscription credentials in unofficial clients may be restricted by
Anthropic's terms and may stop working.

See the [compatibility report](docs/compatibility.md) (Spanish) for results,
diagnostic history and the full list of limitations.

## FAQ

**How do I use my Claude Pro or Max subscription in OpenCode?**
Install Claudeway (`opencode plugin add @tamelabs/opencode-claudeway`), connect
**Claude Code credentials (Claudeway)** in `/connect` and pick a model in
`/models`. You need an existing Claude Code session.

**Do I need an Anthropic API key?**
No. Claudeway uses Claude Code's OAuth credentials, not an API key.

**Which models work?**
Tested with real generation on OpenCode `2.0.29`: Claude Haiku 5.5, Sonnet 5.5
and Opus 5.5 on macOS, plus Fable 5.1 on Ubuntu.

**Which operating systems are supported?**
macOS and Linux. On Windows renewal is disabled until private ACLs are verified.

**Is it free and open source?**
Yes, MIT licensed. You need your own Claude subscription.

**Does it work with OpenCode V1?**
No. Claudeway targets OpenCode V2 only.

**How is it different from opencode-claude-auth?**
Claudeway is an independent project for OpenCode V2, based on a selective
migration of [opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth).
It adds on-demand OAuth renewal with file locking, recovery from interrupted
writes and an optional [dedicated token](#dedicated-token-avoids-clashes-with-claude-code)
to avoid clashing with Claude Code.

**Is it allowed by Anthropic?**
It is unofficial. Using subscription credentials in unofficial clients may be
restricted by Anthropic's terms and could stop working at any time.

## Development

**Node `24.12+` · pnpm `10.32.1` · OpenCode `2.0.29`**

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run lint
pnpm pack
```

Without pnpm, replace `pnpm` with `npx --yes pnpm@10.32.1`.
The package loads `src/index.js` directly, with no `dist/` or helper interpreter.
Regular tests never use real credentials or call Anthropic: they isolate the
environment and use fixtures, in-memory SQLite and a mocked transport.
See [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><strong>Project map</strong></summary>

| File | Responsibility |
| :--- | :--- |
| [`src/index.js`](src/index.js) | V2 integration and allowed destinations. |
| [`src/storage.js`](src/storage.js) | File/Keychain, validation, persistence and locking. |
| [`src/credentials.js`](src/credentials.js) | OAuth renewal, concurrency and recovery. |
| [`src/transforms.js`](src/transforms.js) | Billing, identity, instructions, Haiku and tools. |
| [`src/compatibility.js`](src/compatibility.js) | Headers, fallback and streaming. |
| [`src/errors.js`](src/errors.js) | Codes and sanitized messages. |
| [`test/`](test) | Behavior and V2 host tests. |
| [`scripts/diagnostics.mjs`](scripts/diagnostics.mjs) | Sanitized comparison and manual probe diagnostics. |

</details>

<details>
<summary><strong>Optional live check — requires authorization</strong></summary>

This verifier is **not part of the regular tests**. It reads real credentials and
may consume account usage. Do not run it without explicitly authorizing that.

```sh
node scripts/verify-live.mjs --confirm --max-requests=3
```

- Allows one minimal request and up to two retries within the total budget.
  `--max-requests` defaults to `1`; each request is capped at eight output tokens
  and requires Bearer auth, no API key and the official destination.
- **Never renews tokens or writes their sources.** It disables automatic renewal
  and rejects credentials sixty seconds or less from expiry.
- Blocks redirects in its isolated transport, not in the production plugin.
- Waits for OAuth to finish and distinguishes initialization, credentials and
  request. The report omits tokens, prompts, session IDs and raw errors; its
  structural diffs do not prove which adaptation alone fixed the earlier error.

</details>

## Removal

```sh
opencode plugin remove @tamelabs/opencode-claudeway
```

If you connected a test account, remove only that account from the native UI;
**do not delete Claude Code's credentials**. The plugin keeps no timers or
persistent processes.

## Credits and license

Independent project based on a selective migration of
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth), not
a modification of that repository. Community references do not constitute
authorization to use the service.

[MIT](LICENSE) · [Attributions and dependencies](THIRD_PARTY_NOTICES.md)
