#!/usr/bin/env node
import { createAuthService } from "./auth-service.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_DOCS_URL,
  DEFAULT_RESOURCES,
  DEFAULT_REDIRECT_URI,
  configuredIssuer,
  configPath,
  claudeSkillsDirectory,
  defaultSkillsDirectory,
  fileConfigStore,
  fileSkillsStateStore,
  normalizeDocsUrl,
} from "./config.js";
import { systemCredentialStore } from "./credential-store.js";
import { createOAuthClient } from "./oauth-client.js";
import { fetchDocContent, fetchDocsIndex } from "./docs-service.js";
import { USERNAME_VAR, PASSWORD_VAR } from "./maven-env.js";
import { setupNexusCredential } from "./nexus-service.js";
import {
  fetchSkillsCatalog,
  installedPackages,
  syncSkills,
  type SkillsSyncResult,
} from "./skills-service.js";
import type { CliConfig, ConfigStore } from "./types.js";

const VERSION = "0.3.0";

function usage(): string {
  return `PEP CLI ${VERSION}

Usage:
  pep auth login [--issuer <url>] [--client-id <id>] [--resource <uri> ...]
  pep auth status
  pep auth token
  pep auth logout
  pep skills list
  pep skills add <name> [--dir <path>]
  pep skills sync [--dir <path>]
  pep docs list [--docs-url <url>]
  pep docs get <path> [--docs-url <url>]
  pep nexus setup

The issuer is built into this executable. --issuer overrides it for that one command and is
NOT remembered — pass it every time you log in against a non-default deployment.
--resource names which resource server the token is for (RFC 8707); repeat it for more than
one. It defaults to the docs platform — a token minted without it is rejected by every
resource server, and their answer looks exactly like "this token does not exist".
Use \`pep auth token\` when another agent needs a fresh bearer token.

\`pep skills list\` shows which skill packages this PEP deployment offers; \`pep skills add <name>\`
installs one of them and \`pep skills sync\` refreshes everything you have already added. A package
may contain more than one skill — every directory holding a SKILL.md becomes one, wherever it sits
in the repository.

\`pep skills sync\` fetches the latest skills from PEP and writes them to the shared agent
directory (${defaultSkillsDirectory()}), which Codex, Cursor, Amp and ~20 other agents read
directly. Claude Code keeps its own directory, so each skill is also linked into
${claudeSkillsDirectory()} — one copy on disk, updated in one place. Where links are not
available the skill is copied instead and the run says so.

--dir <path> writes to that path ONLY and skips the linking, for an agent that reads neither
directory. Either way sync only touches skills it wrote itself; anything you put there by
hand is left alone.

\`pep docs list\` prints the documents this account can read (path + description); feed a path
straight to \`pep docs get\` to print that document as markdown on stdout. The documentation
site is built in (${DEFAULT_DOCS_URL}); --docs-url overrides it and is then remembered.

\`pep nexus setup\` asks PEP for this organisation's Maven repository credential and saves it as
the two environment variables the Newland Android SDK reads — \`${USERNAME_VAR}\` and
\`${PASSWORD_VAR}\` — so you do not copy anything by hand. On Windows it writes them to your user
environment (\`setx\`); on macOS it keeps a marked block in your shell profile, backing the file up
first and touching nothing else. Either way persistence only affects NEW shells, so the two lines
are also printed on stdout: \`eval "$(pep nexus setup)"\` uses them in the current one.
Only Android needs this — the Windows and iOS SDKs are cloned from Git, not pulled from Maven.
The password is shown by PEP once and never stored, so a second run reports 409 rather than
handing it out again.`;
}

