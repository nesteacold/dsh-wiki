<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>DeepWiki 式本地仓库 Wiki，为 DeepSeek Harness (DSH) 而做：零上传、零网络、证据优先。</strong><br />
  agent 在本地读懂仓库 → 产出带 <code>路径:行号</code> 证据引用的分页 wiki（目录树 + 图表）→ 构建单文件自包含站点，挂在本机 DSH 宿主上直接浏览。</p>

  <p>
    <a href="#-安装">安装</a> ·
    <a href="#-用法">用法</a> ·
    <a href="#-与社区同类方案对比">对比</a> ·
    <a href="#-安全与隐私">隐私承诺</a> ·
    <a href="#-测试">测试</a> ·
    <a href="README.en.md">English</a>
  </p>

  <p>
    <img src="docs/assets/badges/license.svg" alt="MIT License">
    <img src="docs/assets/badges/dsh.svg" alt="DSH 0.2.x compatible">
    <img src="docs/assets/badges/python.svg" alt="Python ≥3.7">
    <img src="docs/assets/badges/tests.svg" alt="tests 64+25 passed">
    <img src="docs/assets/badges/network.svg" alt="zero network">
  </p>

</div>

> [!NOTE]
> **代码库的知识不该只活在原作者脑子里，也不该以"把整个仓库传上去"为代价。**
>
> 社区（awesome-dsh-plugin，9100+ 插件）里没有交付"DeepWiki 式"产物的插件：dsh-openwiki 依赖外挂 CLI 且停更、codemap 有引用无正文、archify 只有图。dsh-wiki 把**叙事正文 + 强制机检的证据引用 + 离线图表 + 自包含站点**合成一个 DSH bundle——全程本地，一行数据都不出网。
>
> ```sh
> git clone https://github.com/Acfufu/dsh-wiki && cd dsh-wiki
> "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
> ```

## ✨ 这是什么

一个标准 DSH 社区插件（`@acfufu/dsh-wiki`），装进任意 web/desktop profile 后给你四样东西：

| 入口 | 形式 | 说明 |
| --- | --- | --- |
| **`dsh-wiki` 技能** | runtime skill | 对话里说「给这个仓库生成 wiki」即接管：盘点 → 配置解析 → 语言判定 → 页面树规划 → 逐页写作 → build + selfcheck |
| **`/wiki` 命令** | slash command | `/wiki generate [路径]`（fork 子代理执行）、`/wiki view`（给出本机站点 URL）、`/wiki list` |
| **📚 侧栏 Wiki 面板** | 左侧栏全局面板 | 左栏新增 📖 入口：点开即列出所有已构建 wiki，选中后站点内嵌在应用里阅读（刷新 / 返回列表 / 新窗口一键切换） |
| **📖 Wiki 按钮** | 会话头部槽位 | 以独立窗口打开本机索引页（不想占用主面板时用） |

生成产物 `<仓库>/.dsh-wiki/`：

- `wiki.json` — 唯一事实源（schema `repo-wiki-local/1`，分页 + 内嵌 markdown）
- `pages/<id>.md` — 每页导出副本，便于 diff
- `generation-meta.json` — 生效配置与逐字段 provenance
- `site/index.html` — **单文件自包含站点**：目录树导航、全文搜索（键盘可操作）、深浅双主题、mermaid 离线渲染、内联 SVG 自动净化、窄屏自适应

站点经**零外链机检**（覆盖实体编码、protocol-relative、CSS `url()`/`@import` 等形态）；正文 `` `path:line` `` 引用由 selfcheck 强制机检：文件必须存在、行号必须在界内，越界 = 生成失败。

## 🚀 安装

前置：DSH Desktop 或 web profile（`dsh-base` + `dsh-web-app`）、`python3 ≥ 3.7`（构建器纯标准库，无第三方依赖）。

**路线 A · GUI 插件页**：侧栏「插件」→ 添加插件 → 填本仓库路径（或 `https://github.com/Acfufu/dsh-wiki`）→ 安装 → 启用。

**路线 B · CLI**：

```sh
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$CLI" plugin --profile desktop add github:Acfufu/dsh-wiki
"$CLI" plugin --profile desktop list
```

