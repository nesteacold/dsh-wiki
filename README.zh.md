<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>为 DeepSeek Harness（DSH）打造的 DeepWiki 式本地仓库 wiki：零上传、零网络、证据优先。</strong><br />
  agent 在本机读取你的仓库 → 产出带 <code>path:line</code> 引用的分页 wiki（导航树 + 图表）→ 构建成单个自包含
  HTML 站点，由你本机的 DSH host 提供服务。</p>

  <p>
    <a href="#-安装">安装</a> ·
    <a href="#-用法">用法</a> ·
    <a href="#-与社区同类方案对比">对比</a> ·
    <a href="#-安全与隐私">隐私</a> ·
    <a href="#-测试">测试</a> ·
    <a href="README.md">English</a>
  </p>

  <p>
    <img src="docs/assets/badges/license.svg" alt="MIT License">
    <img src="docs/assets/badges/dsh.svg" alt="DSH 0.2.x compatible">
    <img src="docs/assets/badges/python.svg" alt="Python ≥3.7">
    <img src="docs/assets/badges/tests.svg" alt="tests: 217 builder, 113 translation, 412 host, 192 module job, 64 differential, 99 worker pipeline, 64 protocol, 145 client, 114 readme parity, 302 trusted-journal/containment/guard/liveness checks">
    <img src="docs/assets/badges/network.svg" alt="zero network">
  </p>

</div>

> [!NOTE]
> **代码库的知识不该只活在原作者一个人的脑子里，也不该以「把整个仓库传上去」为代价。**
>
> awesome-dsh-plugin 上的 9,100+ 个社区插件里，没有一个能交付真正 DeepWiki 形态的产物：dsh-openwiki
> 包了一层外部 CLI 且已停更；codemap 有引用但没有正文；archify 有图表但没有 wiki 正文。dsh-wiki 把
> **叙事页面 + 机器可检的证据引用 + 离线图表 + 自包含站点**合并进同一个 DSH bundle——一切都在本机，
> 没有任何东西离开这台机器。
>
> ```sh
> # this repository IS the plugin package — clone it and point DSH at the checkout
> REPO="<path to this repo checkout>"
> CLI="<path to DSH>/runtime/cli/bin/dsh"        # e.g. "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
>                                               # or  "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh"
> "$CLI" plugin --profile desktop add "$REPO"
> ```

## ✨ 这是什么

