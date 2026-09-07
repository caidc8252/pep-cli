/**
 * 够用的 tar 读取器 —— 只为读 GitLab 打出来的那种归档，不是通用实现。
 *
 * 为什么手写而不引包：本 CLI 是**零运行时依赖**，最终由 esbuild 打成单文件、再由 postject
 * 塞进一个可执行文件。为了读一种结构极简的格式引一整棵依赖树，代价和收益不成比例 ——
 * tar 就是「512 字节头 + 按 512 对齐的数据」，没有压缩、没有索引、没有状态机。
 * （gzip 那层用 `node:zlib`，那个是内置的。）
 *
 * 支持到的：ustar 头、`prefix` 长路径、pax 扩展头（`path=`）、GNU 长名（`L`）。
 * ⚠ **`prefix` / pax 不是可选项**：GitLab 的归档根目录是 `<项目>-<ref>-<40 位 sha>/`，
 * 光这一层就六十来个字符，再接 `skills/<name>/references/<file>.md` 很容易越过 `name`
 * 字段那 100 字节的上限 —— 那时路径会落到 `prefix` 或 pax 头里。只读 `name` 的实现会在
 * 「skill 名字变长一点」的那天忽然少几个文件，而且不报错。
 *
 * 不支持：GNU base-256 大小编码（8 GB 以上的单文件）、稀疏文件、链接。skills 是 markdown。
 */

const BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPE_OFFSET = 156;
const MAGIC_OFFSET = 257;
const MAGIC_LENGTH = 6;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

export type TarEntry = { path: string; data: Uint8Array };

const decoder = new TextDecoder();

/** 头里的字符串字段是 NUL 补齐的定长块。 */
function readString(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
}

/** 数值字段是八进制文本，可能以空格或 NUL 收尾。 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Malformed archive: unreadable size field.");
  }
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** pax 扩展头的记录形如 `<长度> <键>=<值>\n`；这里只取 `path`。 */
function paxPath(text: string): string | undefined {
  for (const match of text.matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g)) {
    if (match[1] === "path") return match[2];
  }
  return undefined;
}

/**
 * 读出归档里的**普通文件**。目录条目、链接、全局 pax 头一律跳过 —— 目录由写盘那侧按文件
 * 路径自己建，空目录不是内容。
 */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  // 长名头（pax `x` / GNU `L`）描述的是**紧跟其后**的那一条，用完即弃。
  let overrideName: string | undefined;
  let offset = 0;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    // 归档以两个全零块收尾。读到第一个就够了 —— 后面不会再有内容。
    if (isZeroBlock(header)) break;
    if (!readString(header, MAGIC_OFFSET, MAGIC_LENGTH).startsWith("ustar")) {
      throw new Error("Malformed archive: not a ustar tar stream.");
    }

    const size = readOctal(header, SIZE_OFFSET, SIZE_LENGTH);
    const type = String.fromCharCode(header[TYPE_OFFSET]);
    const dataStart = offset + BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);
    // 数据按 512 对齐，不足补零。
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      overrideName = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      overrideName = paxPath(decoder.decode(data)) ?? overrideName;
      continue;
    }
    // `0` 与 NUL 都表示普通文件（后者是早期实现的写法）。其余类型跳过，并丢掉刚攒下的
    // 长名 —— 它描述的是这一条，不该顺延到下一条。
    if (type !== "0" && type !== "\0") {
      overrideName = undefined;
      continue;
    }

    const name = readString(header, NAME_OFFSET, NAME_LENGTH);
    const prefix = readString(header, PREFIX_OFFSET, PREFIX_LENGTH);
    entries.push({
      path: overrideName ?? (prefix === "" ? name : `${prefix}/${name}`),
      data,
    });
    overrideName = undefined;
  }

  return entries;
}
