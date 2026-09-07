import { describe, expect, it } from "vitest";
import { readTar } from "./tar.js";

const BLOCK = 512;
const encoder = new TextEncoder();

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(encoder.encode(text).subarray(0, length));
  return out;
}

function header(options: {
  name?: string;
  size?: number;
  type?: string;
  prefix?: string;
  magic?: string;
}): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(field(options.name ?? "", 100), 0);
  block.set(field(`${(options.size ?? 0).toString(8).padStart(11, "0")}\0`, 12), 124);
  block[156] = (options.type ?? "0").charCodeAt(0);
  block.set(field(options.magic ?? "ustar\0", 6), 257);
  block.set(field(options.prefix ?? "", 155), 345);
  return block;
}

/** 数据块按 512 补零。 */
function payload(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}

function entry(options: Parameters<typeof header>[0], body = ""): Uint8Array[] {
  return [header({ ...options, size: encoder.encode(body).length }), payload(body)];
}

function archive(...parts: Uint8Array[][]): Uint8Array {
  const blocks = [...parts.flat(), new Uint8Array(BLOCK), new Uint8Array(BLOCK)];
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("readTar", () => {
  it("读出普通文件的路径与内容", () => {
    const entries = readTar(archive(entry({ name: "skills/a/SKILL.md" }, "# a")));
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("skills/a/SKILL.md");
    expect(text(entries[0].data)).toBe("# a");
  });

  it("数据不足 512 时按块补零，下一条照样读得到", () => {
    const entries = readTar(
      archive(entry({ name: "a.md" }, "short"), entry({ name: "b.md" }, "also short")),
    );
    expect(entries.map((one) => one.path)).toEqual(["a.md", "b.md"]);
    expect(text(entries[1].data)).toBe("also short");
  });

  it("跨块的大文件读得完整", () => {
    const body = "x".repeat(BLOCK + 7);
    const entries = readTar(archive(entry({ name: "big.md" }, body)));
    expect(text(entries[0].data)).toBe(body);
  });

  // ⚠ GitLab 的归档根是 `<项目>-<ref>-<40 位 sha>/`，六十来字符；再接一层 references 很容易
  // 越过 name 那 100 字节，路径就落到 prefix 里。只读 name 的实现会静默少文件。
  it("prefix + name 拼成完整路径", () => {
    const entries = readTar(
      archive(entry({ prefix: "agent-skills-main-0123456789abcdef", name: "skills/a/SKILL.md" })),
    );
    expect(entries[0].path).toBe("agent-skills-main-0123456789abcdef/skills/a/SKILL.md");
  });

  it("prefix 为空时不多插一个斜杠", () => {
    const entries = readTar(archive(entry({ name: "a.md" })));
    expect(entries[0].path).toBe("a.md");
  });

  it("pax 扩展头（x）里的 path 覆盖后一条的名字", () => {
    const record = "0000 path=skills/very/long/name/SKILL.md\n";
    const entries = readTar(
      archive(entry({ name: "PaxHeader", type: "x" }, record), entry({ name: "short" }, "body")),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("skills/very/long/name/SKILL.md");
    expect(text(entries[0].data)).toBe("body");
  });

  it("pax 头里没有 path 记录时不改名", () => {
    const entries = readTar(
      archive(entry({ name: "PaxHeader", type: "x" }, "0000 mtime=1.0\n"), entry({ name: "a.md" })),
    );
    expect(entries[0].path).toBe("a.md");
  });

  it("GNU 长名（L）同样覆盖后一条", () => {
    const entries = readTar(
      archive(
        entry({ name: "././@LongLink", type: "L" }, "skills/gnu/SKILL.md\0"),
        entry({ name: "truncated" }, "body"),
      ),
    );
    expect(entries[0].path).toBe("skills/gnu/SKILL.md");
  });

  // 长名描述的是紧跟其后的那一条；后面跟的是目录时它就该作废，不能顺延给再下一条。
  it("长名后面跟的不是普通文件 ⇒ 那个名字作废", () => {
    const entries = readTar(
      archive(
        entry({ name: "@LongLink", type: "L" }, "skills/ghost/SKILL.md\0"),
        entry({ name: "skills/a/", type: "5" }),
        entry({ name: "skills/a/SKILL.md" }, "real"),
      ),
    );
    expect(entries.map((one) => one.path)).toEqual(["skills/a/SKILL.md"]);
  });

  it("目录条目不进结果 —— 空目录不是内容", () => {
    const entries = readTar(
      archive(entry({ name: "skills/", type: "5" }), entry({ name: "skills/a/SKILL.md" })),
    );
    expect(entries.map((one) => one.path)).toEqual(["skills/a/SKILL.md"]);
  });

  it("NUL 类型标志也算普通文件（早期实现的写法）", () => {
    const entries = readTar(archive(entry({ name: "a.md", type: "\0" }, "body")));
    expect(entries.map((one) => one.path)).toEqual(["a.md"]);
  });

  it("读到全零块即收尾，之后的字节一概不看", () => {
    const bytes = archive(entry({ name: "a.md" }, "first"));
    const trailing = new Uint8Array(bytes.length + BLOCK * 2);
    trailing.set(bytes);
    trailing.set(header({ name: "after-the-end.md" }), bytes.length);
    expect(readTar(trailing).map((one) => one.path)).toEqual(["a.md"]);
  });

  it("空归档（只有收尾块）⇒ 空数组", () => {
    expect(readTar(archive())).toEqual([]);
  });

  it("不是 ustar ⇒ 抛，而不是回一个空数组", () => {
    expect(() => readTar(archive(entry({ name: "a.md", magic: "nope\0" })))).toThrow(
      /not a ustar/,
    );
  });

  it("大小字段读不出数 ⇒ 抛", () => {
    const block = header({ name: "a.md" });
    block.set(field("zzzzzzzzzzz\0", 12), 124);
    expect(() => readTar(archive([block, new Uint8Array(BLOCK)]))).toThrow(/unreadable size/);
  });
});
