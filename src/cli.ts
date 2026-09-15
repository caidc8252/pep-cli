#!/usr/bin/env node
import packageJson from "../package.json" with { type: "json" };
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
import { usage } from "./help.js";
import { setupNexusCredential } from "./nexus-service.js";
import { installedPackages, updateSkills, type SkillsUpdateResult } from "./skills-service.js";
import type { CliConfig, ConfigStore } from "./types.js";

const VERSION = packageJson.version;

/** 一次更新的汇报。`add` 与 `update` 共用 —— 两者的产出形状本来就一样。 */
function reportUpdate(result: SkillsUpdateResult): void {
  if (result.status === "unchanged") {
    console.log(`${result.name}: already at ${result.commit}. Nothing to do.`);
    return;
  }
  // ⚠ 先说**哪些 skill 真的变了** —— 那是用户来看这行输出的原因。仓库动了别处
  // （README / evals）时 commit 会变而 skill 不变，只报「写了 N 个文件」说不出这个差别。
  console.log(
    result.updated.length > 0
      ? `${result.name}: updated ${result.updated.join(" ")}`
      : `${result.name}: no skill changed (the repository moved, but not these)`,
  );
  if (result.unchanged.length > 0) {
    console.log(`  unchanged: ${result.unchanged.join(" ")}`);
  }
  console.log(`  ${result.fileCount} file(s) in ${result.directory}`);
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
  if (args[0] === "help") {
    console.log(usage(VERSION, args.slice(1).filter((arg) => arg !== "--help" && arg !== "-h")));
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    const path = args.filter((arg) => arg !== "--help" && arg !== "-h").slice(0, 2);
    const flagIndex = path.findIndex((arg) => arg.startsWith("-"));
    console.log(usage(VERSION, flagIndex === -1 ? path : path.slice(0, flagIndex)));
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }
  const group = args.shift();
  if (group !== "auth" && group !== "skills" && group !== "docs" && group !== "nexus")
    throw new Error(`Unknown command.\n\n${usage(VERSION)}`);
  const command = args.shift();
  if (!command) {
    console.log(usage(VERSION, [group]));
    return;
  }
  const configStore = fileConfigStore(configPath());
  const auth = createAuthService({
    configStore,
    credentialStore: systemCredentialStore(),
    oauth: createOAuthClient(),
  });

  if (group === "docs") {
    if (command !== "list" && command !== "get") {
      throw new Error(`Unknown docs command.\n\n${usage(VERSION, ["docs"])}`);
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
    if (command !== "setup") throw new Error(`Unknown nexus command.\n\n${usage(VERSION, ["nexus"])}`);
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);
    const authorization = await auth.currentAuthorization();
    const result = await setupNexusCredential({
      issuer: authorization.issuer,
      accessToken: authorization.accessToken,
    });

    const persisted = result.persisted;
    if (persisted.status === "manual") {
      // 底层 setx 异常可能包含带密码的命令行，不能把 reason 打到终端。
      throw new Error(
        "Maven credentials could not be fully saved locally. PEP does not store the password; contact an operator to reset it in Nexus and configure it locally.",
      );
    }
    console.log("Maven credentials saved successfully. Open a new terminal to use them.");
    return;
  }

  if (group === "skills") {
    if (command !== "update" && command !== "add" && command !== "list") {
      throw new Error(`Unknown skills command.\n\n${usage(VERSION, ["skills"])}`);
    }
    // `add` 的位置参数在选项摘掉之前取 —— 它紧跟命令，不会跟 `--dir` 的值混。
    // `add` 收恰好一个；`update` 收零个或多个（零个 = 全部已装的）。
    const requested = command === "add" ? args.shift() : undefined;
    if (command === "add" && !requested) {
      throw new Error("pep skills add needs a repository: a full https URL, or <group>/<project>.");
    }

    // 显式 `--dir` = 「就铺到这儿，别的什么都别做」—— 给那些不读通用目录的 agent 用的逃生口，
    // 所以那一档不接任何链接（接了反而会往用户没要求的地方写）。
    const explicitDirectory = command === "list" ? undefined : option(args, "--dir");
    const named = command === "update" ? args.filter((one) => !one.startsWith("--")) : [];
    for (const one of named) args.splice(args.indexOf(one), 1);
    const directory = explicitDirectory ?? defaultSkillsDirectory();
    if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);

    // currentAuthorization 会在令牌快过期时先刷新 —— 同步是一次可能不短的下载，拿一枚
    // 马上就到期的令牌出门没有意义。
    const authorization = await auth.currentAuthorization();
    const remote = { issuer: authorization.issuer, accessToken: authorization.accessToken };

    if (command === "list") {
      // ⚠ 列的是**你装过什么**，不是「平台提供什么」—— 后者已经没有出处了：仓由调用方
      // 指定，PEP 只判主机，不再维护一张下发目录。硬编一个「推荐清单」等于把那张表挪个
      // 地方，而它迟早与现实分叉。
      const installed = await installedPackages(fileSkillsStateStore());
      if (installed.length === 0) {
        console.error("Nothing added yet. Run `pep skills add <repo>`.");
        return;
      }
      for (const one of installed) console.log(one);
      console.error("\n`pep skills update` refreshes all of them.");
      return;
    }

    const stateStore = fileSkillsStateStore();
    const installed = await installedPackages(stateStore);
    const targets =
      command === "add" ? [requested as string] : named.length > 0 ? named : installed;
    if (targets.length === 0) {
      // `update` 而账上一个都没有：不猜一个默认值去装，那会替用户做决定。
      console.error("Nothing added yet. Run `pep skills add <repo>`.");
      return;
    }
    // ⚠ 点名了一个没装过的：**说出来**，不要默默把它当成一次新安装 —— `update` 与 `add`
    // 是两件事，混起来会让一次手误变成一次静默安装。
    const unknown = named.filter((one) => !installed.includes(one));
    if (unknown.length > 0) {
      throw new Error(
        `Not added yet: ${unknown.join(" ")}. Run \`pep skills add <repo>\` first, or \`pep skills list\` to see what is.`,
      );
    }

    for (const source of targets) {
      const result = await updateSkills({
        ...remote,
        source,
        directory,
        ...(explicitDirectory === undefined ? { linkInto: claudeSkillsDirectory() } : {}),
        stateStore,
      });
      reportUpdate(result);
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
  throw new Error(`Unknown auth command.\n\n${usage(VERSION, ["auth"])}`);
}

