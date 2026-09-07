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
 * 上一次 `pep skills sync` 留下的账 —— 单独一个文件，不并进 `CliConfig`。
 *
 * 分开是因为登录会**整份重写** config（`auth-service.login` 里的 `configStore.write`），
 * 同步状态并进去就会被一次重新登录抹掉，而那时本地磁盘上的 skills 还在 —— 账和事实对不上，
 * 下一次同步会以为什么都没同步过。
 */
export type SkillsState = {
  version: 1;
  /** 上次装下的那个提交（PEP 的 `X-Skills-Commit`）。服务端摘不到时没有这个键。 */
  commit?: string;
  /** 上次写进磁盘的 skill 名字。**只有这些才允许被删** —— 用户自己放的 skill 不归我们管。 */
  skills: string[];
  /** 上次写到哪儿。换目录后旧的那批要照着它清掉。 */
  directory: string;
};

export interface SkillsStateStore {
  read(): Promise<SkillsState | null>;
  write(state: SkillsState): Promise<void>;
}
