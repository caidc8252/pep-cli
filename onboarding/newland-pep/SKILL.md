---
name: newland-pep
description: 接入 Newland PEP 平台。当用户要读 Newland / PEP 的开发者文档、接入 PEP 的 SDK 或接口、获取 Maven 仓库凭据，或提到 pep-cli / PEP 账号时使用。本 skill 只负责把工具装好并登录，之后由平台下发的 skills 接管。
---

# 接入 Newland PEP

PEP 的开发者文档与接入指南**不公开**，要凭 PEP 账号读取。`pep-cli` 是那把钥匙：它换取一枚
访问令牌，然后用它取文档、并把平台维护的其余 skills 同步下来。

**本 skill 只做引导。** 真正的接入指南是 `pep skills sync` 同步下来的那些——它们由平台维护、
随时更新。本文件刻意不复制它们的内容：复制一份就会过期，而过期的接入指南比没有更糟。

## 第 1 步 · 装

```bash
npm i -g @newlandnpt/pep-cli
```

装完有两个命令名，同一个程序：`pep`（下文都用它）和 `pep-cli`（脚本里用这个更稳，`pep`
这个名字任何人都能占）。

**只支持 Windows 和 macOS**，需要 Node.js ≥ 24。Linux 上 `npm` 会直接拒装
（`EBADPLATFORM`）——令牌要存进操作系统的凭据库（Windows 凭据管理器 / macOS 登录钥匙串），
Linux 那一侧还没实现。这是刻意让它在安装时就失败，而不是装上之后第一次登录才失败。

## 第 2 步 · 登录（**这一步需要用户本人操作，agent 做不了**）

```bash
pep auth login --issuer https://pep-webapp-view.onrender.com
```

会打开浏览器，让用户用 PEP 账号登录并确认授权。令牌存进操作系统凭据库，不落文件。

> `--issuer` 目前必须带。生产地址上的授权服务还没部署完，所以要显式指到当前可用的环境。
> **带一次就会被记住**，之后 `pep auth login` 不用再带。等生产上线，这个参数整个不需要了。

**agent 到这里要停下**：打印上面那条命令，请用户执行并在完成后告知。不要试图代替用户
登录、不要询问账号密码、不要反复重试——授权码流程要求真人在浏览器里同意。

验证是否已登录：

```bash
pep auth status
```

## 第 3 步 · 同步平台下发的 skills

```bash
pep skills sync
```

它把平台维护的接入指南写进 Claude Code 找 skill 的目录（`~/.claude/skills`，`--dir` 可改）。
只动它自己写过的那些，用户手放进去的文件不碰。

**同步完要主动去读那些文件**：新写入的 skill 不一定当场被会话发现。直接读
`~/.claude/skills/<名字>/SKILL.md`，不要等它自动出现。

## 读文档

```bash
pep docs list              # 这个账号能读的文档：路径 + 说明
pep docs get <路径>        # 把那一篇按 markdown 打到 stdout
```

`docs list` 只列**这个账号有权读**的部分——列表比别人短是正常的，不是坏了。文档站地址已
内置，不用配。

## 给别的工具用令牌

```bash
pep auth token             # 打印一枚当前有效的访问令牌
```

curl 或别的 HTTP 客户端要直接打 PEP 接口时用它。**不要把令牌写进文件或提交进版本库。**

## 出错了怎么读

| 现象 | 含义 | 怎么办 |
|---|---|---|
| `EBADPLATFORM`（装的时候） | 当前系统不支持 | 换 Windows 或 macOS |
| 提示未登录 / 401 | 没登录，或令牌过期/被吊销 | 重跑第 2 步 |
| `docs list` 是空的 | 登录成功了，但这个账号没被授予任何文档 | 找 PEP 管理员开权限，不是 CLI 的问题 |
| `docs get` 回 403 | 有账号但没这一篇的权限 | 同上 |
| `skills sync` 回 503 | **平台侧**的问题（上游仓库没配好或不可达） | 报给 PEP 管理员，重试无用 |
| `invalid_scope` / 400 | 这个环境的客户端登记与 CLI 版本不匹配 | 报给 PEP 管理员 |

**503 和 403 要分清**：403 是「你的权限不够」，503 是「平台自己出问题了」。前者找管理员开
权限，后者找管理员修——都不是靠重试能解决的。
