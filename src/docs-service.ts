/**
 * 从文档平台取 markdown。
 *
 * 两个动作，对应 agent 的两跳：先读清单挑一篇（`llms.txt`），再取那一篇的正文。
 * 收在这里而不是让每个调用方各自拼 URL，是因为**路径形状是文档站的实现细节**：
 * 页面地址与正文地址不是同一个（见 `contentPathFor`），谁都硬编码一遍的话，文档站
 * 改一次布局就要改 N 处。
 */

/** 清单里的一条。`path` 是页面地址，原样喂给 `pep docs get` 即可。 */
export type DocsEntry = { title: string; path: string; description?: string };

/**
 * 解析 `llms.txt`。它是给模型读的纯文本索引，每行一条：
 *
 *     - [标题](/global/en/docs/Terminal/Introduction): 一句描述
 *
 * 描述可以没有。认不出的行**跳过而不是抛** —— 那份文件的格式归文档站，多一行标题或空行
 * 不该让整个清单取不出来。
 */
const ENTRY = /^-\s*\[([^\]]*)\]\(([^)]+)\)(?::\s*(.*))?$/;

export function parseDocsIndex(text: string): DocsEntry[] {
  const entries: DocsEntry[] = [];
  for (const line of text.split("\n")) {
    const match = ENTRY.exec(line.trim());
    if (!match) continue;
    const description = match[3]?.trim();
    entries.push({
      title: match[1],
      path: match[2],
      ...(description ? { description } : {}),
    });
  }
  return entries;
}

/**
 * 页面地址 → 正文地址。
 *
 *     /global/en/docs/Terminal/Introduction
 *   → /global/en/llms.mdx/docs/Terminal/Introduction/content.md
 *
 * `llms.mdx` 那一段插在 `docs` **之前**，正文以 `/content.md` 结尾 —— 这是文档站那条
 * 路由的形状（`app/[site]/[lang]/llms.mdx/docs/[[...slug]]`）。
 *
 * 已经是正文地址的原样放过：调用方从别处抄来一个完整地址时不该被二次加工。
 */
export function contentPathFor(path: string): string {
  const clean = `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  if (clean.includes("/llms.mdx/")) return clean.endsWith(".md") ? clean : `${clean}/content.md`;
  const segments = clean.split("/").filter(Boolean);
  const docsAt = segments.indexOf("docs");
  if (docsAt === -1) {
    throw new Error(`Not a documentation path (expected …/docs/…): ${path}`);
  }
  const before = segments.slice(0, docsAt);
  const after = segments.slice(docsAt);
  return `/${[...before, "llms.mdx", ...after, "content.md"].join("/")}`;
}

export type DocsDependencies = {
  docsUrl: string;
  accessToken: string;
  fetch?: typeof globalThis.fetch;
};

/** 把 HTTP 状态翻成「你该做什么」。文档站已经把三种失败分成了三个码。 */
function describeFailure(status: number, what: string): string {
  if (status === 401) {
    return `The documentation platform rejected the access token. Run \`pep auth login\` again.`;
  }
  if (status === 403) {
    return "This client is not allowed to read documentation — it needs the `docs:read` scope.";
  }
  if (status === 404) {
    // ⚠ 文档站故意让「这篇不存在」和「这篇你没权限」不可区分（不泄露存在性），
    // 所以这里也不能替它猜，只能把两种可能都说出来。
    return `No such document, or your account cannot read it: ${what}`;
  }
  if (status === 502) {
    return "The documentation platform could not reach PEP to verify the token. Retry shortly.";
  }
  return `The documentation platform answered ${status} for ${what}.`;
}

async function get(dependencies: DocsDependencies, path: string, accept: string): Promise<Response> {
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const response = await doFetch(`${dependencies.docsUrl.replace(/\/+$/, "")}${path}`, {
    headers: { Authorization: `Bearer ${dependencies.accessToken}`, Accept: accept },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(describeFailure(response.status, path));
  }
  return response;
}

/** 取清单。空清单不是错误 —— 它意味着这个身份一篇都读不到，那是权限的答案。 */
export async function fetchDocsIndex(dependencies: DocsDependencies): Promise<DocsEntry[]> {
  const response = await get(dependencies, "/llms.txt", "text/plain");
  return parseDocsIndex(await response.text());
}

/** 取一篇的正文原文。 */
export async function fetchDocContent(
  dependencies: DocsDependencies,
  path: string,
): Promise<string> {
  const response = await get(dependencies, contentPathFor(path), "text/markdown");
  return response.text();
}
