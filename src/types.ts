export type CliConfig = {
  version: 1;
  issuer: string;
  clientId: string;
  redirectUri: string;
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
