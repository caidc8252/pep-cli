import { describe, expect, it, vi } from "vitest";
import {
  contentPathFor,
  fetchDocContent,
  fetchDocsIndex,
  parseDocsIndex,
} from "./docs-service.js";

const deps = (fetchImpl: unknown) => ({
  docsUrl: "https://docs.example.com",
  accessToken: "tok",
  fetch: fetchImpl as typeof globalThis.fetch,
});

describe("parseDocsIndex", () => {
  it("读出标题、路径、描述", () => {
    const text = [
      "- [Introduction](/global/en/docs/Terminal/Introduction): Elevate your payments",
      "- [Semi-integrated](/global/en/docs/Terminal/Semi): How to integrate",
    ].join("\n");

    expect(parseDocsIndex(text)).toEqual([
      {
        title: "Introduction",
        path: "/global/en/docs/Terminal/Introduction",
        description: "Elevate your payments",
      },
      {
        title: "Semi-integrated",
        path: "/global/en/docs/Terminal/Semi",
        description: "How to integrate",
      },
    ]);
  });

  it("没有描述的条目照样收，不带 description 键", () => {
    expect(parseDocsIndex("- [Only title](/global/en/docs/A)")).toEqual([
      { title: "Only title", path: "/global/en/docs/A" },
    ]);
  });

  it("描述是空白 ⇒ 当作没有", () => {
    expect(parseDocsIndex("- [T](/global/en/docs/A):   ")).toEqual([
      { title: "T", path: "/global/en/docs/A" },
    ]);
  });

  // 那份文件的格式归文档站 —— 多一行标题或空行不该让整个清单取不出来。
  it("认不出的行跳过，不抛", () => {
    const text = [
      "# Some heading",
      "",
      "- [Kept](/global/en/docs/A): yes",
      "not a list item at all",
      "- malformed line without a link",
    ].join("\n");

    expect(parseDocsIndex(text).map((one) => one.path)).toEqual(["/global/en/docs/A"]);
  });

  it("空文本 ⇒ 空数组", () => {
    expect(parseDocsIndex("")).toEqual([]);
  });

  it("描述里带冒号：只按第一个切，右边整段留下", () => {
    expect(parseDocsIndex("- [T](/global/en/docs/A): 先这个: 再那个")[0].description).toBe(
      "先这个: 再那个",
    );
  });
});

describe("contentPathFor —— 页面地址 → 正文地址", () => {
  it("llms.mdx 插在 docs 之前，结尾补 content.md", () => {
    expect(contentPathFor("/global/en/docs/Terminal/Introduction")).toBe(
      "/global/en/llms.mdx/docs/Terminal/Introduction/content.md",
    );
  });

  it("前导斜杠可有可无、尾斜杠剥掉", () => {
    expect(contentPathFor("global/en/docs/A/")).toBe("/global/en/llms.mdx/docs/A/content.md");
  });

  // 从别处抄来一个完整正文地址时不该被二次加工。
  it("已经是正文地址的原样放过", () => {
    const already = "/global/en/llms.mdx/docs/A/content.md";
    expect(contentPathFor(already)).toBe(already);
  });

  it("已带 llms.mdx 但没有 content.md ⇒ 补上", () => {
    expect(contentPathFor("/global/en/llms.mdx/docs/A")).toBe(
      "/global/en/llms.mdx/docs/A/content.md",
    );
  });

  it("路径里没有 docs 段 ⇒ 抛（那不是一篇文档）", () => {
    expect(() => contentPathFor("/global/en/blog/A")).toThrow(/Not a documentation path/);
  });
});

describe("fetchDocsIndex / fetchDocContent", () => {
  it("清单打 /llms.txt，带 Bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("- [T](/global/en/docs/A): d"));

    expect(await fetchDocsIndex(deps(fetchImpl))).toEqual([
      { title: "T", path: "/global/en/docs/A", description: "d" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("https://docs.example.com/llms.txt", {
      headers: { Authorization: "Bearer tok", Accept: "text/plain" },
    });
  });

  it("docsUrl 的尾斜杠不会拼出双斜杠", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(""));
    await fetchDocsIndex({ ...deps(fetchImpl), docsUrl: "https://docs.example.com///" });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("https://docs.example.com/llms.txt");
  });

  // 空清单不是故障，是权限的答案。
  it("空清单回空数组，不抛", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(""));
    expect(await fetchDocsIndex(deps(fetchImpl))).toEqual([]);
  });

  it("正文按 text/markdown 要，路径已映射过", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("# Introduction"));

    expect(await fetchDocContent(deps(fetchImpl), "/global/en/docs/Terminal/Introduction")).toBe(
      "# Introduction",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://docs.example.com/global/en/llms.mdx/docs/Terminal/Introduction/content.md",
      { headers: { Authorization: "Bearer tok", Accept: "text/markdown" } },
    );
  });
});

describe("失败的归因 —— 每一种都说清下一步", () => {
  it.each([
    [401, /pep auth login/],
    [403, /docs:read/],
    // ⚠ 文档站故意让「不存在」与「没权限」不可区分，所以这里也不替它猜。
    [404, /No such document, or your account cannot read it/],
    [502, /could not reach PEP/],
    [500, /answered 500/],
  ])("%i", async (status, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status }));
    await expect(fetchDocsIndex(deps(fetchImpl))).rejects.toThrow(expected);
  });
});