一个 DSH 插件，在这里以 **`@dsh-ext/dsh-wiki`** 维护——它是
[`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) 的 **fork**，可靠性、流水线与翻译方面的工作记录在
本仓库的 [`CHANGELOG.md`](CHANGELOG.md) 和提交历史里（开发用的 spec 与架构笔记放在私有开发树，不在这里）。
运行期 id 是 `dsh-wiki`，包名因此保留这个后缀。装进任意 web/desktop profile 后，你会得到四个入口：

| 入口 | 形态 | 说明 |
| --- | --- | --- |
| **`dsh-wiki` 技能** | runtime skill | 说「给这个仓库生成一个 wiki」，分阶段协议就接管（Phase 0 inventory → Phase 5 report）：inventory → config resolution → language detection → page-tree planning → per-page writing → build + selfcheck |
| **`/wiki` 命令** | slash command | `/wiki generate [path]`（在 fork subagent 里运行）、`/wiki view`（打印本机站点 URL）、`/wiki list` |
| **📚 侧栏 Wiki 面板** | 左侧栏全局面板 | 侧栏新增一行 📖：点开即列出所有已构建的 wiki，选中后站点就在应用内直接阅读（refresh / 返回列表 / pop-out） |
| **📖 Wiki 按钮** | session-header 槽位 | 在独立窗口里打开本机索引页（当你不愿离开对话时） |

产物落在 `<repo>/.dsh-wiki/`：

- `wiki.json` — 唯一事实源（schema `repo-wiki-local/1`，分页，inline markdown）
- `pages/<id>.md` — 每页的导出副本，便于 diff
- `generation-meta.json` — 解析后的配置，带逐字段 provenance
- `site/index.html` — **单文件自包含站点**：导航树、全文搜索（可用键盘操作）、浅色/深色主题、离线 mermaid
  渲染、净化后的内联 SVG、移动端自适应

站点要通过 **零外部链接的机器检查**（实体编码、protocol-relative URL、CSS `url()`/`@import` 形态都已覆盖）。
引用同样被机器检查，但只覆盖一种很窄的形态：单个反引号包起来的 `` `path:line` ``（或 `path:start-end`），
其扩展名在允许列表内、路径为 ASCII。对这种形态，文件缺失、路径越出仓库或行号越界都会让 `selfcheck` 失败；
能解析但内容为空的行只是 warning，仓库根不可用时整个检查降级为 warning。裸路径、带空格、非 ASCII
路径、无扩展名或扩展名不在列表内、一个 span 里多个引用、以及没有反引号的引用都**不被**检查——你自己
发出的每一条引用，请自行核实。

## 🚀 安装

前置条件：一个 DSH Desktop / web profile（`dsh-base` + `dsh-web-app`）、`python3 ≥ 3.7`（构建器纯标准库，
无第三方依赖）。

**路线 A · GUI 插件页**：侧栏「Plugins」→ Add → 粘贴本仓库的检出路径（包含 `package.json` 的那个目录）
→ Install → Enable。

**路线 B · CLI**：

```sh
CLI="<path to DSH>/runtime/cli/bin/dsh"
REPO="<path to this repo checkout>"
"$CLI" plugin --profile desktop add "$REPO"
"$CLI" plugin --profile desktop list
```

desktop profile 运行 `patchReload: live`——刷新即生效。Peer 范围 `^0.1.1-rc.1 || ^0.2.0-rc.1` 能通过
0.2.2-rc.1 的版本门禁（写法与 @jieai/dsh-plugin-vet 相同），无需任何豁免。

## 🧭 用法

```sh
/wiki generate            # full wiki for the current workspace (fork subagent)
/wiki generate /path/repo # explicit repo
/wiki view                # print the local site URL
/wiki list                # list known wikis
```

本机路由（桌面宿主上的回环地址）：

- `/dsh-wiki/` — wiki 索引页（自动汇总已发现的仓库）
- `/dsh-wiki/site?path=<repo>/.dsh-wiki` — 直接打开某个站点
- `/dsh-wiki/api/status` — JSON 状态

**发现机制**：会话的 workspace 会被自动记住（持久化到 `<profile home>/dsh-wiki/registry.json`），已知
根目录的**同级目录**也会被扫描——任何包含 `<wikiDirName>/site/index.html` 的目录都会被收录，所以通过
`import-legacy` 导入的 wiki 零配置就出现在索引里；`config.wikiRoots` 可以追加额外的根。

### 面板内 Generate / Update —— **被 release gate 关闭**

面板带着 job 控件和一个模型选择器，但**后台生成在这次发布里是被故意关掉的**：写路径必须先通过真正的
文件系统隔离 + 可信恢复评审，才会对外开放。job manager **确实已经构建出来**并持有 trusted journal
store，但 `jobs.enabled` 默认为 `false`，所以每个 job 路由都在读 body、解析 root 或触碰任何路径之前
就先回 503。今天的服务端契约：

| 路由 | 方法 | 状态 | 行为 |
| --- | --- | --- | --- |
| `/dsh-wiki/api/models` | GET | **可用**（只读） | `{ default, models: [{provider, model, label, providerLabel}], groups, failures }` 直接来自 `sessionController.modelCatalog()`；service 缺席时 503。它只读 catalog。 |
| `/dsh-wiki/api/jobs` | POST | **503 disabled** | `{ error: "<gate message>", disabled: true }`，在**读取 body 之前**返回，也不 resolve Host service、不触碰任何路径。 |
| `/dsh-wiki/api/jobs?root=` | GET | **disabled payload** | `{ ok: true, root, disabled: true, disabledReason, active: null, last: null }`；manager 存在，但 gate 让它保持 idle。形状仍与面板的 poller 兼容。未知 root 仍然是 403。 |
| `/dsh-wiki/api/jobs/cancel` | POST | **503 disabled** | 与 POST `/api/jobs` 相同的 gate 回答。 |
| `/dsh-wiki/api/jobs/recovery-plan?root=` | GET | **关闭期间 503** | 针对某个 root 的 journal record 的只读恢复计划；它从不重命名或删除任何东西。2026-11-10 实测：`jobs.enabled` gate 对这条路由同样回 503，未授权的 root 在 gate 之前就是 403。 |
| `/dsh-wiki/api/jobs/recovery-execute` | POST | **关闭期间 403/503；需要 `confirm`** | 唯一可能执行恢复计划的路由。需要 body 里字面量字段 `confirm: "execute-recovery"`、同源、JSON、已授权的 root 和一个打开的 journal store。**它目前无法完成一次重启后的恢复**——见下面的限制。 |

所以模型 catalog 可用，但这次发布里面板**没有可用的实时生成**。Generate/Update 控件**保持可见但
disabled**，并把 Host 的原始 gate 原因作为文字显示在旁边的 notice 里：一个能力消失了，和一个能力被删除
了，在用户眼里无法区分，用户也就分不清「暂时不行」和「再也不会行」。这个原因刻意做成**可见文字而不是
hover tooltip**，因为被 disabled 的表单控件的 tooltip 在各浏览器之间并不可靠（没有在本机实测——这只是
选择可见文字的理由，不是关于某个具体引擎的结论）。gate 关闭期间模型下拉**不渲染**（选中的模型改为
notice 里一行灰字），因为孤零零一个只读选择器看起来像残留的碎片。就算选了也启动不了任何东西：
Generate/Update 是 disabled，POST 路由回 503，任何 job 都无法变成 active。请改用会话内的前台
`/wiki generate`——面板为此提供了一个「Copy command」按钮。

### 三个 action，以及为什么没有「Regenerate」

| 控件 | 发送 | 含义 |
| --- | --- | --- |
| **Update wiki (incremental)** | `action:"update"` + `incremental:true` | 只重写 `diff-impact` 映射到变更文件的那些 page/card（spec 013）。 |
| **Rebuild whole wiki**（More actions） | `action:"update"`，不带 `incremental` | 全量重建。没有可用 baseline、`diff-impact` 不可用、或已发布 wiki 的 id 与文件名不一致时，这是唯一正确的选择。 |
| **Generate wiki** | `action:"generate"` | 首次构建；此时还没有 baseline。 |

没有单独的「Regenerate」action，这是服务端事实而不是 UI 遗漏：`lib/jobs.js` 定义
`JOB_ACTIONS = ["generate", "update", "translate"]`，而 `btn.regen` 这个字典 key 在任何 revision 里都没有
被渲染成按钮。增量工作通过独立的 `incremental` 字段请求，而不是通过 `action`；`buildWorkerPrompt` 仍然
只接受 `{jobId, root, stageDir, config}` 并拒绝未知 key，受影响集合装在它自己可选的 `incremental`
option 里。

### 增量更新 fail-closed，绝不静默变成全量重建

`incremental:true` 只在 `action:"update"` 时被接受。每一次降级都是一次显式 refusal，而每一次 refusal
都不启动 job：不是布尔值的 `incremental` 是 400 `invalid-incremental`；`incremental:true` 配错 action 是
400 `incremental-not-for-generate` / `incremental-not-for-translate`；409 家族则是
`incremental-no-baseline`、`incremental-unavailable`、`incremental-baseline-diverged`、
`incremental-up-to-date`、`incremental-id-mismatch`、`incremental-unexpected-write`。其中两个之所以存在，
是因为一个要求增量、却静默拿到全量重建的调用方已经被骗了。

有三条安全性质值得直白写出来：

- **staging 树从正在运行的 wiki 播种，播种失败就是硬失败。** 发布是用新树替换活动树，所以缺了播种会让
  wiki *缩小*。
- **plan 未授权的每一个条目都会在 worker 停止之后从原始字节重新哈希**，受影响集合之外的任何改动、新增
  或删除都会在发布前让 job 失败。这覆盖 `wiki.json` 的**每一个顶层 key**、`pages/`+`cards/` 下的每个
  文件、其它每一个顶层条目、新增的空目录，以及 worker 丢到 `site/` 下的文件（只有 `site/index.html`
  由 host 重新生成，所以那个子树的其余部分会被比较）。唯一的例外是 `generation-meta.json`、
  `config.json` 和 `locales/`，它们到不了发布环节：第一个由 host 在 worker 停止后写入，后两个由 host
  拥有并从 live 重新复制。没有这次比较，「除列出的 id 之外逐字节相同」的承诺就是未经验证的——worker
  guard 允许在 staging 下的任何位置 `write`/`edit`，只有这项检查把一句指令变成被强制执行的边界。
  `sourceCommit` 只有在至少一个页面被真正重写**或被故意移除**时才前进；零变更的 job 保留旧 baseline，
  而不是宣称自己并不拥有的新鲜度。当已发布 wiki 的 front-matter id 与文件名不一致时，增量 plan 会被直接
  拒绝（`incremental-id-mismatch`），因为受影响集合按 id 索引、文件却按名称索引——也因为受影响文件被
  排除在上面那次比较之外，它们的声明 id 会在 worker 停止后复查：一个受影响页面不得声明*另一个*页面的
  id，否则它就能通过 `assemble` 的重复 id 解析遮蔽那个页面（`selfcheck` 不拒绝重复 id，所以别的检查
  抓不到）。
- **移除受影响页面是允许的、并且会被记录，绝不静默。** 主题已从仓库删除的页面必须能消失，拒绝它会把
  job 推进永久死胡同（页面在之后每次运行里都仍然受影响，worker 再删一次，job 永远失败）。所以这次移除
  照样发布，job state 携带 `pagesRemoved` 以及一个有界的 `removedSample`，面板在完成行里显示
  ", N pages removed"。移除从不计入一次重写。移除受影响的 **card** 则被拒绝，因为没有公开字段可以记录
  它，而无声消失比要求一次全量更新更糟。

已知残余缺口，直说而不隐藏：`site/index.html` 本身不参与比较（host 会覆盖它），
`config.json`/`locales/` 的字节不参与比较（它们无法从 staging 发布），worker 自己的工具在 staging 里
留下的杂散文件会让 job fail-closed（可以用一次全量更新恢复），而一个目录被另一个内容完全相同的目录
替换，这套比较检测不出来。

实测限制，写出来以免有人过度解读这个功能：在唯一可用的真实语料（`DXVK_Project`，`dd02d64..67a1131`）上，
116 个变更文件映射到 **31 个页面中的 23 个、25 张卡片中的 9 张**，另有 102 个文件没有映射到任何页面。
对于一个已经漂移很远的 wiki，增量比全量重建省不了多少。在该语料里 `.dsh-wiki/` 本身也被提交，所以一次 wiki
更新也会出现在 diff 里；本仓库则把它 ignore 掉（`.gitignore`），这也是推荐配置。

为什么要有 gate：一个后台 job 会用**没有任何文件系统隔离**的方式跑一个普通的模型会话（「不要碰正在使用
的 `.dsh-wiki`」只是 prompt 层面的规则，不是 sandbox），而以前的读取路由在
`GET /api/projects|project|wiki|site` 上调用了 `recover()`，于是一次普通读取就可能重命名一个任意残留的
`.dsh-wiki.bak-*` 目录。在写路径拥有真正的隔离、并且恢复变得可信（仅写路径、在评审过的 per-repo lock
之下）之前，gate 保持关闭。只读路由不再调用 `recover()`；残留的备份一个字节都不动。

**恢复路由：2026-11-10 用测量发现两个缺陷，已修复，等待独立评审。** 两个都只在 execute 路径上。单独
读任何一个文件都看不出来——它们是两个各自内部自洽的模块之间的分歧。

1. **词表不一致。** 生产的 liveness provider 返回 `proof: "epoch-host-dead"`（`lib/index.js`），但
   planner 只接受 `["process-exit","host-registry","worker-session-id"]`（`lib/journal.js`）。于是一次
   重启之后 `planRecovery` 在畸形输入上*抛出异常*，`reconcile` 报告 `status:"error"`，executor 永远
   到不了——也就是说，这条路由之所以存在的唯一场景（一个 Host 在发布中途死亡，留下一个
   `.dsh-wiki.bak-*` 加一条记录）根本跑不起来。provider 现在返回 `"process-exit"`，这正是实际被确立的
   事实：记录中的 host 进程已经不在了，而 worker 是一个进程内 subagent。`WORKER_PROOFS` 被导出，好让
   测试能断言 provider 的值在 planner 的词表内。
2. **Host pin。** journal store 被 pin 到一个**每次 apply 都会重新生成**的 host id
   （`makeHostInstanceId`），于是 `lib/publish-executor.js` 对任何前一个进程留下的记录都以
   `host-pin-mismatch` 拒绝 `restore-backup`。只修 (1) 的话，这会成为下一个硬停点。execute 路由现在在
   同一个 `storeDir` 和同一份 allowlist 上打开**第二个明确不 pin 的 store**，并且未 pin 的
   **`restore-backup` 执行要求显式的 `recovery: true`**——旧的「不 pin 就跳过检查」的静默行为已经消失，
   所以接错线会 fail-closed 报 `recovery-not-declared`，而不是碰巧跑通。清理决策（`remove-backup`、
   `remove-staging`）**不**受该标志约束；它们从不推进记录，这是边界而不是证明。

安全不依赖 pin：`lib/journal.js` 对 `alive`、`unknown`、缺失 proof、或跨一次重启除独立进程退出之外的
任何 proof 都返回**零个 action**。未 pin 的 store 只有在 planner 已经决定要重命名时才能重命名任何东西。
注意「未 pin」意味着 option key **被省略**；显式传 `hostInstanceId: null` 会被当作 `invalid-options`
拒绝，因为是否出现由 `Object.getOwnPropertyDescriptor` 判定。

这条路径上的残余限制，明说而不含糊：body 读取在字节上和时间上都有界。deadline 被强制两次——一次
**每次迭代都做的同步耗时检查**，会停掉那些 `next()` 立即返回的 iterable，包括零字节流（零长度 chunk
从不被累积）；以及一次 **`setTimeout` 竞速**，会停掉永不 settle 的 `next()`。在溢出、超时或中止时，
reader 停止**而不销毁 socket**：路由先写出 413/408 响应，然后在 `finish` 时关闭连接，所以 chunked
客户端收到的是响应体而不是 reset。实测：无限零字节 iterator → 约 21 ms 内 408、约 20 MB 堆（以前会耗尽
堆）；chunked 溢出 → 对端收到带错误体的 `413`。`remove-backup` / `remove-staging` 清理决策不受
`recovery: true` 约束（它们从不推进记录，但那是边界，不是证明）；Windows 上的持久性仍是
`"file-flushed"`，没有目录同步；这条路由在任何 revision 上都没有被端到端地通过 HTTP 跑过。**在写下
一份独立结论之前，把重启后恢复视为未评审。**

实现仍然在树里（`lib/jobs.js`）：staging 发布、canonical-`en` 语言 gate、受保护的 host 自有
`config.json`/`locales/`、single-flight 围栏、cancel/quarantine、有界超时、备份恢复，以及那些写围栏
（same-origin、JSON content-type、32 KB 上限、项目 allowlist、精确 catalog model）。一个**模块级**
harness（`tools/jobs-harness-test.mjs`）把它当作未来/内部契约来演练——那些**不是**对在用路由的断言。
在用路由的契约（503/disabled、读取时不调用 `recover()`）覆盖在 `tools/harness-test.mjs` §19。重新打开
意味着先落地隔离 + 恢复那部分工作，然后重新接线 manager（见 `lib/index.js` 里的注释）。

重新启用后，一个 job 是这样工作的：Host 在仓库根创建一个普通的 DSH session，用
`agent.model.select(...)` pin 住模型（session 作用域——部署默认值**不**改变），发送一条 follow-up
prompt，并把候选写入 `<repo>/.dsh-wiki.staging-<jobId>/`（`.dsh-wiki` 的**同级**目录）。在一个
`completed` 回合之后，Host 要求 `wiki.json` 的 `repoId` 指向仓库根，运行 `build` + `selfcheck`（无
shell、有界超时），并且只发布绿色的候选，用 rename 加备份。发布从来就不是原子的（有界的毫秒窗口）；
那条设计说明是给未来工作的，不是当前行为。

那部分未来工作的已知限制：`translate` job 与 `locales/<lang>/` 尚未实现；job 状态只在内存里（Host
重启会忘掉上一个 job 视图；磁盘上的 wiki 不受影响）；面板只在 agent 回合前后看到 stage 粒度；agent
仍然以普通权限运行。

**从 ZCode 迁移**：说「导入旧的 wiki」——`import-legacy` 一步转换
[zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) 的数据（`~/.zcode/v2/repo-wiki/<hash>`）；
`wiki.json` schema 完全兼容。

**知识卡片（0.2.0）**：除页面之外，一个 wiki 还可以带短小的原子卡片（module / concept / API），带机器
可检的 `path:line` 证据，以可筛选的卡片网格、单卡视图以及在搜索里出现；页面用 `[text](#card-<id>)`
链接到它们。写带 front-matter 的 `pages/*.md` + `cards/*.md`，再运行 `build_wiki_site.py assemble`
生成 `wiki.json`。

**增量影响（`diff-impact`，只读）**：把一个 git 区间映射到 wiki 上，而不重新生成它。

```sh
python3 scripts/build_wiki_site.py diff-impact --wiki <repo>/.dsh-wiki [--repo <abs repo path>] [--from <commit>] [--to <commit>]
```

`--from` 默认为记录的 `sourceCommit`（`generation-meta.json`，否则 `wiki.json`），`--to` 默认为
`HEAD`；`--repo` 默认为 `wiki.json` 的 `repoId`。stdout 上的 JSON 报告包含 `from`、`to`、
`changedFiles`、`affectedPages`、`affectedCards` 和 `unmappedFiles`：变更文件按精确路径或目录前缀与
每个页面的 `filePaths`、每张卡片的 `keyFiles` 匹配（`lib` 覆盖 `lib/a.py`，不覆盖 `library/a.py`），
`:line`/`:start-end` 后缀会被规范化去掉。它从不构建、从不写入（连 `.dsh-wiki` 里面也不写）、从不触网，
diff 路径上的失败以 `2` 退出。

## ⚔️ 与社区同类方案对比

| | dsh-wiki | dsh-openwiki | dsh-plugin-codemap | archify |
| --- | --- | --- | --- | --- |
| 叙事式 wiki 正文 | ✅ 分页 + 导航树 | ✅（外部 CLI） | ❌ | ❌ |
| `path:line` 引用 + 机器检查 | ✅ 强制 | ❌ | ✅ | ❌ |
| 图表（离线 mermaid/SVG） | ✅ | ❌ | 仅依赖图 | ✅ 仅图表 |
| 单文件自包含站点（搜索/主题） | ✅ 通过零外链检查 | ❌ | ❌ | ❌ |
| 第二套工具链 / 第二个 API key | ❌ 不需要 | ✅ 需要 | ❌ | ❌ |
| 上传仓库内容 | 从不 | 取决于后端 | 从不 | 云端 |
| 维护状态 | 活跃 | 停更（2026-09） | 活跃 | 上游活跃 |

## 🎛️ 配置

插件行 `config`（在 GUI 插件页里逐行可改）：

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
```

仅供 job 使用的设置（`pythonPath`、`jobTimeoutMs`、`buildTimeoutMs`、`selfcheckTimeoutMs`、`pollMs`）
只在 job gate 重新打开后生效；只读的模型 catalog 和读取路由忽略它们。

生成配置合并四层：内置默认 → `~/.dsh/dsh-wiki/config.json` → `<repo>/.dsh-wiki/config.json` →
`--set k=v`。预设 `compact`/`standard`/`deep`/`legacy`；可调项覆盖语言、页面数、粒度
（theme/file/hybrid）、每页字数、图表密度（none/minimal/rich）、引用模式（relaxed/strict）。

两个彼此独立的语言决策：**站点 chrome**（搜索占位符、卡片标签、主题切换、页脚、空状态文案）按前缀跟随
`wiki.json` 的 `language`——`vi*` → 越南语，`zh*` → 中文，其它（默认）→ 英语——而**页面内容**的语言来自
resolve-config 的 `language` 字段（默认 `auto`：跟随仓库的文档语言）。在这一版里内容仍保持 canonical
`en`；后台 job 路径默认关闭，而一旦启用，也只会生成或更新 canonical `en` wiki。

## 🔒 安全与隐私

| 行为 | dsh-wiki |
| --- | --- |
| 上传仓库内容 / Git 历史 | **从不** |
| 网络请求（生成、图表、字体、脚本） | **从不**（零依赖构建器、零外链站点） |
| 读取 `.git` 对象内容 | **从不**（唯一例外：可选的 `git log --oneline -15` 摘要） |
| 产物位置 | 仅本地磁盘 |

Host 侧的路由围栏：回环 Host 检查 + 目录 basename 必须等于 `wikiDirName` + 只读的单文件服务，没有遍历
面。读取路由从不调用 `recover()`，所以浏览一个 wiki 不可能重命名一个残留的 `.dsh-wiki.bak-*` 目录。三个
POST job 路由（`/api/jobs`、`/api/jobs/cancel`、`/api/jobs/recovery-execute`）**目前在路由层就被禁用**
（`jobs.enabled` 默认为 `false`，所以每个都在读请求 body 之前回 503）；`recovery-execute` 还额外要求
body 里字面量字段 `confirm: "execute-recovery"`，并且是唯一可能执行 journal 恢复计划的路由；
`lib/jobs.js` 里的同源检查（严格回环 `Origin` == 解析后的 `Host`）、JSON content-type 要求、32 KB body
上限、项目根 allowlist 和精确模型检查仍然实现着，等 gate 重新打开时使用，并由模块级 harness 覆盖——
而不是由一条在用的写路径覆盖。一般提醒：插件的 host 半边运行在 host 进程内部——如果你要审计插件，请
配合 `@jieai/dsh-plugin-vet`。

## 🧪 测试

```sh
python3 tests/test_build_wiki_site.py   # 217 builder regression checks (injection PoCs, SVG sanitizing, config merge, node --check on site scripts, citation resolution incl. unique-basename fallback)
python3 tests/test_wiki_translations.py # 113 translation-policy checks (structural SHA-256 per typed unit)
node tools/harness-test.mjs             # 412 host-half checks (skill / commands / routes / trust fence / subagent paths, plus job-gate, language API and body-read response wiring)
node tools/jobs-harness-test.mjs        # 192 module-level job checks (drives lib/jobs.js directly, incl. starved-deadline, chunked-overflow and hostile-input regressions)
node tools/frontmatter-differential-test.mjs # 64 differential checks (58 front-matter shapes: the extracted JS reader vs the real python assemble reader; 0 leaks; exits 2 rather than passing when python is absent)
node tools/jobs-worker-test.mjs         # 99 worker-pipeline checks (prompt/guard/journal/publish-executor/translate seeding)
node tools/worker-protocol-test.mjs     # 64 protocol checks (1 POSIX-only case skipped on Windows)
node tools/client-smoke.mjs <react> <react-dom>  # 145 client checks (grid/detail/cards, markdown safety, zoom + focus trap, model selector, language selector, job controls)
node tools/readme-parity-test.mjs          # 114 README parity checks (EN is the source of truth; every README.<lang>.md must match its headings, byte-identical code blocks, facts, links and length)
node tools/journal-test.mjs             # 75 journal validator/planner checks (incl. the exported proof vocabulary)
node tools/journal-store-test.mjs       # 86 journal-store checks (exclusive create, flush, rename, tamper refusal)
node tools/publish-executor-test.mjs    # 27 publish/recovery-executor checks (incl. restart restore + explicit recovery flag)
node tools/fs-contain-test.mjs          # 27 containment checks (canonical dir, identity, guarded rename)
node tools/worker-guard-test.mjs        # 61 worker tool-guard checks
node tools/host-liveness-test.mjs       # 26 host-liveness checks
```

## ❓ FAQ

**这和 DeepWiki（Cognition）有什么区别？** DeepWiki 是一个托管服务——仓库要离开你的机器。dsh-wiki 使用
你本地 session 里的模型；没有任何东西离开这台机器，产物是一个双击就能打开的 HTML 文件。

**支持哪些 DSH 版本？** peer 声明 `^0.1.1-rc.1 || ^0.2.0-rc.1`；在 0.2.2-rc.1（`engines.dsh` 所 pin 的版本）上验证
过。没有使用会破坏 0.2.2 的 API（tools.resolve / tools.mode / Session Projection 都避开了）。

**headless / tui profile 呢？** 技能和 `/wiki view|list` 可用；`/wiki generate` 和本机站点路由需要
web/desktop host（webServer）。

**构建器需要依赖吗？** 不需要。纯 Python 3.7+ 标准库，零 pip 安装。

## 📄 许可

MIT —— 见 [LICENSE](LICENSE)。构建器与查看器移植自
[zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki)（MIT）。内联的 mermaid 运行时打包了第三方
组件——见 `assets/THIRD-PARTY-NOTICES`。

## 🙏 上游

本包是 [`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) 的 fork，保留其 MIT 许可、skill/command
名称和 `repo-wiki-local/1` 产物 schema，因此已有的 wiki 仍然可读。fork 专属的工作在本仓库里：

- 带 journal 的两次 rename 发布路径，配一个 trusted recovery journal（`lib/journal*.js`、
  `lib/publish-executor.js`、`lib/fs-contain.js`）
- 一个 tool-guard，把 worker 的 `write`/`edit` 限制在 `staging/pages|cards/*.md`
  （`lib/worker-guard.js`）
- canonical-English wiki，配按 locale 的单元翻译与结构 SHA-256 校验（`locales/<lang>/`、
  `scripts/wiki_translations.py`）
- 被跟踪的工作、决策与未解决风险：本仓库的 [`CHANGELOG.md`](CHANGELOG.md) 及其提交历史（编号 spec 和
  `docs/arch-notes/` 留在私有开发树中）

这里的包名是 `@dsh-ext/dsh-wiki`；`dsh-wiki` 只是运行期 id。如果你想要未经改动的原版，请从上游仓库
安装。
