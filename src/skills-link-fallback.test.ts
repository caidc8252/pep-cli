// @vitest-environment node
//
// 「建不成链接就复制」这一条单独一个文件，因为它要 `vi.mock` 掉 `node:fs/promises` 的
// `symlink` —— 而 `vi.mock` 是**文件级**的（会被提升到文件顶部），放进 skills-service.test.ts
// 会把那边所有真实文件操作一起换掉。
//
// 为什么非得 mock：这个降级路径在 Linux 上**造不出真实失败** —— 任何能挡住 symlink 的条件
// （目录不可写、权限被拒）同样会挡住随后的复制，于是测不到「symlink 失败但复制成功」这一格。
// 真实触发场景是 Windows 上 junction 不可用、或 FAT32 一类不支持链接的文件系统，都不在 CI 里。
//
// ⚠ 这一格值得测：它是**用户看不见的降级**。失败了不报错、不提示，只把 `copiedCount` 记进
// 结果 —— 所以一旦它坏掉（比如有人把 catch 里的 cp 删了），表现是「链接目录里什么都没有」
// 而同步报成功，没有任何一行日志指向真因。
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: vi.fn().mockRejectedValue(new Error("EPERM: operation not permitted")),
  };
});

const { syncSkills } = await import("./skills-service.js");

const ROOT = "agent-skills-main-0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

/** 最小 ustar 归档：一个 512 头 + 内容，末尾两个空块。 */
function gzippedArchive(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, body] of Object.entries(files)) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(path), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    const size = encoder.encode(body).length;
    header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.set(encoder.encode("        "), 148);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0" + "00"), 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header);
    const content = new Uint8Array(Math.ceil(size / 512) * 512);
    content.set(encoder.encode(body));
    blocks.push(content);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return gzipSync(out);
}

describe("链接建不成时降级成复制", () => {
  it("整次同步照样成功，内容照样到位，并如实报出复制了几个", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pep-canon-"));
    const linkInto = await mkdtemp(join(tmpdir(), "pep-link-"));

    const result = await syncSkills({
      issuer: "https://pep.example.com",
      accessToken: "tok",
      directory,
      linkInto,
      stateStore: { read: async () => null, write: async () => {} },
      fetch: vi.fn().mockResolvedValue(
        new Response(gzippedArchive({ [`${ROOT}/skills/coding/SKILL.md`]: "# coding" }), {
          headers: { "content-type": "application/gzip" },
        }),
      ) as unknown as typeof globalThis.fetch,
    });

    expect(result).toMatchObject({ status: "written", copiedCount: 1 });
    // 降级之后内容照样在 —— 这才是「成功」的判据，不是「用了哪种手段」。
    expect(await readFile(join(linkInto, "coding", "SKILL.md"), "utf8")).toBe("# coding");
    expect(await readFile(join(directory, "coding", "SKILL.md"), "utf8")).toBe("# coding");
  });
});
