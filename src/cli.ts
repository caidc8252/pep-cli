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
  projectSkillsTarget,
  userSkillsTarget,
  type SkillsTarget,
} from "./config.js";
import { systemCredentialStore } from "./credential-store.js";
import { createOAuthClient } from "./oauth-client.js";
import { fetchDocContent, fetchDocsIndex } from "./docs-service.js";
import { USERNAME_VAR, PASSWORD_VAR } from "./maven-env.js";
import { setupNexusCredential } from "./nexus-service.js";
import { updateSkills, type SkillsUpdateResult } from "./skills-service.js";
import type { CliConfig, ConfigStore } from "./types.js";

declare const __PEP_VERSION__: string | undefined;
/** 构建期由 `scripts/build-js.mjs` 从 package.json 注入 —— 源码里不再抄一份，理由见那里。 */
const VERSION = typeof __PEP_VERSION__ === "undefined" ? "0.0.0-dev" : __PEP_VERSION__;

function usage(): string {
  return `PEP CLI ${VERSION}

Usage:
  pep auth login [--issuer <url>] [--client-id <id>] [--resource <uri> ...]
  pep auth status
  pep auth token
  pep auth logout
  pep skills list
  pep skills add <repo-url | group/project[@ref]> [-p | --dir <path>]
  pep skills update [<repo>...] [-p | --dir <path>]
  pep docs list [--docs-url <url>]
  pep docs get <path> [--docs-url <url>]
  pep nexus setup

The issuer is built into this executable. --issuer overrides it for that one command and is
NOT remembered — pass it every time you log in against a non-default deployment.
--resource names which resource server the token is for (RFC 8707); repeat it for more than
one. It defaults to the docs platform — a token minted without it is rejected by every
resource server, and their answer looks exactly like "this token does not exist".
Use \`pep auth token\` when another agent needs a fresh bearer token.

\`pep skills add\` takes a repository on the platform's own GitLab, either as a full https URL or
as the path with the host left off:

  pep skills add https://git.example.com/group/sub/project
  pep skills add https://git.example.com/group/sub/project/-/tree/some-branch
  pep skills add group/sub/project
  pep skills add group/sub/project@some-branch

Anything on another host is refused. PEP fetches it with its own read-only service account, so no
GitLab credential ever reaches this machine. \`pep skills list\` shows what you have added and
\`pep skills update\` refreshes it — all of it, or just the repositories you name. One repository
may hold more than one skill: every directory containing a SKILL.md becomes one, wherever it sits,
and update reports which of them actually changed rather than just that the repository moved.

\`pep skills update\` fetches the latest skills from PEP and writes them to the shared agent
directory (${defaultSkillsDirectory()}), which Codex, Cursor, Amp and ~20 other agents read
directly. Claude Code keeps its own directory, so each skill is also linked into
${claudeSkillsDirectory()} — one copy on disk, updated in one place. Where links are not
available the skill is copied instead and the run says so.

-p, --project installs into the CURRENT PROJECT instead: ./.agents/skills plus the same link into
./.claude/skills. Use it when the skills belong to one repository and should be committed with
it; note both directories then show up in git status, which is why the personal location is the
default.

--dir <path> writes to that path ONLY and skips the linking, for an agent that reads neither
directory.

Where a repository was installed is remembered, so \`pep skills update\` refreshes each one where
it already lives and never moves anything. On update, -p and --dir instead NARROW the run to the
repositories installed there: \`pep skills update -p\` refreshes only this project's, and reports
nothing to do when the project has none. To move a repository, add it again with the new flag —
add is where the location is decided, and the copy in the old location is then removed.
Delete a skill folder by hand and update LEAVES IT DELETED — it refreshes what is still there and
reports the ones it left alone. Run \`pep skills add <repo>\` to put them back; add is the command
that installs. Either way update only touches skills it wrote itself; anything you put there by
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
  // ⚠ 跳过的必须说出来，而且要说清**怎么让它回来** —— 否则「我明明 update 了，它怎么还
  // 没有」这件事，命令行上一点线索都没有。
  if (result.skipped.length > 0) {
    console.log(`  deleted locally, left alone: ${result.skipped.join(" ")}`);
    console.log(`  (\`pep skills add ${result.name}\` puts them back)`);
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

/**
 * 摘一个布尔开关（可以有多个拼法，长短形式都收）。给了就从 `args` 里拿掉，好让剩下的
 * 按位置参数处理。重复给同一个开关不算错 —— 一律摘干净，否则残下的那个会被当成「不认识
 * 的选项」报出来，而用户只是多敲了一次。
 */
function flag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const name of names) {
    for (let index = args.indexOf(name); index !== -1; index = args.indexOf(name)) {
      args.splice(index, 1);
      found = true;
    }
  }
  return found;
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

