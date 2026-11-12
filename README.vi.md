<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>Wiki repo cục bộ kiểu DeepWiki cho DeepSeek Harness (DSH): không upload, mặc định không dùng mạng, bằng chứng đặt lên trước.</strong><br />
  Agent đọc repo ngay trên máy bạn → dựng một wiki phân trang kèm trích dẫn <code>path:line</code> (cây điều hướng + sơ đồ) → build thành một site HTML tự chứa duy nhất, do host DSH cục bộ phục vụ.</p>

  <p>
    <a href="#-cài-đặt">Cài đặt</a> ·
    <a href="#-cách-dùng">Cách dùng</a> ·
    <a href="#-so-với-các-plugin-cộng-đồng">So sánh</a> ·
    <a href="#-bảo-mật--riêng-tư">Riêng tư</a> ·
    <a href="#-kiểm-thử">Kiểm thử</a> ·
    <a href="README.md">English</a> ·
    <a href="README.zh.md">简体中文</a>
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
> **Kiến thức về codebase không nên chỉ nằm trong đầu tác giả gốc — và cũng không nên có giá là "upload cả repo lên".**
>
> Trong 9.100+ plugin cộng đồng trên awesome-dsh-plugin, không có cái nào cho ra một artifact đúng hình dạng DeepWiki: dsh-openwiki bọc một CLI bên ngoài và không còn được bảo trì; codemap có trích dẫn nhưng không có văn xuôi; archify có sơ đồ nhưng không có nội dung wiki. dsh-wiki gộp **trang có văn xuôi + trích dẫn được máy kiểm tra + sơ đồ offline + một site tự chứa** vào đúng một DSH bundle — tất cả đều cục bộ, không gì rời khỏi máy.
>
> ```sh
> # this repository IS the plugin package — clone it and point DSH at the checkout
> REPO="<path to this repo checkout>"
> CLI="<path to DSH>/runtime/cli/bin/dsh"        # e.g. "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
>                                               # or  "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh"
> "$CLI" plugin --profile desktop add "$REPO"
> ```

## ✨ Đây là gì

