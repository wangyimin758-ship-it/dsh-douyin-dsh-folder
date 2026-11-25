# dsh-douyin-dsh-folder

**第一版（v1.1.0）· 首次公开发布。** DSH 插件：抖音收藏夹只读学习。只学**精确匹配**配置目标的那一个收藏夹，学过的视频记入本地账本防重；归档到配置的归档夹只给人工确认步骤，不自动宣称已移入。这是它第一次亮相的样子。

## 它做什么

- 只读列出抖音收藏夹，确认目标收藏夹存在。
- 仅从目标收藏夹读取未学视频，返回轻量摘要（编号 + 标题 + id），完整详情写本地文件。
- 用本地账本记录已学视频 id，避免重复学习。
- 生成"移入归档夹"的人工步骤，界面勾选流程未验证，插件绝不自动点击隐藏控件、绝不宣称已移入。
- 页面出现登录、验证码、安全验证或不在 `www.douyin.com` 域名时，工具直接拒绝，不绕过。

## 设计取舍

- **目标可配置**：学习夹、归档夹、默认返回条数都可在运行时改，立即生效。
- **只读优先**：全程不改动抖音收藏状态；`[data-e2e="video-player-collect"]` 这类隐藏控件会翻转真实收藏态，插件不碰。
- **证据克制**：归档是否完成以"数量变化 + 用户人工核对"为准，插件只出步骤不代替确认。

## 前置条件

1. 一个已登录抖音的独立 Chrome，开启调试端口 `9222`（建议用独立 profile，别动日常 Chrome）。例如：

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --remote-debugging-port=9222 `
     --user-data-dir="$env:USERPROFILE\.dsh\douyin-chrome-profile"
   ```

   在这个窗口里手动登录抖音，之后保持它开着。端口可通过配置 `cdp` 改。

2. 插件通过 Chrome DevTools Protocol 连接，**不需要** playwright / puppeteer 等浏览器依赖。

## 安装

在 DSH 里安装（换成你自己的仓库地址）：

```bash
dsh plugin --profile web add link:<本仓库本地路径>
```

装完重启一次 DSH，bundle patch 才会组装。

## 配置

基线写在 `cordis.patch.yml` 的 `config`；运行时覆盖写在插件 home 目录的 `config.json`。用 `douyin_config` 工具查看或修改，**立即生效，无需重启，也不动 profile 的 patch 文件**。

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `learnable` | 精确匹配的学习目标收藏夹名 | `dsh` |
| `archived` | 归档目标收藏夹名 | `dsh已学` |
| `defaultLimit` | `douyin_dsh_pending` 默认返回条数（1–50） | `5` |
| `cdp` | 调试端口地址 | `http://127.0.0.1:9222` |
| `home` | 状态文件目录 | `~/.dsh/douyin-dsh-folder-data` |

`home` 留空或为占位符时，自动回退到当前用户 home 下的 `~/.dsh/douyin-dsh-folder-data`。修改示例（对 AI 说即可）："把学习目标改成 `课程收藏`"。

## 工具

| 工具 | 作用 |
| --- | --- |
| `douyin_config` | 查看或修改 learnable / archived / defaultLimit |
| `douyin_dsh_folders` | 只读列出收藏夹，确认精确目标是否存在 |
| `douyin_dsh_pending` | 只从目标夹取未学视频摘要；详情写本地文件，并报告显示数与实采数差异 |
| `douyin_dsh_mark` | 按 id 记入已学账本，避免重复学习 |
| `douyin_dsh_archive_prepare` | 生成移入归档夹的人工步骤，不执行移动 |

## 状态文件

默认目录：`~/.dsh/douyin-dsh-folder-data`（可由 `home` 覆盖）

- `config.json`：运行时配置覆盖（由 `douyin_config` 写入）
- `ledger.json`：已学账本
- `dsh-pending.json`：最近一次待学详情（含 `diag` 差异诊断）

## 许可

MIT