desktop profile 是 `patchReload: live`，装完刷新页面即生效。版本门禁声明覆盖 `^0.1.1-rc.1 || ^0.2.0-rc.1` 两条线（与 @jieai/dsh-plugin-vet 同款写法，0.2.2-rc.1 实测通过），无需豁免。

## 🧭 用法

```sh
/wiki generate            # 为当前工作区生成完整 wiki（fork 子代理跑技能协议）
/wiki generate /path/repo # 指定仓库
/wiki view                # 输出当前仓库站点的本机 URL
/wiki list                # 列出所有已知 wiki
```

本机路由（桌面宿主回环地址）：

- `/dsh-wiki/` — wiki 索引页（自动汇总已发现的仓库）
- `/dsh-wiki/site?path=<仓库>/.dsh-wiki` — 直接打开某个站点
- `/dsh-wiki/api/status` — JSON 状态

**发现机制**：插件从会话事件自动记住工作目录（持久化在 `<profile home>/dsh-wiki/registry.json`），并自动扫描已知目录的**同级目录**——凡含 `<wikiDirName>/site/index.html` 即收录，`import-legacy` 导入的存量 wiki 无需任何配置即可出现在索引；`config.wikiRoots` 可补充额外根目录。

**从 ZCode 迁移**：对话里说「导入 ZCode 的旧 wiki」或 `/repo-wiki` 存量数据（`~/.zcode/v2/repo-wiki/<hash>`）经 `import-legacy` 一键转入——数据格式与 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) 完全兼容。

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
    wikiDirName: .dsh-wiki   # 各仓库内 wiki 目录名
    wikiRoots: []            # 额外扫描的绝对路径数组
```

生成配置四层合并：内置默认 → `~/.dsh/dsh-wiki/config.json` → `<仓库>/.dsh-wiki/config.json` → `--set k=v`。预设 `compact`/`standard`/`deep`/`legacy`；可调语言、页数、粒度（theme/file/hybrid）、每页字数、图表密度（none/minimal/rich）、引用档位（relaxed/strict）。

## 🔒 安全与隐私

| 行为 | dsh-wiki |
| --- | --- |
| 上传仓库内容 / Git 历史 | **从不** |
| 网络请求（生成、图表、字体、脚本） | **从不**（构建器零第三方依赖、站点零外链） |
| 读取 `.git` 对象内容 | **从不**（唯一例外：可选 `git log --oneline -15` 摘要） |
| 产物位置 | 仅本地磁盘 |

宿主侧路由安全边界：仅回环 Host 放行 + 目录名必须等于 `wikiDirName` + 只读单文件服务，无遍历面。通用提醒：插件宿主半区跑在宿主进程内，建议配合 `@jieai/dsh-plugin-vet` 自查。

## 🧪 测试

```sh
python3 tests/test_build_wiki_site.py   # 构建器回归 64 项（注入 PoC、SVG 净化、配置合并、node --check 站点脚本）
node tools/harness-test.mjs             # 宿主半区 25 项（技能注册/命令/路由/信任围栏/子代理路径）
```

## ❓ FAQ

**和 DeepWiki（Cognition）有什么区别？** DeepWiki 托管在云端、把仓库上传给服务；dsh-wiki 用你本地会话里的模型，数据一步不出机器，产物是可双击打开的 HTML。

**支持哪些 DSH 版本？** peer 声明 `^0.1.1-rc.1 || ^0.2.0-rc.1`，实测 0.2.2-rc.1（2026-11-04 latest）；未使用任何 0.2.2 破坏性 API（tools.resolve / tools.mode / Session Projection 均避开）。

**headless / tui profile 能用吗？** 技能与 `/wiki view|list` 可用；`/wiki generate` 与本机站点路由依赖 web 桌面宿主（webServer）。

**构建器要装依赖吗？** 不要。纯 Python 3.7+ 标准库，零 pip 安装。

## 📄 许可

MIT —— 见 [LICENSE](LICENSE)。构建器与查看器源自 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki)（MIT）。内联 mermaid 运行时含第三方组件，见 `assets/THIRD-PARTY-NOTICES`。
