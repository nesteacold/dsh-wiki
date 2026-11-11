<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>DeepWiki 式本地仓库 Wiki，为 DeepSeek Harness (DSH) 而做：零上传、默认零网络、证据优先。</strong><br />
  agent 在本地读懂仓库 → 产出带 <code>路径:行号</code> 证据引用的分页 wiki（目录树 + 图表）→ 构建单文件自包含站点，挂在本机 DSH 宿主上直接浏览。</p>

  <p>
    <a href="#-安装">安装</a> ·
    <a href="#-用法">用法</a> ·
    <a href="#-与社区同类方案对比">对比</a> ·
    <a href="#-安全与隐私">隐私承诺</a> ·
    <a href="#-测试">测试</a> ·
    <a href="README.md">English</a> ·
    <a href="README.vi.md">Tiếng Việt</a>
  </p>

  <p>
    <img src="docs/assets/badges/license.svg" alt="MIT License">
    <img src="docs/assets/badges/dsh.svg" alt="DSH 0.2.x compatible">
    <img src="docs/assets/badges/python.svg" alt="Python ≥3.7">
    <img src="docs/assets/badges/tests.svg" alt="tests: all suites pass — Python builder and translation regressions, Node host routes and trust fence, MCP adapter, job module and worker pipeline, journal/publish/containment/guard, client and update-panel React rendering, wiki freshness, README parity">
    <img src="docs/assets/badges/network.svg" alt="network: opt-in">
  </p>

</div>

> [!NOTE]
> **代码库的知识不该只活在原作者脑子里，也不该以"把整个仓库传上去"为代价。**
>
> 社区（awesome-dsh-plugin，9100+ 插件）里没有交付"DeepWiki 式"产物的插件：dsh-openwiki 依赖外挂 CLI 且停更、codemap 有引用无正文、archify 只有图。dsh-wiki 把**叙事正文 + 强制机检的证据引用 + 离线图表 + 自包含站点**合成一个 DSH bundle——全程本地，一行数据都不出网。
>
> ```sh
> # this repository IS the plugin package — clone it and point DSH at the checkout
> REPO="<path to this repo checkout>"
> CLI="<path to DSH>/runtime/cli/bin/dsh"        # e.g. "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
>                                               # or  "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh"
> "$CLI" plugin --profile desktop add "$REPO"
> ```

## ✨ 这是什么

