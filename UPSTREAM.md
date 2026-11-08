# 上游基线

dsh-wiki 的构建器、查看器与你看到的站点产物都来自 [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki)
（MIT）。本文件钉死基线、文件名与路径映射，以及本仓库相对基线有意做出的每一处改动，让"这段代码是谁的、
为什么和上游不一样"可以逐条核对。

## 基线

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/Acfufu/zcode-repo-wiki` |
| 版本 | `0.2.2`（tag `v0.2.2`，annotated tag） |
| commit | `74ce9f4bc26f1eaea6b7c76af7335c0e9c45978b`（`chore(release): 0.2.2`） |
| 取用日期 | 2026-11-08 |
| `repo-wiki/scripts/build_wiki_site.py` 的 git blob | `d8c7712c3fbe901dc0dc466ccc53c9e9fc13800a` |
| 同上，sha256（LF 文本，70441 字节） | `e5fbac1ecd83c643b1776f095eae3608e17a0aec82cfb0f3456ab574cb5b895f` |
| 同上，sha256（对工作区检出的 CRLF 副本，132612 字节） | `f8aea8fea1e89d8aba77d62a47cfa363a32205c70c516803d3182457906c10e7` |
| 同上，本仓库当前文件 sha256 | `a4b119fed8d5a5fdef63979a7722c0fbdecc7d569d1361862afed8d868db1c4c`（73942 字节） |
| 归档副本 | `../_upstream/zcode-repo-wiki`（仅作参照，勿改） |

核对基线文件（任意平台，在 `../_upstream/zcode-repo-wiki` 下）：

```bash
git rev-parse v0.2.2^{commit}                     # 74ce9f4b…
git rev-parse v0.2.2:repo-wiki/scripts/build_wiki_site.py   # d8c7712c…（git blob id）
# 取原始字节再算 sha256：Linux/macOS 上即是 e5fbac1e…（LF）。
# 上游仓库把该文件以 CRLF 入库，core.autocrlf 检出后会变成 f8aea8fe…（CRLF），二者都对，
# 取决于你算的是 blob 还是检出副本。
git cat-file blob v0.2.2:repo-wiki/scripts/build_wiki_site.py > /tmp/b.py && sha256sum /tmp/b.py
```

注意：Windows PowerShell 的 `git show … | Set-Content`/`Get-FileHash` 文本管道会改写字节并加
BOM，算出来的哈希对不上；一律用 `git cat-file` 重定向到文件再算。

`0.2.0` / `0.2.1` 两个 tag 里没有 `CHANGELOG.md`；`CHANGELOG.md` 中转录的上游条目取自
`v0.2.2`（sha256 `15b9a68f9b0fdf45e5564fa4601857bcbde4ecd1db89293d027d1ea930cd3c9b`）。

## 路径映射

| 上游 `v0.2.2` | 本仓库 |
|---|---|
| `repo-wiki/scripts/build_wiki_site.py` | `scripts/build_wiki_site.py` |
| `repo-wiki/tests/` | `tests/` |
| `repo-wiki/assets/` | `assets/` |
| `repo-wiki/README.md`、`repo-wiki/LICENSE` | `README.md`、`LICENSE`（已改写：dsh-wiki 版） |
| `repo-wiki/skills/repo-wiki/SKILL.md` | `skills/wiki-protocol.md`（已改写：DSH 技能协议） |
| `repo-wiki/commands/repo-wiki.md` | `lib/index.js` 里的 `/wiki` 命令（已改写） |
| `repo-wiki/.zcode-plugin/plugin.json` | `package.json` 的 `dsh` 段（已改写） |
| `install.sh`（ZCode 插件缓存安装器） | 未移植（DSH 按插件 bundle 安装） |
| — | `lib/client.js`、`cordis.patch.yml`、`tools/harness-test.mjs`、`docs/assets/`：dsh-wiki 独有 |
| — | `.github/workflows/test.yml`、`SECURITY.md`、`CHANGELOG.md`、本文件：从上游同名文件移植/重写 |

## 本地改动清单

构建器（`scripts/build_wiki_site.py`）的差异全部归属下面四类，外加日志前缀改名：

1. **mermaid `<` 转义（0.1.1，安全修复）**——`scripts/build_wiki_site.py:696`。
   内联 mermaid 时把 `<body`/`</body`/`<head`/`</head`/`<html`/`</html`/`<script`（大小写不敏感、
   后接非字母）改写成 `\u003c…`。原因：bundle 的字符串字面量自带假边界标签，宿主侧按正则找
   注入点的代码（本插件路由的 `</body>`、`dsh-host-webserver` 的 `/<body…>/`）会命中假标签，
   把 `<script>` 注进脚本中间，注入的 `</script>` 提前闭合脚本、约 3 MB 余下部分泄漏为正文。
   上游没有这个处理。回归：`tests/test_build_wiki_site.py` 里的"边界标签各只出现一次"与
   "朴素 `<body>` 定位器命中真 body 标签"两项，外加 harness 的 "site injection at last `</body>`"。
2. **`_strip_leading_h1`（0.1.1）**——定义在 `scripts/build_wiki_site.py:1170`，调用点在
   `:1200`。`import-legacy` 合并页面后，去掉与页头 h1 重复的正文首行 `# 标题`（空白与大小写
   归一后比较）。上游不处理，导入的旧 wiki 会出现重复标题。
