# 安全策略

威胁模型移植自上游 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) v0.2.2
（`SECURITY.md`），按 dsh-wiki 的结构改写；上游未变的部分保持原文。

## 报告漏洞

请通过 GitHub 的私密渠道报告：本仓库 **Security** 标签页 → **Report a vulnerability**
（Private vulnerability reporting）。请勿在公开 issue 中披露尚未修复的问题。

报告时请附上：复现步骤、受影响的版本、以及你观察到的实际行为（若涉及站点产物，
请说明是 `build`、`selfcheck` 还是 `import-legacy` 路径；若涉及宿主半区，请说明是
`/dsh-wiki/api/*` 还是 `/dsh-wiki/site` 路由）。本插件默认不联网（仅选入的版本检查例外，见下文），因此**不需要**提供任何
本机路径之外的隐私信息。

## 支持范围

仅最新发布版本接受安全修复，当前为 `0.1.x`。

## 威胁模型边界（诚实声明）

本插件把"数据不出本机"作为硬约束，但边界要说清楚：

- **默认不联网、不上传**：生成与构建全程本地，不发任何网络请求，也不读写 `.git` 对象内容。
  唯一的可选例外是 `git log --oneline -15` 这类摘要命令；以及下一条描述的、默认关闭的版本检查/自更新。
- **版本检查/自更新是唯一的联网面，选入使用**（`config.update.enabled`，默认 `false`；`lib/update.js`）：
  关闭时零出站请求，状态路由照常应答 `update-disabled`。开启后唯一的请求是对固定 URL
  `https://raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json` 的一次 GET（仓库、分支、URL 都
  不可配置；5 s 超时、响应体按流式计数、上限 64 KiB、不跟随重定向、不带凭据与 Cookie）。写盘只发生在
  `POST /dsh-wiki/api/update`，要求请求体恰为 `{"confirm":"install-update"}`，并沿用同源、`application/json`、
  4 KiB 请求体上限与回环 Host 围栏——这与上面一样依赖请求头，**不是**对本机其他进程的鉴权。它只对真实目录、
  git worktree 顶层、`origin` 为 `https://` 的 `nesteacold/dsh-wiki`、工作树干净、已发布版本严格更新的安装
  动手；符号链接（开发链接）安装在任何 git 调用之前即被拒绝。每次 git 调用都带 `credential.helper=`、
  `core.hooksPath` 指向空的临时目录（仓库自带的钩子不会执行）、`core.fsmonitor=false`、
  `submodule.recurse=false`、仅 HTTPS，环境只放行白名单变量并设 `GIT_CONFIG_NOSYSTEM=1`、空的
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`、`GIT_TERMINAL_PROMPT=0`；不携带任何凭据或令牌，参数数组传入、
  不经 shell。响应体只含 15 个封闭原因码之一与固定文案，不含路径、git stderr 或上游错误文本。信任边界是
  “到固定 GitHub 源的 HTTPS 加 git 自身的对象完整性”，**不**做提交签名验证；回退/检出路径目前只对注入的
  假实现验证过，没有对真实仓库执行过（见 `specs/016-wiki-self-update/spec.md` §8.4）。
- **产物净化与机检是有界保证，不是形式化证明**：站点页面的"零外链、零脚本注入"由构建期
  净化（SVG 走 XML 解析器白名单重序列化）与机检（外链扫描覆盖常见属性形态与 CSS 上下文）
  共同保障；外链扫描器是**有界启发式**，无法证明"任何输入都不可能生成外链"。引用机检只
  覆盖白名单扩展名。
- **内联脚本会打断 HTML 边界标签字面量**：站点把 mermaid 运行时内联进页面，其中的
  `<body`/`</body`/`<head`/`</head`/`<html`/`</html`/`<script` 字面量在构建期改写为
  `\u003c` 形式。这是为了让宿主侧"朴素注入器"（按正则找 `</body>` 等注入点的代码）不会
  命中脚本字符串里的假标签、把 `<script>` 注进脚本中间造成整段 bundle 泄漏为正文。
  它保证的是**页面形态**，不是沙箱。
- **知识卡片只走纯文本路径**：卡片的 title/summary/tags/keyFiles 一律 `html.escape`，不经 markdown、HTML 或 SVG 渲染，也不生成任何由数据派生的 CSS；卡片 id 经 `_safe_id` 限定为 `[A-Za-z0-9_-]`，站内锚点 `#card-<id>` 不可能携带外链。`[文本](#card-<id>)` 只在目标卡片存在时变成锚点。
- **宿主半区有请求围栏**：`/dsh-wiki` 下的路由只放行回环 Host（`127.0.0.1`、`localhost`、
  `::1`），目标目录的 basename 必须等于 `wikiDirName`（默认 `.dsh-wiki`），且只服务
  单个文件、不接受路径拼接——因此没有目录遍历面。该围栏依赖 Host 请求头，**不是**对
  本机其他进程的鉴权：任何本机进程都能访问回环端口。
- **MCP 适配层（`mcp/`，进程外）的围栏要说清它证明了什么**：默认 stdio 传输不开 socket；显式
  `--transport http` 只绑回环，且每个请求要过 `Host` + `Origin` 双回环检查（缺这两个头的 CLI 客户端
  放行，浏览器一定会带）、只认 `/mcp` 一条路径、请求体 1 MiB 上限；`GET /mcp` 的 SSE 通道最多
  16 条；单条请求 30 s 硬时限。受控读**只打开一次句柄**：`fstat` 判普通文件与大小、再按声明大小从
  同一句柄读满，所以“检查后被换掉”不能越过 16 MiB 闸。它**不**声称 Host 侧的句柄身份证明：
  仓库内一个硬链接指向同卷别处的文件，`realpath` 看不出差异（记录在
  `specs/015-wiki-mcp-adapter/plan.md` 的「已知差异」），关闭它需要 `nlink`/inode 比较，那是 Host 侧
  的做法。它同样**不是**鉴权边界：HTTP 模式下本机任何进程都能访问回环端口。
- **不防御恶意 agent**：本插件约束的是**产物形态**，不是模型行为。技能协议文本
  （`skills/wiki-protocol.md`）是约定，不是沙箱边界；agent 在本机以你的权限运行。
- **产物是本地静态文件**：`site/index.html` 自包含、可离线打开；把它分享出去是你的决定，
  插件不参与任何分发。