/**
 * `pep skills <command>` 的参数 → 「要哪几个包 + 铺到哪儿」。**纯函数，为的是可测**
 * （`main` 那条路要先过钥匙串，linux 上根本跑不到这里）。
 *
 * ⚠ **选项必须先摘，位置参数后取。** 反过来做了半年：`update` 那侧先按「不以 `--` 开头」
 * 捞位置参数，而 `--dir <path>` 的**值**恰好不以 `--` 开头，于是它被当成一个仓库名吃掉，
 * `option()` 再去找就只剩一个光杆 `--dir` ——`pep skills update --dir <path>` 因此
 * **无论怎么写都报「--dir requires a value.」**（2026-09-15 实测确认，钉在 cli.test.ts）。
 */
export function parseSkillsArgs(
  command: "add" | "update" | "list",
  args: string[],
  cwd?: string,
): { requested?: string; named: string[]; chosenTarget?: SkillsTarget } {
  const explicitDirectory = command === "list" ? undefined : option(args, "--dir");
  const project = command === "list" ? false : flag(args, "--project", "-p");
  if (explicitDirectory !== undefined && project) {
    // 两个都给 = 两个互相矛盾的落点。挑一个去执行等于替用户猜，而猜错是静默铺错地方。
    throw new Error("--dir and --project/-p cannot be used together: they name different places.");
  }
  // 选项摘完，剩下还以 `-` 开头的就是不认识的。⚠ 判 `-` 而不是 `--`：短选项进来之后，
  // 只判双横线会让 `-x` 这种笔误漏过去、被当成一个仓库名，于是报「取不到这个仓」——
  // 那句话指向的是 GitLab，而错在命令行。仓库路径不会以 `-` 开头，这里不会误伤。
  const unknownOption = args.find((one) => one.startsWith("-"));
  if (unknownOption) throw new Error(`Unknown option: ${unknownOption}`);

  // `add` 收恰好一个位置参数；`update` 收零个或多个（零个 = 全部已装的）；`list` 一个不收。
  const requested = command === "add" ? args.shift() : undefined;
  if (command === "add" && !requested) {
    throw new Error("pep skills add needs a repository: a full https URL, or <group>/<project>.");
  }
  const named = command === "update" ? [...args] : [];
  if (command !== "update" && args.length > 0) {
    throw new Error(`Unexpected argument: ${args[0]}`);
  }

  // 本次**显式**指定的落点。`undefined` = 没指定，那时沿用账上记的（见 `targetForSource`）
  // —— 这正是 v4 按包记落点换来的：`update` 不必再把 `--dir` / `--project` 重敲一遍。
  //
  // 显式 `--dir` = 「就铺到这儿，别的什么都别做」—— 给那些不读通用目录的 agent 用的逃生口，
  // 所以那一档不接任何链接（接了反而会往用户没要求的地方写）。
  const chosenTarget: SkillsTarget | undefined =
    explicitDirectory !== undefined
      ? { directory: explicitDirectory }
      : project
        ? projectSkillsTarget(cwd)
        : undefined;

  return { ...(requested !== undefined ? { requested } : {}), named, ...(chosenTarget ? { chosenTarget } : {}) };
}

/**
 * 这一次把这个包铺到哪儿：**本次显式给的 > 账上记的 > 个人级默认**。
 *
 * ⚠ 中间那一档是 v4 的全部意义 —— 用 `--project` / `--dir` 装过的包，此后 `update` 不带
 * 参数也回到原处。没有它的话（v3 就没有），一次 `update` 会把那些包**搬回**
 * `~/.agents/skills`，而原处那份没人清。
 */