3. **`{{BUILDER_PATH}}` 占位符（DSH 技能机制）**——`skills/wiki-protocol.md:13` 里写占位符，
   `lib/index.js:150` 在注册 runtime 技能时替换成构建器的绝对路径。上游的 `SKILL.md` 是静态
   文本，靠安装位置定位脚本。
4. **改名（ZCode → DSH）**——所有 `[repo-wiki]` 日志前缀改为 `[dsh-wiki]`；页脚
   `repo-wiki@local` → `dsh-wiki@local`（`:579`）；配置落盘目录 `.zcode/repo-wiki/` →
   `.dsh/dsh-wiki/`、`.zcode-wiki/` → `.dsh-wiki/`（含 `generation-meta.json`、`import-legacy`
   的 `--dest` 默认值与报错文案）。**未改名**：`wiki.json` 的 `schema` 仍为
   `repo-wiki-local/1`（`:1017`、`:1262`）——它是磁盘格式标识，改了就不兼容上游产物。

其余差异：查看器 backBar 下游没有，属 dsh-wiki 独有（`lib/index.js:263`、`:308`）；测试套件
`tests/test_build_wiki_site.py` 的 `REPO/repo-wiki/` 路径改为仓库根，并新增上述两组用例。

## 变更流程（把上游改动并进来）

1. 取上游新 tag，更新归档副本：`git -C ../_upstream/zcode-repo-wiki fetch --tags`。
2. 生成逐行差异（EOL 归一后再比，否则整份文件都会被判为改动）：
   ```bash
   git -C ../_upstream/zcode-repo-wiki log --oneline v0.2.2..<新tag>
   git diff --no-index -U2 <(git -C ../_upstream/zcode-repo-wiki show <新tag>:repo-wiki/scripts/build_wiki_site.py) \
                          plugins/dsh-wiki/scripts/build_wiki_site.py
   ```
3. 只拣与上面四类无关的上游改动（即"上游修 bug / 加功能"的那些 hunk），逐 hunk 应用；每处
   改名、转义与占位符改写都要保持原样。
4. 重跑 `python tests/test_build_wiki_site.py` 与 `node tools/harness-test.mjs`，全绿后更新本文件
   的基线段（tag、commit、两个 sha256）并在 `CHANGELOG.md` 记一条。
5. 基线变化视为审阅事件：构建器改动不与其它功能提交混在一起。

## 第二上游：Acfufu/dsh-wiki（dsh-ext 导入）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/Acfufu/dsh-wiki` |
| commit | `9f9e8428119b21e6416862a67b5c96420191a265` |
| 导入方式 | `git subtree add --prefix=plugins/dsh-wiki <dsh-wiki> main`（保留历史，不 squash），2026-11-08 |
| dsh-ext 内命名 | 目录 `plugins/dsh-wiki`，包名 `@dsh-ext/dsh-wiki`（`package.json` 与 `cordis.patch.yml` 的 `name` 一致，loader 要求）；运行时 id `dsh-wiki`、路由 `/dsh-wiki`、默认目录 `.dsh-wiki` 与包名现已一致，无需改动即兼容已生成的 wiki（owner 决定 2026-11-08；曾短暂命名为 `repo-wiki`，见 specs/003-repo-wiki-baseline） |

拉取上游更新（在 dsh-ext 根目录）：

```bash
git subtree pull --prefix=plugins/dsh-wiki https://github.com/Acfufu/dsh-wiki main
# 冲突常见于 package.json 的 name 与已移到根 .github/workflows/dsh-wiki.yml 的 CI；按本节保留 dsh-ext 侧。
```

## 许可

上游 MIT。`LICENSE` 与上游 `repo-wiki/LICENSE` 逐行一致（仅行尾不同），保留上游著作权声明；
`assets/THIRD-PARTY-NOTICES` 记录内联的 Mermaid 11 运行时（MIT）。
