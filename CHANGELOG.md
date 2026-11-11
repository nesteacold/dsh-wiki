# 更新日志

本文件是版本摘要。

- `0.1.x`：dsh-wiki 自身的版本历史，取自本仓库的 git log。
- `0.2.0`–`0.2.2`：**上游** [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) 的
  版本说明，逐字转录自其 `CHANGELOG.md`（`v0.2.2` /
  `74ce9f4bc26f1eaea6b7c76af7335c0e9c45978b`，sha256
  `15b9a68f9b0fdf45e5564fa4601857bcbde4ecd1db89293d027d1ea930cd3c9b`），不表示 dsh-wiki
  发布过这些版本。为什么放在这里：dsh-wiki 的构建器与查看器由该基线移植而来（见
  `UPSTREAM.md`），这三次的安全与健壮性修复是审计本仓库代码的前提。上游 v0.2.0、v0.2.1
  两个 tag 里没有 `CHANGELOG.md`，其条目是在 v0.2.2 时补写的。

## 0.3.1 — 未发布（spec `specs/015-wiki-mcp-adapter`；同一个 wiki 也给 DSH 之外的 agent 用）

spec 014 让 DSH 会话里的 agent 看到五个原生工具；本版把**同一批工具**交给 DSH 之外的 agent
（Claude Code、VS Code、任何 MCP 客户端），传输是 MCP。

- **零新依赖、零第二套实现**：`mcp/` 只做协议与传输（JSON-RPC 2.0 / MCP）。工具定义、全部上限、
  新鲜度算术都来自 `lib/wiki-tools.js` —— `tools/list` 的 `inputSchema` 就是定义的 `parameters`，
  `tools/call` 的 content 就是定义的 `output.render`。启动时校验定义名集合与 `WIKI_TOOL_NAMES` 一致，
  漂移即抛错，所以两个工具面不可能给出两个答案。
- **两种传输，默认 stdio**：`--transport stdio`（默认，换行分帧，请求串行排队以保证响应顺序）与
  `--transport http`（显式选入，Streamable HTTP，默认端口 7919，只有 `POST /mcp` 与 `GET /mcp` 两条语义）。
  普通终端里 Claude Code 用管道拉起服务器（`claude mcp add dsh-wiki -- node …/mcp/server.mjs`），
  不开端口、不监听、没有网络面 —— 那才是用户实际使用的形态；只有需要 URL 的客户端/自动化才显式选
  HTTP。`--port` 只在 http 下有意义，配 stdio 使用时直接拒绝（退出码 2），不静默忽略。
- **实测的客户端握手**（Claude Code 2.1.286，HTTP 模式）：`server/discover` → `initialize` →
  `notifications/initialized` → `GET /mcp`（SSE）→ `tools/list`，五步都实现。`server/discover` 是
  兼容层：不实现它，首包就会拿到 -32601。
- **为什么默认 stdio**：用户跑 Claude Code 的地方是普通终端，管道就是那里的正常传输；HTTP 只是回退/
  自动化路径。DSH 沙箱是例外而不是常态：从沙箱里拉起的进程不能 spawn 带管道的子进程（`EPERM`，与
  spec 014 spec.md:158 记录的是同一失败类），所以沙箱里的 agent 跑不了 stdio 端到端 —— 测试里这一层
  显式 SKIP，而默认传输与参数围栏用“普通文件接住子进程输出”的 CLI 检查在沙箱内实际验证。
- **安全**：默认 stdio 不开 socket；HTTP 模式只绑 `127.0.0.1`（没有 host 选项）；只读
  `<repo>/<wikiDirName>/wiki.json` 与 `generation-meta.json`，不联网、不写盘；带非回环 `Origin` 的请求
  一律 403（DNS rebinding 护栏），`Host` 头同样必须是回环名（rebinding 的请求 Host 仍是攻击者域名，
  Origin 挡不到这一半）；无会话状态，所以 `DELETE /mcp` 是 405；请求体上限 1 MiB，非 JSON
  `Content-Type` 是 415；`GET /mcp` 的 SSE 通道最多同时 16 条，第 17 条是 429 而不是再占一个 fd；
  请求接收有上限（旧代码把 `requestTimeout` 设成 0，等于一个只发了半个 body 的连接可以永远占着
  socket），单条请求另有 30 s 派发时限，超时回 -32603 —— stdio 是串行队列，一条卡死的调用不能把
  后面所有请求一起堵住。两个上限都不影响已经打开的 SSE 响应（实测）。
