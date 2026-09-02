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
pep auth login --issuer https://pep.example.com
pep auth status
$token = pep auth token
pep auth logout
```

`pep auth token` writes only the access token to stdout, so agents can use it without parsing status
text. Refresh occurs automatically shortly before expiry and the rotated refresh token replaces the old
credential atomically.

## Build the customer executable

```bash
pnpm build:exe
```

The unsigned standalone executable is written to `dist/pep.exe` and does not require Node.js
on the customer machine. Production distribution should sign that file with the organization's Windows
code-signing certificate after injection.