Một plugin DSH, bảo trì tại đây dưới tên **`@dsh-ext/dsh-wiki`** — một **fork** của
[`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki), với phần việc về độ tin cậy, pipeline và dịch thuật
ghi lại trong [`CHANGELOG.md`](CHANGELOG.md) và lịch sử commit của repo này (spec phát triển và ghi chú
kiến trúc nằm trong cây phát triển riêng, không có ở đây). Runtime id là `dsh-wiki`, đó là lý do tên package
giữ hậu tố này. Cài vào bất kỳ profile web/desktop nào là có bốn mục:

| Mục | Dạng | Ghi chú |
| --- | --- | --- |
| **skill `dsh-wiki`** | runtime skill | Nói "generate a wiki for this repo" là giao thức 5 pha tiếp quản: inventory → config resolution → language detection → page-tree planning → per-page writing → build + selfcheck |
| **lệnh `/wiki`** | slash command | `/wiki generate [path]` (chạy trong một fork subagent), `/wiki view` (in URL site cục bộ), `/wiki list` |
| **📚 Panel Wiki ở sidebar** | global panel cột trái | Sidebar có thêm dòng 📖: bấm vào để liệt kê mọi wiki đã build, chọn một cái là đọc site ngay trong app (refresh / quay lại danh sách / mở pop-out) |
| **📖 Nút Wiki** | slot ở header session | Mở trang index cục bộ trong một cửa sổ riêng (khi bạn không muốn rời khỏi cuộc hội thoại) |

Artifact nằm trong `<repo>/.dsh-wiki/`:

- `wiki.json` — nguồn sự thật duy nhất (schema `repo-wiki-local/1`, phân trang, markdown nhúng)
- `pages/<id>.md` — bản export từng page, để diff
- `generation-meta.json` — config đã resolve kèm provenance từng field
- `site/index.html` — **site tự chứa một file duy nhất**: cây điều hướng, full-text search (dùng được bằng bàn phím), theme sáng/tối, mermaid render offline, SVG inline đã sanitize, responsive trên mobile

Site phải qua một **machine check zero-external-link** (đã tính cả entity encoding, URL protocol-relative và
các dạng CSS `url()`/`@import`). Trích dẫn cũng được máy kiểm tra, nhưng chỉ đúng một dạng hẹp: một
`` `path:line` `` duy nhất trong backtick (hoặc `path:start-end`), có extension nằm trong allowlist và đường
dẫn thuần ASCII. Với dạng đó, thiếu file, đường dẫn thoát ra ngoài repo hay số dòng vượt biên đều làm
`selfcheck` fail; một dòng resolve được nhưng rỗng chỉ là warning, còn repo root không truy cập được thì hạ
toàn bộ phép check xuống warning. Đường dẫn trần, có dấu cách, không phải ASCII, thiếu extension hoặc
extension không có trong danh sách, nhiều ref trong một span, và tham chiếu không bọc backtick thì **không**
được kiểm tra — hãy tự xác minh mọi trích dẫn bạn phát ra.

## 🚀 Cài đặt

Điều kiện: một profile DSH Desktop / web (`dsh-base` + `dsh-web-app`), `python3 ≥ 3.7` (builder thuần
stdlib, không dependency bên thứ ba).

**Cách A · trang plugin trong GUI**: sidebar "Plugins" → Add → dán đường dẫn checkout của repo này (thư mục
chứa `package.json`) → Install → Enable.

**Cách B · CLI**:

```sh
CLI="<path to DSH>/runtime/cli/bin/dsh"
REPO="<path to this repo checkout>"
"$CLI" plugin --profile desktop add "$REPO"
"$CLI" plugin --profile desktop list
```

Profile desktop chạy `patchReload: live` — refresh là có ngay. Peer range `^0.1.1-rc.1 || ^0.2.0-rc.1` qua
được version gate 0.2.2-rc.1 (cùng kiểu với @jieai/dsh-plugin-vet), không cần exemption nào.

## 🧭 Cách dùng

```sh
/wiki generate            # full wiki for the current workspace (fork subagent)
/wiki generate /path/repo # explicit repo
/wiki view                # print the local site URL
/wiki list                # list known wikis
```

Route cục bộ (loopback trên host desktop):

- `/dsh-wiki/` — index wiki (tự gom các repo đã phát hiện)
- `/dsh-wiki/site?path=<repo>/.dsh-wiki` — mở thẳng một site
- `/dsh-wiki/api/status` — status JSON

**Discovery**: workspace của session được tự động ghi nhớ (persist vào `<profile home>/dsh-wiki/registry.json`),
và **các thư mục sibling** của những root đã biết cũng được quét — thư mục nào có `<wikiDirName>/site/index.html`
là được nhận, nên wiki import qua `import-legacy` hiện lên index mà không cần config gì; `config.wikiRoots`
thêm root bổ sung.

### Agent tools — wiki như một knowledge base

Plugin đăng ký **năm tool DSH native** (ở mức toàn cục, nên mọi agent trong mọi session đều thấy)
cùng một skill thứ hai, `wiki-knowledge`, mô tả vòng lặp tra cứu. Chúng là các định nghĩa plain-object truyền
vào `ctx.tools.register` — plugin này vẫn **không** import package `@deepseek-ai/*` nào, nên không bao giờ
cần `defineTool`. Khi một Host không có service `tools`, plugin ghi log **một** cảnh báo và mọi bề mặt khác
(skill, `/wiki`, route) vẫn chạy bình thường.

Vì vậy `tools` **không** nằm trong danh sách `inject` cordis của plugin; nó được resolve lười bên trong
`apply()` bằng `ctx.get("tools")`. Đo trên Host đã cài (2026-11-11): `inject` của cordis là all-or-nothing —
`Fiber._refresh()` vô hiệu hoá cả plugin khi bất kỳ service nào được inject không có implementation, nên
`apply()` sẽ không bao giờ chạy và skill, `/wiki` cùng các route sẽ biến mất trên một Host không có `tools`;
cordis không có dạng `{ required, optional }`. `ctx.get(name)` chạy được mà không cần `inject` (`dsh-tool-subagent`
của cùng profile resolve `llm` theo cách đó). Một Host thiếu cả `ctx.get` cũng suy biến y hệt: một cảnh báo,
không throw.

| Tool | Trả lời | Giới hạn cứng |
| --- | --- | --- |
| `wiki_search` | Page/card xếp hạng cho một truy vấn văn bản và/hoặc đường dẫn repo, kèm trích dẫn `path:line` | **20 hit** (mặc định 5) và ngân sách **24 KiB** cho cả tập kết quả |
| `wiki_page` | Markdown của một page + danh sách file + id cha/con/anh em | **16 KiB** markdown (`truncated: true` khi bị cắt) |
| `wiki_cards` | Card nguyên tử lọc theo `tags` (all-of), `file` hoặc `kind`; không lọc thì trả index gọn | **50 dòng** và ngân sách **24 KiB** |
| `wiki_impact` | File đã đổi → các page/card phủ chúng, dùng đúng phép chuẩn hoá của `diff-impact` | **50 đường dẫn đầu vào** và ngân sách **24 KiB** |
| `wiki_status` | Repo id, tiêu đề, ngôn ngữ, số page/card, `sourceCommit` so với git `HEAD`, độ cũ | một object nhỏ |

**Wiki là một tấm bản đồ, không phải nguồn sự thật.** Mỗi hit mang theo các trích dẫn mà item đó vốn đã có,
và skill bảo agent phải xác minh lại từng `path:line` được trích trong code trước khi hành động theo nó.

**Ngữ nghĩa độ tươi** (cái gate mà owner yêu cầu):

- `stale: false` — `sourceCommit` đã ghi bằng git `HEAD`.
- `stale: true` — không bằng; kết quả còn mang `behind` (số commit) và `changedFiles`.
- `stale: "unknown"` — git hoặc commit đã ghi không khả dụng. Trường hợp này **không bao giờ** bị báo là
  `false`: không đo được thì không phải là tươi.
- `GET /dsh-wiki/api/project?root=` phơi ra cùng các field `stale`/`behind`/`changedFiles`, được tính bởi
  **chính** hàm mà `wiki_status` dùng, nên panel và các tool không thể bất đồng với nhau.

Việc resolve repo mặc định là đóng: một `repo` tường minh chỉ được nhận khi nó đã là một root được phát hiện
(hoặc thật sự chứa `<wikiDirName>/wiki.json`) **và** chứng minh được là canonical, không có symlink thoát ra
ngoài. Một yêu cầu mơ hồ hoặc không biết là một lỗi có kiểu, liệt kê tên các ứng viên — không bao giờ đoán.
Bỏ `repo` thì ưu tiên **thư mục tạo ra** session (`session.header.cwd`, bất biến — cùng sự kiện mà
`lib/worker-guard.js:22,348` ghi lại), rồi đến wiki được phát hiện duy nhất có wiki; nhiều ứng viên thì trả
`repo-ambiguous` chứ không đoán.
Thông báo lỗi tới được model, nên chúng chỉ nêu `<wikiDirName>/wiki.json` **tương đối** theo wiki; một đường dẫn
host tuyệt đối không bao giờ được nhúng vào đó.
Nội dung wiki chỉ được đọc từ `<repo>/<wikiDirName>/wiki.json` và `generation-meta.json`, qua reader có
containment sẵn có của plugin (không link, không hard link, file thường, ràng theo handle-identity).

Giới hạn cũng áp lên *field*: id/tiêu đề/tóm tắt và danh sách tham chiếu bị cắt, và mỗi collection có một ngân
sách byte, nên một wiki sinh ra bệnh lý không thể làm tràn một context window.
`wiki_search` mang tính xác định — cùng input, output giống hệt từng byte, hoà thì xếp theo `(kind, id)`.

**Tham số** của tool là hợp đồng của chính chúng ta, không phải của Host: `register()` kiểm `output.schema`
nhưng không bao giờ kiểm `parameters` (bộ kiểm schema của Host cũng chấp nhận schema chỉ có annotation như JSON
không ràng buộc). Vì vậy harness khẳng định, với mọi định nghĩa, một parameter schema gốc là object mà
`required` (nếu có) chỉ nằm trên object — key `required` theo từng property bị từ chối.

### MCP adapter — cùng wiki đó cho agent ngoài DSH (Claude Code)

Session DSH nhận năm tool này một cách native. Một agent **ngoài** DSH — Claude Code, VS Code, bất kỳ MCP
client nào — nhận cùng năm tool qua MCP từ một process nhỏ **tái dùng** `lib/wiki-tools.js`: định nghĩa, giới
hạn và phép tính độ tươi là cùng một đoạn code, nên hai bề mặt không thể lệch nhau.

**stdio là transport mặc định** — hình dạng bình thường trong terminal của người dùng: client spawn server và
hai bên nói JSON-RPC phân tách bằng dòng mới qua stdin/stdout. Không port, không socket lắng nghe, không bề mặt
mạng, không gì phải chọn hay giữ rảnh.

```sh
node mcp/server.mjs                                # stdio (default): JSON-RPC on stdin/stdout, no socket
node mcp/server.mjs --transport http --port 7919   # opt-in Streamable HTTP on 127.0.0.1
```

| Flag | Ý nghĩa |
| --- | --- |
| `--transport stdio\|http` | Transport (mặc định `stdio`) |
| `--port N` | Port loopback chỉ cho `--transport http` (mặc định `7919`); bị từ chối dưới 1024 và trong dải dành riêng `2190-2289` thay vì bị âm thầm dời, và bị từ chối khi đi kèm stdio mặc định thay vì bị bỏ qua |
| `--repo PATH` | Root mặc định khi một tool call bỏ `repo` (tuyệt đối; vẫn phải qua phép chứng minh resolve thông thường) |
| `--dsh-home DIR` | Profile home chứa `dsh-wiki/registry.json` (mặc định `$DSH_HOME` hoặc `~/.dsh`) |
| `--wiki-dir NAME` | Thư mục wiki trong một repository (mặc định `.dsh-wiki`) |

Đăng ký nó bằng installer đi kèm — nó tính đường dẫn tuyệt đối, in ra hoặc áp dụng việc đăng ký cho **Claude Code
và Claude Desktop**, và từ chối đoán mò. Khi đó các tool xuất hiện dưới tên `mcp__dsh-wiki__wiki_search`,
`mcp__dsh-wiki__wiki_page`, `mcp__dsh-wiki__wiki_cards`, `mcp__dsh-wiki__wiki_impact`,
`mcp__dsh-wiki__wiki_status`:

```sh
node tools/register-mcp.mjs            # dry run: prints the exact registration, changes nothing
node tools/register-mcp.mjs --apply    # register in Claude Code (user scope) + Claude Desktop
node tools/register-mcp.mjs --apply --target code --scope project   # project-scoped .mcp.json
node tools/register-mcp.mjs --uninstall --apply
```

**`--repo` là yếu tố chịu lực, đo trên máy này.** Adapter resolve một `repo` bị bỏ từ registry của DSH
(`~/.dsh/dsh-wiki/registry.json`); registry đó chứa 8 root và **hai** trong số đó có wiki, nên một lời gọi không chỉ định trả
`repo-ambiguous` thay vì đoán. Vì vậy installer luôn
ghim `--repo <abs>` khi chứng minh được đúng một wiki, và thoát với exit 2 kèm danh sách ứng viên khi không thể.
Hãy tự truyền `--repo` khi chạy từ ngoài một thư mục có wiki.

Điều gì đã thực sự được xác minh ở đây, và điều gì chưa:

| Bước | Bằng chứng |
| --- | --- |
| Claude Code chấp nhận và lưu việc đăng ký | **đã đo** — `claude mcp add -s project` ghi `.mcp.json`; `-s user` ghi `~/.claude.json` (`Added stdio MCP server dsh-wiki ... to user config`), file này giữ nguyên 62 key cấp cao và 13 project |
| Bắt tay Claude Code ↔ server của ta, trực tiếp | **đã đo** — `claude mcp get dsh-wiki` báo `Scope: User config (available in all your projects)` và `Status: √ Connected`, còn `claude mcp list` liệt kê `dsh-wiki ... √ Connected` cạnh các server khác |
| Gộp config Claude Desktop | **đã đo trên file thật** — `mcpServers.dsh-wiki` được chèn, `coworkUserFilesPath` và toàn bộ object `preferences` được giữ nguyên, một bản backup có timestamp được ghi bên cạnh. Claude Desktop đọc file này lúc khởi động, nên hãy **khởi động lại app** để nhận server |
| `tools/list` / `tools/call` qua stdio | **đã đo** như một process thật — đúng argv lưu trong `.mcp.json`, stdin/stdout chuyển hướng ra file: `initialize` trả `serverInfo {name: dsh-wiki, title: Local Repo Wiki}`, `tools/list` trả đủ năm tool, một notification không sinh response, và stdout chỉ chứa byte giao thức |
| `tools/list` / `tools/call` dưới bộ test | **đã đo** bằng `node tools/mcp-test.mjs` (110 passed, 0 skipped, 0 failed khi có quyền file đầy đủ; trong shell bị hạn chế thì các tầng CLI/stdio phụ thuộc pipe SKIP thay vì chạy) |

Phạm vi quan trọng với việc phê duyệt: một entry **user-scope** được tin và kết nối ngay, còn một entry
`.mcp.json` ở project vẫn ở trạng thái `⏸ Pending approval` cho tới khi bạn duyệt — nên một repository vừa
clone không thể âm thầm khởi động một server.

Các lệnh thô tương đương, nếu bạn thích tự gõ. Repo này **chính là** package, nên server nằm ở `mcp/server.mjs` (không có cấp `plugins/dsh-wiki/` ở đây); `<path-to-dsh-wiki>` là nơi bạn clone nó, `<path-to-your-repo>` là repo có wiki bạn muốn phục vụ. User scope:

```sh
claude mcp add dsh-wiki -s user -- node "<path-to-dsh-wiki>\mcp\server.mjs" --repo "<path-to-your-repo>"
```

Project scope (`.mcp.json`). **Đừng commit
file này:** `--repo` phải là đường dẫn tuyệt đối (`mcp/server.mjs:120` từ chối mọi thứ khác) và `command` nêu
node của máy này, nên một `.mcp.json` đã commit là sai trên mọi máy khác và mục khi node di chuyển. User scope
đã phủ mọi project, đó là lý do một file project thường là không cần thiết — hãy sinh nó theo từng máy bằng
`--scope project` nếu bạn muốn, và thêm `.mcp.json` vào `.gitignore`. (`${CLAUDE_PROJECT_DIR}` **không** được expand trong `.mcp.json` — đã đo — nên nó cũng không làm file portable được. Lưu ý dạng không có `--repo` bên dưới: bỏ `--repo` thì server dùng thư mục Claude Code khởi chạy nó, và thư mục đó phải chứa `<wikiDir>/wiki.json` mới được chấp nhận, nên nó không thể bind nhầm repo):

```json
{ "mcpServers": { "dsh-wiki": { "type": "stdio", "command": "node", "args": ["<path-to-dsh-wiki>\\mcp\\server.mjs", "--repo", "<path-to-your-repo>"] } } }
```

**Claude Desktop** giữ danh sách riêng tại `%APPDATA%\Claude\claude_desktop_config.json` (`~/Library/
Application Support/Claude/claude_desktop_config.json` trên macOS); `--apply --target desktop` gộp entry vào đó
kèm backup. Hãy khởi động lại app sau khi đăng ký.

**Dự phòng / tự động hoá: Streamable HTTP.** Một số client và script chỉ nhận một URL. Hãy khởi động cùng server
đó một cách tường minh, rồi đăng ký URL — port bạn ghi ra chính là port nó lắng nghe:

```sh
node mcp/server.mjs --transport http --port 7919
claude mcp add --transport http dsh-wiki http://127.0.0.1:7919/mcp
```

hoặc trong `.mcp.json`:

```json
{ "mcpServers": { "dsh-wiki": { "type": "http", "url": "http://127.0.0.1:7919/mcp" } } }
```

Hãy chọn port từ 1024 trở lên (dưới đó là đặc quyền) và nằm ngoài `2190-2289` (dành riêng trên máy này — dải đó
không bao giờ bind được). Server từ chối cả hai với exit code 2 thay vì dời đi, nên một URL đã đăng ký không thể
âm thầm trỏ vào hư không. Endpoint là một `POST /mcp` duy nhất (cộng với kênh SSE `GET /mcp` mà client đã đo
mở ra), và listener chỉ bind `127.0.0.1`.

**Transport, như đã đo — không phải giả định.** Claude Code 2.1.286 gửi `POST /mcp` với
`Accept: application/json, text/event-stream` và thực hiện `server/discover` → `initialize` →
`notifications/initialized` → `GET /mcp` (SSE) → `tools/list`. Cả năm đều được implement; `tools/call` trả các
text block đã render, và một refusal có kiểu (`ok:false`) là một kết quả bình thường với `isError:true`, không
bao giờ là một lỗi JSON-RPC. Đo qua HTTP; đường stdio nói cùng protocol core và được bộ test chạy in-process.

**Vì sao stdio là mặc định — và môi trường này không xác minh được gì.** Người dùng chạy Claude Code trong một
terminal bình thường, nơi lệnh trên spawn server với pipe; đó là transport mà client được xây quanh, và nó không
cần port. Một process bị DSH sandbox là ngoại lệ, không phải quy tắc: nó không spawn được child có pipe (`spawn`
→ `EPERM`), nên một **agent bị sandbox** hoàn toàn không thể thử stdio. Tầng CLI/OS-pipe của nó vì vậy bị bỏ qua
ở đó (một `SKIP` tường minh, không bao giờ là một pass giả) và phải được chạy một lần trong terminal bình
thường; bản thân mặc định, hàng rào `--port` và usage text vẫn được khẳng định ngay trong sandbox thông qua
output child lấy qua file (không qua pipe). Stdio đầu cuối với chính Claude Code **chưa** được quan sát từ môi
trường này.

**Bảo mật:** transport stdio mặc định không mở socket nào; transport HTTP tuỳ chọn chỉ bind `127.0.0.1` (không
có option host). Mọi request HTTP phải qua bốn hàng rào: một `Host` loopback **và** một `Origin` loopback (hoặc
không có header nào, đó là thứ CLI client gửi — trình duyệt luôn gửi cả hai, nên một trang DNS-rebinding bị từ
chối hai lần), đường dẫn duy nhất `/mcp`, và cap body 1 MiB. `GET /mcp` mở tối đa 16 kênh SSE đồng thời (kênh
tiếp theo là `429`, không phải thêm một file descriptor), và mọi request đều bị chặn hai lần: một `requestTimeout`
hữu hạn cho việc nhận nó (một kết nối không bao giờ xong body sẽ bị đóng) và một deadline dispatch có chặn (30 s)
thay vì giữ transport của nó mãi — trên stdio một lời gọi bị kẹt sẽ chặn hàng đợi tuần tự phía sau nó. Không
giới hạn nào đóng một response SSE đang mở. Adapter chỉ đọc — nó mở `<repo>/<wikiDirName>/wiki.json` và
`generation-meta.json` và không gì khác — không bao giờ fetch và không bao giờ ghi.

Điều adapter **không** tuyên bố:

- **Không có handle-identity containment.** Host đọc qua `lib/fs-contain.js` (không link ở bất kỳ cấp nào, một
  hard link duy nhất, identity ràng theo handle). Adapter mở file đã resolve **một lần** và lấy kích thước từ
  chính handle đó trước khi đọc (nên một lần hoán đổi giữa check và read không thể vượt cap 16 MiB), nhưng nó
  không phát hiện được một hard link mà tên nằm trong repository còn byte nằm ở nơi khác trên cùng volume —
  `realpath` không có đường dẫn nào để so. Khoảng hở duy nhất đó được ghi tại
  `specs/015-wiki-mcp-adapter/plan.md`; đóng nó cần so `nlink`/inode, việc mà Host làm.
- **Không phải một ranh giới xác thực.** Ở chế độ HTTP, bất kỳ process nào trên máy này đều với tới được port
  loopback; các hàng rào chặn một *trang trình duyệt*, không chặn một chương trình cục bộ. Phơi ra từ xa nằm
  ngoài phạm vi (constitution A7: TLS + credential theo thiết bị).

Khi client bỏ `repo`, việc resolve theo registry của DSH (`<profile home>/dsh-wiki/registry.json`): một root tường
minh phải tuyệt đối, canonical và hoặc đã được đăng ký hoặc thật sự chứa `<wikiDirName>/wiki.json`; nếu không thì
dùng **đúng một** root có wiki, và nhiều root thì trả `repo-ambiguous` liệt kê basename — không bao giờ đoán.

### Generate / Update trong panel — **đang bị release gate khoá**

Panel có sẵn các nút điều khiển job và một model selector, nhưng **generate chạy nền bị tắt có chủ ý** trong
bản này: write path phải qua một vòng review thật về filesystem-isolation + trusted recovery rồi mới được mở
ra. Job manager **thì vẫn được dựng** và giữ trusted journal store, nhưng `jobs.enabled` mặc định là `false`,
nên mọi route job trả 503 trước khi đọc body, resolve root hay chạm vào bất kỳ path nào. Contract server hiện
tại:

| Route | Method | Trạng thái | Hành vi |
| --- | --- | --- | --- |
| `/dsh-wiki/api/models` | GET | **có sẵn** (chỉ đọc) | `{ default, models: [{provider, model, label, providerLabel}], groups, failures }` lấy thẳng từ `sessionController.modelCatalog()`; 503 khi service vắng mặt. Nó chỉ đọc catalog. |
| `/dsh-wiki/api/jobs` | POST | **503 disabled** | `{ error: "<gate message>", disabled: true }`, trả **trước khi** đọc body, resolve Host service hay chạm vào path nào. |
| `/dsh-wiki/api/jobs?root=` | GET | **payload disabled** | `{ ok: true, root, disabled: true, disabledReason, active: null, last: null }`; manager có tồn tại nhưng gate giữ nó ở trạng thái idle. Shape vẫn tương thích với poller của panel. Root lạ vẫn là 403. |
| `/dsh-wiki/api/jobs/cancel` | POST | **503 disabled** | Cùng câu trả lời gate như POST `/api/jobs`. |
| `/dsh-wiki/api/jobs/recovery-plan?root=` | GET | **503 khi đang tắt** | Recovery plan chỉ đọc cho journal record của một root; nó không bao giờ rename hay xoá gì. Đo ngày 2026-11-10: gate `jobs.enabled` cũng trả 503 cho route này, và root không được phép thì là 403 trước cả gate. |
| `/dsh-wiki/api/jobs/recovery-execute` | POST | **403/503 khi đang tắt; bắt buộc `confirm`** | Route duy nhất có thể thực thi một recovery plan. Cần đúng field `confirm: "execute-recovery"` trong body, same-origin, JSON, root được phép và một journal store đang mở. **Hiện nó không thể hoàn tất một lần restore sau restart** — xem phần giới hạn bên dưới. |

Vậy là model catalog dùng được, nhưng **không có generate trực tiếp** từ panel trong bản này. Nút
Generate/Update vẫn **hiện nhưng disabled**, kèm đúng lý do gate của Host dưới dạng chữ trong notice bên
cạnh: một capability biến mất sẽ không phân biệt được với một capability bị gỡ, và người dùng không thể phân
biệt "chưa mở" với "không bao giờ mở nữa". Lý do cố ý là **chữ hiển thị chứ không phải tooltip hover**, vì
tooltip của một form control đang disabled không đáng tin trên nhiều browser (chưa đo trên máy này — coi đó là
lý do để dùng chữ hiển thị, không phải một phát biểu về bất kỳ engine cụ thể nào). Model dropdown
**không được render** khi gate đóng (model đang chọn hiện thành một dòng mờ trong notice thay vào đó), vì một
selector chỉ-đọc đứng một mình trông như đồ thừa. Mà có chọn thì cũng không khởi động được gì: Generate/Update đang tắt, route
POST trả 503, và không job nào có thể active. Hãy dùng `/wiki generate` chạy foreground ngay trong session —
panel có nút "Copy command" đúng cho việc đó.

### Ba action, và vì sao không có "Regenerate"

| Nút | Gửi gì | Ý nghĩa |
| --- | --- | --- |
| **Update wiki (incremental)** | `action:"update"` + `incremental:true` | Chỉ ghi lại những page/card mà `diff-impact` ánh xạ tới các file đã đổi (spec 013). |
| **Rebuild whole wiki** (More actions) | `action:"update"`, không kèm `incremental` | Rebuild toàn bộ. Lựa chọn đúng duy nhất khi chưa có baseline dùng được, khi `diff-impact` không khả dụng, hoặc khi id và tên file của wiki đã publish lệch nhau. |
| **Generate wiki** | `action:"generate"` | Build lần đầu; chưa có baseline. |

**Không có action "Regenerate" riêng**, và đó là sự thật ở phía server chứ không phải thiếu sót của UI:
`lib/jobs.js` định nghĩa `JOB_ACTIONS = ["generate", "update", "translate"]`, và key `btn.regen` trong
dictionary chưa từng được render thành nút ở bất kỳ revision nào. Việc incremental được yêu cầu qua field
`incremental` riêng, không qua `action`; `buildWorkerPrompt` vẫn chỉ nhận `{jobId, root, stageDir, config}`
và từ chối key lạ, còn tập ảnh hưởng đi kèm trong option `incremental` tùy chọn của chính nó.

### Incremental update fail-closed, không bao giờ âm thầm full rebuild

`incremental:true` chỉ được chấp nhận cùng `action:"update"`. Mọi lần hạ cấp đều là một refusal rõ ràng, và
mỗi refusal không start job nào: `incremental` không phải boolean là 400 `invalid-incremental`;
`incremental:true` với action sai là 400 `incremental-not-for-generate` / `incremental-not-for-translate`;
còn họ 409 gồm `incremental-no-baseline`, `incremental-unavailable`, `incremental-baseline-diverged`,
`incremental-up-to-date`, `incremental-id-mismatch`, `incremental-unexpected-write`. Hai trong số đó tồn tại vì
một caller đã xin incremental mà lại âm thầm nhận full rebuild là bị lừa.

Hai tính chất an toàn cần nói thẳng:

- **Staging tree được seed từ wiki đang chạy, và seed lỗi là fail cứng.** Publish thay thế cả cây đang chạy,
  nên thiếu seed sẽ làm wiki *co lại*.
- **Mọi entry mà plan không cho phép đều được băm lại sau khi worker dừng**, từ byte thô, và bất kỳ thay đổi,
  thêm hay xoá nào ngoài tập ảnh hưởng đều làm job fail trước khi publish. Việc này phủ
  **mọi top-level key của `wiki.json`**, mọi file trong `pages/`+`cards/`, mọi entry top-level khác, các thư
  mục rỗng mới thêm, và cả file worker thả vào `site/` (chỉ `site/index.html` được host sinh lại, nên phần còn
  lại của subtree đó vẫn được so). Exclusion duy nhất là `generation-meta.json`, `config.json` và `locales/`, vì chúng không thể tới
  được bước publish: cái đầu do host ghi sau khi worker dừng, hai cái sau thuộc host và được copy lại từ bản
  đang chạy. Không có phép so này thì lời hứa "byte-identical trừ các id đã liệt kê" sẽ không được kiểm chứng —
  worker guard cho phép `write`/`edit` ở bất kỳ đâu dưới staging, nên chỉ phép check này mới biến chỉ dẫn thành
  ranh giới được cưỡng chế. `sourceCommit` chỉ tiến khi có ít nhất một page thực sự được viết lại
  **hoặc bị xoá có chủ ý**; job không đổi gì sẽ giữ baseline cũ thay vì tự nhận độ tươi nó không có. Một
  plan incremental bị từ chối thẳng khi front-matter id và tên file của wiki đã publish lệch nhau
  (`incremental-id-mismatch`), vì tập ảnh hưởng khoá theo id còn file khoá theo tên — và vì file ảnh hưởng
  được miễn khỏi phép so ở trên, id khai báo của chúng được kiểm lại sau khi worker dừng: một page ảnh hưởng
  không được khai id của page *khác*,
  nếu không nó có thể che page đó qua cơ chế resolve duplicate-id của `assemble` (`selfcheck` không từ chối id
  trùng, nên không có gì khác bắt được).
- **Xoá một page ảnh hưởng là được phép và có ghi lại, không bao giờ âm thầm.** Một page mà chủ thể của nó đã
  bị xoá khỏi repo phải có đường biến mất, và từ chối nó sẽ đẩy job vào ngõ cụt vĩnh viễn (page vẫn ảnh hưởng
  ở mọi lần chạy sau, worker lại xoá, job lại fail mãi). Vì vậy lần xoá đó vẫn publish và job state mang
  `pagesRemoved` cùng một `removedSample` có giới hạn, panel hiện thành ", N pages removed" trong dòng done.
  Một lần xoá không bao giờ bị tính là một lần viết lại. Xoá một **card** ảnh hưởng thì bị từ chối, vì không có
  field công khai nào để ghi lại và một sự biến mất âm thầm còn tệ hơn việc yêu cầu full update.

Những lỗ hổng còn lại, nói ra chứ không giấu: bản thân `site/index.html` không được so (host ghi đè), byte của
`config.json`/`locales/` không được so (chúng không thể publish từ staging), một file lạc do chính tooling của
worker để lại trong staging làm job fail-closed (gỡ được bằng một lần full update), và một thư mục bị thay bằng
một thư mục *khác* có nội dung y hệt thì phép so này không phát hiện được.

Giới hạn đã đo, nói ra để không ai đọc quá xa tính năng này: trên corpus thật duy nhất hiện có
(một workspace riêng tư, `dd02d64..67a1131`) 116 file đổi ánh xạ tới **23 trong 31 page và 9 trong 25 card**, với 102
file không ánh xạ tới page nào. Với một wiki đã trôi xa, incremental chỉ rẻ hơn full rebuild không đáng kể, và bản thân `.dsh-wiki/` cũng
được commit, nên một lần update wiki cũng hiện ra trong diff.

Vì sao có gate: một background job sẽ chạy một session model bình thường với **không có filesystem isolation**
("đừng chạm vào `.dsh-wiki` đang chạy" là luật ở mức prompt, không phải sandbox), và các read route trước đây
gọi `recover()` ở `GET /api/projects|project|wiki|site`, nên một lần đọc thường cũng có thể rename một thư mục
`.dsh-wiki.bak-*` lạc bất kỳ. Chừng nào write path chưa có isolation thật và recovery chưa được tin (chỉ write
path, dưới một per-repo lock đã review), gate còn đóng. Read-only route không còn gọi `recover()`; một backup
lạc được để nguyên từng byte.

**Recovery route: hai defect tìm ra bằng đo đạc ngày 2026-11-10, đã sửa, đang chờ review độc lập.** Cả hai đều
chỉ nằm trên execute path. Đọc riêng từng file thì không thấy — chúng là chỗ hai module vốn tự nhất quán lại
bất đồng với nhau.

1. **Lệch vocabulary.** production liveness provider trả `proof: "epoch-host-dead"`
   (`lib/index.js`), nhưng planner chỉ nhận `["process-exit","host-registry","worker-session-id"]`
   (`lib/journal.js`). Sau một lần restart, `planRecovery` vì thế *throw* trên input không hợp lệ, `reconcile`
   báo `status:"error"`, và executor không bao giờ được tới — nghĩa là đúng cái case mà route này tồn tại
   (một Host chết giữa lúc publish, để lại `.dsh-wiki.bak-*` kèm một record) lại không chạy được. Provider giờ
   trả `"process-exit"`, đúng như điều đã được xác lập: process host đã ghi trong record đã chết, và worker là
   một subagent trong cùng process. `WORKER_PROOFS` được export để test có thể khẳng định giá trị của provider
   nằm trong vocabulary của planner.
2. **Host pin.** Journal store bị pin vào một host id sinh **mỗi lần apply** (`makeHostInstanceId`), nên
   `lib/publish-executor.js` từ chối `restore-backup` với `host-pin-mismatch` cho mọi record do process trước
   để lại. Chỉ sửa (1) thì đây sẽ là điểm dừng cứng tiếp theo. Execute route giờ mở
   **một store thứ hai, tường minh không pin** trên cùng `storeDir` và cùng allowlist, và việc thực thi
   `restore-backup` trên store không pin **bắt buộc `recovery: true` tường minh** — hành vi cũ "không pin
   nghĩa là bỏ qua check" đã biến mất, nên
   một lần wiring nhầm sẽ fail-closed với `recovery-not-declared` thay vì vô tình chạy đúng. Quyết định cleanup
   (`remove-backup`, `remove-staging`) **không** chịu cờ đó; chúng không bao giờ đẩy một record tiến lên, và đó
   là ranh giới chứ không phải bằng chứng.

An toàn không dựa vào pin: `lib/journal.js` trả **không action nào** cho `alive`, `unknown`, thiếu proof, hoặc
— qua một lần restart — mọi proof không phải process exit độc lập. Một store không pin không rename được gì
trừ khi planner đã quyết định rename. Lưu ý "không pin" nghĩa là **bỏ hẳn** key option; truyền
`hostInstanceId: null` tường minh bị từ chối là `invalid-options`, vì sự hiện diện được xét bằng
`Object.getOwnPropertyDescriptor`.

Giới hạn còn lại trên path này, nói rõ chứ không làm mờ: phần đọc body bị chặn cả theo byte lẫn theo thời
gian. Deadline được cưỡng chế hai lần — một **phép check thời gian đồng bộ ở mỗi vòng lặp** dừng các iterable
có `next()` resolve ngay lập tức, kể cả stream zero-byte (chunk độ dài 0 không bao giờ được tích luỹ), và một
**race `setTimeout`** dừng `next()` không bao giờ kết thúc. Khi overflow, timeout hay abort, reader dừng
**mà không destroy socket**: route ghi response 413/408 rồi đóng kết nối ở `finish`, nên client chunked nhận được
body lỗi thay vì một reset. Đo được: iterator zero-byte vô hạn → 408 sau ~21 ms với ~20 MB heap (trước đây nó
làm cạn heap); overflow chunked → peer nhận `413` kèm body lỗi. Quyết định cleanup `remove-backup` /
`remove-staging` không chịu gate của `recovery: true` (chúng không bao giờ đẩy record, nhưng đó là ranh giới,
không phải bằng chứng); durability trên Windows vẫn là `"file-flushed"`, chưa dir-synced; và route này chưa
từng được chạy end to end qua HTTP ở bất kỳ revision nào.
**Coi post-restart recovery là chưa review cho tới khi có một kết luận độc lập được ghi ra.**

Phần implementation vẫn còn trong cây (`lib/jobs.js`): publish từ staging, language gate canonical-`en`,
`config.json`/`locales/` host-owned được bảo vệ, single-flight fence, cancel/quarantine, timeout có chặn,
backup recovery, cùng các write fence (same-origin, JSON content type, cap 32 KB, project allowlist, đúng model
trong catalog). Một harness **ở mức module** (`tools/jobs-harness-test.mjs`) chạy nó như một contract tương
lai/nội bộ — đó **không** phải claim về route đang sống. Contract của route đang sống (503/disabled, không
`recover()` trên read) nằm trong `tools/harness-test.mjs` §19. Muốn mở lại thì phải land phần isolation +
recovery trước, rồi nối lại manager (xem comment trong `lib/index.js`).

Khi được mở lại, một job chạy như sau: Host tạo một session DSH bình thường ở repo root, pin model bằng
`agent.model.select(...)` (scope theo session — default của deployment **không** bị đổi), gửi một prompt
follow-up, và ghi candidate vào `<repo>/.dsh-wiki.staging-<jobId>/` (một **sibling** của `.dsh-wiki`). Sau một
turn `completed`, Host yêu cầu `wiki.json` có `repoId` trỏ đúng repo root, chạy `build` + `selfcheck` (không
shell, timeout có chặn), và chỉ publish candidate xanh bằng rename kèm backup. Publish chưa bao giờ atomic
(cửa sổ mili giây có chặn); ghi chú thiết kế đó dành cho việc tương lai, không phải hành vi hiện tại.

Giới hạn đã biết cho phần việc tương lai đó: job `translate` và `locales/<lang>/` chưa được implement; job
state chỉ nằm trong memory (Host restart là mất view job gần nhất; wiki trên đĩa không bị ảnh hưởng); panel chỉ
thấy độ chi tiết stage quanh agent turn; và agent vẫn chạy với quyền bình thường.

**Chuyển từ ZCode**: nói "import the legacy wiki" — `import-legacy` chuyển dữ liệu
[zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) (`~/.zcode/v2/repo-wiki/<hash>`) trong một bước;
schema `wiki.json` tương thích hoàn toàn.

**Knowledge card (0.2.0)**: ngoài page, một wiki có thể mang các card ngắn, nguyên tử (module / concept / API)
với bằng chứng `path:line` được máy kiểm tra, hiện thành một grid card lọc được, có view từng card và có mặt
trong search; page link tới card bằng `[text](#card-<id>)`. Viết `pages/*.md` + `cards/*.md` kèm front-matter
rồi chạy `build_wiki_site.py assemble` để sinh `wiki.json`.

**Incremental impact (`diff-impact`, chỉ đọc)**: ánh xạ một git range lên wiki mà không sinh lại nó.

```sh
python3 scripts/build_wiki_site.py diff-impact --wiki <repo>/.dsh-wiki [--repo <abs repo path>] [--from <commit>] [--to <commit>]
```

`--from` mặc định là `sourceCommit` đã ghi (`generation-meta.json`, không có thì `wiki.json`), `--to` mặc định
là `HEAD`; `--repo` mặc định lấy `repoId` trong `wiki.json`. Report JSON in ra stdout có `from`, `to`,
`changedFiles`, `affectedPages`, `affectedCards` và `unmappedFiles`: file đổi được so với `filePaths` của từng
page và `keyFiles` của từng card theo khớp đường dẫn chính xác hoặc theo tiền tố thư mục (`lib` phủ `lib/a.py`,
không phủ `library/a.py`), với hậu tố `:line`/`:start-end` được chuẩn hoá bỏ đi. Nó không bao giờ build, không
bao giờ ghi (kể cả bên trong `.dsh-wiki`), không chạm mạng, và lỗi trên đường diff thoát với exit `2`.

## 🔄 Cập nhật

Panel có một thẻ **Version**: phiên bản đã cài, nút **Check** (kiểm tra) và nút **Install update** (cài bản cập
nhật). Tính năng này **tuỳ chọn bật** và mặc định tắt (`update.enabled`, xem Cấu hình): khi tắt, plugin không gửi
bất kỳ request ra ngoài nào và thẻ chỉ báo rằng việc kiểm tra đã bị vô hiệu.

**Check.** Với `update.enabled: true`, và chỉ với một bản cài qua được các yêu cầu 1-5 bên dưới, bấm **Check**
gửi một request HTTPS tới
`raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json` (timeout 5 s, giới hạn response 64 KiB, không
theo redirect, không gửi credential) và đọc `version` của nó. Không có gì tự polling: panel đọc status một lần khi
mở và thêm một lần mỗi khi bạn bấm **Check**; với `update.enabled: true`, mỗi lần đọc như vậy có thể gửi đúng
một request đó. Cùng dữ liệu có ở `GET /dsh-wiki/api/update/status`.

**Install update.** Nút chỉ hoạt động khi **mọi** yêu cầu đều thoả, được xét theo thứ tự này (cái fail đầu tiên
thắng, và lý do của nó hiện thành chữ cạnh nút):

1. `update.enabled` là `true`, và không có bản cập nhật nào khác đang chạy.
2. Package plugin đã cài là một **thư mục thật**, không phải symlink.
3. Nó là một git worktree **và** thư mục cài đặt chính là cấp cao nhất của worktree đó (không phải thư mục con
   của một repository lớn hơn).
4. `origin` là một URL `https://` tới `nesteacold/dsh-wiki` (`ssh://`, `git://`, `http://`, dạng scp và đường
   dẫn cục bộ đều bị từ chối).
5. Working tree sạch (`git status --porcelain` không in gì), nên công việc chưa commit không bao giờ bị chạm tới.
6. Phiên bản đã publish là một `X.Y.Z` chặt chẽ và **mới hơn hẳn** bản đã cài — một bản publish bằng hoặc cũ hơn
   không bao giờ được cài (không downgrade).

Sau đó nó chạy `git fetch --tags --prune origin` rồi `git checkout --detach` tới tag `v<version>` (hoặc
`<version>`) nếu có, không thì tới `origin/main`, và đọc lại `package.json` cục bộ: nó phải bằng phiên bản đã
publish, nếu không thì revision trước đó được khôi phục và `postcondition-failed` được báo. Mọi lệnh git đều chạy
ở chế độ cứng hoá: không credential helper, thư mục hooks trỏ vào một thư mục tạm rỗng, không đệ quy submodule,
chỉ HTTPS, không đọc config git của user hay hệ thống, không prompt tương tác. Request là
`POST /dsh-wiki/api/update` với body `{"confirm":"install-update"}`; thiếu đúng token đó thì update service
không bao giờ được gọi.

**Reload để hoàn tất.** Một bản cập nhật đã áp dụng **không** restart gì cả. Thẻ báo hãy reload plugin, và
`reloadRequired` giữ `true` cho tới khi plugin được tạo lại.

**Vì sao bản cài để phát triển bị từ chối.** Một bản cài là symlink — plugin được link vào profile DSH từ một
checkout phát triển — bị từ chối với `install-is-development-link`, trước khi chạy bất kỳ lệnh git nào. Checkout
một phiên bản đã publish vào thư mục đằng sau link sẽ ghi đè cây phát triển đó, nên ở đó cả việc kiểm tra phiên
bản đã publish lẫn **Install update** đều không chạy; phiên bản đã publish chỉ được fetch cho các bản cài qua
được mọi check đứng trước nó (yêu cầu 1-5).

**Lý do từ chối** là một tập đóng gồm 15 mã, mỗi mã có đúng một câu cố định (không đường dẫn, output git hay văn
bản upstream nào tới được client): `update-disabled`, `update-in-progress`, `install-not-found`,
`install-is-development-link`, `install-not-git`, `install-not-worktree-root`, `install-origin-mismatch`,
`install-dirty`, `latest-not-newer`, `version-invalid`, `network-unavailable`, `fetch-failed`,
`checkout-failed`, `postcondition-failed`, `internal-error`. Tất cả là HTTP 409 trừ `internal-error` (500).

**Cách làm thủ công tương đương** (điều nút làm, trong một checkout thật, sạch của plugin):

```sh
git fetch --tags --prune origin
git checkout --detach v<version>   # or the tag <version>, or origin/main when no tag exists
```

rồi reload plugin. Một bản cài 0.3.1 không thể tự cập nhật qua panel: 0.3.1 có lỗi với annotated tag (postcondition so sánh HEAD với id của tag object chưa được peel, nên mọi lần cập nhật đều bị từ chối với `postcondition-failed` rồi được khôi phục), đã sửa ở 0.3.2. Để đi từ 0.3.1 lên 0.3.2, hãy dùng cách làm thủ công tương đương này với `v0.3.2`. Khoá cấu hình: `update.enabled` (boolean, mặc định `false`; đó là khoá `update` duy nhất và
mọi khoá khác là lỗi cấu hình). Giới hạn đã biết: đường checkout/restore cho tới nay mới được xác minh với các
bản giả được tiêm vào, chưa với một repository thật.

## ⚔️ So với các plugin cộng đồng

| | dsh-wiki | dsh-openwiki | dsh-plugin-codemap | archify |
| --- | --- | --- | --- | --- |
| Văn wiki dạng kể | ✅ phân trang + cây điều hướng | ✅ (CLI ngoài) | ❌ | ❌ |
| Trích dẫn `path:line` + máy kiểm tra | ✅ cưỡng chế | ❌ | ✅ | ❌ |
| Sơ đồ (mermaid/SVG offline) | ✅ | ❌ | chỉ dependency graph | ✅ chỉ sơ đồ |
| Site tự chứa một file (search/theme) | ✅ đã check zero-external-link | ❌ | ❌ | ❌ |
| Toolchain thứ hai / API key thứ hai | ❌ không | ✅ cần | ❌ | ❌ |
| Upload nội dung repo | không bao giờ | tuỳ backend | không bao giờ | cloud |
| Bảo trì | active | stale (2026-09) | active | upstream active |

## 🎛️ Cấu hình

Dòng `config` của plugin (sửa được từng dòng trong trang plugin của GUI):

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

Các setting chỉ dành cho job (`pythonPath`, `jobTimeoutMs`, `buildTimeoutMs`, `selfcheckTimeoutMs`, `pollMs`)
chỉ có hiệu lực khi job gate mở lại; model catalog chỉ đọc và các read route bỏ qua chúng.

Config generate merge bốn lớp: default builtin → `~/.dsh/dsh-wiki/config.json` → `<repo>/.dsh-wiki/config.json` →
`--set k=v`. Preset `compact`/`standard`/`deep`/`legacy`; các knob chỉnh được gồm ngôn ngữ, số page, độ chi
tiết (theme/file/hybrid), số từ mỗi page, mật độ sơ đồ (none/minimal/rich), chế độ trích dẫn (relaxed/strict).

Hai quyết định ngôn ngữ tách rời nhau: **site chrome** (placeholder search, nhãn card, nút đổi theme, footer,
chuỗi empty-state) đi theo `language` trong `wiki.json` dựa trên tiền tố — `vi*` → tiếng Việt, `zh*` → tiếng
Trung, còn lại (mặc định) → tiếng Anh — trong khi ngôn ngữ **nội dung page** lấy từ field `language` của
resolve-config (mặc định `auto`: theo ngôn ngữ tài liệu của repo). Nội dung vẫn canonical `en` trong lát cắt
này; đường background job mặc định tắt và khi được bật cũng chỉ sinh hoặc cập nhật wiki canonical `en`.

## 🔒 Bảo mật & riêng tư

| Hành vi | dsh-wiki |
| --- | --- |
| Upload nội dung repo / lịch sử Git | **không bao giờ** |
| Request mạng (generate, sơ đồ, font, script) | **không bao giờ** (builder zero-dep, site zero-external-link). Ngoại lệ tuỳ chọn duy nhất là kiểm tra phiên bản/tự cập nhật (`update.enabled`, mặc định `false`; xem Cập nhật và `SECURITY.md`) |
| Đọc nội dung object trong `.git` | **không bao giờ** (ngoại lệ duy nhất: tùy chọn `git log --oneline -15`) |
| Vị trí artifact | chỉ trên đĩa cục bộ |

Route fence phía Host: check Host loopback + basename thư mục phải bằng `wikiDirName` + chỉ phục vụ một file
read-only, không có bề mặt traversal. Các read route không bao giờ gọi `recover()`, nên việc xem một wiki không
thể rename một thư mục `.dsh-wiki.bak-*` lạc. Ba route job POST (`/api/jobs`, `/api/jobs/cancel`,
`/api/jobs/recovery-execute`) **hiện bị tắt ngay ở lớp route** (`jobs.enabled` mặc định `false`, nên mỗi route
trả 503 trước khi body được đọc); `recovery-execute` còn cần đúng field `confirm: "execute-recovery"` trong
body và là route duy nhất có thể thực thi một journal recovery plan; check same-origin (`Origin` loopback
nghiêm ngặt == `Host` đã parse), yêu cầu content-type JSON, cap body 32 KB, project-root allowlist và check
đúng model trong `lib/jobs.js` vẫn được implement cho lúc gate mở lại, và được cover bởi harness ở mức module
— không phải bởi một write path đang sống. Nhắc chung: nửa host của plugin chạy trong process host — nếu bạn
audit plugin thì nên đi kèm `@jieai/dsh-plugin-vet`.

## 🧪 Kiểm thử

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

Mỗi dòng ở trên nêu con số do chính bộ test đó in ra, theo đúng định dạng của nó: hai bộ Python in `N/M passed`; bộ `node:test` in `ℹ tests N / ℹ pass N / ℹ skipped N` (nên `worker-protocol-test.mjs` khai báo 65 ca và bỏ qua 1 ca trên Windows); các harness còn lại in một dòng `PASS` cho mỗi mục rồi kết thúc bằng `ALL PASS`. Ở đây **cố ý không có tổng số duy nhất**: một dòng `PASS` và một ca `node:test` là hai đơn vị khác nhau, cộng lại chỉ ra một con số không có ý nghĩa xác định — và mọi tổng số cố định sẽ lỗi thời ngay khi có bộ test mới. Vì vậy huy hiệu ghi `all suites pass`. Chạy lại đoạn trên để kiểm tra bất kỳ con số nào.

## ❓ Câu hỏi thường gặp

**Khác gì so với DeepWiki (Cognition)?** DeepWiki là một service hosted — repo phải rời khỏi máy bạn. dsh-wiki
dùng model ngay trong session cục bộ của bạn; không gì rời khỏi máy và artifact là một file HTML bấm đúp là mở.

**Dùng với DSH bản nào?** Peer khai báo `^0.1.1-rc.1 || ^0.2.0-rc.1`; đã verify trên 0.2.2-rc.1 (2026-11-04
latest). Không dùng API nào gây vỡ 0.2.2 (tools.resolve / tools.mode / Session Projection đều tránh).

**Profile headless / tui?** Skill và `/wiki view|list` chạy được; `/wiki generate` cùng các route site cục bộ
cần host web/desktop (webServer).

**Builder có cần dependency không?** Không. Python 3.7+ thuần stdlib, zero pip install.

## 📄 Giấy phép

MIT — xem [LICENSE](LICENSE). Builder và viewer port từ [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki)
(MIT). mermaid runtime được nhúng kèm các component bên thứ ba — xem `assets/THIRD-PARTY-NOTICES`.

## 🙏 Nguồn gốc (upstream)

Package này là một fork của [`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) và giữ nguyên giấy phép MIT,
tên skill/command và schema artifact `repo-wiki-local/1` để một wiki sẵn có vẫn đọc được. Phần việc riêng của
fork nằm trong repo này:

- đường publish hai lần rename có journal, kèm trusted recovery journal (`lib/journal*.js`,
  `lib/publish-executor.js`, `lib/fs-contain.js`)
- một tool-guard nhốt `write`/`edit` của worker trong `staging/pages|cards/*.md`
  (`lib/worker-guard.js`)
- wiki canonical-English với bản dịch theo từng đơn vị locale và verify bằng SHA-256 cấu trúc
  (`locales/<lang>/`, `scripts/wiki_translations.py`)
- phần việc, quyết định và rủi ro còn mở đang được theo dõi: [`CHANGELOG.md`](CHANGELOG.md) của repo này cùng
  lịch sử commit (các spec đánh số và `docs/arch-notes/` ở lại trong cây phát triển riêng)

Tên package ở đây là `@dsh-ext/dsh-wiki`; `dsh-wiki` chỉ là runtime id. Nếu bạn muốn bản gốc chưa sửa, hãy cài
từ repo upstream.