- **EOF 不丢响应**（review 修复）：stdin 的 EOF 只说明“不会再有请求”。已排队的响应必须写进流、并且
  等到 stdout 真的收下这些字节之后才允许进程退出；旧实现在 EOF 时丢弃排队响应、并可能在写缓冲排空前
  `process.exit`。客户端“连写几条就关 stdin”是常见收尾方式，这条路径必须有保证。
- **入参形状与 id**（review 修复）：`arguments` 存在但不是对象 → -32602（不再悄悄当成 `{}`，否则工具会
  带着默认参数落到另一个仓库）；`id` 只接受字符串/数字/null，其它形状回 -32600 且 `id` 为 null（不 echo
  一个客户端发不出的形状）。
- **受控读只开一次**（review 修复）：`stat` 之后按路径再读是 TOCTOU（中间被换成巨物/链接，容量闸失效）。
  改为打开一次句柄，`fstat` 判普通文件与大小，再按声明大小从同一个句柄读满；文件读取期间变大也不会越过闸。
- **与 Host 侧的差异如实记录**：进程外拿不到 Host 的句柄身份证明，读路径改用 `fs.realpath` 的包含性
  证明（目标必须落在规范根之内、必须是普通文件、有 16 MiB 硬闸，且全部作用在同一句柄上），仓库解析沿用
  同一套顺序与同一批定型错误码，但不是同一段代码 —— 见 `specs/015-wiki-mcp-adapter/plan.md` 的「已知差异」。
  `repo-not-trusted` 的文案也随之更正：链接其实是**被接受**的（realpath 之后就是同一个根），旧文案
  声称链接不受信任与行为矛盾；这条错误现在只说“这个路径在本机解析不出来”。
- 测试：`node tools/mcp-test.mjs` —— 110 项（真实端口的 HTTP + 进程内 stdio + 解析语义 + 受控读的容量闸 +
  有界超时 + 文件接住输出的 CLI 默认传输/参数检查，含 `--transport http` 仍能起服务并应答 initialize）。
  在禁止 spawn 带管道子进程的环境里，CLI 端到端与 OS 管道 stdio 那一层改为显式 SKIP（从不伪造通过），
  须在普通终端补跑。数字以该套件自己打印的 `N passed, N skipped, N failed` 为准，本节不另记总数。
- **定型拒绝不是协议错误**：`ok:false` 走 `tools/call` 的 `isError:true`（与原生工具同义）；未知工具是
  -32602，未知方法是 -32601，批量数组是 -32600（MCP 2025-06-18 起批量已不合法），坏 JSON 是 400 + -32700。

### 面板内版本检查与安全自更新（spec `specs/016-wiki-self-update`）

面板新增 **Version** 卡片：显示已安装版本（开发链接安装带 `development link` 徽标）、**Check**（检查已发布版本）
与 **Install update**（安装更新）两个按钮。刻意**默认关闭、选入使用**。

- **默认零网络**：`config.update.enabled` 默认 `false`。关闭时插件不发任何出站请求，状态路由
  （`GET /dsh-wiki/api/update/status`）照常应答 `update-disabled`；开启后，仅对通过前置检查（真实目录、git 顶层、https origin、工作树干净）的安装，面板打开时与每次点击 Check 时各请求一次（不轮询）
  `raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json`（5 s 超时、响应上限 64 KiB、不跟随重定向、
  不带凭据）。`config.update` 只有 `enabled` 一个键，**多出的键是配置错误**（比 `config.jobs` 更严）：
  仓库、分支、超时、字节上限都固定、不可配置。
- **只对满足全部条件的安装动手**（`lib/update.js` 的 preflight，首个失败即拒绝）：安装路径是**真实目录**（不是
  符号链接）、是 git worktree 且安装目录就是该 worktree 的顶层、`origin` 是指向 `nesteacold/dsh-wiki` 的
  **`https://`** 地址、工作树干净、已发布版本为严格 `X.Y.Z` 且**严格新于**已安装版本（降级守卫）。随后
  `git fetch --tags --prune origin` → `git checkout --detach <目标>`（优先 `v<版本>` / `<版本>` 标签，没有则
  `origin/main`），再重读本地 `package.json` 必须等于已发布版本，否则尝试回到原修订并报 `postcondition-failed`。
