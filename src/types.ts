export type CliConfig = {
  version: 1;
  issuer: string;
  clientId: string;
  redirectUri: string;
  /**
   * 这枚令牌准备拿去访问哪些资源服务器（RFC 8707 的 `resource`，可多值）。
   * 缺省 = 旧版本写下的配置，登录时按 `DEFAULT_RESOURCES` 补。
   */
  resources?: string[];
  /**
   * 文档平台地址（`pep docs` 用）。**不内置默认值** —— 它跟 PEP 的 issuer 没有固定配对
   * 关系（同一个文档站可以对接任意一个 PEP 部署），编一个默认值会让人以为已经配好了。
   * 由 `--docs-url` 给一次，之后记住。
   */
  docsUrl?: string;
};

export type StoredAuthorization = {
  version: 1;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: number;
  scopes: string[];
};

export type DiscoveryDocument = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  userinfoEndpoint: string;
};

export type UserInfo = {
  sub: string;
  email?: string;
  name?: string;
};

export interface CredentialStore {
  read(): Promise<StoredAuthorization | null>;
  write(authorization: StoredAuthorization): Promise<void>;
  delete(): Promise<void>;
}

export interface ConfigStore {
  read(): Promise<CliConfig | null>;
  write(config: CliConfig): Promise<void>;
  /** 退出登录时连它一起清 —— 理由见 `auth-service.ts` 的 `logout`。 */
  delete(): Promise<void>;
}

/**
 * 上一次更新留下的账 —— 单独一个文件，不并进 `CliConfig`。
 *
 * 分开是因为登录会**整份重写** config（`auth-service.login` 里的 `configStore.write`），
 * 状态并进去就会被一次重新登录抹掉，而那时本地磁盘上的 skills 还在 —— 账和事实对不上，
 * 下一次更新会以为什么都没装过。
 *
 * ── v3 起逐个 skill 记内容哈希（2026-09-14）────────────────────────────────────
 * v2 只记「这个包铺出了哪些 skill 名」，能回答的问题止于「哪些目录是我们的」。而用户真正
 * 想知道的是「**我关心的那个 skill 变了没有**」—— 只比仓库 commit 答不了：仓里改一行
 * README、动一下 `evals/`，commit 就变了，于是每个 skill 都被报成「更新了」。
 *
 * 逐个记哈希之后，`update` 能分出 updated / unchanged。做法参照 `npx skills` 的
 * `.skill-lock.json`（它逐 skill 记 `skillFolderHash`，按 source+ref 分组取一次源再逐个比）。
 *
 * ── v4 起落点**按包**记（2026-09-15）──────────────────────────────────────────
 * v3 的 `directory` / `linkedInto` 在顶层，全局一份 —— 那等于断言「这台机器上所有包都铺在
 * 同一个地方」。加了 `--project` 之后这句话不再成立：项目级的包铺在 `<项目>/.agents/skills`，
 * 个人级的铺在 `~/.agents/skills`，同一本账上两种并存。
 *
 * ⚠ 顶层那一份还有个**当场就错**的后果：`update` 不带参数时算不出该往哪儿写，只能退回默认
 * 目录 —— 于是用 `--dir` 装的包，一次 `update` 就被搬回 `~/.agents/skills`，而原处那份没人清。
 * 按包记之后 `update` 读账即知落点，不必再带一次参数（这正是 v4 存在的理由）。
 */
export type SkillsState = {
  version: 4;
  /** 装过哪些包，键是调用方给的那串仓库地址（**原样，不规范化**）。 */
  packages: Record<string, SkillsPackageState>;
};

export type SkillsPackageState = {
  /** 上次装下的那个提交（PEP 的 `X-Skills-Commit`）。服务端摘不到时没有这个键。 */
  commit?: string;
  /**
   * **这个包**上次写到哪儿（canonical）。换落点后旧的那批要照着它清掉 —— v4 起按包记，
   * 理由见上面 SkillsState 的头注。
   */
  directory: string;
  /**
   * 上次把链接接进了哪个 agent 目录。移除某个 skill 时两处都要清 —— 只清 canonical 会
   * 留下一条指向空处的死链。`undefined` = 上次用了 `--dir`，没接链接。
   */
  linkedInto?: string;
  /**
   * 这个包上次铺出的每个 skill → 它的内容哈希。
   *
   * ⚠ 键就是「**只有这些才允许被删**」的那张名单 —— 用户自己放的、以及别的包铺的，都不归
   * 它管。值是 v3 新加的：空串 = 从 v2 迁过来、哈希未知，那一档一律当作「变了」，因为
   * 「不知道」不该被说成「没变」。
   */
  skills: Record<string, string>;
};

/** v3 的账。**只读** —— 它的落点在顶层，迁移时抄进每个包。 */
export type SkillsStateV3 = {
  version: 3;
  directory: string;
  linkedInto?: string;
  packages: Record<string, { commit?: string; skills: Record<string, string> }>;
};

/** v1 的账（2026-09-14 之前）。**只读**：遇到就迁到最新，不再写回这个形状。 */
export type SkillsStateV1 = {
  version: 1;
  commit?: string;
  skills: string[];
  directory: string;
  linkedInto?: string;
};

/** v2 的账。同样只读 —— 它的 `skills` 是名字数组，没有哈希。 */
export type SkillsStateV2 = {
  version: 2;
  directory: string;
  linkedInto?: string;
  packages: Record<string, { commit?: string; skills: string[] }>;
};

export interface SkillsStateStore {
  read(): Promise<SkillsState | null>;
  write(state: SkillsState): Promise<void>;
}
