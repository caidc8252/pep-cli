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
}