- **确认令牌**：`POST /dsh-wiki/api/update` 的请求体必须恰为 `{"confirm":"install-update"}`，同时沿用同源、
  `application/json`、4 KiB 请求体上限与回环 Host 围栏；缺少或写错令牌时服务一次都不会被调用。
- **git 在隔离配置下运行**（每次调用）：`credential.helper=` 与 `credential.interactive=never`、`core.hooksPath`
  指向一个空的临时目录（仓库里的 `post-checkout` 等钩子不会执行）、`core.fsmonitor=false`、
  `submodule.recurse=false`、`protocol.allow=never` + `protocol.https.allow=always`；环境只放行白名单变量，
  并设 `GIT_CONFIG_NOSYSTEM=1`、空的 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`、`GIT_TERMINAL_PROMPT=0`；
  参数以数组传入、不经 shell；无法创建临时沙箱则不运行任何 git。
- **封闭的 15 个原因码**（`REASON_CODES`）：`update-disabled`、`update-in-progress`、`install-not-found`、
  `install-is-development-link`、`install-not-git`、`install-not-worktree-root`、`install-origin-mismatch`、
  `install-dirty`、`latest-not-newer`、`version-invalid`、`network-unavailable`、`fetch-failed`、
  `checkout-failed`、`postcondition-failed`、`internal-error`。每个码只对应一句固定文案；响应里**没有**
  文件路径、git stderr 或上游错误文本，只有 `internal-error` 是 5xx，其余拒绝为 409。
- **开发链接安装按设计被拒绝**：本机的 profile 条目是指向开发树的符号链接，面板据此报
  `install-is-development-link`，Install update 不可用，也不会获取已发布版本。拒绝发生在任何 git 调用之前。
- **更新之后需要手动重载**：成功只回答 `reloadRequired: true`，插件**不会**自行重载或重启，由用户决定何时
  重启插件；重载之前该提示在状态路由里持续存在。
- **并发**：同一实例同一时刻只允许一个更新（第二个得到 `update-in-progress`）。
- **验证范围如实记录**：`node tools/update-test.mjs` 与 `node tools/update-ui-test.mjs` 通过注入的假 git 与假
  fetch 验证守卫；**写路径（fetch/checkout/回滚）从未对真实仓库执行过**，规格 §8.4 记录了待做的演练。

## 0.3.0 — 未发布（spec `specs/014-wiki-agent-tools`；wiki 作为 agent 的知识库）

wiki 从“人能看的站点”变成“agent 能查的知识库”：五个原生 DSH 工具 + 第二个技能 + 新鲜度闸门。
`wiki.json` schema 仍是 `repo-wiki-local/1`，构建器**未改动**（无子命令变更、无输出变更）。

- **五个工具**（`ctx.tools.register` 的普通对象定义，全局注册，每个会话的每个 agent 都看得到）：
  `wiki_search`（打分检索页面/卡片，默认 5 条、上限 20 条，每条带 `path:line` 引用）、
  `wiki_page`（单页 markdown，硬上限 16 KiB 并置 `truncated`）、
  `wiki_cards`（按 tags 全含 / file / kind 过滤；无过滤返回紧凑索引，最多 50 行）、
  `wiki_impact`（改动文件 → 受影响的页面/卡片，与构建器 `diff-impact` 的归一/边界语义一致，最多 50 个路径）、
  `wiki_status`（repo id/标题/语言/页数/卡片数/`sourceCommit`/`HEAD`/`behind`/`stale`）。
  不新增任何依赖，也不 import `@deepseek-ai/*`（宿主服务仍全部经 `ctx` 按名解析，所以用的是对象定义而不是
  `defineTool`）；Host 没有 `tools` 服务时只记一条 warning，技能/命令/路由照旧。
- **新鲜度闸门（owner 要求）**：`sourceCommit != HEAD` 即 stale，并从 git 读 `behind` 与 `changedFiles`。
  git 不可用、或 wiki 没有记录 `sourceCommit`，一律 `stale: "unknown"` —— **绝不**假设为 `false`。
  `GET /dsh-wiki/api/project` 增加同名的 `stale`/`behind`/`changedFiles` 字段，与 `wiki_status` 调用
  **同一个函数**，面板与工具不可能给出两个答案。
- **有界输出（契约级）**：除“20 条命中 / 16 KiB 页面 / 50 行卡片 / 50 个 impact 路径”外，字段与引用列表
  也各自有上限，且每个集合还有字节预算（24 KiB），超限按确定顺序截断并置 `truncated`。
  实测最坏尺寸见 README。
- **仓库解析**：显式 `repo` 只接受“已发现根”或真正含 `<wikiDirName>/wiki.json` 的根，且必须通过既有的
  规范路径/无链接证明；歧义或未知返回定型错误 + 候选**名字**（不回显别的绝对路径），绝不猜。
  读取仅限 `<repo>/<wikiDirName>/wiki.json` 与 `generation-meta.json`，走既有受控读（无链接、单链接普通
  文件、句柄身份绑定）。
- **第二个技能 `wiki-knowledge`**：说明“先检索 → 再读页 → 最后回代码核对引用”的循环，以及何时使用
  （改不熟悉的模块之前、改动之后查影响）。“**wiki 是地图不是真相**”写在技能、工具描述与 README 里。
- 测试：宿主 harness 412 → 444 项（新增注册形状/disposer/降级/确定性排序/归一化/新鲜度/上限与泄露检查）。

## 0.2.1 — 未发布（spec `specs/007-wiki-pipeline-i18n-models` 第一切片；后台作业被发布闸门关闭）

面板内后台 Generate / Update 与模型选择器已实现，但 **2026-11-09 评审后整段关闭**，直到写路径具备真正的文件系统隔离、恢复（recovery）可信为止。当前对外契约：

- `GET /dsh-wiki/api/models`：唯一仍可用的接口（只读），来自 `sessionController.modelCatalog()`；服务缺失 503。它只列出模型，不生成任何东西——本版本**没有活的生成能力**。
- `POST /dsh-wiki/api/jobs` 与 `POST /dsh-wiki/api/jobs/cancel`：一律 **503** `{ error: <闸门消息>, disabled: true }`，在读取请求体、解析 Host 服务、触碰任何路径之前返回（`translate` 同样是 503，不再是 501）。
- `GET /dsh-wiki/api/jobs?root=`：200 disabled 负载 `{ ok, root, disabled: true, disabledReason, active: null, last: null }`；宿主**仍然构造**作业管理器并持有可信 journal store（`lib/index.js` 构造、闸门只挡路由），只是闸门让它始终空闲。未知 root 仍 403（白名单仍在）。
- 只读路由不再调用 `recover()`：`GET /api/projects|project|wiki|site` 不会把崩溃遗留的 `.dsh-wiki.bak-*` 改名，查看 wiki 是纯读操作（旧实现会在普通读取时重命名任意备份目录，等于读接口触发写）。

为什么关：后台作业启动的是普通模型会话，**没有文件系统隔离**（提示词级的「别碰 live `.dsh-wiki`」不是沙箱）；而只读 GET 里的 `recover()` 会在查看时改动文件系统。隔离 + 可信恢复落地前不开闸；开闸的正确方式是先完成这两项，再把 `lib/jobs.js` 的作业管理器接回 `lib/index.js`（现场注释已写明，不要只改常量）。

本切片另落地两处能力与一处措辞修正：

- **增量更新（`incremental: true`，仅限 `action:"update"`）**：`POST /api/jobs` 不再一律回 501 `incremental-unsupported`。作业先解析已发布 wiki 的基线（`generation-meta.json` 的 `sourceCommit`，回退 `wiki.json`——实测 `wiki.json` 根本没有这个键），再跑只读子命令 `diff-impact` 把 git 变更文件映射成受影响的页面/卡片，从 live 逐字节播种 staging，只让 worker 重写受影响的 id，最后走原有 journal 发布路径。**绝不静默降级**：所有降级都是显式拒绝——`incremental-not-for-generate` / `incremental-not-for-translate`（400）、`incremental-no-baseline` / `incremental-unavailable` / `incremental-baseline-diverged` / `incremental-up-to-date` / `incremental-id-mismatch` / `incremental-unexpected-write`（409）。「播种失败」是硬失败（发布是整树替换，缺播种会让 wiki 缩水）；`sourceCommit` 只在真的重写过至少一页时才前进；worker 停手后重新对**全树**做**原始字节**哈希，凡受影响集合之外的条目被改写/新增/删除即发布前硬失败——覆盖 `wiki.json` 的**每一个**顶层键、`pages/`+`cards/` 的全部文件、其它顶层条目、新增的空目录，以及 worker 丢进 `site/` 的文件（宿主只重写 `site/index.html`，该子树其余部分照样比对；只排除 `generation-meta.json`、`config.json`、`locales/`——前者的宿主在 worker 停手后才写，后两者由宿主从 live 重新拷回，都到不了发布）。这条检查是独立评审发现的缺口，加之前「除列出的 id 外逐字节不变」只是一个没人验证的承诺。另有两处保证：`sourceCommit` 只在真的重写过**或有意删除**至少一页时才前进（零变化则保留旧基线，不假装新鲜）；若已发布 wiki 的 front-matter id 与文件名不一致（受影响集合按 id 建键、而文件按名建键），规划阶段直接拒绝 `incremental-id-mismatch`，而不是等到作业中途莫名失败——并且因为受影响文件被排除在上述比对之外，worker 停手后还会**再查一次**它们的声明 id：受影响页面不得声明**别的**页面的 id，否则会通过 `assemble` 的重复 id 解析把那一页覆盖掉（`selfcheck` 不拒绝重复 id，所以没有别的环节会拦住它）。删除受影响**页面**是允许的，但会以 `pagesRemoved` + 有界的 `removedSample` 记录下来并在面板的完成行显示「N 页已删除」，绝不静默消失、也绝不计成「重写」；删除受影响**卡片**则被拒绝——没有可记录的公开字段，静默消失比要求用户跑一次全量更新更糟。
- 面板总览重做：hero 标题区（标题、中间省略的仓库路径、状态 pill）取代原来的 h1 + 路径 + 横幅 + 动作行；竞争的第二枚「Update wiki」按钮与重复的「in Chat」按钮已删除，只剩**一枚**主操作；闸门关闭时该主操作**仍然可见但 disabled**，Host 的原始原因以文字形式显示在同一提示块里（tooltip 在 disabled 控件上不可靠，所以原因必须是可见文字）；关闭时不再渲染模型下拉，选中的模型改为提示块里一行 muted 文本；闸门块从 1px 黑色重边框 + ⛔ emoji 改为左侧警示色条的紧凑提示；六个统计格改为带 1px 分隔线的条带，数值 `nowrap` + 等宽数字，时间不再折成三行；disabled 按钮不再显得可点。主按钮在有 wiki 时是「更新 wiki（增量）」，整树重建则是 More actions 里独立的「重建整个 wiki」。
- **仍然没有独立的「Regenerate」动作**，这是服务端事实而非 UI 遗漏：`JOB_ACTIONS = ["generate","update","translate"]` 只有三项，`btn.regen` 这个键从有史以来就没有被渲染成按钮。现在三者的分工是清楚的：**「更新 wiki（增量）」**走 `action:"update"` + `incremental:true`（只重写 `diff-impact` 判定的受影响页面/卡片）；**「重建整个 wiki」**走 `action:"update"` 不带 `incremental`（整树重建，基线缺失或 `diff-impact` 不可用时的唯一正确选择）；**「生成 wiki」**是首次生成。`buildWorkerPrompt` 依旧只接受 `{jobId, root, stageDir, config}`、拒绝未知键——增量信息是通过新增的可选 `incremental` 键传入的，不是通过 `action`。
- `tools/ui-preview.mjs`：把真实组件渲染成 9 个状态（light / dark / 闸门开启且作业在跑（含菜单）/ 未生成 / 460px 与 464px 窄面板 / 未生成且闸门关闭 / 增量更新运行中 / 增量更新完成）的**自包含** HTML，布局改动可以直接截图评审，而不是靠嘴说。

- 站点 chrome 支持越南语：`wiki.json` 的 `language` 为 `vi*` 时全站 chrome 用越南语，`zh*` 用中文，其余（默认）英文；页面**正文**语言另行由 resolve-config 的 `language` 字段决定，本切片保持 canonical `en`。
- 新子命令 `diff-impact`（只读）：把 `<from>..<to>` 的改动文件映射到受影响页面/卡片，输出 `from`、`to`、`changedFiles`、`affectedPages`、`affectedCards`、`unmappedFiles`；按精确路径或目录前缀匹配 `filePaths`/`keyFiles`，不构建、不写盘、不联网，失败退出 2。
- 修正技能文档里关于引用机检的表述：机检只覆盖单个反引号包裹、白名单扩展名、ASCII 路径的 `path:line`/`start-end` 形态，其余形态不受检，仓库根不可用时降级为警告——作者须自行核对每条引用。

保留与测试：

- `lib/jobs.js` 的实现保留在树上：暂存发布（候选写 `<repo>/.dsh-wiki.staging-<jobId>/`，必须 `wiki.json.repoId` 指向仓库根，build + selfcheck 都退出 0 才发布）、canonical `en` 语言门、宿主所有的 `config.json`/`locales/` 原样保留（拒绝符号链接）、单飞栅栏（任何 `await` 之前同步插入）、取消/隔离/等待输入、超时、备份恢复，以及同源/JSON/32KB/项目白名单/精确模型等写栅栏。**但本版本不接线**（`lib/index.js` 不构造管理器）。
- `tools/jobs-harness-test.mjs` 改为**模块级** harness（直接 `createJobManager()`；51 项）作为 future/internal 契约，**不声称是活路由行为**；活路由契约（POST 503、GET disabled、读路由不 `recover()`）由 `tools/harness-test.mjs` 第 19 节覆盖（含"查看不得改动文件系统"的备份原地不动断言）。
- 客户端：模型选择器 UI 仍在，但闸门期间应视为**禁用/惰性**——选择只改下拉值，Generate/Update 启动即 503，不会出现活动作业；主屏与项目概览仍共用同一选择。P1 修复保留（无原型 id 字典、缩放浮层焦点陷阱、去掉自造 `dsh:select-panel` 兜底）。
- 测试：构建器 111 项、宿主 harness 73 项、作业模块 harness 51 项（future/internal）全绿；客户端冒烟 61 项本次未改动客户端，沿用上次结果。

## 0.2.0 — 未发布

知识卡片与生成体验（spec `specs/004-wiki-knowledge-cards`）。`wiki.json` schema 仍为 `repo-wiki-local/1`；无卡片的 wiki 构建输出与 0.1.x 逐字节一致（时间戳除外）。

- 知识卡片：`wiki.json` 可选 `cards` 数组（`id/title/kind/summary/keyFiles/related/tags/pageIds`），构建器清洗与告警，>200 张告警；站点新增卡片网格（按类型/标签筛选）、单卡视图（关键文件、相关卡片、引用页面）、卡片进入全文搜索。
- 页面链接 `[文本](#card-<id>)` 渲染为站内锚点；目标缺失降级为纯文本并告警。
- selfcheck：卡片 `keyFiles` 与页面引用同一道机检；`cards` 非数组或含非法条目判 FAIL；引用指向空行时 WARN。
- 新子命令 `assemble`：由 `pages/*.md`（+ `cards/*.md`）front-matter 组装 `wiki.json`。
- `resolve-config` 在 generation-meta 中记录 `sourceCommit`（`git rev-parse HEAD`，非 git 仓库省略）。
- 测试：构建器回归 66 → 92 项（原 66 项未改动）。

## 0.1.0 — 2026-11-06

首个版本：纯本地 Repo Wiki 插件，适配 DSH 0.2.x；构建器与查看器移植自 zcode-repo-wiki，
`wiki.json` schema（`repo-wiki-local/1`）兼容。

- runtime 技能：5 阶段生成协议，构建器绝对路径烧入到技能正文（`{{BUILDER_PATH}}` 占位符）。
- `/wiki` 命令：`generate`（fork 子代理）/ `view` / `list`。
- `/dsh-wiki` 本机路由：索引页 + 站点服务 + `api/status`（回环围栏、目录名必须等于
  `wikiDirName`、只读单文件服务）。
- 会话头部 Wiki 按钮（客户端半区，`__ModuleLoader__` IIFE）。
- 测试：构建器回归 64 项 + 宿主 harness 25 项。

0.1.0 之后、0.1.1 之前并入的改动（均为 2026-11-06）：

- 双语 README（`README.md` / `README.en.md`）、logo、与其他 wiki 插件的对比表、FAQ。
- wiki 独立窗口加「← 返回 DSH」入口（`window.close()` 优先，200ms 后 `location.assign('/')` 兜底）。
- 左侧栏 Wiki 面板（`sidebar.panellist` + `main` 双槽位，iframe 内嵌阅读）；返回按钮在被
  iframe 嵌入时跳过（`window.self!==window.top`）；外链徽章换成本地 SVG。

## 0.1.1 — 2026-11-06

修复宿主注入截断泄漏：内联 mermaid bundle 的字符串字面量自带假边界标签
（DOMPurify 的 XHTML 包装串、iframe 助手的 `<body …>`），宿主侧朴素注入器（本插件路由的
首个 `</body>` 替换、`dsh-host-webserver` 的 `/<body…>/` 定位）会命中假标签把
`<script>…</script>` 注进脚本中间，注入的 `</script>` 提前闭合脚本，约 3 MB 的 bundle
余下部分整体泄漏为正文 JS 源码墙。

- 构建器：内联 mermaid 时把 `<body`/`</body`/`<head`/`</head`/`<html`/`</html`/`<script`
  序列打断成 `\u003c`（JS 字符串/模板/正则与 JSON 中语义等价）。
- 路由：backBar 注入点取最后一个 `</body>`，兜底未打断的旧构建产物。
- `import-legacy`：去掉与页头 h1 重复的正文首行 `#` 标题（`_strip_leading_h1`）。
- 回归测试：构建器新增边界唯一性 / 朴素定位器命中真标签 / 导入去重三类用例；
  宿主 harness 新增"注入点取末位 `</body>`"用例。当前基线：构建器 66/66、harness 31 项全过。

## 0.1.2 — 2026-11-06

索引同级目录自动发现：`import-legacy` 导入的 wiki（落盘目录的 `repoId` 不在登记表里）
靠扫描已知根目录的父目录一层收录，零配置可见；无站点与点目录兄弟不收录。

---

以下 `0.2.0`–`0.2.2` 为上游 zcode-repo-wiki 原文（其 `0.1.0` 段讲的是上游自己的首个
版本，与上面的 dsh-wiki `0.1.0` 无关，因此未转录）。

## 0.2.2 — 2026-09-22

修复一个让查看器整体失效的缺陷，并新增站点显示名。

**修复**

- **查看器内联脚本语法错误**（0.2.1 起存在）：搜索循环处多了一个 `}`，提前闭合了 `input` 事件回调，脚本末尾的 `});` 因此括号不匹配，**整段脚本解析失败**——全文搜索、深浅主题切换、mermaid 图表渲染、搜索命中的键盘操作与 hash 路由在构建产物中全部失效，页面退化为静态 HTML。删掉这个多余括号即可恢复。
- 回归门补齐：套件现在会提取站点内联脚本并做**真实语法校验**（`node --check`，机器上没有 node 时显式打印 SKIP），这类"子串断言看得见、解析器才看得见"的缺陷不再能溜过。

**新增**

- `wiki.json` 顶层可选 `title`：站点品牌位的显示名。缺省回落到 `repoId`（与历史行为一致），引用机检的仓库根始终取 `repoId`。

**验证**

- 站点全部内联脚本通过 `node --check`；真实 Chrome 实测：mermaid 渲染出图、主题切换生效、搜索返回命中。
- 回归套件 64 例全绿（本机 macOS；Linux 的 3.9 / 3.13 经容器复跑）。

**升级**

```bash
git pull && bash install.sh
```

> 注：`install.sh` 是上游 ZCode 的安装器，dsh-wiki 没有移植它——本仓库按 DSH 插件方式安装。

## 0.2.1 — 2026-09-20

安全加固、失败路径健壮性与发布包洁净度。六个审核轮次（5 轮高精度 + 1 轮收敛）的修复全部落地。

**安全**

- SVG 净化重写为「解析 → 白名单 → 重序列化」：此前基于正则的删除可被 `<scr<script>ipt>` 这类拼接绕过（Chrome 实测执行）；事件属性、外部 URL、`<meta refresh>`、`<foreignObject>` 等执行面一律移除，不可解析时降级为转义代码块。
- 收回 SVG 内联 CSS 与 SMIL 动画：`<style>`、`style=` 属性与 `<animate>` 全部移除——CSS 反斜杠转义（`u\72l(`、`@im\70ort`）与 `<animate attributeName="href" values="http://…">` 都能让浏览器真实发起请求而机检全绿（Chrome netlog 实证）。样式请用呈现属性（`fill`、`stroke`、`opacity`）表达。
- 零外链机检与净化同源、逐属性扫描：覆盖单/双/无引号、实体编码与控制字符混淆、protocol-relative、`srcset`/`srcdoc`/meta refresh、`values/to/from/by/attributeName`、CSS `@import` 与字符串 URL（含反斜杠转义归一）；`xmlns` 与 `data-*` 不误报，正文以代码块讲解 CSS 也不误报。
- 搜索索引注入（`JSON.parse` + `\uXXXX` 转义 + `textContent`）、`sources[].startLine` 注入、`_inline` 引号属性注入均已封死。

**健壮性**

- 全链路干净报错：缺文件、坏 JSON、非 UTF-8、目录误传、超深嵌套都给出可读信息与退出码，不再有裸 traceback。
- 原子写 + 权限保持：站点/wiki/meta/pages 写入均走 tmp + replace，替换前不截断旧文件。
- 递归全面有界（树/导航/目录树改迭代、markdown 深度上限、全局 `RecursionError` 兜底）。
- 引用机检拒绝 `..` 与绝对路径越界（不读仓库外文件），仓内符号链接引用正常；相对 `repoId` 以 wiki 目录为基准，不随 CWD 漂移。
- `import-legacy` 的 `--dest` 守卫：等于源目录、位于源目录之外的上层、或非本工具产物目录均拒绝。

**安装器**

- 缓存与 zip 统一排除 `tests/`、`__pycache__`、`*.pyc`，`--delete-excluded` 同时清理历史污染；MIT LICENSE 随包分发。
- zip 仅在缺失或源较新时重建（sha256 与内容一致，registry 溯源可校验），打包失败保留旧包并回滚新建缓存。
- 三份配置 JSON 先全部校验再统一 tmp + replace 落盘，不留半安装状态；新建配置文件用 0600，备份与源文件同权限。

**行为变化（升级需知）**

- 未知配置键与未知子键会被拒绝（此前静默忽略）；`profile` 支持 `--set profile=…`，显式 `null` 报错。
- 站点质量门加严：`site/index.html` 缺失 `DOCTYPE`/`main` 结构或内容不完整判 FAIL。
- 引用机检白名单扩展（`.sh`、`.c`、`.css`、`.html` 等常见代码/配置扩展名纳入）。
- 新增 `repo-wiki/tests/test_build_wiki_site.py` 回归套件（纯标准库）。

## 0.2.0 — 2026-09-20

生成配置全量可调，引用可解析性机检常开。

**新增**

- **生成配置（`resolve-config`）**：四层合并（内置默认 → `~/.zcode/repo-wiki/config.json` → `<仓库>/.zcode-wiki/config.json` → `--set k=v`），不建配置文件时行为与 v0.1 完全一致。
- 八族参数：`language`、`granularity`（`theme`/`file`/`hybrid`）、`pages`、`tree`、`wordsPerPage`、`diagrams`、`citations`、`skeleton.knownIssues`。
- 预设档位 `compact` / `standard` / `deep` / `legacy`；其中 `legacy` 一键复刻旧版内置生成器风格（逐文件切页 + 每页配图 + 长文）。
- 留档复现：合并结果与逐字段 provenance 写入 `<仓库>/.zcode-wiki/generation-meta.json`。
- **引用机检（常开，不受配置控制）**：所有 `` `路径:行号` `` 引用强制校验文件存在且行号在界内；仓库根不可用的存量 wiki 降级为警告。

**兼容性**

- schema 保持 `repo-wiki-local/1`，已生成的 `.zcode-wiki/` 与 `import-legacy` 导入数据零改动兼容。
