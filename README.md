# PEP CLI

Windows command-line OAuth client for obtaining a PEP access token. Login uses the
authorization-code flow with PKCE and a localhost callback. Access and rotating refresh tokens are
stored in Windows Credential Manager; the non-secret issuer and client ID are stored under `%APPDATA%\\PEP`.

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

| build | issuer |
| --- | --- |
| `development` | `https://pep-webapp-dev.onrender.com` |
| `view` | `https://pep-webapp-view.onrender.com` |
| `production` | `https://pep.newlandnpt.us` |

`--issuer` remains available only as a temporary override — it is **not** remembered, so every
`auth login` needs it again. That is why the built-in default decides where most users land.

⚠ **The npm release is built from `view`** (see `prepublishOnly`). As of 2026-09-08
`https://pep.newlandnpt.us/.well-known/openid-configuration` returns **404** — the production
domain does not serve the authorization server yet, so a `production` build would fail at
discovery on the user's very first `auth login`. Switch `prepublishOnly` back to `production`
once that endpoint is live.

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
