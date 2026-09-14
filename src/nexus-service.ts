import {
  persistMavenEnv,
  resolveTarget,
  type MavenCredential,
  type MavenEnvResult,
  type MavenEnvTarget,
} from "./maven-env.js";

const CREDENTIAL_PATH = "/api/nexus/credential";

/** PEP 回的凭据。密码**只在这一次响应里出现** —— 平台不存，丢了只能找运维在 Nexus 上重置。 */
export type NexusCredential = MavenCredential;

export type NexusSetupResult = {
  /** 持久化到哪儿了、有没有落成。 */
  persisted: MavenEnvResult;
};

export type NexusDependencies = {
  issuer: string;
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  /** 注入只为可测；默认按当前平台与 `$SHELL` 推。 */
  target?: MavenEnvTarget;
  os?: string;
  now?: () => Date;
};

/**
 * 把 HTTP 状态翻成「你该做什么」。
 *
 * ⚠ **403 分两种，措辞必须分开**：一种是这枚客户端没获准这个 scope（要找运维改
 * `allowed_scopes`），一种是这家公司的契约不含 Maven 仓库访问（要找商务）。
 * 服务端用两个错误码分开了它们（`32002` / `32003`），这里就不该合成一句和稀泥的话 ——
 * 指错方向比不指方向更费时间。
 */
function describeFailure(status: number, code: string | undefined): string {
  if (status === 401) {
    return "PEP rejected the access token. Run `pep auth login` again.";
  }
  if (status === 403 && code === "32003") {
    return "Your organisation's contract does not include Maven repository access. Contact your Newland representative — re-logging in will not change this.";
  }
  if (status === 403) {
    // 本 CLI 的 `DEFAULT_SCOPES` **含** `nexus-credentials:write`，所以令牌里没有它只有一个
    // 成因：这枚客户端在 PEP 那侧的 `allowed_scopes` 里没获准它。措辞指向那一侧。
    return "This access token carries no `nexus-credentials:write` scope. Ask an operator to add it to this client's allowed_scopes in PEP, then run `pep auth login` again — existing tokens do not gain new scopes.";
  }
  if (status === 409) {
    // 409 = 这家公司已经开过一份了。⚠ 平台不存密码，所以这里**拿不回**那一份 ——
    // 不能假装「已经有了，没事」，那会让人以为凭据已经配好。
    return "This organisation already has a Maven credential. PEP does not store the password, so it cannot be shown again — ask an operator to reset it in Nexus, or reuse the one you saved earlier.";
  }
  if (status === 503) {
    return "PEP could not reach Nexus (not configured, or upstream is down). This is a platform-side problem — retrying will not help. Report it to a PEP operator.";
  }
  return `PEP answered ${status} when asking for a Maven credential.`;
}

/** 尽力从错误体里取本仓错误码；取不到就算了，`describeFailure` 有兜底。 */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** 向 PEP 要一份凭据。**不落盘、不打印** —— 那是调用方的事。 */
export async function fetchNexusCredential(
  dependencies: Pick<NexusDependencies, "issuer" | "accessToken" | "fetch">,
): Promise<NexusCredential> {
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const response = await doFetch(`${dependencies.issuer.replace(/\/+$/, "")}${CREDENTIAL_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dependencies.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(describeFailure(response.status, await errorCodeOf(response)));
  }
  const body = (await response.json()) as { data?: { username?: unknown; password?: unknown } };
  const username = body.data?.username;
  const password = body.data?.password;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new Error("PEP returned a credential without a username or password.");
  }
  return { username, password };
}

/**
 * 取一份凭据，落成 `NEWLAND_MAVEN_USERNAME` / `NEWLAND_MAVEN_PASSWORD` 两个环境变量。
 *
 * 只返回持久化结果，不把用户名和密码交给 CLI 输出。失败由 CLI 报错，提示联系运维重置。
 */
export async function setupNexusCredential(
  dependencies: NexusDependencies,
): Promise<NexusSetupResult> {
  const credential = await fetchNexusCredential(dependencies);
  const target = dependencies.target ?? resolveTarget(dependencies.os);

  const persisted = await persistMavenEnv(credential, target, dependencies.now).catch(
    (error: unknown): MavenEnvResult => ({
      status: "manual",
      reason: (error as Error).message,
      ...(target.kind === "profile" ? { path: target.path } : {}),
    }),
  );

  return { persisted };
}
