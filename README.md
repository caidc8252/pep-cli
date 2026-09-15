# PEP CLI

Command-line OAuth client for obtaining a PEP access token, reading PEP documentation, and
syncing agent skills. Login uses the authorization-code flow with PKCE and a localhost callback.

Tokens live in the OS keychain — **Windows Credential Manager** or the **macOS login keychain**
(via the built-in `security` tool). Linux is not implemented yet: `systemCredentialStore()` throws,
and `package.json` declares `os: ["win32", "darwin"]` so npm refuses to install elsewhere rather
than letting the install succeed and the first `auth login` fail.

The non-secret issuer, client ID, resources and documentation URL are stored in a plain config file
(`%APPDATA%\\PEP` on Windows, `~/.config/pep` elsewhere). `auth logout` clears both.

## Install

```
npm i -g @newlandnpt/pep-cli
```

The package name is scoped, the command names are not — see below. The scope is not a style
choice: npm's typo-squatting policy **refuses** the unscoped name `pep-cli` ("too similar to
existing packages cp-cli, del-cli, open-cli"), and that check applies to every short
`<prefix>-cli` name. Scoped names skip the check, so `@newlandnpt/…` is what makes this
publishable at all.

## Command name

The package installs **two** names for the same executable:

```
pep        # short form, used throughout this document
pep-cli    # alias
```

`bin` names are global and independent of the package name — any other package (or any
non-npm tool) may also claim `pep`, and on a global install the last one wins silently.
The alias costs nothing (one more symlink to the same file) and gives scripts a name that
cannot be clobbered by an unrelated `pep`. Prefer `pep-cli` in anything automated.

## Register the public client

Run this once from the `pep-webapp` repository for the customer tenant (replace the IDs):

```bash
node scripts/oauth-bootstrap.mjs --client --public \
  --client-id 1b916aae96f69a535d7a1a30c8f2e1dc --name "PEP CLI" \
  --party <party-id> --admission-user <user-id> \
  --redirect-uri http://localhost:53682/callback \
  --scopes "openid profile email"
```

If one PEP deployment serves multiple customer tenants, register a distinct client ID for each tenant
and pass it with `--client-id`.

## Use

```powershell
pep auth login
pep auth status
$token = pep auth token
pep auth logout
```

The issuer is fixed at build time:

| build         | issuer                                 |
| ------------- | -------------------------------------- |
| `development` | `https://pep-webapp-dev.onrender.com`  |
| `view`        | `https://pep-webapp-view.onrender.com` |
| `production`  | `https://pep.newlandnpt.us`            |

`--issuer` remains available only as a temporary override — it is **not** remembered, so every
`auth login` needs it again. That is why the built-in default decides where most users land.

⚠ **The npm release is currently built from `development`** — it ships
`https://pep-webapp-dev.onrender.com` (see `prepack` in `package.json`). This is a deliberate
temporary state: production is not going live in the near term and this build is for other
departments to use now.

`https://pep.newlandnpt.us/.well-known/openid-configuration` still returns **404** (last checked
2026-09-09) — the production domain does not serve the authorization server yet, so a
`production` build fails at discovery on the user's very first `auth login`. **Switch `prepack`
back to `production` and publish immediately once that endpoint is live**: the issuer is baked in
at build time, so releases already out in the wild cannot be repointed.

## Skills

```powershell
pep skills add https://git.newlandpayment.com/group/sub/project   # or group/sub/project[@ref]
pep skills list
pep skills update                                                 # all of them
pep skills update group/sub/project                               # just this one
pep skills add group/sub/project -p                               # into THIS project
```

PEP fetches the repository with its own read-only service account, so no GitLab credential ever
reaches the machine. Only repositories on the platform's own GitLab host are accepted. One
repository may hold several skills: every directory containing a `SKILL.md` becomes one, and
`update` reports which of them actually changed rather than just that the repository moved.

### Where skills are installed

| Scope       | Flag        | Canonical copy            | Linked into                |
| ----------- | ----------- | ------------------------- | -------------------------- |
| **Personal**| (default)   | `~/.agents/skills/`       | `~/.claude/skills/`        |
| **Project** | `-p`, `--project` | `./.agents/skills/`       | `./.claude/skills/`        |
| **Raw**     | `--dir <p>` | `<p>/`                    | nothing — linking skipped  |

`~/.agents/skills` is the cross-agent convention that Codex, Cursor, Amp and ~20 others read
directly; Claude Code keeps its own directory, so each skill is also linked there — one copy on
disk, updated in one place. The project paths are the same two names rooted at the current
directory, matching what `npx skills` installs at project scope.

Personal is the default because the project directories get committed: whether a synced skill
counts as a change, and whether to gitignore it, is a question every repository would otherwise
have to answer. Use `-p` when the skills genuinely belong to one repository.

**The location is remembered per repository.** `pep skills update` refreshes each repository where
it already lives, and never moves anything.

On `update`, `-p` and `--dir` **narrow the run** rather than relocate — the same meaning they have
in `npx skills`:

```powershell
pep skills update          # every repository, each where it lives
pep skills update -p       # only the ones installed in this project
```

If the current project has none, `update -p` says so and does nothing. **To move a repository, add
it again with the new flag** — `add` is where the location is decided, and the copy in the old
location is then removed:

```powershell
pep skills add group/sub/project -p    # move it into this project
```

`pep skills list` prints each repository with the directory it lives in, which is what `-p` matches
against.

### Deleting a skill

Delete a skill folder by hand and it **stays deleted**. `update` refreshes what is still on disk
and leaves the rest alone, naming them so the run is not silent:

```
group/sub/project: updated b
  deleted locally, left alone: a
  (`pep skills add group/sub/project` puts them back)
```

`add` is the command that installs, so that is what brings a deleted skill back. This split is
deliberate: `update` means "bring what I have up to date", not "refill everything the repository
offers".

Skills that are **new upstream** are still installed by `update` — the test is "was mine and is now
gone", not "is absent".

`pep auth token` writes only the access token to stdout, so agents can use it without parsing status
text. Refresh occurs automatically shortly before expiry and the rotated refresh token replaces the old
credential atomically.

## Build the customer executable

```powershell
pnpm build:exe:dev    # dist/pep-dev.exe
pnpm build:exe:view   # dist/pep-view.exe
pnpm build:exe        # dist/pep.exe (production)
```

The unsigned standalone executable is written to `dist/pep.exe` and does not require Node.js
on the customer machine. Production distribution should sign that file with the organization's Windows
code-signing certificate after injection.

## Build the Windows installer

Install [NSIS 3](https://nsis.sourceforge.io/Download), then run:

```powershell
pnpm build:installer:dev    # dist/pep-dev-setup.exe
pnpm build:installer:view   # dist/pep-view-setup.exe
pnpm build:installer       # dist/pep-setup.exe (production)
```

Both user-level installers install PEP CLI under `%LOCALAPPDATA%\Programs\PEP`, add that directory
to the user `PATH`, and register an uninstaller. Installing one environment replaces the other, and
new terminals can run `pep auth login` from any directory. Run `pep auth login` after switching
environments so the stored authorization matches the installed environment. Sign both `pep.exe` and
the final production installer before distribution.