一个 DSH 插件，在这里以 **`@dsh-ext/dsh-wiki`** 维护——它是
[`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) 的 **fork**，可靠性、流水线与翻译方面的改动记录在本仓库的 [`CHANGELOG.md`](CHANGELOG.md) 与提交历史里
（编号 spec 与架构笔记留在私有开发树中，不在这里）。运行期 id 是 `dsh-wiki`，
包名因此保留该后缀。装进任意 web/desktop profile 后给你四样东西：

| 入口 | 形式 | 说明 |
| --- | --- | --- |
| **`dsh-wiki` 技能** | runtime skill | 对话里说「给这个仓库生成 wiki」，五阶段协议即接管：盘点 → 配置解析 → 语言判定 → 页面树规划 → 逐页写作 → build + selfcheck |
| **`/wiki` 命令** | slash command | `/wiki generate [路径]`（fork 子代理执行）、`/wiki view`（给出本机站点 URL）、`/wiki list` |
| **📚 侧栏 Wiki 面板** | 左侧栏全局面板 | 左栏新增 📖 入口：点开即列出所有已构建 wiki，选中后站点内嵌在应用里阅读（刷新 / 返回列表 / 新窗口一键切换） |
| **📖 Wiki 按钮** | 会话头部槽位 | 以独立窗口打开本机索引页（不想离开对话时用） |

生成产物 `<仓库>/.dsh-wiki/`：

- `wiki.json` — 唯一事实源（schema `repo-wiki-local/1`，分页 + 内嵌 markdown）
- `pages/<id>.md` — 每页导出副本，便于 diff
- `generation-meta.json` — 生效配置与逐字段 provenance
- `site/index.html` — **单文件自包含站点**：目录树导航、全文搜索（键盘可操作）、深浅双主题、mermaid 离线渲染、内联 SVG 自动净化、窄屏自适应

站点经**零外链机检**（覆盖实体编码、protocol-relative、CSS `url()`/`@import` 等形态）。
引用同样经机检，但只覆盖一种很窄的形态：反引号包裹的单个 `` `path:line` ``（或 `path:start-end`），其扩展名在允许列表内且路径为纯 ASCII。
对这种形态，文件缺失、路径跳出仓库或行号越界都会让 `selfcheck` 失败；
能解析但内容为空白的行只是警告，仓库根目录不可用则把整个检查降级为警告。
裸路径、含空格、非 ASCII 路径、无扩展名或扩展名不在列表内、同一 span 里的多个引用、以及未用反引号包裹的引用**都不会**被检查——请自行核对你输出的每一条引用。

## 🚀 安装

前置：DSH Desktop 或 web profile（`dsh-base` + `dsh-web-app`）、`python3 ≥ 3.7`（构建器纯标准库，无第三方依赖）。

**路线 A · GUI 插件页**：侧栏「插件」→ 添加插件 → 填本仓库的检出路径（含 `package.json` 的那一层）→ 安装 → 启用。

**路线 B · CLI**：

```sh
CLI="<path to DSH>/runtime/cli/bin/dsh"
REPO="<path to this repo checkout>"
"$CLI" plugin --profile desktop add "$REPO"
"$CLI" plugin --profile desktop list
```

desktop profile 是 `patchReload: live`，装完刷新页面即生效。版本门禁声明覆盖 `^0.1.1-rc.1 || ^0.2.0-rc.1` 两条线（与 @jieai/dsh-plugin-vet 同款写法，0.2.2-rc.1 实测通过），无需豁免。

## 🧭 用法

```sh
/wiki generate            # full wiki for the current workspace (fork subagent)
/wiki generate /path/repo # explicit repo
/wiki view                # print the local site URL
/wiki list                # list known wikis
```

本机路由（桌面宿主回环地址）：

- `/dsh-wiki/` — wiki 索引页（自动汇总已发现的仓库）
- `/dsh-wiki/site?path=<仓库>/.dsh-wiki` — 直接打开某个站点
- `/dsh-wiki/api/status` — JSON 状态

**发现机制**：会话的工作目录会被自动记住（持久化在 `<profile home>/dsh-wiki/registry.json`），并自动扫描已知目录的**同级目录**——凡含 `<wikiDirName>/site/index.html` 即收录，`import-legacy` 导入的存量 wiki 无需任何配置即可出现在索引；
`config.wikiRoots` 可补充额外根目录。

### Agent 工具——把 wiki 当作知识库

插件注册**五个原生 DSH 工具**（全局注册，因此每个会话里的每个 agent 都能看到），外加第二个技能 `wiki-knowledge`，用来说明查阅流程。
它们是传给 `ctx.tools.register` 的普通对象定义——本插件仍然**不**导入任何 `@deepseek-ai/*` 包，因此从不需要 `defineTool`。
当 Host 没有 `tools` 服务时，插件只记录**一条**警告，其余所有入口（技能、`/wiki`、路由）照常工作。

因此 `tools` **不在**插件的 cordis `inject` 列表里；
它在 `apply()` 内用 `ctx.get("tools")` 惰性解析。
对已安装 Host 的实测（2026-11-11）：cordis 的 `inject` 是"全有或全无"——只要有任何被注入的服务没有实现，`Fiber._refresh()` 就会停用整个插件，`apply()` 永远不会运行，在没有 `tools` 的 Host 上技能、`/wiki` 与路由会一并消失；
cordis 没有 `{ required, optional }` 形式。
`ctx.get(name)` 无需 `inject` 即可使用（同一 profile 的 `dsh-tool-subagent` 就是这样解析 `llm` 的）。
连 `ctx.get` 都没有的 Host 也同样降级：一条警告，不抛异常。

| 工具 | 回答什么 | 硬上限 |
| --- | --- | --- |
| `wiki_search` | 针对文本查询和/或仓库路径的排序页面/卡片，附带 `path:line` 引用 | **20 条命中**（默认 5）与 **24 KiB** 的整体预算 |
| `wiki_page` | 一个页面的 markdown + 它的文件列表 + 父/子/兄弟页面 id | **16 KiB** markdown（被截断时 `truncated: true`） |
| `wiki_cards` | 按 `tags`（全部满足）、`file` 或 `kind` 过滤的原子卡片；不带过滤则返回精简索引 | **50 行**与 **24 KiB** 预算 |
| `wiki_impact` | 变更文件 → 覆盖它们的页面/卡片，使用 `diff-impact` 完全相同的规范化 | **50 个输入路径**与 **24 KiB** 预算 |
| `wiki_status` | 仓库 id、标题、语言、页面/卡片数量、`sourceCommit` 与 git `HEAD` 的对比、是否过期 | 一个很小的对象 |

**wiki 是地图，不是事实源。** 每条命中都带着该条目本来就有的引用，技能会要求 agent 在依据它行动之前，先在代码里复核每一条被引用的 `path:line`。

**新鲜度语义**（owner 要求的那道闸门）：

- `stale: false` — 记录的 `sourceCommit` 等于 git `HEAD`。
- `stale: true` — 不相等；结果还会带上 `behind`（相差提交数）与 `changedFiles`。
- `stale: "unknown"` — git 或记录的提交不可用。这种情况**绝不**报告为 `false`：无法度量就不算新鲜。
- `GET /dsh-wiki/api/project?root=` 暴露同样的 `stale`/`behind`/`changedFiles` 字段，由与 `wiki_status` **同一个**函数计算，因此面板与工具不可能互相矛盾。

仓库解析默认是封闭的：显式给出的 `repo` 只有在它已经是被发现的根目录（或确实包含 `<wikiDirName>/wiki.json`）**并且**被证明是规范路径、没有符号链接逃逸时才被接受。
含糊或未知的请求会得到列出候选名称的类型化错误——绝不猜测。
省略 `repo` 时优先取会话的**创建目录**（`session.header.cwd`，不可变——与 `lib/worker-guard.js:22,348` 记录的是同一个事实），然后是唯一一个有 wiki 的已发现 wiki；
多个候选则返回 `repo-ambiguous`，而不是猜。
错误消息会到达模型，所以它们只写相对于 wiki 的 `<wikiDirName>/wiki.json`；绝不会嵌入宿主上的绝对路径。
wiki 内容只从 `<repo>/<wikiDirName>/wiki.json` 与 `generation-meta.json` 读取，走插件已有的带隔离读取器（无链接、无硬链接、常规文件、绑定句柄身份）。

上限同样作用于*字段*：id/标题/摘要与引用列表会被截短，且每个集合都有字节预算，所以一份病态的生成 wiki 无法淹没上下文窗口。
`wiki_search` 是确定性的——相同输入、逐字节相同的输出，平局按 `(kind, id)` 排序。

工具的**参数**是我们自己的契约，不是 Host 的：`register()` 校验 `output.schema`，但从不校验 `parameters`（Host 的 schema 检查也把只有注解的 schema 当作不受约束的 JSON 接受）。
因此测试套件对每个定义断言：参数 schema 以 object 为根，且 `required`（若存在）只出现在该 object 上——逐属性的 `required` 键会被拒绝。

### MCP 适配器——给 DSH 之外的 agent（Claude Code）同一份 wiki

DSH 会话原生获得这五个工具。
DSH **之外**的 agent——Claude Code、VS Code、任意 MCP 客户端——通过一个小进程经 MCP 获得同样的五个工具，该进程**复用** `lib/wiki-tools.js`：定义、上限与新鲜度算法是同一份代码，因此两个入口不会各走各的。

**stdio 是默认传输**——也是用户终端里的常规形态：客户端拉起服务器，双方通过 stdin/stdout 说按换行分隔的 JSON-RPC。没有端口、没有监听套接字、没有网络暴露面，也没有需要选择或保持空闲的东西。

```sh
node mcp/server.mjs                                # stdio (default): JSON-RPC on stdin/stdout, no socket
node mcp/server.mjs --transport http --port 7919   # opt-in Streamable HTTP on 127.0.0.1
```

| 参数 | 含义 |
| --- | --- |
| `--transport stdio\|http` | 传输方式（默认 `stdio`） |
| `--port N` | 仅用于 `--transport http` 的回环端口（默认 `7919`）；低于 1024 与保留段 `2190-2289` 会被拒绝而不是被悄悄挪走，与默认的 stdio 同时给出也会被拒绝而不是被忽略 |
| `--repo PATH` | 工具调用省略 `repo` 时的默认根目录（绝对路径；仍需通过常规的解析证明） |
| `--dsh-home DIR` | 存放 `dsh-wiki/registry.json` 的 profile home（默认 `$DSH_HOME` 或 `~/.dsh`） |
| `--wiki-dir NAME` | 仓库内的 wiki 目录（默认 `.dsh-wiki`） |

用随附的安装器注册——它会计算绝对路径，为 **Claude Code 与 Claude Desktop** 输出或应用注册，并拒绝猜测。
之后这些工具会以 `mcp__dsh-wiki__wiki_search`、`mcp__dsh-wiki__wiki_page`、`mcp__dsh-wiki__wiki_cards`、`mcp__dsh-wiki__wiki_impact`、`mcp__dsh-wiki__wiki_status` 的名字出现：

```sh
node tools/register-mcp.mjs            # dry run: prints the exact registration, changes nothing
node tools/register-mcp.mjs --apply    # register in Claude Code (user scope) + Claude Desktop
node tools/register-mcp.mjs --apply --target code --scope project   # project-scoped .mcp.json
node tools/register-mcp.mjs --uninstall --apply
```

**`--repo` 是承重参数，在本机上实测。
** 适配器在省略 `repo` 时从 DSH 注册表（`~/.dsh/dsh-wiki/registry.json`）解析；
那份注册表里有 8 个根目录，其中**两个**带有 wiki，所以不带限定的调用会回答 `repo-ambiguous` 而不是猜。
因此安装器在能证明恰好只有一个 wiki 时总会固定 `--repo <abs>`，不能证明时带着候选列表以退出码 2 退出。
从没有 wiki 的目录运行时，请自己传 `--repo`。

这里真正验证了什么，没验证什么：

| 步骤 | 证据 |
| --- | --- |
| Claude Code 接受并保存这个注册 | **实测**——`claude mcp add -s project` 写出了 `.mcp.json`；`-s user` 写入了 `~/.claude.json`（`Added stdio MCP server dsh-wiki ... to user config`），该文件保留了 62 个顶层键与 13 个项目，完好无损 |
| Claude Code ↔ 我们服务器的握手（实时） | **实测**——`claude mcp get dsh-wiki` 报告 `Scope: User config (available in all your projects)` 与 `Status: √ Connected`，`claude mcp list` 在其他服务器旁列出 `dsh-wiki ... √ Connected` |
| Claude Desktop 配置合并 | **在真实文件上实测**——插入了 `mcpServers.dsh-wiki`，`coworkUserFilesPath` 与整个 `preferences` 对象被保留，旁边写出带时间戳的备份。Claude Desktop 在启动时读取该文件，所以请**重启应用**才能识别该服务器 |
| 经 stdio 的 `tools/list` / `tools/call` | **作为真实进程实测**——使用 `.mcp.json` 中存的完全相同的 argv，stdin/stdout 重定向到文件：`initialize` 返回 `serverInfo {name: dsh-wiki, title: Local Repo Wiki}`，`tools/list` 返回全部五个工具，通知不产生响应，stdout 只含协议字节 |
| 测试套件下的 `tools/list` / `tools/call` | 由 `node tools/mcp-test.mjs` **实测**（完整文件权限下 110 通过、0 跳过、0 失败；在受限 shell 里依赖管道的 CLI/stdio 层级改为 SKIP） |

范围对批准流程很重要：**用户级**条目被信任并立即连接，而项目里的 `.mcp.json` 条目会一直处于 `⏸ Pending approval`，直到你批准——所以克隆下来的仓库无法悄悄启动一个服务器。

如果你更愿意手敲，原始等价命令如下（把 `<path-to-checkout>` 换成检出目录的绝对路径）。用户级：

```sh
claude mcp add dsh-wiki -- node "<path-to-checkout>\plugins\dsh-wiki\mcp\server.mjs" --repo "<path-to-checkout>"
```

项目级（`.mcp.json`，Windows 路径为 JSON 做了转义；
`type` 是 Claude Code 写入的）。
**不要提交这个文件：** `--repo` 必须是绝对路径（`mcp/server.mjs:120` 拒绝其他任何形式），`command` 写的是这台机器的 node，所以提交进去的 `.mcp.json` 在其他任何机器上都是错的，node 一挪位置就失效。
用户级已经覆盖所有项目，这也是项目级文件通常没必要的原因——如果你想要，用 `--scope project` 按机器生成，并把 `.mcp.json` 加进 `.gitignore`：

```json
{ "mcpServers": { "dsh-wiki": { "type": "stdio", "command": "node", "args": ["<path-to-checkout>\\plugins\\dsh-wiki\\mcp\\server.mjs", "--repo", "<path-to-checkout>"] } } }
```

**Claude Desktop** 在 `%APPDATA%\Claude\claude_desktop_config.json`（macOS 上是 `~/Library/
Application Support/Claude/claude_desktop_config.json`）里保存它自己的列表；`--apply --target desktop` 会把条目连同备份合并进去。注册后请重启应用。

**回退 / 自动化：Streamable HTTP。** 有些客户端和脚本只接受 URL。显式启动同一个服务器，再注册该 URL——你写下的端口就是它监听的端口：

```sh
node mcp/server.mjs --transport http --port 7919
claude mcp add --transport http dsh-wiki http://127.0.0.1:7919/mcp
```

或者写进 `.mcp.json`：

```json
{ "mcpServers": { "dsh-wiki": { "type": "http", "url": "http://127.0.0.1:7919/mcp" } } }
```

请选 1024 及以上（以下为特权端口）且不在 `2190-2289`（本机保留——该段永远绑定不上）的端口。
服务器对这两种情况都以退出码 2 拒绝，而不是挪走，所以注册过的 URL 不会悄悄指向虚空。
端点是单一的 `POST /mcp`（外加实测客户端会打开的 `GET /mcp` SSE 通道），监听器只绑定 `127.0.0.1`。

**传输层，按实测——不是假设。
** Claude Code 2.1.286 发送带 `Accept: application/json, text/event-stream` 的 `POST /mcp`，依次执行 `server/discover` → `initialize` → `notifications/initialized` → `GET /mcp`（SSE）→ `tools/list`。
五者都已实现；
`tools/call` 返回渲染后的文本块，类型化拒绝（`ok:false`）是 `isError:true` 的正常结果，绝不是 JSON-RPC 错误。
HTTP 路径是实测的；
stdio 路径使用同一个协议内核，由测试套件在进程内演练。

**为什么 stdio 是默认——以及这个环境没能验证什么。
** 用户在普通终端里运行 Claude Code，上面的命令会带着管道拉起服务器；
客户端就是围绕这种传输构建的，而且它不需要端口。
被 DSH 沙箱化的进程是例外，不是常规：它无法拉起带管道的子进程（`spawn` → `EPERM`），所以**沙箱里的 agent** 根本无法演练 stdio。
因此它的 CLI/OS 管道层级在那里被跳过（明确的 `SKIP`，绝不是假通过），必须在普通终端里跑一次；
默认值本身、`--port` 围栏与 usage 文本，仍然通过写入文件（非管道）的子进程输出在沙箱内被断言。
与 Claude Code 本身的端到端 stdio **没有**在这个环境里观察到。

**安全：** 默认的 stdio 传输不打开任何套接字；
可选的 HTTP 传输只绑定 `127.0.0.1`（没有 host 选项）。
每个 HTTP 请求都必须通过四道围栏：回环 `Host` **并且**回环 `Origin`（或两者皆无，CLI 客户端就是这样发送的——浏览器总是两者都发，所以 DNS 重绑定页面会被拒绝两次）、唯一路径 `/mcp`、以及 1 MiB 的请求体上限。
`GET /mcp` 最多同时打开 16 个 SSE 通道（下一个得到 `429`，而不是再多一个文件描述符），并且每个请求都被限界两次：接收它用有限的 `requestTimeout`（一直发不完请求体的连接会被关闭），以及有界的分发期限（30 s），而不是无限占用其传输——在 stdio 上，一个卡死的调用否则会阻塞它身后的串行队列。
这两个限界都不会关闭一个已打开的 SSE 响应。
适配器是只读的——它只打开 `<repo>/<wikiDirName>/wiki.json` 与 `generation-meta.json`，别无其他——从不抓取、从不写入。

适配器**不**声称的事情：

- **没有句柄身份隔离。
** Host 通过 `lib/fs-contain.js` 读取（任一级都没有链接、单一硬链接、身份绑定到句柄）。
适配器只打开解析后的文件**一次**，并在读取之前从同一个句柄取得其大小（所以检查与读取之间的替换无法绕过 16 MiB 上限），但它无法检测一个名字在仓库内、字节却在同一卷其他位置的硬链接——`realpath` 没有路径可比。
这唯一的缺口记录在 `specs/015-wiki-mcp-adapter/plan.md`；
要补上需要比较 `nlink`/inode，而这是 Host 做的事。
- **不是认证边界。** 在 HTTP 模式下，本机上任何进程都能访问回环端口；这些围栏挡的是*浏览器页面*，不是本地程序。远程暴露不在范围内（constitution A7：TLS + 按设备凭据）。

当客户端省略 `repo` 时，解析依据 DSH 注册表（`<profile home>/dsh-wiki/registry.json`）：显式根目录必须是绝对、规范路径，且要么已注册要么确实包含 `<wikiDirName>/wiki.json`；
否则使用**恰好一个**带 wiki 的根目录，多个则返回 `repo-ambiguous` 并列出 basename——绝不猜测。

### 面板内 Generate / Update——**被发布闸门禁用**

面板带有任务控件和模型选择器，但本版本中**后台生成被有意关闭**：写入路径必须先通过一次真实的文件系统隔离 + 可信恢复评审才会开放。
任务管理器**确实**被构造出来并持有可信日志存储，但 `jobs.enabled` 默认是 `false`，所以每条任务路由都在读取请求体、解析根目录或触碰任何路径**之前**就回 503。
当前服务端契约：

| 路由 | 方法 | 状态 | 行为 |
| --- | --- | --- | --- |
| `/dsh-wiki/api/models` | GET | **可用**（只读） | `{ default, models: [{provider, model, label, providerLabel}], groups, failures }`，直接取自 `sessionController.modelCatalog()`；服务缺失时 503。它只读取目录。 |
| `/dsh-wiki/api/jobs` | POST | **503 disabled** | `{ error: "<gate message>", disabled: true }`，在读取请求体、解析 Host 服务或触碰任何路径**之前**返回。 |
| `/dsh-wiki/api/jobs?root=` | GET | **disabled 载荷** | `{ ok: true, root, disabled: true, disabledReason, active: null, last: null }`；管理器存在，但闸门让它保持空闲。形状仍与面板的轮询器兼容。未知根目录依然是 403。 |
| `/dsh-wiki/api/jobs/cancel` | POST | **503 disabled** | 与 POST `/api/jobs` 相同的闸门回答。 |
| `/dsh-wiki/api/jobs/recovery-plan?root=` | GET | **禁用期间 503** | 针对某个根目录日志记录的只读恢复计划；它绝不重命名或删除任何东西。2026-11-10 实测：`jobs.enabled` 闸门对这条路由同样回 503，未授权的根目录在闸门之前就是 403。 |
| `/dsh-wiki/api/jobs/recovery-execute` | POST | **禁用期间 403/503；需要 `confirm`** | 唯一可以执行恢复计划的路由。要求请求体里有字面量字段 `confirm: "execute-recovery"`、同源、JSON、已授权的根目录与一个打开的日志存储。**它目前无法完成重启后的恢复**——见下面的限制。 |

所以模型目录是可用的，但本版本面板里**没有实时生成**。
Generate/Update 控件保持**可见但禁用**，Host 给出的确切闸门原因以文字显示在旁边的提示里：消失的能力与被移除的能力无法区分，用户也就分不清"现在不行"和"再也不行"。
原因特意用**可见文字而不是悬停提示**，因为被禁用的表单控件的 tooltip 在不同浏览器中不可靠（未在本机测量——把它当作使用可见文字的理由，而不是对任何具体引擎的事实陈述）。
闸门关闭时**不渲染**模型下拉框（所选模型改为提示里一行淡色文字），因为孤零零一个只读选择器看起来像遗留的碎片。
反正选择也启动不了任何东西：Generate/Update 被禁用，POST 路由回 503，也不可能有任务变成活动状态。
请改用会话内的前台 `/wiki generate`——面板为此提供了"复制命令"按钮。

### 三个动作，以及为什么没有"Regenerate"

| 控件 | 发送 | 含义 |
| --- | --- | --- |
| **Update wiki (incremental)** | `action:"update"` + `incremental:true` | 只重写 `diff-impact` 映射到变更文件的页面/卡片（spec 013）。 |
| **Rebuild whole wiki**（More actions） | `action:"update"`，不带 `incremental` | 全量重建。当没有可用基线、`diff-impact` 不可用、或已发布 wiki 的 id 与文件名对不上时，这是唯一正确的选择。 |
| **Generate wiki** | `action:"generate"` | 首次构建；尚无基线。 |

**没有单独的"Regenerate"动作**，这是服务端的事实，而不是 UI 的疏漏：`lib/jobs.js` 定义 `JOB_ACTIONS = ["generate", "update", "translate"]`，而字典键 `btn.regen` 在任何修订里都从未被渲染成按钮。
增量是通过单独的 `incremental` 字段请求的，不是通过 `action`；
`buildWorkerPrompt` 仍然只接受 `{jobId, root, stageDir, config}` 并拒绝未知键，受影响集合由它自己可选的 `incremental` 选项携带。

### 增量更新是失败即关闭的，绝不悄悄退化成全量重建

`incremental:true` 只在 `action:"update"` 时被接受。
每一次降级都是明确的拒绝，且每次拒绝都不会启动任务：非布尔的 `incremental` 是 400 `invalid-incremental`；
`incremental:true` 配错误的 action 是 400 `incremental-not-for-generate` / `incremental-not-for-translate`；
409 家族是 `incremental-no-baseline`、`incremental-unavailable`、`incremental-baseline-diverged`、`incremental-up-to-date`、`incremental-id-mismatch`、`incremental-unexpected-write`。
其中两个之所以存在，是因为要求增量却悄悄拿到全量重建的调用方是被骗了。

有两条安全性质值得明说：

- **暂存树由线上 wiki 播种，播种失败是硬失败。** 发布会替换线上树，所以缺少种子会让 wiki *缩水*。
- **worker 停止后，计划未授权的每个条目都会从原始字节重新哈希**，受影响集合之外的任何改动、新增或删除都会让任务在发布前失败。
这覆盖 **`wiki.json` 的每个顶层键**、`pages/`+`cards/` 下的每个文件、其他每个顶层条目、新增的空目录，以及 worker 丢进 `site/` 的文件（只有 `site/index.html` 由 host 重新生成，所以该子树的其余部分会被比较）。
仅有的例外是 `generation-meta.json`、`config.json` 与 `locales/`，它们到不了发布：第一个由 host 在 worker 停止后写入，后两个归 host 所有、从线上重新复制。
没有这个比较，"除列出的 id 外逐字节相同"的承诺就无从验证——worker guard 允许在暂存目录任意位置 `write`/`edit`，所以只有这项检查才能把指令变成被强制执行的边界。
`sourceCommit` 只有在至少有一个页面被真正重写**或被有意删除**时才前进；
零改动的任务保留旧基线，而不是宣称它并不具备的新鲜度。
当已发布 wiki 的 front-matter id 与文件名对不上时，增量计划会被直接拒绝（`incremental-id-mismatch`），因为受影响集合按 id 索引而文件按名称索引——而且因为受影响文件被排除在上述比较之外，它们声明的 id 会在 worker 停止后被复查：受影响的页面不得声明*另一个*页面的 id，否则它会通过 `assemble` 的重复 id 解析遮蔽那个页面（`selfcheck` 不会拒绝重复 id，所以没有别的东西能抓到）。
- **删除一个受影响的页面是允许的，并且有记录，绝不静默。
** 一个主题已从仓库中删除的页面必须有办法消失，拒绝它会把任务推入永久死胡同（该页面在之后每次运行里仍然受影响，worker 再次删除它，任务永远失败）。
所以删除会发布，任务状态带上 `pagesRemoved` 加一个有界的 `removedSample`，面板在完成行里显示为", N pages removed"。
删除从不被算作重写。
删除一个受影响的**卡片**则被拒绝，因为没有公开字段可以记录它，而静默消失比要求一次全量更新更糟。

已知的剩余缺口，明说而不是隐藏：`site/index.html` 本身不被比较（host 会覆盖它），`config.json`/`locales/` 的字节不被比较（它们无法从暂存发布），worker 自己的工具在暂存里留下的游离文件会让任务失败即关闭（可通过一次全量更新恢复），而一个目录被另一个内容相同的*不同*目录替换，这个比较检测不到。

实测限度，写出来以免有人过度解读这个功能：在唯一可用的真实语料（一个私有工作区，`dd02d64..67a1131`）上，116 个变更文件映射到 **31 个页面中的 23 个、25 个卡片中的 9 个**，另有 102 个文件根本没有映射到任何页面。
对于漂移得很远的 wiki，增量几乎不比全量重建便宜，而且 `.dsh-wiki/` 本身是被提交的，所以一次 wiki 更新也会出现在 diff 里。

为什么要有闸门：后台任务会运行一个**没有文件系统隔离**的普通模型会话（"不要碰线上的 `.dsh-wiki`"是提示词层面的规则，不是沙箱），而以前的读路由在 `GET /api/projects|project|wiki|site` 上调用 `recover()`，所以一次普通读取就可能重命名任意遗留的 `.dsh-wiki.bak-*` 目录。
在写路径有真正的隔离、恢复值得信任之前（仅写路径，在一个经过评审的按仓库锁下），闸门保持关闭。
只读路由不再调用 `recover()`；
遗留的备份保持逐字节不动。

**恢复路由：2026-11-10 通过测量发现的两个缺陷，已修复，等待独立评审。** 两者都只在执行路径上。单独读任何一个文件都看不出来——它们是两个各自内部自洽的模块之间的不一致。

1. **词表不匹配。
** 生产环境的存活性提供者返回 `proof: "epoch-host-dead"`（`lib/index.js`），但规划器只接受 `["process-exit","host-registry","worker-session-id"]`（`lib/journal.js`）。
因此重启之后 `planRecovery` 会对畸形输入*抛出异常*，`reconcile` 报告 `status:"error"`，执行器根本到不了——也就是说，这条路由存在的唯一场景（Host 在发布过程中死掉，留下一个 `.dsh-wiki.bak-*` 外加一条记录）根本跑不起来。
提供者现在返回 `"process-exit"`，这正是实际确立的事实：记录中的 host 进程已经消失，而 worker 是进程内的子代理。
`WORKER_PROOFS` 被导出，这样测试可以断言提供者的值在规划器的词表之内。
2. **Host 绑定。
** 日志存储绑定到**每次 apply** 生成的 host id（`makeHostInstanceId`），所以 `lib/publish-executor.js` 会对前一个进程留下的任何记录以 `host-pin-mismatch` 拒绝 `restore-backup`。
只修 (1) 的话，这会成为下一个硬性停止点。
执行路由现在在同一个 `storeDir` 与同一份白名单上打开**第二个、显式不绑定的**存储，并且未绑定的 **`restore-backup` 执行需要显式的 `recovery: true`**——旧的"未绑定就跳过检查"的静默行为没有了，所以意外的接线会以 `recovery-not-declared` 失败即关闭，而不是意外地可用。
清理类决定（`remove-backup`、`remove-staging`）**不**受该标志约束；
它们从不推进记录，这是一条边界而不是一个证明。

安全并不依赖绑定：对于 `alive`、`unknown`、缺失证明，或——跨重启——除独立进程退出以外的任何证明，`lib/journal.js` 返回**零个动作**。
除非规划器已经决定，否则未绑定的存储什么也重命名不了。
注意，未绑定指的是选项键被**省略**；
显式传 `hostInstanceId: null` 会被拒绝为 `invalid-options`，因为存在性由 `Object.getOwnPropertyDescriptor` 判定。

这条路径上的剩余限制，写明而不是含糊带过：请求体读取在字节与时间上都有界。
期限被强制两次——**每次迭代的同步耗时检查**会终止 `next()` 立即 resolve 的迭代器（包括零字节流；
零长度分块从不累积），而 **`setTimeout` 竞速**会终止永不落定的 `next()`。
溢出、超时或中止时，读取器停下来**而不销毁套接字**：路由写出 413/408 响应，然后在 `finish` 时关闭连接，所以分块客户端收到的是响应体而不是连接重置。
实测：无限零字节迭代器 → 约 21 ms 后 408，堆约 20 MB（以前会耗尽堆）；
分块溢出 → 对端收到带错误体的 `413`。
`remove-backup` / `remove-staging` 清理决定不受 `recovery: true` 约束（它们从不推进记录，但那是边界，不是证明）；
Windows 上的持久性仍然是 `"file-flushed"`，不是目录同步；
并且这条路由在任何修订上都从未通过 HTTP 端到端演练过。
**在独立结论被写下来之前，把重启后的恢复视为未评审。
**

实现仍在树里（`lib/jobs.js`）：暂存发布、规范 `en` 语言闸门、受保护的 host 所有的 `config.json`/`locales/`、单飞围栏、取消/隔离、有界超时、备份恢复，以及写入围栏（同源、JSON content type、32 KB 上限、项目白名单、精确的目录内模型）。
一个**模块级**测试套件（`tools/jobs-harness-test.mjs`）把它当作未来/内部契约来演练——这些**不是**对线上路由的声明。
线上路由契约（503/disabled，读取不调用 `recover()`）由 `tools/harness-test.mjs` §19 覆盖。
要重新开放，必须先落地隔离 + 恢复工作，再重新接上管理器（见 `lib/index.js` 里的注释）。

重新启用后，一个任务是这样工作的：Host 在仓库根目录创建一个普通 DSH 会话，用 `agent.model.select(...)` 固定模型（会话作用域——部署默认值**不会**被改变），发送一条后续提示，并把候选结果写入 `<repo>/.dsh-wiki.staging-<jobId>/`（`.dsh-wiki` 的**同级**目录）。
一个 `completed` 回合之后，Host 要求 `wiki.json` 存在且其 `repoId` 指向该仓库根目录，运行 `build` + `selfcheck`（无 shell、有界超时），并且只通过带备份的重命名来发布通过的候选。
发布从来不是原子的（有界的毫秒级窗口）；
这条设计说明是为未来工作写的，不是当前行为。

针对那项未来工作的已知限制：`translate` 任务与 `locales/<lang>/` 尚未实现；任务状态只在内存里（Host 重启会忘掉最近一次任务视图；磁盘上的 wiki 不受影响）；面板只能看到 agent 回合前后的阶段粒度；而 agent 仍以普通权限运行。

**从 ZCode 迁移**：说「import the legacy wiki」——`import-legacy` 一步转换 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) 数据（`~/.zcode/v2/repo-wiki/<hash>`）；
`wiki.json` schema 完全兼容。

**知识卡片（0.2.0）**：除分页外，wiki 可附带短小的原子卡片（模块 / 概念 / API），证据 `path:line` 同样经机检；
站点里以可筛选的卡片网格、单卡视图和搜索结果呈现，页面用 `[文本](#card-<id>)` 链接。
写带 front-matter 的 `pages/*.md` + `cards/*.md`，再运行 `build_wiki_site.py assemble` 生成 `wiki.json`。

**增量影响（`diff-impact`，只读）**：把一个 git 区间映射到 wiki 上，而不重新生成它。

```sh
python3 scripts/build_wiki_site.py diff-impact --wiki <repo>/.dsh-wiki [--repo <abs repo path>] [--from <commit>] [--to <commit>]
```

`--from` 默认取记录的 `sourceCommit`（`generation-meta.json`，否则 `wiki.json`），`--to` 默认 `HEAD`；
`--repo` 默认取 `wiki.json` 的 `repoId`。
stdout 上的 JSON 报告包含 `from`、`to`、`changedFiles`、`affectedPages`、`affectedCards` 与 `unmappedFiles`：变更文件按精确路径或目录前缀匹配每个页面的 `filePaths` 与每张卡片的 `keyFiles`（`lib` 覆盖 `lib/a.py`，不覆盖 `library/a.py`），`:line`/`:start-end` 后缀会被规范化掉。
它从不构建、从不写入（连 `.dsh-wiki` 内部也不写）、从不碰网络，diff 路径上的失败以退出码 `2` 退出。

## 🔄 更新

面板里有一张 **Version** 卡片：已安装版本、**Check**（检查）按钮与 **Install update**（安装更新）按钮。该功能
**选入使用**、默认关闭（`update.enabled`，见「配置」）：关闭时插件不发任何出站请求，卡片只提示检查已停用。

**检查。** 设置 `update.enabled: true` 后，且仅当安装满足下文第 1–5 项条件时，点击 **Check** 会向
`raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json` 发一次 HTTPS 请求（5 s 超时、响应上限 64 KiB、
不跟随重定向、不带凭据）并读取其中的 `version`。不轮询：面板打开时读取一次状态，之后每次点 Check 再读取一次；`update.enabled: true` 时每次读取都可能发出这一次请求。同样的数据也在
`GET /dsh-wiki/api/update/status`。

**安装更新。** 只有**全部**条件满足时按钮才可用，按下列顺序判定（首个失败即拒绝，原因以文字显示在按钮旁）：

1. `update.enabled` 为 `true`，且没有其它更新正在运行。
2. 已安装的插件包是**真实目录**，不是符号链接。
3. 它是 git worktree，且安装目录就是该 worktree 的顶层（不是更大仓库里的子目录）。
4. `origin` 是指向 `nesteacold/dsh-wiki` 的 `https://` 地址（`ssh://`、`git://`、`http://`、scp 形式与本地路径一律拒绝）。
5. 工作树干净（`git status --porcelain` 无输出），所以未提交的改动绝不会被碰到。
6. 已发布版本是严格的 `X.Y.Z`，且**严格新于**已安装版本——相同或更旧的已发布版本绝不会安装（不降级）。

随后执行 `git fetch --tags --prune origin`，再 `git checkout --detach` 到标签 `v<版本>`（或 `<版本>`），没有标签则到
`origin/main`，并重读本地 `package.json`：它必须等于已发布版本，否则恢复到原修订并报 `postcondition-failed`。
每次 git 调用都在隔离配置下运行：无凭据助手、钩子目录指向空的临时文件夹、不递归子模块、只走 HTTPS、
不读用户/系统 git 配置、不出现交互提示。请求是 `POST /dsh-wiki/api/update`，请求体为
`{"confirm":"install-update"}`；没有这个确切令牌，更新服务一次都不会被调用。

**重载才算完成。** 更新成功**不会**重启任何东西。卡片会提示重载插件，`reloadRequired` 在插件被重新创建之前一直为 `true`。

**为什么开发安装会被拒绝。** 作为符号链接的安装——即从开发检出目录链接进 DSH profile 的插件——会在运行任何
git 命令之前以 `install-is-development-link` 被拒绝：把已发布版本检出到链接背后的目录会覆盖那棵开发树，
所以那里既不检查已发布版本，也永远不能 Install update；只有通过前 5 项条件的安装才会获取已发布版本。

**拒绝原因**是封闭的 15 个码，每个只对应一句固定文案（路径、git 输出和上游文本都不会到达客户端）：
`update-disabled`、`update-in-progress`、`install-not-found`、`install-is-development-link`、`install-not-git`、
`install-not-worktree-root`、`install-origin-mismatch`、`install-dirty`、`latest-not-newer`、`version-invalid`、
`network-unavailable`、`fetch-failed`、`checkout-failed`、`postcondition-failed`、`internal-error`。除
`internal-error`（500）外均为 HTTP 409。

**手动等价操作**（按钮所做的事，在插件的干净真实检出里）：

```sh
git fetch --tags --prune origin
git checkout --detach v<version>   # or the tag <version>, or origin/main when no tag exists
```

然后重载插件。0.3.1 的安装无法通过面板自更新：0.3.1 存在附注标签（annotated tag）缺陷（后置条件把 HEAD 与未剥离的标签对象 id 比较，导致每次更新都以 `postcondition-failed` 被拒并恢复），已在 0.3.2 修复；从 0.3.1 升到 0.3.2 请用本节的手动等价操作（`v0.3.2`）。配置键：`update.enabled`（布尔，默认 `false`；它是 `update` 下唯一的键，多出的键是配置错误）。
已知限制：检出/恢复路径目前只对注入的假实现验证过，没有对真实仓库执行过。

## ⚔️ 与社区同类方案对比

| | dsh-wiki | dsh-openwiki | dsh-plugin-codemap | archify |
| --- | --- | --- | --- | --- |
| 叙事 wiki 正文 | ✅ 分页 + 目录树 | ✅（外挂 CLI） | ❌ | ❌ |
| `path:line` 证据 + 机检 | ✅ 强制 | ❌ | ✅ | ❌ |
| 图表（mermaid/SVG 离线渲染） | ✅ | ❌ | 依赖图 | ✅ 仅图 |
| 单文件自包含站点（搜索/双主题） | ✅ 零外链机检 | ❌ | ❌ | ❌ |
| 第二工具链 / 第二密钥 | ❌ 不需要 | ✅ 需要 | ❌ | ❌ |
| 上传仓库内容 | 从不 | 视后端 | 从不 | 云端 |
| 维护状态 | 活跃 | 停更（2026-09） | 活跃 | 上游活跃 |

## 🎛️ 配置

插件行 `config`（GUI 插件页可逐行改）：

```yaml
- id: dsh-wiki
  config:
    wikiDirName: .dsh-wiki   # wiki dir name inside each repo
    wikiRoots: []            # extra absolute scan roots
    # in-panel jobs (spec 007) — optional overrides
    pythonPath: ~            # interpreter for build/selfcheck (default: probe python3, python, py -3)
    jobTimeoutMs: 2700000    # whole agent turn budget (45 min)
    buildTimeoutMs: 600000   # build subprocess timeout (10 min)
    selfcheckTimeoutMs: 600000
    pollMs: 500              # job supervisor poll interval
    update:
      enabled: false         # in-panel version check / self-update (see Updating); false = zero network
```

仅用于任务的设置（`pythonPath`、`jobTimeoutMs`、`buildTimeoutMs`、`selfcheckTimeoutMs`、`pollMs`）只在任务闸门重新开放后才生效；只读的模型目录与读路由会忽略它们。

生成配置四层合并：内置默认 → `~/.dsh/dsh-wiki/config.json` → `<仓库>/.dsh-wiki/config.json` → `--set k=v`。
预设 `compact`/`standard`/`deep`/`legacy`；
可调语言、页数、粒度（theme/file/hybrid）、每页字数、图表密度（none/minimal/rich）、引用档位（relaxed/strict）。

两个相互独立的语言决定：**站点外壳**（搜索占位符、卡片标签、主题切换、页脚、空状态文案）按前缀跟随 `wiki.json` 的 `language`——`vi*` → 越南语，`zh*` → 中文，其余（默认）→ 英文——而**页面内容**语言来自 resolve-config 的 `language` 字段（默认 `auto`：跟随仓库文档的语言）。
本阶段内容保持规范 `en`；
后台任务路径默认关闭，开启后也只生成或更新规范 `en` 的 wiki。

## 🔒 安全与隐私

| 行为 | dsh-wiki |
| --- | --- |
| 上传仓库内容 / Git 历史 | **从不** |
| 网络请求（生成、图表、字体、脚本） | **从不**（构建器零第三方依赖、站点零外链）。唯一的选入例外是版本检查/自更新（`update.enabled`，默认 `false`；见「更新」与 `SECURITY.md`） |
| 读取 `.git` 对象内容 | **从不**（唯一例外：可选 `git log --oneline -15` 摘要） |
| 产物位置 | 仅本地磁盘 |

宿主侧路由安全边界：回环 Host 校验 + 目录名必须等于 `wikiDirName` + 只读单文件服务，无遍历面。
读路由从不调用 `recover()`，所以浏览 wiki 不可能重命名遗留的 `.dsh-wiki.bak-*` 目录。
三条 POST 任务路由（`/api/jobs`、`/api/jobs/cancel`、`/api/jobs/recovery-execute`）**目前在路由层被禁用**（`jobs.enabled` 默认 `false`，所以每条都在读取请求体之前回 503）；
`recovery-execute` 另外要求请求体里有字面量字段 `confirm: "execute-recovery"`，并且是唯一能执行日志恢复计划的路由；
同源检查（严格的回环 `Origin` == 解析后的 `Host`）、JSON content-type 要求、32 KB 请求体上限、项目根白名单与 `lib/jobs.js` 里的精确模型检查仍为闸门重新开放而保留，并由模块级测试套件覆盖——不是由线上写路径覆盖。
通用提醒：插件宿主半区跑在宿主进程内，建议配合 `@jieai/dsh-plugin-vet` 自查。

## 🧪 测试

```sh
# Counts measured 2026-11-11 on Windows with full file access; each suite prints its own tally.
python3 tests/test_build_wiki_site.py   # 217 builder regression checks (injection PoCs, SVG sanitizing, config merge, node --check on site scripts, citation resolution incl. unique-basename fallback)
python3 tests/test_wiki_translations.py # 113 translation-policy checks (structural SHA-256 per typed unit)
node tools/harness-test.mjs             # host-half checks (skill / commands / routes / trust fence / subagent paths, plus job-gate, language API and body-read response wiring, plus the five agent tools). Measured 2026-11-11 with full file access: 479 PASS / 0 FAIL / 0 SKIP. Where git is unavailable the two git-dependent blocks SKIP by design (measured: 472 PASS / 0 FAIL / 2 SKIP with git removed from PATH).
node tools/mcp-test.mjs                 # MCP adapter checks (HTTP over a real socket, in-process stdio, resolution semantics, CLI default transport + flag fences via file-captured stdio). Measured 2026-11-11 with full file access: 110 passed / 0 skipped / 0 failed; the CLI-spawned and OS-pipe tiers report SKIP where the environment denies piped child processes.
node tools/jobs-harness-test.mjs        # 202 module-level job checks (drives lib/jobs.js directly, incl. starved-deadline, chunked-overflow and hostile-input regressions)
node tools/frontmatter-differential-test.mjs # 64 differential checks (58 front-matter shapes: the extracted JS reader vs the real python assemble reader; 0 leaks; exits 2 rather than passing when python is absent)
node tools/jobs-worker-test.mjs         # 99 worker-pipeline checks (prompt/guard/journal/publish-executor/translate seeding)
node tools/worker-protocol-test.mjs     # 64 protocol checks passed (65 cases; 1 POSIX-only case skips on Windows)
node tools/client-smoke.mjs <react> <react-dom> # 155 client checks (grid/detail/cards, markdown safety, zoom + focus trap, model selector, language selector, job controls)
node tools/journal-test.mjs             # 75 journal validator/planner checks (incl. the exported proof vocabulary)
node tools/journal-store-test.mjs       # 86 journal-store checks (exclusive create, flush, rename, tamper refusal)
node tools/publish-executor-test.mjs    # 27 publish/recovery-executor checks (incl. restart restore + explicit recovery flag)
node tools/fs-contain-test.mjs          # 27 containment checks (canonical dir, identity, guarded rename)
node tools/worker-guard-test.mjs        # 61 worker tool-guard checks
node tools/host-liveness-test.mjs       # 26 host-liveness checks
node tools/readme-parity-test.mjs       # 127 README parity checks (heading skeleton, byte-identical code blocks, fact tokens, links and anchors, line ratio, no machine paths — across every README translation)
node tools/update-test.mjs              # 150 update checks (version check + safe self-update: enabled gate, symlink/dirty-tree/origin refusals, downgrade guard, no path or upstream text in payloads, never restarts, single-flight, hardened git config)
node tools/update-ui-test.mjs <react> <react-dom> # 72 update UI checks (the Version card in every state rendered with real React; requests only on user action; install success only reports a reload)
node tools/wiki-freshness-test.mjs      # 39 wiki-freshness checks (changedFiles excludes the wiki dir via git pathspec, stale/behind/unknown semantics, injected fake execFile — no git, no network)
node tools/recovery-code-projection-test.mjs # 18 recovery-code projection checks (route PLAN_CODES / releaseReason allowlists re-derived from the producers, drift in either direction fails, fail-closed fallback kept)
```

上面每一行给出的是该套件自己打印的数字，并保持该套件自己的格式：两个 Python 套件打印 `N/M passed`；`node:test` 套件打印 `ℹ tests N / ℹ pass N / ℹ skipped N`（所以 `worker-protocol-test.mjs` 声明 65 个用例，在 Windows 上跳过 1 个）；其余 harness 每项打印一行 `PASS`，最后是 `ALL PASS`。这里**刻意不给单一总数**：一行 `PASS` 与一个 `node:test` 用例是两种不同的计量单位，相加只会得到一个没有定义的数字；而任何固定总数在下一个套件增长时就会过期。徽章因此写 `all suites pass`。要核对任何数字，重跑上面这段即可。

## ❓ FAQ

**和 DeepWiki（Cognition）有什么区别？** DeepWiki 托管在云端、把仓库上传给服务；dsh-wiki 用你本地会话里的模型，数据一步不出机器，产物是可双击打开的 HTML。

**支持哪些 DSH 版本？** peer 声明 `^0.1.1-rc.1 || ^0.2.0-rc.1`，实测 0.2.2-rc.1（2026-11-04 latest）；
未使用任何 0.2.2 破坏性 API（tools.resolve / tools.mode / Session Projection 均避开）。

**headless / tui profile 能用吗？** 技能与 `/wiki view|list` 可用；`/wiki generate` 与本机站点路由依赖 web 桌面宿主（webServer）。

**构建器要装依赖吗？** 不要。纯 Python 3.7+ 标准库，零 pip 安装。

## 📄 许可

MIT —— 见 [LICENSE](LICENSE)。
构建器与查看器源自 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki)（MIT）。
内联 mermaid 运行时含第三方组件，见 `assets/THIRD-PARTY-NOTICES`。

## 🙏 上游

本包是 [`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) 的 fork，保留其 MIT 许可、技能与命令名以及
`repo-wiki-local/1` 产物格式，因此既有的 wiki 仍可直接读取。本仓库独有的改动：

- 带可信恢复日志的"两段 rename"发布路径（`lib/journal*.js`、`lib/publish-executor.js`、`lib/fs-contain.js`）
- 把 worker 的 `write`/`edit` 限制在 `staging/pages|cards/*.md` 的工具闸门（`lib/worker-guard.js`）
- 以英文为 canonical、按单元翻译并用结构 SHA-256 校验的多语言支持（`locales/<lang>/`、`scripts/wiki_translations.py`）
- 被跟踪的工作项、决策与未解决风险：本仓库的 [`CHANGELOG.md`](CHANGELOG.md) 与提交历史
  （编号 spec 与 `docs/arch-notes/` 留在私有开发树中）

此处的包名是 `@dsh-ext/dsh-wiki`；`dsh-wiki` 只是运行期 id。若需要未改动的原版，请从上游仓库安装。
