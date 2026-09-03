#!/usr/bin/env node
import { createAuthService } from "./auth-service.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  configuredIssuer,
  configPath,
  fileConfigStore,
} from "./config.js";
import { systemCredentialStore } from "./credential-store.js";
import { createOAuthClient } from "./oauth-client.js";
import type { CliConfig } from "./types.js";

const VERSION = "0.1.0";

function usage(): string {
  return `PEP CLI ${VERSION}

Usage:
  pep auth login [--issuer <url>] [--client-id <id>]
  pep auth status
  pep auth token
  pep auth logout

The issuer is built into this executable. Use --issuer only to override it temporarily.
Use \`pep auth token\` when another agent needs a fresh docs:read bearer token.`;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

async function loginConfig(args: string[]): Promise<CliConfig> {
  const store = fileConfigStore();
  const saved = await store.read();
  const issuer = configuredIssuer(option(args, "--issuer"));
  const clientId = option(args, "--client-id") ?? saved?.clientId ?? DEFAULT_CLIENT_ID;
  if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
  return { version: 1, issuer, clientId, redirectUri: DEFAULT_REDIRECT_URI };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }
  if (args.shift() !== "auth") throw new Error(`Unknown command.\n\n${usage()}`);
  const command = args.shift();
  const configStore = fileConfigStore(configPath());
  const auth = createAuthService({
    configStore,
    credentialStore: systemCredentialStore(),
    oauth: createOAuthClient(),
  });

  if (command === "login") {
    const config = await loginConfig(args);
    console.error("Opening your browser to sign in to PEP…");
    const authorization = await auth.login(config, (url) =>
      console.error(`If the browser does not open, visit:\n${url}`),
    );
    console.log(`Logged in. Granted scopes: ${authorization.scopes.join(" ")}`);
    return;
  }
  if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
  if (command === "status") {
    const { authorization, user } = await auth.status();
    console.log("Logged in");
    console.log(`Issuer: ${authorization.issuer}`);
    console.log(`Client: ${authorization.clientId}`);
    console.log(`Account: ${user.email ?? user.name ?? user.sub}`);
    console.log(`Scopes: ${authorization.scopes.join(" ")}`);
    console.log(`Access token expires: ${new Date(authorization.expiresAt).toISOString()}`);
    return;
  }
  if (command === "token") {
    const authorization = await auth.currentAuthorization();
    process.stdout.write(`${authorization.accessToken}\n`);
    return;
  }
  if (command === "logout") {
    const result = await auth.logout();
    if (!result.wasLoggedIn) {
      console.log("Already logged out.");
      return;
    }
    if (result.revocationError)
      console.error(`Warning: remote revocation failed: ${result.revocationError.message}`);
    console.log("Logged out. Local credentials were removed.");
    return;
  }
  throw new Error(`Unknown auth command.\n\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(`pep: ${(error as Error).message}`);
  process.exitCode = 1;
});
