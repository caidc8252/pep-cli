#!/usr/bin/env node
// 可执行入口。**只负责启动**，一行逻辑都不放。
//
// 为什么与 `cli.ts` 分开：`cli.ts` 末尾原本直接 `main().catch(...)`，于是任何 import 它的人
// 都会**顺带把 CLI 跑一遍**。2026-09-10 给 `loginConfig` 补测试时撞上这一点——测试文件
// import `./cli.js` 就执行了 main()，用的是 vitest 的 argv；那次侥幸没出事（vitest 的
// worker 隔离吞掉了 `process.exitCode = 1`），但那是运气，不是设计。
// 拆开之后：入口自我执行，逻辑随便 import。
import { main } from "./cli.js";

main().catch((error: unknown) => {
  console.error(`pep: ${(error as Error).message}`);
  process.exitCode = 1;
});
