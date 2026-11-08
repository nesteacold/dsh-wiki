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