export function targetForSource(
  chosen: SkillsTarget | undefined,
  recorded: { directory: string; linkedInto?: string } | undefined,
): SkillsTarget {
  if (chosen) return chosen;
  if (!recorded) return userSkillsTarget();
  return {
    directory: recorded.directory,
    ...(recorded.linkedInto !== undefined ? { linkInto: recorded.linkedInto } : {}),
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
    if (command !== "update" && command !== "add" && command !== "list") {
      throw new Error(`Unknown skills command.\n\n${usage()}`);
    }
    const { requested, named, chosenTarget } = parseSkillsArgs(command, args);

    // currentAuthorization 会在令牌快过期时先刷新 —— 同步是一次可能不短的下载，拿一枚
    // 马上就到期的令牌出门没有意义。
    const authorization = await auth.currentAuthorization();
    const remote = { issuer: authorization.issuer, accessToken: authorization.accessToken };

    if (command === "list") {
      // ⚠ 列的是**你装过什么**，不是「平台提供什么」—— 后者已经没有出处了：仓由调用方
      // 指定，PEP 只判主机，不再维护一张下发目录。硬编一个「推荐清单」等于把那张表挪个
      // 地方，而它迟早与现实分叉。
      const listed = await fileSkillsStateStore().read();
      const packages = Object.entries(listed?.packages ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (packages.length === 0) {
        console.error("Nothing added yet. Run `pep skills add <repo>`.");
        return;
      }
      // 落点也列出来。有了项目级之后「这个仓装在哪儿」就是看这张表的主要理由，
      // 也是**唯一**能看出 `update -p` 会命中哪几行的地方。制表符分隔，与 `docs list` 同形。
      for (const [source, pkg] of packages) console.log(`${source}\t${pkg.directory}`);
      console.error("\n`pep skills update` refreshes all of them, each where it lives.");
      return;
    }

    const stateStore = fileSkillsStateStore();
    const state = await stateStore.read();
    const installed = Object.keys(state?.packages ?? {}).sort();

    const run = async (source: string, target: SkillsTarget, restoreMissing = false) =>
      reportUpdate(
        await updateSkills({
          ...remote,
          source,
          directory: target.directory,
          ...(target.linkInto !== undefined ? { linkInto: target.linkInto } : {}),
          ...(restoreMissing ? { restoreMissing: true } : {}),
          stateStore,
        }),
      );

    if (command === "add") {
      // `add` 是「**放哪儿**」这个决定的唯一出口：本次显式给的赢，没给就沿用账上记的
      // （重复 add 同一个仓不会把它搬走），再没有就个人级默认。
      //
      // ⚠ 它也是「**装上**」这个动作的唯一出口：盘上被删掉的那些由它补回来
      // （`restoreMissing`），`update` 不管 —— 见那个字段的注释。
      await run(
        requested as string,
        targetForSource(chosenTarget, state?.packages[requested as string]),
        true,
      );
      return;
    }

    if (installed.length === 0) {
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

    // ⚠ **`update` 的 `-p` / `--dir` 是筛子，不是搬家。** 与 `npx skills` 同口径 —— 那边
    // `-p` 也是「只更新项目里的那些」。放哪儿只由 `add` 决定。
    //
    // 〔2026-09-15 补。此前它被当成落点，而 `update` 不点名时的目标是**账上所有包** ——
    // 于是在一个还没装过任何 skill 的项目里敲一下 `pep skills update -p`，个人级那些会被
    // 整体搬进这个项目、原处删掉。没人会想要那个，而且它不可逆。〕
    const wanted = named.length > 0 ? named : installed;
    const targets = chosenTarget
      ? wanted.filter((one) => state?.packages[one]?.directory === chosenTarget.directory)
      : wanted;

    if (targets.length === 0) {
      // 筛没了。**说清楚筛的是哪儿**，否则看起来像「什么都没发生」。
      console.error(`No skills are installed in ${chosenTarget?.directory}.`);
      console.error("`pep skills update` (no flag) refreshes every repository where it lives;");
      console.error("`pep skills add <repo> -p` installs one into this project.");
      return;
    }
    // 点了名却不在这个范围里的，逐个说出来 —— 默默跳过会让人以为已经更新了。
    const skipped = wanted.filter((one) => !targets.includes(one));
    if (skipped.length > 0) {
      console.error(`Not installed in ${chosenTarget?.directory}, skipped: ${skipped.join(" ")}`);
    }

    for (const source of targets) {
      // 落点一律取**账上记的** —— `update` 不搬家，理由见上面那段。
      await run(source, targetForSource(undefined, state?.packages[source]));
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

