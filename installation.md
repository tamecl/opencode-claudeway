# Install Claudeway in OpenCode V2

These instructions are for AI coding agents asked to install and configure
`opencode-claudeway`. Install from GitHub, not npm. The repository is public.

**Experimental:** minimal subscription generation succeeded in the previous
version; the current JavaScript implementation and OAuth renewal have only been
validated with fixtures. The native host still has a request-redirect limitation.
Installing the plugin does not establish that it works with the user's account.

## 1. Check prerequisites without reading credentials

```sh
opencode --version
opencode plugin list
```

- Require **OpenCode V2**; the tested version is `2.0.29`. Do not apply V1's
  singular `plugin` configuration or upgrade OpenCode without permission.
- If OpenCode is missing or is V1, stop and explain the prerequisite.
- Ask the user to confirm they are already signed in to Claude Code. If not,
  they must sign in themselves before connecting the plugin.
- Do not dump Keychain items, read credential files, print tokens, or ask the
  user to paste secrets. No API key is needed.
- Automatic renewal is disabled on Windows until private recovery-file ACLs
  are verified. Explain this limitation before proceeding on Windows.

## 2. Install globally, preserving existing configuration

These instructions use global installation. If the user requested project-only
installation or prohibited global changes, ask before proceeding.

If Claudeway is already installed, do not add another copy. Keep an existing SSH
or local-path installation unless the user explicitly requests migration.

Otherwise, run:

```sh
opencode plugin add 'git+https://github.com/tamecl/opencode-claudeway.git#main'
```

This command installs the Git package and adds it to OpenCode's global plugin
configuration. OpenCode manages dependencies. Do not publish to npm, run a global
npm installation, clone a second copy, or introduce a compilation step.

Do not replace the user's configuration, remove other plugins, or disable
existing providers. Do not print the full configuration: it may contain secrets.
The package's `private: true` flag prevents npm publication, not Git installation.

## 3. Verify installation without account requests

```sh
opencode plugin list
```

Confirm the configured package and the plugin's reported state. If installation
or loading fails, report the failure; do not claim the plugin is active merely
because the package was added. Do not delete caches, databases or credentials to
work around an error.

If a service restart is needed, ask first: it may interrupt other sessions.
Only after approval, run:

```sh
opencode service restart
opencode plugin list
```

## 4. Let the user activate their account

Installation and loading do not authorize an agent to read or renew account
credentials. Explain these steps for the user to perform in OpenCode:

1. Run `/connect` and select **Anthropic**.
2. Choose **Claude Code credentials (Claudeway)**. If Anthropic already has saved
   accounts, add this method as needed and explicitly activate the Claudeway account.
3. Run `/models` and select the desired Claude model.

Before activation, tell the user that connecting or using Claudeway may renew
tokens and update the selected Claude Code Keychain/file source. It uses OAuth
subscription credentials, not a separately billed API-key connection.

Do not run `opencode auth login`, a generation, or the repository's live verifier
on the user's behalf without separate authorization. Do not choose an API-key
method, copy tokens manually, edit OpenCode's database or synchronize `auth.json`.

## Optional: dedicated token (no renewal conflicts with Claude Code)

By default Claudeway shares Claude Code's rotating refresh token, so both can
collide when renewing (symptom: "OAuth renewal is rate-limited"). To avoid it,
the **user** (never the agent) stores a separate year-long token:

```sh
claude setup-token
# macOS: prompts for the token, so it never lands in shell history or argv
security add-generic-password -U -s "Claudeway-token" -a "$USER" -w
# Linux: private file, must be 0600 and owned by the user
install -m 600 /dev/null ~/.claude/.claudeway-token && cat > ~/.claude/.claudeway-token
```

When present, Claudeway uses it as-is and never reads or renews Claude Code's
credentials. After about a year (or a 401), repeat the steps above. Windows is
not supported.

## 5. Report the result accurately

Report what was installed, whether it loaded, and whether account activation is
still pending. Distinguish installation success from a successful real generation.
No account request is required to complete installation.

For limitations and recovery behavior, see:
https://github.com/tamecl/opencode-claudeway/blob/main/README.md

Official OpenCode V2 plugin installation documentation:
https://opencode.ai/v2/docs/plugins
