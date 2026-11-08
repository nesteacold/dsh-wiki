# tests — repo-wiki 构建器测试

## 回归测试套件（推荐入口）

```
python3 repo-wiki/tests/test_build_wiki_site.py
```

纯标准库、无需参数；在临时目录跑，不写仓库。覆盖：fixture 构建/自检、配置合并与校验边界（含 bool/null/未知键/点路径）、注入与净化 PoC（SVG 变异绕过、CSS 转义/动画 URL、外链扫描器）、失败路径的干净报错与写入原子性。结尾打印 `N/N passed` 并全绿（退出码 0）。

## fixture 样本

除 `bad-json/`（非法 JSON）与 `legacy-src/`（旧版 draft 导入源，无 wiki.json）外，各子目录是一份 wiki.json 样本，`repoId` 取 `"."`（相对 wiki 目录解析，随仓库走、不固化本机路径）。

| 样本 | 用途 |
|---|---|
| `valid/` | 合法 wiki，引用机检应 2/2 通过、selfcheck exit 0；`sample.py` 是引用目标 |
| `bad-json/` | 坏 JSON：build/selfcheck 应输出干净错误（非裸 traceback） |
| `payload/` | title/description/正文含 `<script>__PWN_*` 注入样本：构建后站点不得出现未转义 payload |
| `rel-repo/` | 相对 repoId 样本：引用解析应在任意 CWD 下稳定 |
| `nonwhite-ref/` | 扩展名覆盖样本：`run.sh`（白名单内）应被机检，`weird.xyz`（白名单外）不检 |
| `legacy-src/` | 旧版 draft-pages 导入样本（页面均为非空 markdown） |

手工构建单个样本（在仓库根运行）：

```
python3 repo-wiki/scripts/build_wiki_site.py build --wiki repo-wiki/tests/fixture/valid
python3 repo-wiki/scripts/build_wiki_site.py selfcheck --wiki repo-wiki/tests/fixture/valid
```

构建产物落在各样本的 `site/` 下，已被 .gitignore 覆盖。
