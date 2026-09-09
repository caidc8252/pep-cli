#!/usr/bin/env node
import { createAuthService } from "./auth-service.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_RESOURCES,
  DEFAULT_REDIRECT_URI,
  configuredIssuer,
  configPath,
  defaultSkillsDirectory,
  fileConfigStore,
  fileSkillsStateStore,
  normalizeDocsUrl,
} from "./config.js";
import { systemCredentialStore } from "./credential-store.js";
import { createOAuthClient } from "./oauth-client.js";
import { fetchDocContent, fetchDocsIndex } from "./docs-service.js";
import { syncSkills } from "./skills-service.js";
import type { CliConfig } from "./types.js";

const VERSION = "0.1.0";

function usage(): string {
  return `PEP CLI ${VERSION}

Usage:
  pep auth login [--issuer <url>] [--client-id <id>] [--resource <uri> ...]
  pep auth status
  pep auth token
  pep auth logout
  pep skills sync [--dir <path>]
  pep docs list [--docs-url <url>]
  pep docs get <path> [--docs-url <url>]

The issuer is built into this executable. Use --issuer only to override it temporarily.
--resource names which resource server the token is for (RFC 8707); repeat it for more than
one. It defaults to the docs platform — a token minted without it is rejected by every
resource server, and their answer looks exactly like "this token does not exist".
Use \`pep auth token\` when another agent needs a fresh bearer token.

\`pep skills sync\` fetches the latest skills from PEP and writes them where Claude Code
looks for them (${defaultSkillsDirectory()} unless --dir says otherwise). It only touches
skills it wrote itself; anything you put there by hand is left alone.

\`pep docs list\` prints the documents this account can read (path + description); feed a path
straight to \`pep docs get\` to print that document as markdown on stdout. --docs-url is needed
once and then remembered — there is no built-in default, because the same documentation site
can front any PEP deployment.`;
}

/** 可重复的选项，按出现顺序取值。`--resource` 是唯一一个 —— RFC 8707 允许一次带多个受众。 */
function repeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index === -1) return values;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
    args.splice(index, 2);
  }
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
  const issuer = configuredIssuer(option(args, "--issuer"), saved?.issuer);
  const clientId = option(args, "--client-id") ?? saved?.clientId ?? DEFAULT_CLIENT_ID;
  // 显式给了就用给的；否则沿用上次登录存下的；再否则用内置默认。**不会**是空数组 ——
  // 没有受众的令牌在任何资源服务器那里都换不到东西。
  const explicit = repeatedOption(args, "--resource");
  const resources =
    explicit.length > 0 ? explicit : (saved?.resources ?? [...DEFAULT_RESOURCES]);
  if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
  return { version: 1, issuer, clientId, redirectUri: DEFAULT_REDIRECT_URI, resources };
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
  const group = args.shift();
  if (group !== "auth" && group !== "skills" && group !== "docs")
    throw new Error(`Unknown command.\n\n${usage()}`);
  const command = args.shift();
  const configStore = fileConfigStore(configPath());
  const auth = createAuthService({
    configStore,
    credentialStore: systemCredentialStore(),
    oauth: createOAuthClient(),
  });

  if (group === "docs") {
    if (command !== "list" && command !== "get") {
      throw new Error(`Unknown docs command.\n\n${usage()}`);
    }
    const explicitDocsUrl = option(args, "--docs-url");
    // `get` 的位置参数在选项摘掉之后才取 —— 否则 `--docs-url` 的值会被当成路径。
    const path = command === "get" ? args.shift() : undefined;
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
    if (command === "get" && !path) throw new Error("pep docs get needs a document path.");

    const saved = await configStore.read();
    const docsUrl = explicitDocsUrl
      ? normalizeDocsUrl(explicitDocsUrl)
      : (saved?.docsUrl ?? undefined);
    if (!docsUrl) {
      throw new Error(
        "No documentation site configured. Pass --docs-url <url> once; it is remembered afterwards.",
      );
    }
    // 显式给过就记住，下次不用再带。没有 saved 说明还没登录过 —— 那一步会先失败，不用管。
    if (explicitDocsUrl && saved && saved.docsUrl !== docsUrl) {
      await configStore.write({ ...saved, docsUrl });
    }

    const authorization = await auth.currentAuthorization();
    const dependencies = { docsUrl, accessToken: authorization.accessToken };
    if (command === "list") {
      const entries = await fetchDocsIndex(dependencies);
      if (entries.length === 0) {
        // 空清单不是故障，是权限的答案 —— 说清楚，免得对接方去查网络。
        console.error("No documents are readable with this account.");
        return;
      }
      for (const entry of entries) {
        console.log(entry.description ? `${entry.path}\t${entry.description}` : entry.path);
      }
      return;
    }
    // 正文原样写 stdout，不加任何装饰 —— 调用方多半要把它管道给别的东西。
    process.stdout.write(await fetchDocContent(dependencies, path as string));
    return;
  }

  if (group === "skills") {
    if (command !== "sync") throw new Error(`Unknown skills command.\n\n${usage()}`);
    const directory = option(args, "--dir") ?? defaultSkillsDirectory();
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
    // currentAuthorization 会在令牌快过期时先刷新 —— 同步是一次可能不短的下载，拿一枚
    // 马上就到期的令牌出门没有意义。
    const authorization = await auth.currentAuthorization();
    const result = await syncSkills({
      issuer: authorization.issuer,
      accessToken: authorization.accessToken,
      directory,
      stateStore: fileSkillsStateStore(),
    });
    if (result.status === "unchanged") {
      console.log(`Already at ${result.commit}. Nothing to do.`);
      return;
    }
    console.log(
      `Wrote ${result.fileCount} file(s) across ${result.skills.length} skill(s) to ${result.directory}`,
    );
    if (result.commit) console.log(`Commit: ${result.commit}`);
    if (result.removed.length > 0)
      console.log(`Removed (gone upstream): ${result.removed.join(" ")}`);
    return;
  }

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