/** 一次同步的汇报。`add` 与 `sync` 共用 —— 两者的产出形状本来就一样。 */
function reportSync(result: SkillsSyncResult): void {
  if (result.status === "unchanged") {
    console.log(`${result.name}: already at ${result.commit}. Nothing to do.`);
    return;
  }
  console.log(
    `${result.name}: wrote ${result.fileCount} file(s) across ${result.skills.length} skill(s) to ${result.directory}`,
  );
  if (result.skills.length > 0) console.log(`  skills: ${result.skills.join(" ")}`);
  if (result.linkedInto !== undefined) {
    // 两行分开说：一行是「22 家共读的那份」，一行是「额外接给 Claude Code 的那条」。
    // 合成一句的话，用户看不出哪个是实体、哪个是链接，也就看不出该去哪儿改。
    console.log(
      result.copiedCount === undefined
        ? `  linked into ${result.linkedInto} for Claude Code`
        : `  linked into ${result.linkedInto} for Claude Code (${result.copiedCount} copied instead — links unavailable here)`,
    );
  }
  if (result.commit) console.log(`  commit: ${result.commit}`);
  if (result.removed.length > 0)
    console.log(`  removed (gone upstream): ${result.removed.join(" ")}`);
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

/** `store` 可注入只为可测：默认就是真配置文件。 */
export async function loginConfig(
  args: string[],
  store: ConfigStore = fileConfigStore(),
): Promise<CliConfig> {
  // ⚠ **这三项刻意不沿用上次登录存下的值**（2026-09-10 改；此前是「显式 > 记住 > 内置」）。
  //
  // 同一个字段被当成两件事在用，而只有第一件是真需求：
  //   ① 「当前这枚令牌绑在哪个 issuer / client 上」—— 续期、`auth status`、`auth token` 都要它，
  //      但它**存在钥匙串里**（`StoredAuthorization`），不在 config.json，与本函数无关；
  //   ② 「下一次 login 默认打哪」—— 只有这一件读 config.json，而让它继承上一次，就是所有
  //      环境错配的来源。
  //
  // 继承带来的坑，两个都真的发生过：
  //   · 早期版本把随机 `client_id` 烘进包里，用户本地存下了；改成固定名 `pep-cli` 之后，
  //     存量配置里那个旧值**压过新包的默认值**，打任何环境都回 `2D002 invalid_client`
  //     —— 而那句文案（"This application is not authorized to sign you in"）完全指不到
  //     「你本地配置里有个旧 client_id」。
  //   · `--resource urn:…:probe` 只在某一个环境登记过，被记住后跟着换环境 ⇒ `invalid_target`。
  //
  // 代价是生产上线前每次 `login` 都要带 `--issuer`。可接受：`login` 不是常跑的命令（令牌自动
  // 续期），且生产上线后这个代价归零——不带参数就是生产。
  //
  // `docsUrl` **不在此列**（见下面 docs 分支）：它每次 `docs` 命令都要用、且不参与环境绑定语义，
  // 记住它撞不出上面那类问题。
  const issuer = configuredIssuer(option(args, "--issuer"));
  const clientId = option(args, "--client-id") ?? DEFAULT_CLIENT_ID;
  const explicit = repeatedOption(args, "--resource");
  const resources = explicit.length > 0 ? explicit : [...DEFAULT_RESOURCES];
  if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
  // `docsUrl` 要**显式带过来**：`login` 成功后 `auth-service` 用本对象整体覆写 config.json，
  // 而它是那个文件里唯一一项不由本函数产出的字段 —— 不带上，每次重新登录都会把用户设过的
  // 文档地址抹掉（既有缺陷，2026-09-10 随「三项不再记住」一并修：既然还宣称 docsUrl 记得住，
  // 就不能让另一条路径悄悄清掉它）。
  const saved = await store.read();
  return {
    version: 1,
    issuer,
    clientId,
    redirectUri: DEFAULT_REDIRECT_URI,
    resources,
    ...(saved?.docsUrl !== undefined ? { docsUrl: saved.docsUrl } : {}),
  };
}

export async function main(): Promise<void> {
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
  if (group !== "auth" && group !== "skills" && group !== "docs" && group !== "nexus")
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
    // 显式 > 记住 > 内置，与 issuer / clientId / resources 同一口径。
    const docsUrl = explicitDocsUrl
      ? normalizeDocsUrl(explicitDocsUrl)
      : (saved?.docsUrl ?? DEFAULT_DOCS_URL);
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

  if (group === "nexus") {
    if (command !== "setup") throw new Error(`Unknown nexus command.\n\n${usage()}`);
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
    const authorization = await auth.currentAuthorization();
    const result = await setupNexusCredential({
      issuer: authorization.issuer,
      accessToken: authorization.accessToken,
    });

    // ⚠ 两行走 **stdout**，说明全走 stderr —— 与 `pep auth token` 同一口径：给机器读的
    // 可以直接 `eval "$(pep nexus setup)"` 让**当前**这个 shell 立刻能用，而持久化那一半
    // 无论在哪个平台都只对**新** shell 生效。
    console.log(result.lines);

    const persisted = result.persisted;
    if (persisted.status === "windows") {
      console.error(`Saved ${USERNAME_VAR} and ${PASSWORD_VAR} to your Windows user environment.`);
      console.error("Existing terminals do not see them — open a new one (or use the lines above).");
    } else if (persisted.status === "manual") {
      // 没落盘。凭据已经换走了且 PEP 不存密码，所以上面那两行就是全部 —— 说清楚。
      console.error(
        `Nothing was written${persisted.path ? ` to ${persisted.path}` : ""}: ${persisted.reason}`,
      );
      console.error("The two lines above are the only copy — PEP does not store the password.");
    } else {
      console.error(
        persisted.status === "profile-replaced"
          ? `Replaced the pep-cli block in ${persisted.path}`
          : `Appended a pep-cli block to ${persisted.path}`,
      );
      // 备份路径必须打出来 —— 改的是用户自己的 profile，出了意外要能一条命令回去。
      if (persisted.backupPath) console.error(`Backup: ${persisted.backupPath}`);
      console.error("New shells will have it; this one will not until you re-source the profile.");
    }
    console.error(`Nexus user: ${result.username}`);
    return;
  }

  if (group === "skills") {
    if (command !== "sync" && command !== "add" && command !== "list") {
      throw new Error(`Unknown skills command.\n\n${usage()}`);
    }
    // `add` 的位置参数在选项摘掉之前取 —— 它紧跟命令，不会跟 `--dir` 的值混。
    const requested = command === "add" ? args.shift() : undefined;
    if (command === "add" && !requested) throw new Error("pep skills add needs a package name.");

    // 显式 `--dir` = 「就铺到这儿，别的什么都别做」—— 给那些不读通用目录的 agent 用的逃生口，
    // 所以那一档不接任何链接（接了反而会往用户没要求的地方写）。
    const explicitDirectory = command === "list" ? undefined : option(args, "--dir");
    const directory = explicitDirectory ?? defaultSkillsDirectory();
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);

    // currentAuthorization 会在令牌快过期时先刷新 —— 同步是一次可能不短的下载，拿一枚
    // 马上就到期的令牌出门没有意义。
    const authorization = await auth.currentAuthorization();
    const remote = { issuer: authorization.issuer, accessToken: authorization.accessToken };

    if (command === "list") {
      const catalog = await fetchSkillsCatalog(remote);
      if (catalog.length === 0) {
        // 空清单不是故障，是这个部署的答案 —— 说清楚，免得对接方去查网络。
        console.error("This PEP deployment offers no skill packages.");
        return;
      }
      const installed = new Set(await installedPackages(fileSkillsStateStore()));
      for (const one of catalog) {
        // 装过的标一下 —— 否则用户看不出 `add` 过哪个，而那正是决定下一步的信息。
        console.log(
          [installed.has(one.name) ? "*" : " ", one.name, one.description]
            .filter(Boolean)
            .join("\t"),
        );
      }
      console.error("\n* = already added; `pep skills sync` refreshes those.");
      return;
    }

    const stateStore = fileSkillsStateStore();
    const targets =
      command === "add" ? [requested as string] : await installedPackages(stateStore);
    if (targets.length === 0) {
      // `sync` 而账上一个都没有：不猜一个默认值去装，那会替用户做决定。
      console.error("Nothing added yet. Run `pep skills list`, then `pep skills add <name>`.");
      return;
    }

    for (const name of targets) {
      const result = await syncSkills({
        ...remote,
        name,
        directory,
        ...(explicitDirectory === undefined ? { linkInto: claudeSkillsDirectory() } : {}),
        stateStore,
      });
      reportSync(result);
    }
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

