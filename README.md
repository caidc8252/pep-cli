# PEP CLI

Windows command-line OAuth client for obtaining a PEP `docs:read` access token. Login uses the
authorization-code flow with PKCE and a localhost callback. Access and rotating refresh tokens are
stored in Windows Credential Manager; the non-secret issuer and client ID are stored under `%APPDATA%\\PEP`.

## Register the public client

Run this once from the `pep-webapp` repository for the customer tenant (replace the IDs):

```bash
node scripts/oauth-bootstrap.mjs --client --public \
  --client-id pep-cli --name "PEP CLI" \
  --party <party-id> --admission-user <user-id> \
  --redirect-uri http://localhost:53682/callback \
  --scopes "openid profile email docs:read"
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

The issuer is fixed at build time. The development executable uses
`https://pep-webapp-dev.onrender.com`; the production executable uses
`https://pep.newlandnpt.us`. `--issuer` remains available only as a temporary override.

`pep auth token` writes only the access token to stdout, so agents can use it without parsing status
text. Refresh occurs automatically shortly before expiry and the rotated refresh token replaces the old
credential atomically.

## Build the customer executable

```powershell
pnpm build:exe:dev   # dist/pep-dev.exe
pnpm build:exe       # dist/pep.exe (production)
```

The unsigned standalone executable is written to `dist/pep.exe` and does not require Node.js
on the customer machine. Production distribution should sign that file with the organization's Windows
code-signing certificate after injection.

## Build the Windows installer

Install [NSIS 3](https://nsis.sourceforge.io/Download), then run:

```powershell
pnpm build:installer:dev   # dist/pep-dev-setup.exe
pnpm build:installer      # dist/pep-setup.exe (production)
```

Both user-level installers install PEP CLI under `%LOCALAPPDATA%\Programs\PEP`, add that directory
to the user `PATH`, and register an uninstaller. Installing one environment replaces the other, and
new terminals can run `pep auth login` from any directory. Run `pep auth login` after switching
environments so the stored authorization matches the installed environment. Sign both `pep.exe` and
the final production installer before distribution.
