// dsh-wiki 客户端半区（spec 006）：在 DSH 内原生打开 Repo Wiki（不再内嵌 iframe 站点）。
// 入口：左侧栏 sidebar.panellist「Repo Wiki」+ main 主面板（key 与 panellist id 一致）；会话头部按钮保留。
// 视图：项目网格（全部/已生成/未生成、搜索、刷新、网格/列表）→ 详情（面包屑、页面树、卡片、概览、正文）。
// 安全：markdown 由本文件解析成 React 元素树，从不使用 dangerouslySetInnerHTML；
//       正文里的内联 <svg> 一律按代码块显示；mermaid 在无 allow-same-origin 的沙箱 iframe 里渲染。
window.__ModuleLoader__.load({
  id: "@dsh-ext/dsh-wiki",
  factory: (require) => {
    var module = { exports: {} };
    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-wiki";
    var PANEL_ID = "dsh-wiki";
    var PANEL_ORDER = 20;
    var ROUTE = "/dsh-wiki";

    var DICT = {
      zh: {
        "sidebar.label": "Repo Wiki",
        "nav.unavailable": "无法切换到 Repo Wiki 面板，请从左侧栏打开。",
        "home.title": "把代码变成 Repo Wiki",
        "home.sub": "纯本地生成、带证据引用的仓库文档。",
        "tab.all": "全部", "tab.generated": "已生成", "tab.missing": "未生成",
        "search": "搜索项目…", "refresh": "刷新", "view.grid": "网格", "view.list": "列表",
        "loading": "加载中…", "error": "读取失败：", "retry": "重试",
        "empty": "没有匹配的项目。在仓库会话里运行 /wiki generate 后会出现在这里。",
        "badge.generated": "已生成", "badge.missing": "未生成", "badge.update": "可更新",
        "pages": "页", "cards": "卡片", "updated": "更新于",
        "go.generate": "去生成",
        "crumb.root": "Repo Wiki",
        "pages.search": "搜索页面…", "cards.entry": "知识卡片", "overview": "概览",
        "ov.language": "语言", "ov.status": "生成状态", "ov.pages": "页面", "ov.cards": "卡片",
        "ov.updatedAt": "更新时间", "ov.commit": "已更新到", "ov.newCommits": "仓库有新的提交，wiki 可能已过时。",
        "btn.update": "在会话中更新…", "btn.generate": "在会话中生成…", "btn.more": "更多操作", "btn.regen": "重新生成", "btn.site": "打开独立站点",
        "btn.copyCmd": "复制命令", "btn.folder": "复制文件夹路径", "btn.back": "返回",
        "gen.hint": "「更多操作」里的「在会话中生成…/在会话中更新…」会在该仓库开会话并复制 /wiki generate <仓库路径>；粘贴到输入框发送。面板里的「生成/更新 wiki」按钮则在这里跑后台作业。",
        "gen.copied": "已复制命令。在该仓库的会话里粘贴运行：",
        "gen.started": "已在该仓库新开会话。命令已复制，粘贴到输入框发送：",
        "zoom.title": "图表", "zoom.fit": "适应", "zoom.reset": "重置", "zoom.resetTitle": "重置为 100%",
        "zoom.copy": "复制代码", "zoom.copied": "✓ 已复制", "zoom.copyFail": "⚠ 复制失败",
        "zoom.close": "关闭", "zoom.zoomOut": "缩小", "zoom.zoomIn": "放大",
        "copied": "已复制：", "btn.source": "查看源码", "btn.rendered": "查看渲染", "btn.copyLink": "复制链接", "keyFiles": "关键文件", "related": "相关卡片", "refBy": "引用此卡片的页面",
        "noPage": "页面不存在", "noWiki": "该项目还没有 wiki。",
        "job.model": "模型", "job.model.default": "（默认）", "job.language": "目标语言",
        "job.lang.en": "英文（规范）", "job.lang.other": "其他语言（后续切片）",
        "job.generate": "生成 wiki", "job.update": "更新 wiki", "job.cancel": "取消", "job.running": "运行中",
        "job.stage.staging": "准备分区目录", "job.stage.session": "创建会话", "job.stage.agent": "生成页面与卡片",
        "job.stage.validate": "校验候选", "job.stage.build": "构建站点", "job.stage.selfcheck": "自检",
        "job.stage.publish": "发布", "job.stage.done": "完成", "job.stage.queued": "排队中",
        "job.stage.waiting_input": "等待人工输入（后台无法代答，请取消）",
        "job.done": "已完成并发布。", "job.failed": "失败：", "job.canceled": "已取消。未发布候选时活动 wiki 保持上一次已发布的内容；模型以普通权限运行（不在沙箱里），Host 只保证候选校验与失败回滚，无法限制模型在暂存目录之外写什么。worker 未能确认停下时，暂存与单飞栅栏会被隔离。",
        "job.busy": "该项目已有作业在运行。", "job.session": "作业会话", "job.openSession": "打开会话",
        "job.copySession": "复制会话 id", "job.keepOpen": "作业在后台运行，面板可以保持打开。",
        "job.noCatalog": "模型目录不可用：", "job.noCatalogHint": "没有可用模型目录时不启动生成。",
        "job.pages": "页", "job.modelLocked": "作业固定使用所选模型，不会回退到其他模型。模型以普通权限运行（不在沙箱里）：Host 保证候选校验与失败回滚，不能限制模型在暂存目录之外写什么。",
        "job.gate.title": "后台生成已停用",
        "job.gate.reason": "宿主原因",
        "job.gate.unknown": "宿主没有给出原因。",
        "job.gate.checking": "正在检查后台作业是否可用…",
        "job.gate.copyCmd": "复制命令",
        "job.gate.copyCmdTitle": "复制 /wiki generate 命令",
        "job.gate.hint": "在该仓库的会话里粘贴运行；这个面板不会自己开一个会话。",
        "lang.label": "Wiki 语言",
        "lang.listFail": "读不到宿主的语言列表。",
        "lang.noneTitle": "该项目还没有其他语言的翻译。",
        "lang.missing.title": "还没有该语言的翻译",
        "lang.missing.body": "该项目的 wiki 目前只有英文（规范）版本。可以为该语言启动一次翻译作业；英文 wiki 不受影响。",
        "lang.translate": "翻译为 ",
      },
      en: {
        "sidebar.label": "Repo Wiki",
        "nav.unavailable": "Can't open the Repo Wiki panel here. Open it from the sidebar.",
        "home.title": "Turn code into Repo Wiki",
        "home.sub": "Local, evidence-cited repository documentation.",
        "tab.all": "All", "tab.generated": "Generated", "tab.missing": "Not generated",
        "search": "Search projects…", "refresh": "Refresh", "view.grid": "Grid", "view.list": "List",
        "loading": "Loading…", "error": "Failed to load: ", "retry": "Retry",
        "empty": "No matching projects. Run /wiki generate in a repo session and it will show up here.",
        "badge.generated": "Generated", "badge.missing": "Not generated", "badge.update": "Update available",
        "pages": "pages", "cards": "cards", "updated": "Updated",
        "go.generate": "Go to generate",
        "crumb.root": "Repo Wiki",
        "pages.search": "Search pages…", "cards.entry": "Knowledge cards", "overview": "Overview",
        "ov.language": "Language", "ov.status": "Generation status", "ov.pages": "Pages", "ov.cards": "Cards",
        "ov.updatedAt": "Update time", "ov.commit": "Updated to", "ov.newCommits": "Repository has new commits; the wiki may be out of date.",
        "btn.update": "Update in Chat…", "btn.generate": "Generate in Chat…", "btn.more": "More actions", "btn.regen": "Regenerate", "btn.site": "Open standalone site",
        "btn.copyCmd": "Copy command", "btn.folder": "Copy folder path", "btn.back": "Back",
        "gen.hint": "\"Generate in Chat…\" / \"Update in Chat…\" in More actions opens a session for the repository and copies /wiki generate <root> — paste it into the composer and send. The Generate/Update button in this panel runs the background job here instead.",
        "gen.copied": "Command copied. Paste it into a session in that repository:",
        "gen.started": "Opened a new session in this repository. Command copied — paste it into the composer and send:",
        "zoom.title": "Diagram", "zoom.fit": "Fit", "zoom.reset": "Reset", "zoom.resetTitle": "Reset zoom to 100%",
        "zoom.copy": "Copy code", "zoom.copied": "✓ Copied", "zoom.copyFail": "⚠ Copy failed",
        "zoom.close": "Close", "zoom.zoomOut": "Zoom out", "zoom.zoomIn": "Zoom in",
        "copied": "Copied: ", "btn.source": "View source", "btn.rendered": "View rendered", "btn.copyLink": "Copy link", "keyFiles": "Key files", "related": "Related cards", "refBy": "Referenced by pages",
        "noPage": "Page not found", "noWiki": "This project has no wiki yet.",
        "job.model": "Model", "job.model.default": " (default)", "job.language": "Target language",
        "job.lang.en": "English (canonical)", "job.lang.other": "Other languages (later slice)",
        "job.generate": "Generate wiki", "job.update": "Update wiki", "job.cancel": "Cancel", "job.running": "Running",
        "job.stage.staging": "Preparing staging", "job.stage.session": "Opening a session", "job.stage.agent": "Writing pages and cards",
        "job.stage.validate": "Validating candidate", "job.stage.build": "Building the site", "job.stage.selfcheck": "Self-check",
        "job.stage.publish": "Publishing", "job.stage.done": "Done", "job.stage.queued": "Queued",
        "job.stage.waiting_input": "Waiting for human input (a background job can't answer — cancel it)",
        "job.done": "Finished and published.", "job.failed": "Failed: ", "job.canceled": "Canceled. With no published candidate the live wiki still holds the last published content; the model runs with normal permissions (not sandboxed), so the Host guarantees candidate validation and rollback, not what the model touches outside the staging directory. If the worker cannot be confirmed stopped, staging and the single-flight fence stay quarantined.",
        "job.busy": "A job is already running for this project.", "job.session": "Job session", "job.openSession": "Open session",
        "job.copySession": "Copy session id", "job.keepOpen": "The job keeps running in the background; this panel can stay open.",
        "job.noCatalog": "Model catalog unavailable: ", "job.noCatalogHint": "Generation does not start without a real model catalog.",
        "job.pages": "pages", "job.modelLocked": "The job stays on the selected model and never falls back to another one. The model runs with normal permissions (not sandboxed): the Host guarantees candidate validation and rollback, not what the model touches outside the staging directory.",
        "job.gate.title": "Background generation is disabled",
        "job.gate.reason": "Host reason",
        "job.gate.unknown": "The Host reported no reason.",
        "job.gate.checking": "Checking whether background jobs are available…",
        "job.gate.copyCmd": "Copy command",
        "job.gate.copyCmdTitle": "Copy the /wiki generate command",
        "job.gate.hint": "Paste it into a session for this repository; this panel never opens one by itself.",
        "lang.label": "Wiki language",
        "lang.listFail": "Could not read the language list from the Host.",
        "lang.noneTitle": "No other language is translated yet.",
        "lang.missing.title": "No translation in this language yet",
        "lang.missing.body": "This project's wiki exists only in English (canonical) so far. You can start one translation job for this language; the English wiki stays as it is.",
        "lang.translate": "Translate to ",
      },
    };
    var fallbackT = function (key) { return DICT.en[key] ?? DICT.zh[key] ?? key; };
    // English first: Chinese only when the DSH locale is zh*. Read from ctx.locale snapshot (set in apply).
    var hostLocale = function () { return ""; };
    var activeT = function (key) {
      var lang = "";
      try { lang = String(hostLocale() || ""); } catch (e) { lang = ""; }
      var d = /^zh/i.test(lang) ? DICT.zh : DICT.en;
      return d[key] ?? DICT.en[key] ?? key;
    };

    // ---------- 样式：只用宿主 --dsw-alias-* token ----------
    var CSS = [
      // position:relative 是缩放浮层的定位基准：浮层盖住插件面板（inset:0），永远不盖桌面标题栏
      ".dw-root{position:relative;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}",
      ".dw-root *{box-sizing:border-box}",
      ".dw-scroll{flex:1;min-height:0;overflow:auto}",
      ".dw-home{padding:28px 32px 40px;max-width:1200px;margin:0 auto;width:100%}",
      ".dw-h1{font-size:22px;font-weight:600;margin:0 0 4px}",
      ".dw-sub{color:var(--dsw-alias-label-secondary);margin:0 0 18px}",
      ".dw-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:16px}",
      ".dw-tabs{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2)}",
      ".dw-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12.5px}",
      ".dw-tab.on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".dw-input{flex:1;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none}",
      ".dw-input:focus{border-color:var(--dsw-alias-link)}",
      ".dw-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;white-space:nowrap}",
      ".dw-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // 主按钮用描边而不是实心填充：深色主题下没有对比度风险；禁用时连描边一起退掉，不再像可点
      ".dw-btn.primary{font-weight:600;border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
      ".dw-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dw-btn.primary:disabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".dw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}",
      ".dw-list{display:flex;flex-direction:column;gap:8px}",
      ".dw-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:14px;border-radius:12px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;font:inherit}",
      ".dw-card:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dw-list .dw-card{flex-direction:row;align-items:center;gap:14px}",
      ".dw-card-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dw-muted{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all}",
      ".dw-badge{align-self:flex-start;font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".dw-badge.ok{color:var(--dsw-alias-link);border-color:var(--dsw-alias-link)}",
      ".dw-badge.upd{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dw-detail{flex:1;min-height:0;display:flex;flex-direction:column}",
      ".dw-crumb{display:flex;align-items:center;gap:6px;padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);flex:none}",
      ".dw-crumb a{color:var(--dsw-alias-link);cursor:pointer}",
      ".dw-split{flex:1;min-height:0;display:flex}",
      ".dw-side{width:270px;min-width:220px;border-right:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;min-height:0}",
      ".dw-side .dw-input{margin:10px;flex:none}",
      ".dw-tree{flex:1;min-height:0;overflow:auto;padding:0 6px 16px}",
      ".dw-node{display:flex;align-items:center;gap:4px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;padding:4px 6px;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}",
      ".dw-node:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dw-node.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-link);font-weight:500}",
      ".dw-caret{width:14px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      ".dw-main{flex:1;min-width:0;min-height:0;overflow:auto;padding:24px 40px 60px}",
      ".dw-doc{max-width:1200px;margin:0 auto}",
      ".dw-doc h1{font-size:24px;margin:0 0 6px;font-weight:600}",
      ".dw-doc h2{font-size:18px;margin:26px 0 8px;font-weight:600}.dw-doc h3{font-size:15px;margin:20px 0 6px;font-weight:600}",
      ".dw-doc p,.dw-doc li{font-size:14px;line-height:1.7}",
      ".dw-doc code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 5px}",
      ".dw-doc pre{background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;overflow:auto;font-size:12.5px}",
      ".dw-doc pre code{background:none;padding:0}",
      ".dw-doc blockquote{margin:12px 0;padding:2px 14px;border-left:3px solid var(--dsw-alias-link);color:var(--dsw-alias-label-secondary)}",
      ".dw-doc table{border-collapse:collapse;margin:12px 0;width:100%}",
      ".dw-doc th,.dw-doc td{border:0.5px solid var(--dsw-alias-border-l2);padding:6px 10px;text-align:left;font-size:13px}",
      ".dw-doc th{background:var(--dsw-alias-bg-layer-1)}",
      ".dw-cite{cursor:pointer;color:var(--dsw-alias-link)!important}",
      ".dw-link{color:var(--dsw-alias-link);cursor:pointer}",
      ".dw-mwrap{position:relative;margin:18px 0;border-radius:12px;padding:24px;background:#f3f4f6;display:flex;flex-direction:column;align-items:center}",
      ".dw-dark .dw-mwrap{background:#1f2937}",
      ".dw-mscroll{width:100%;overflow-x:auto;overflow-y:hidden;cursor:zoom-in;display:flex}",
      ".dw-mzoom{position:absolute;top:8px;right:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer;border-radius:6px;padding:2px 6px}",
      ".dw-mzoom:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // 缩放浮层（Qoder 风格）：absolute inset:0 —— 只覆盖 Wiki 面板，不覆盖桌面标题栏/窗口按钮
      ".dw-zoom{position:absolute;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);-webkit-app-region:no-drag}",
      // 浮动居中工具栏：顶部安全边距 16px，窄宽度换行，按钮永不缩小到 44px 以下
      ".dw-zoombar{flex:none;align-self:center;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;margin:16px 16px 8px;padding:8px 10px;max-width:calc(100% - 32px);border-radius:14px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.22);-webkit-app-region:no-drag}",
      ".dw-zoombar button{flex:0 0 auto;min-height:44px;min-width:44px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;font-weight:500;line-height:1.1;cursor:pointer;white-space:nowrap}",
      ".dw-zoombar button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dw-zoombar button:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}",
      ".dw-zoomicon{font-size:20px;line-height:1}",
      ".dw-zoomlabel{font-size:16px;font-weight:600;max-width:min(320px,40vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dw-zoompct{display:inline-flex;align-items:center;justify-content:center;min-width:64px;min-height:44px;padding:0 10px;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
      ".dw-zoombar button.dw-zoomclose{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dw-zoombar button.dw-zoomclose:hover{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);opacity:.86}",
      // 只有这个区域滚动：工具栏是 flex:none，永远不会被滚出视野
      ".dw-zoompane{flex:1;min-height:0;overflow:auto;padding:0 24px 32px}",
      ".dw-pagemeta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:2px 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      // 头部（hero）：标题与路径在左，状态药丸 / 语言 / 更多操作在右；旧的 h1+路径+横幅+按钮行都在这里收成一行
      ".dw-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}",
      ".dw-hero-main{min-width:0}",
      ".dw-hero-main h1{font-size:22px;font-weight:600;margin:0 0 4px;line-height:1.25}",
      // 仓库路径：一条路径一行。放不下时省略号吃掉前段，最后两段始终保留（认出仓库靠尾段），
      // 完整路径放在 title 里。宽窄由 flex 自己算，不写死截断长度。
      ".dw-hero-path{display:flex;align-items:baseline;min-width:0;overflow:hidden;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
      // 只有前段会收缩：前段先被省略号吃掉，尾段（plugins\dsh-wiki）保持完整；
      // 只有尾段自己都放不下（极端窄）时才由容器的 overflow:hidden 从右边裁掉一点。
      ".dw-hero-path .dw-path-head{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dw-hero-path .dw-path-tail{flex:0 0 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dw-hero-aside{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0}",
      // 仓库有新提交：一行提示文字，不再是带按钮的横幅（唯一的动作在作业控件里）
      ".dw-hero-sub{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-primary)}",
      ".dw-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.65;white-space:nowrap}",
      ".dw-pill i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}",
      ".dw-pill.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".dw-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
      ".dw-pill.idle{color:var(--dsw-alias-state-idle-primary)}",
      // 视觉隐藏但保留给读屏：语言选择器的 <label>
      ".dw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
      // 统计条：1px 的 gap 加上底色就是分隔线，比六个描边格子安静得多
      ".dw-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:1px;margin:14px 0;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-border-l1)}",
      ".dw-stat{padding:10px 12px;background:var(--dsw-alias-bg-layer-1);min-width:0}",
      ".dw-stat span{display:block;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}",
      ".dw-stat b{display:block;font-size:16px;font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}",
      // 闸门提示（spec 007 UI 修订）：浅描边 + 左侧警告色细线，原因照登但不再是黑框
      // 换行是必需的：按钮的固有宽度曾经赢过正文，把原因挤成一条竖直的细条（一次三四个词一行）
      ".dw-notice{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px 12px;margin:12px 0;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-state-warn-primary)}",
      ".dw-notice-body{flex:1 1 240px;min-width:0}",
      ".dw-notice-body b{display:block;font-size:12.5px;font-weight:600;line-height:1.4}",
      ".dw-notice-body span{display:block;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary);word-break:break-word;user-select:text}",
      // 两个动作合成一个按钮组：放得下就在正文右侧，放不下整组落到下一行并靠右，
      // 且组本身永不把正文压得比它的 240px 基准更窄。
      // max-width:100% 是给极窄面板的兜底：组不会溢出提示条，超宽时组内按钮自己换行。
      ".dw-notice-actions{display:flex;flex-wrap:wrap;gap:8px;flex:0 0 auto;margin-left:auto;max-width:100%}",
      // 停靠成窄面板时两个按钮的固有宽度超过提示条：允许按钮收缩并把标签折行，
      // 而不是让 nowrap 的标签冲出提示条（宽面板里标签本来就放得下，这一条不改变观感）。
      ".dw-notice-actions .dw-btn{flex:0 1 auto;min-width:0;white-space:normal}",
      ".dw-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;position:relative}",
      ".dw-hint{margin:0 0 14px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      // 菜单挂在自己的按钮下面，靠 right 对齐：没有写死的像素偏移，不会飘到面板左下角
      ".dw-more{position:relative}",
      ".dw-menu{position:absolute;top:calc(100% + 6px);right:0;left:auto;z-index:5;min-width:200px;padding:4px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:0 6px 20px rgba(0,0,0,.18)}",
      ".dw-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit}",
      ".dw-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dw-toast{position:sticky;bottom:12px;margin:12px auto 0;max-width:640px;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);font-size:12.5px}",
      ".dw-tags{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.dw-tag{font-size:11px;color:var(--dsw-alias-label-secondary)}",
      // 面板内后台作业（spec 007）：模型选择 + 阶段进度 + 取消
      ".dw-job{display:flex;flex-direction:column;gap:8px;padding:10px 12px;margin:10px 0;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".dw-jobrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
      ".dw-jobrow label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dw-select{max-width:280px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px}",
      ".dw-progress{position:relative;height:6px;border-radius:4px;background:var(--dsw-alias-bg-base);border:0.5px solid var(--dsw-alias-border-l2);overflow:hidden}",
      ".dw-progress > i{display:block;height:100%;background:var(--dsw-alias-link);transition:width .3s ease}",
      ".dw-stages{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      ".dw-stages b{color:var(--dsw-alias-link);font-weight:600}",
      ".dw-joberr{color:var(--dsw-alias-label-primary);font-size:12.5px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;word-break:break-word}",
      // 宿主作业闸门：停用原因原样展示（不是装饰性的灰字），作为提示条出现在作业控件之上
      ".dw-clock{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11.5px}",
      // 语言选择（T017b）：概览里在 hero 右侧，其他视图在面包屑右侧；列表为空/请求失败时旁边显示 —
      ".dw-lang{margin-left:auto;display:inline-flex;align-items:center;gap:6px;min-width:0}",
      ".dw-lang label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dw-lang .dw-select{max-width:220px}",
      ".dw-hero-aside .dw-lang{margin-left:0}",
      ".dw-hero-aside .dw-lang .dw-select{max-width:160px}",
      ".dw-langnone{color:var(--dsw-alias-label-secondary)}",
    ].join("\n");

    var getJson = function (url) {
      return fetch(url, { headers: { accept: "application/json" } }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) {
            // code 必须带出来：/api/wiki?lang= 的 404 translation-missing 是“还没翻译”，不是读取失败
            var err = new Error((b && b.error) || ("HTTP " + r.status));
            err.status = r.status;
            err.code = b && b.code;
            throw err;
          }
          return b;
        });
      });
    };
    // 语言显示名：已知 tag 给人类可读名，未知 tag 原样显示（绝不因为一个陌生 tag 抛错）
    var LANG_NAMES = { en: "English", vi: "Tiếng Việt" };
    var langLabel = function (tag) {
      var s = tag == null ? "" : String(tag);
      var name = Object.prototype.hasOwnProperty.call(LANG_NAMES, s) ? LANG_NAMES[s] : "";
      return name ? s + " — " + name : s;
    };
    // 语言选择按项目根记忆：重开面板仍是上次选的语言；en 等同“清除”（不写存储）。
    var LANG_STORE_PREFIX = "dsh-wiki:lang:";
    var readStoredLang = function (root) {
      try {
        var v = window.localStorage.getItem(LANG_STORE_PREFIX + root);
        return typeof v === "string" && v ? v : "en";
      } catch (e) { return "en"; }
    };
    var storeLang = function (root, tag) {
      try {
        if (!tag || tag === "en") window.localStorage.removeItem(LANG_STORE_PREFIX + root);
        else window.localStorage.setItem(LANG_STORE_PREFIX + root, String(tag));
      } catch (e) { /* storage unavailable: the selection just isn't remembered */ }
    };
    var copyText = function (text) {
      try { if (navigator.clipboard) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }); } catch (e) { /* ignore */ }
      return Promise.resolve(false);
    };
    var fmtDate = function (iso) {
      if (!iso) return "—";
      try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
    };
    // 统计条里的紧凑时间：本地时间 YYYY-MM-DD HH:mm（无逗号、无 AM/PM，列宽稳定）；
    // 完整的人类可读时间仍通过 title 提供，所以信息没有减少。
    var fmtDateShort = function (iso) {
      if (!iso) return "—";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    };
    var isDark = function () {
      try {
        var el = document.documentElement;
        var attr = (el.getAttribute("data-theme") || el.className || "") + " " + (document.body ? document.body.className : "");
        if (/dark/i.test(attr)) return true;
        if (/light/i.test(attr)) return false;
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch (e) { return false; }
    };

    // ---------- 安全 markdown → React（与构建器 md_to_html 同一子集） ----------
    var CITE_RE = /^[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+:\d+(?:-\d+)?$/;
    // Guard rail for pathological quote nesting (e.g. "> ".repeat(5000) + "text"): recursion
    // stops at this depth and the rest is rendered as plain paragraphs.
    var MAX_BLOCKQUOTE_DEPTH = 32;
    function blockquoteDepth(line) {
      var m = /^\s*((?:>\s*)+)/.exec(line);
      return m ? (m[1].match(/>/g) || []).length : 0;
    }
    function inline(text, env, keyBase) {
      var out = [];
      var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*\n]+\*)/g;
      var last = 0, m, k = 0;
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        var tok = m[0], key = keyBase + "-" + (k++);
        if (m[1]) {
          var code = tok.slice(1, -1);
          if (CITE_RE.test(code)) {
            out.push(h("code", { key: key, className: "dw-cite", title: env.t("btn.folder"),
              onClick: function (c) { return function () { env.cite(c); }; }(code) }, code));
          } else out.push(h("code", { key: key }, code));
        } else if (m[2]) {
          out.push(h("strong", { key: key }, inline(tok.slice(2, -2), env, key)));
        } else if (m[3]) {
          var lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
          var label = lm[1], href = lm[2];
          var cm = /^#card-([A-Za-z0-9_-]+)$/.exec(href);
          if (cm && env.hasCard(cm[1])) {
            out.push(h("a", { key: key, className: "dw-link", onClick: function (id) { return function () { env.openCard(id); }; }(cm[1]) }, label));
          } else if (/^#[A-Za-z0-9_-]+$/.test(href) && env.hasPage(href.slice(1))) {
            out.push(h("a", { key: key, className: "dw-link", onClick: function (id) { return function () { env.openPage(id); }; }(href.slice(1)) }, label));
          } else {
            // 外部/未知链接：只显示文本 + title，不可点击（零网络）
            out.push(h("span", { key: key, title: href, style: { borderBottom: "1px dotted currentColor" } }, label));
          }
        } else if (m[4]) {
          out.push(h("em", { key: key }, tok.slice(1, -1)));
        }
        last = re.lastIndex;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }
    function listBlock(items, pos, depth, env, key) {
      var ordered = items[pos].ordered;
      var lis = [];
      while (pos < items.length) {
        var it = items[pos];
        if (it.depth < depth) break; // shallower sibling: caller renders the remainder
        if (it.depth === depth && it.ordered !== ordered) break; // different marker type: new list
        if (it.depth > depth) {
          var sub = listBlock(items, pos, it.depth, env, key + "s" + pos);
          var lastLi = lis.pop();
          if (!lastLi) break; // defensive: a deeper first item belongs to a parent list
          lis.push(h("li", { key: lastLi.key }, lastLi.props.children, sub.el));
          pos = sub.pos;
          continue;
        }
        lis.push(h("li", { key: key + "i" + pos }, inline(it.text, env, key + "i" + pos)));
        pos++;
      }
      return { el: h(ordered ? "ol" : "ul", { key: key }, lis), pos: pos };
    }
    function renderMarkdown(md, env, nesting) {
      nesting = nesting | 0;
      var lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
      var out = [], i = 0, n = lines.length, k = 0, diagramCount = 0;
      while (i < n) {
        var line = lines[i], key = "b" + (k++), m;
        if ((m = /^\s*```(\w*)\s*$/.exec(line))) {
          var lang = m[1].toLowerCase(), buf = [];
          i++;
          while (i < n && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
          i++;
          if (lang === "mermaid") {
            diagramCount++;
            out.push(h(Mermaid, { key: key, src: buf.join("\n"), label: env.diagramTitle || "", index: diagramCount }));
          }
          else out.push(h("pre", { key: key }, h("code", null, buf.join("\n"))));
          continue;
        }
        if (/^\s*<\s*svg\b/i.test(line)) {
          // 内联 SVG：不注入 DOM，按源码展示（独立站点里有经净化的渲染版）
          var sb = [line];
          i++;
          while (i < n && !/<\s*\/\s*svg\s*>/i.test(sb[sb.length - 1])) sb.push(lines[i++]);
          out.push(h("pre", { key: key, title: "inline SVG (rendered in the standalone site)" }, h("code", null, sb.join("\n"))));
          continue;
        }
        if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
          var lv = Math.min(m[1].length + 1, 6); // page title is already h1; body headings shift down one level
          out.push(h("h" + lv, { key: key }, inline(m[2], env, key)));
          i++;
          continue;
        }
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push(h("hr", { key: key })); i++; continue; }
        if (line.indexOf("|") >= 0 && i + 1 < n && /^\s*\|?[\s:|-]*-/.test(lines[i + 1])) {
          var cells = function (l) { return l.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
          var head = cells(line);
          i += 2;
          var rows = [];
          while (i < n && lines[i].indexOf("|") >= 0 && lines[i].trim()) rows.push(cells(lines[i++]));
          out.push(h("table", { key: key },
            h("thead", null, h("tr", null, head.map(function (c, j) { return h("th", { key: j }, inline(c, env, key + "h" + j)); }))),
            h("tbody", null, rows.map(function (r, ri) {
              return h("tr", { key: ri }, r.map(function (c, j) { return h("td", { key: j }, inline(c, env, key + "r" + ri + "c" + j)); }));
            }))));
          continue;
        }
        if (/^\s*>/.test(line)) {
          var q = [], quoteLevel = 0, quoteStart = i;
          while (i < n && /^\s*>/.test(lines[i])) {
            quoteLevel = Math.max(quoteLevel, blockquoteDepth(lines[i]));
            q.push(lines[i++].replace(/^\s*>\s?/, ""));
          }
          if (nesting + quoteLevel > MAX_BLOCKQUOTE_DEPTH) {
            // Excessive nesting: strip every leading marker in one pass and render plain
            // paragraphs. Recursion stops here, so pathological input cannot overflow the
            // stack or make render cost grow with the declared nesting depth.
            var fallback = [], buf = [];
            var flush = function () {
              if (!buf.length) return;
              var fk = key + "q" + fallback.length;
              fallback.push(h("p", { key: fk }, inline(buf.join(" "), env, fk)));
              buf = [];
            };
            for (var qi = quoteStart; qi < i; qi++) {
              var stripped = lines[qi].replace(/^\s*(?:>\s*)+/, "").trim();
              if (stripped) buf.push(stripped); else flush();
            }
            flush();
            out.push(h("blockquote", { key: key, className: "dw-md-quote-deep" }, fallback));
            continue;
          }
          out.push(h("blockquote", { key: key }, renderMarkdown(q.join("\n"), env, nesting + 1)));
          continue;
        }
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
          var items = [];
          while (i < n) {
            var mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
            if (mm) { items.push({ depth: Math.floor(mm[1].length / 2), ordered: /\d/.test(mm[2][0]), text: mm[3] }); i++; }
            else if (lines[i].trim() && items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].text += " " + lines[i].trim(); i++; }
            else break;
          }
          // Relative depths against the shallowest indentation seen so far: a leading indented
          // item and a later shallower sibling are one top-level list (CommonMark allows 0-3
          // spaces before a marker), while deeper lines stay nested under their parent.
          var baseDepth = items[0].depth;
          for (var ni = 0; ni < items.length; ni++) {
            if (items[ni].depth < baseDepth) baseDepth = items[ni].depth;
            items[ni].depth -= baseDepth;
          }
          // Render every list the block contains: listBlock stops at a depth or marker-type
          // boundary, so the remainder must be passed through as its own list.
          var listPos = 0;
          while (listPos < items.length) {
            var block = listBlock(items, listPos, 0, env, key + "l" + listPos);
            if (block.pos <= listPos) {
              // Defensive: if a future depth rule ever makes no progress, still render the item.
              var oneKey = key + "x" + listPos;
              out.push(h(items[listPos].ordered ? "ol" : "ul", { key: oneKey },
                h("li", { key: oneKey + "i" }, inline(items[listPos].text, env, oneKey + "i"))));
              listPos++;
              continue;
            }
            out.push(block.el);
            listPos = block.pos;
          }
          continue;
        }
        if (!line.trim()) { i++; continue; }
        var p = [line];
        i++;
        while (i < n && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s|<svg\b)/.test(lines[i])) p.push(lines[i++]);
        out.push(h("p", { key: key }, inline(p.map(function (s) { return s.trim(); }).join(" "), env, key)));
      }
      return out;
    }

    // ---------- mermaid: sandboxed iframe (sandbox="allow-scripts", opaque origin) ----------
    // Theme: DSH theme service when present (theme.getTheme()), else DOM/media-query heuristics.
    var themeIsDark = function () {
      try {
        var th = svc("theme");
        if (th && typeof th.getTheme === "function") {
          var v = th.getTheme();
          var name = typeof v === "string" ? v : v && (v.resolved || v.mode || v.appearance || v.name || v.theme);
          if (typeof name === "string") {
            if (/dark/i.test(name)) return true;
            if (/light/i.test(name)) return false;
          }
        }
      } catch (e) { /* fall through */ }
      return isDark();
    };
    var MERMAID_TIMEOUT_MS = 5000;
    var MIN_INLINE_SCALE = 0.75; // never shrink 16px labels below ~12px inline; scroll instead
    var mermaidSeq = 0;
    // Renders one mermaid source in a sandboxed frame at natural size and reports {width,height}.
    // `scale` is applied with a CSS transform on the frame; the wrapper reserves the scaled box.
    function MermaidFrame(props) {
      var fS = React.useState(null), frame = fS[0], setFrame = fS[1];
      var idRef = React.useRef("m" + (++mermaidSeq));
      var onResult = props.onResult;
      React.useEffect(function () {
        if (!frame) return undefined;
        var finished = false;
        var send = function () {
          try { if (frame.contentWindow) frame.contentWindow.postMessage({ dshWikiRender: 1, id: idRef.current, src: props.src, dark: props.dark }, "*"); }
          catch (e) { /* ignore */ }
        };
        var onMsg = function (e) {
          // opaque-origin ("null") frame: authenticate by window identity, not origin
          if (e.source !== frame.contentWindow) return;
          var d = e.data || {};
          if (!d.dshWikiMermaid) return;
          if (d.ready) { send(); return; }
          if (d.id !== idRef.current) return;
          finished = true;
          if (d.error) onResult({ error: String(d.error) });
          else onResult({ width: Math.min(Math.max(Number(d.width) || 300, 40), 20000), height: Math.min(Math.max(Number(d.height) || 80, 30), 20000) });
        };
        window.addEventListener("message", onMsg);
        var onLoad = function () { send(); };
        frame.addEventListener("load", onLoad);
        var timer = setTimeout(function () { if (!finished) onResult({ error: "diagram did not render within 5 s" }); }, MERMAID_TIMEOUT_MS);
        return function () { clearTimeout(timer); window.removeEventListener("message", onMsg); frame.removeEventListener("load", onLoad); };
      }, [props.src, props.dark, frame]);
      var w = props.size ? props.size.width : 300, ht = props.size ? props.size.height : 80, sc = props.scale || 1;
      return h("div", { style: { width: Math.ceil(w * sc), height: Math.ceil(ht * sc), position: "relative", flex: "none", margin: "0 auto" } },
        h("iframe", { ref: setFrame, sandbox: "allow-scripts", src: ROUTE + "/mermaid-frame", title: "mermaid diagram", scrolling: "no",
          style: { border: 0, background: "transparent", width: w, height: ht, transform: "scale(" + sc + ")", transformOrigin: "0 0",
            position: "absolute", left: 0, top: 0, visibility: props.size ? "visible" : "hidden", pointerEvents: "none" } }));
    }

    // 缩放浮层由面板根（WikiApp）持有：浮层必须定位在 .dw-root（position:relative）里，
    // 而不是 position:fixed 贴视口——否则会盖住桌面窗口标题栏与窗口按钮。见 spec 006 修复。
    var ZoomCtx = React.createContext(null);

    function Mermaid(props) {
      var openZoom = React.useContext(ZoomCtx);
      var dS = React.useState(themeIsDark()), dark = dS[0], setDark = dS[1];
      var rS = React.useState(null), res = rS[0], setRes = rS[1];            // {width,height} | {error}
      var cS = React.useState(0), cw = cS[0], setCw = cS[1];                 // container inner width
      var boxRef = React.useRef(null);
      React.useEffect(function () { setRes(null); }, [props.src, dark]);
      React.useEffect(function () {
        if (typeof MutationObserver === "undefined" || typeof document === "undefined") return undefined;
        var obs = new MutationObserver(function () { setDark(themeIsDark()); });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
        return function () { obs.disconnect(); };
      }, []);
      React.useEffect(function () {
        var el = boxRef.current;
        if (!el) return undefined;
        var measure = function () { setCw(Math.max(0, el.clientWidth - 48)); };
        measure();
        if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return function () { window.removeEventListener("resize", measure); }; }
        var ro = new ResizeObserver(measure); ro.observe(el);
        return function () { ro.disconnect(); };
      }, [res && res.error]);
      if (res && res.error) {
        return h("div", { className: "dw-mwrap", style: { background: dark ? "#1f2937" : "#f3f4f6", alignItems: "stretch" } },
          h("div", { className: "dw-muted", style: { marginBottom: 6 } }, "⚠ Mermaid diagram could not be rendered: " + res.error),
          h("pre", { style: { width: "100%", textAlign: "left" } }, h("code", null, props.src)));
      }
      var size = res && res.width ? res : null;
      var scale = size && cw ? Math.min(1, Math.max(MIN_INLINE_SCALE, cw / size.width)) : 1;
      // trigger 记下打开浮层的按钮，关闭时把焦点还给它（Esc 与 Close 都走这条路）
      var open = function (e) {
        if (!size || typeof openZoom !== "function") return;
        openZoom({ src: props.src, dark: dark, size: size, label: props.label, index: props.index,
          trigger: (e && e.currentTarget) || null });
      };
      return h("div", { className: "dw-mwrap", ref: boxRef, style: { background: dark ? "#1f2937" : "#f3f4f6" } },
        h("button", { type: "button", className: "dw-mzoom", title: "Zoom", onClick: open }, "⤢"),
        h("div", { className: "dw-mscroll", onClick: open, title: size ? "Click to zoom" : "" },
          h(MermaidFrame, { key: dark ? "d" : "l", src: props.src, dark: dark, size: size, scale: scale, onResult: setRes }),
          !size ? h("div", { className: "dw-muted", style: { padding: 12 } }, "Rendering diagram…") : null));
    }

    // Qoder 风格缩放浮层：浮在 Wiki 面板内的居中顶部工具栏（大按钮、高对比 Close、Esc 关闭）。
    function MermaidZoom(props) {
      var t = props.t;
      var paneRef = React.useRef(null);
      var closeRef = React.useRef(null);
      var dialogRef = React.useRef(null);
      var fitOf = function () {
        var el = paneRef.current;
        if (!el) return 1;
        return Math.max(0.1, Math.min((el.clientWidth - 48) / props.size.width, (el.clientHeight - 48) / props.size.height, 4));
      };
      var zS = React.useState(null), zoom = zS[0], setZoom = zS[1];
      var cS = React.useState(""), copied = cS[0], setCopied = cS[1];
      React.useEffect(function () {
        setZoom(fitOf());
        if (closeRef.current && typeof closeRef.current.focus === "function") closeRef.current.focus();
      }, []);
      React.useEffect(function () {
        var onKey = function (e) {
          if (e.key === "Escape") {
            e.stopPropagation();
            if (typeof e.preventDefault === "function") e.preventDefault();
            props.onClose();
            return;
          }
          // 焦点陷阱：模态浮层内的 Tab/Shift+Tab 只在浮层内循环，键盘用户不会掉到面板背后
          if (e.key !== "Tab") return;
          var root = dialogRef.current;
          if (!root) return;
          var nodes = root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
          var focusable = [];
          for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.disabled || el.getAttribute("aria-hidden") === "true") continue;
            // 隐藏元素（display:none / 视口外 0 尺寸）不接受焦点
            if (typeof el.offsetParent !== "undefined" && el.offsetParent === null) continue;
            focusable.push(el);
          }
          if (!focusable.length) return;
          var first = focusable[0], last = focusable[focusable.length - 1];
          var active = document.activeElement;
          if (e.shiftKey && (active === first || !root.contains(active))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (active === last || !root.contains(active))) {
            e.preventDefault();
            first.focus();
          }
        };
        window.addEventListener("keydown", onKey, true);
        return function () {
          window.removeEventListener("keydown", onKey, true);
          // 关闭后焦点回到触发按钮（键盘用户不会掉到 body 上）
          try { if (props.trigger && typeof props.trigger.focus === "function") props.trigger.focus(); } catch (e) { /* ignore */ }
        };
      }, []);
      var z = zoom || 1;
      var set = function (v) { setZoom(Math.max(0.1, Math.min(8, v))); };
      var copySrc = function () {
        copyText(props.src).then(function (ok) {
          setCopied(ok ? t("zoom.copied") : t("zoom.copyFail"));
          setTimeout(function () { setCopied(""); }, 1600);
        });
      };
      var label = (props.label ? props.label + " · " : "") + t("zoom.title") + (props.index ? " " + props.index : "");
      return h("div", { className: "dw-zoom", role: "dialog", "aria-modal": "true", "aria-label": label, ref: dialogRef },
        h("div", { className: "dw-zoombar", role: "toolbar", "aria-label": t("zoom.title") },
          h("span", { className: "dw-zoomlabel", title: label }, label),
          h("button", { type: "button", onClick: function () { set(z / 1.25); }, title: t("zoom.zoomOut"), "aria-label": t("zoom.zoomOut") },
            h("span", { className: "dw-zoomicon", "aria-hidden": "true" }, "−")),
          h("span", { className: "dw-zoompct", "aria-live": "polite" }, Math.round(z * 100) + "%"),
          h("button", { type: "button", onClick: function () { set(z * 1.25); }, title: t("zoom.zoomIn"), "aria-label": t("zoom.zoomIn") },
            h("span", { className: "dw-zoomicon", "aria-hidden": "true" }, "+")),
          h("button", { type: "button", onClick: function () { set(fitOf()); } }, t("zoom.fit")),
          h("button", { type: "button", onClick: function () { set(1); }, title: t("zoom.resetTitle") }, t("zoom.reset")),
          h("button", { type: "button", onClick: copySrc }, copied || t("zoom.copy")),
          h("button", { type: "button", className: "dw-zoomclose", ref: closeRef, onClick: props.onClose,
            title: t("zoom.close") + " (Esc)" }, t("zoom.close"), " ", h("span", { className: "dw-zoomicon", "aria-hidden": "true" }, "✕"))),
        h("div", { className: "dw-zoompane", ref: paneRef },
          zoom ? h("div", { style: { padding: 24, width: "max-content", margin: "0 auto" } },
            h(MermaidFrame, { src: props.src, dark: props.dark, size: props.size, scale: z, onResult: function () {} })) : null));
    }
    // ---------- 面板内后台作业（spec 007 第一切片） ----------
    var JOB_POLL_MS = 1500;
    var JOB_IDLE_POLL_MS = 8000;
    var JOB_STAGES = ["staging", "session", "agent", "validate", "build", "selfcheck", "publish", "done"];
    var postJson = function (url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) {
            var err = new Error((b && (b.error || b.message)) || ("HTTP " + r.status));
            err.status = r.status;
            err.code = b && b.code;
            throw err;
          }
          return b;
        });
      });
    };
    // 模型目录：只列宿主真实返回的模型；拿不到就禁用生成（绝不发明模型）
    function useCatalog() {
      var s = React.useState({ phase: "loading", models: [], groups: [], failures: [], def: null, error: null });
      var catalog = s[0], setCatalog = s[1];
      React.useEffect(function () {
        var alive = true;
        getJson(ROUTE + "/api/models").then(function (b) {
          if (!alive) return;
          setCatalog({ phase: "ready", models: Array.isArray(b.models) ? b.models : [], groups: Array.isArray(b.groups) ? b.groups : [],
            failures: Array.isArray(b.failures) ? b.failures : [], def: b.default || null, error: null });
        }, function (e) {
          if (!alive) return;
          setCatalog({ phase: "error", models: [], groups: [], failures: [], def: null, error: String(e.message || e) });
        });
        return function () { alive = false; };
      }, []);
      return catalog;
    }
    // 作业闸门：宿主 GET /api/jobs 在闸门关闭时回 disabled:true + disabledReason，active/last 恒为 null。
    // 只有宿主明确说 disabled === false 才算开启；缺字段、尚未响应、请求失败都按关闭处理（fail closed）：
    // 宁可在确认之前禁用一个按钮，也不显示一个注定拿 503 的 Generate。
    var jobGateFrom = function (b) {
      if (!b || typeof b !== "object") return { known: false, disabled: true, reason: "" };
      if (b.disabled !== false) {
        return { known: true, disabled: true, reason: typeof b.disabledReason === "string" ? b.disabledReason : "" };
      }
      return { known: true, disabled: false, reason: "" };
    };
    var jobGateClosed = function (gate) { return !gate || gate.disabled !== false; };
    // 停用原因：host 原文优先；已答复但没给原因时说明这一点，未答复时说明还在检查。
    var jobGateText = function (t, gate) {
      if (gate && gate.reason) return String(gate.reason);
      return gate && gate.known ? t("job.gate.unknown") : t("job.gate.checking");
    };
    // 作业状态轮询：有活动作业时 1.5s，空闲时 8s；卸载即停
    function useJobView(root) {
      var s = React.useState({ active: null, last: null, gate: { known: false, disabled: true, reason: "" } });
      var view = s[0], setView = s[1];
      var refresh = React.useCallback(function () {
        if (!root) return Promise.resolve(null);
        return getJson(ROUTE + "/api/jobs?root=" + encodeURIComponent(root)).then(function (b) {
          setView({ active: (b && b.active) || null, last: (b && b.last) || null, gate: jobGateFrom(b) });
          return b;
        }, function () {
          // 状态拿不到：保留 active/last，闸门退回“未确认关闭”，绝不让按钮重新变亮。
          setView(function (v) { return { active: v.active, last: v.last, gate: { known: false, disabled: true, reason: "" } }; });
          return null;
        });
      }, [root]);
      React.useEffect(function () {
        if (!root) return undefined;
        var stopped = false, timer = null;
        var tick = function () {
          refresh().then(function (b) {
            if (stopped) return;
            timer = setTimeout(tick, b && b.active ? JOB_POLL_MS : JOB_IDLE_POLL_MS);
          }, function () { if (!stopped) timer = setTimeout(tick, JOB_IDLE_POLL_MS); });
        };
        tick();
        return function () { stopped = true; if (timer) clearTimeout(timer); };
      }, [root, refresh]);
      return [view, refresh];
    }
    function jobStageIndex(stage) {
      var at = JOB_STAGES.indexOf(stage);
      return at < 0 ? 0 : at;
    }
    /**
     * 可用语言列表（宿主 GET /api/languages）：只列真实存在、且已有可读 wiki.json 的 locale 目录。
     * 空的 locales/ 目录（units:false）不算一种可读语言，所以不进选择器；en 由面板自己补上。
     * 请求失败 = 没有额外语言（界面显示 —），绝不因为列表缺失就挡住 en 内容。
     */
    function useLanguages(root) {
      var s = React.useState({ phase: "loading", tags: [], error: null });
      var view = s[0], setView = s[1];
      var refresh = React.useCallback(function () {
        if (!root) return Promise.resolve([]);
        return getJson(ROUTE + "/api/languages?root=" + encodeURIComponent(root)).then(function (b) {
          var tags = (Array.isArray(b && b.languages) ? b.languages : []).filter(function (l) {
            return l && l.units === true && typeof l.tag === "string" && l.tag && l.tag !== "en";
          }).map(function (l) { return l.tag; });
          setView({ phase: "ready", tags: tags, error: null });
          return tags;
        }, function (e) {
          setView({ phase: "error", tags: [], error: String((e && e.message) || e) });
          return [];
        });
      }, [root]);
      React.useEffect(function () { refresh(); }, [refresh]);
      return [view, refresh];
    }
    /**
     * 模型下拉：只列出宿主 /api/models 返回的模型；目录不可用时禁用并说明原因。
     * disabled 时仍渲染全部真实选项：闸门关闭时模型选择器是只读查看，不能作为生成动作。
     * props: { t, catalog, model, onModel, disabled, title }
     */
    function ModelSelect(props) {
      var t = props.t, catalog = props.catalog || { phase: "loading", models: [], failures: [], def: null }, model = props.model;
      var models = catalog.phase === "ready" ? catalog.models : [];
      var key = model ? model.provider + "\u0000" + model.model : "";
      return h(React.Fragment, null,
        h("label", { htmlFor: "dw-model-select" }, t("job.model")),
        models.length
          ? h("select", { id: "dw-model-select", className: "dw-select", value: key, disabled: !!props.disabled,
              title: props.title || undefined,
              onChange: function (e) {
                var next = models.filter(function (m) { return m.provider + "\u0000" + m.model === e.target.value; })[0];
                if (next) props.onModel({ provider: next.provider, model: next.model });
              } },
              models.map(function (m) {
                var isDefault = catalog.def && catalog.def.provider === m.provider && catalog.def.model === m.model;
                return h("option", { key: m.provider + "\u0000" + m.model, value: m.provider + "\u0000" + m.model },
                  m.providerLabel + " / " + m.label + (isDefault ? t("job.model.default") : ""));
              }))
          : h("span", { className: "dw-muted" }, catalog.phase === "error" ? t("job.noCatalog") + catalog.error : t("loading")),
        catalog.failures && catalog.failures.length
          ? h("span", { className: "dw-stages", role: "note" }, catalog.failures.map(function (f) {
              return h("span", { key: f.id }, "⚠ " + f.name + ": " + f.message);
            }))
          : null);
    }
    /**
     * 闸门提示条：宿主停用后台作业时，原因原样照登（不是装饰性的灰字）。
     * 只有一条细描边 + 左侧警告色竖线。闸门关闭时它同时是唯一的动作区：被挡住的主按钮
     * （永远禁用，title 就是宿主给出的原因）和「复制命令」兜底并排在右侧 —— 原因、被挡住的主动作
     * 与前台兜底因此是同一块，而不是一张只剩一个禁用按钮的空卡片。
     * 闸门关闭时模型下拉收起：选中的模型作为一行灰字留在这里，仍然可见，只是不可操作。
     * props: { t, text, model, generated, onStart, onCopy }
     */
    function GateNotice(props) {
      var t = props.t, model = props.model;
      return h("div", { className: "dw-notice", role: "status", "aria-live": "polite" },
        h("div", { className: "dw-notice-body" },
          h("b", null, t("job.gate.title")),
          h("span", null, props.text),
          model ? h("span", null, t("job.model") + ": " + model.provider + " / " + model.model) : null),
        // 只有真的有动作时才渲染按钮组（未翻译面板只用这一条提示解释原因，它自己的动作在提示条之外）
        props.onStart || props.onCopy
          ? h("div", { className: "dw-notice-actions" },
              // 主按钮在这个分支里永远是禁用态（浏览器因此不派发点击）；接线与启用路径是同一份，
              // 将来闸门开启时不必再重排结构。
              props.onStart
                ? h("button", { type: "button", className: "dw-btn primary", disabled: true, title: props.text,
                    onClick: function () { props.onStart(props.generated ? "update" : "generate"); } },
                  props.generated ? "↻ " + t("job.update") : "✨ " + t("job.generate"))
                : null,
              // 标签只留动作，命令原文和「贴到会话里」都折进 title：按钮因此不再主导这一行的宽度
              props.onCopy
                ? h("button", { type: "button", className: "dw-btn",
                    title: t("job.gate.copyCmdTitle") + " — " + t("job.gate.hint"),
                    onClick: function () { props.onCopy(); } }, t("job.gate.copyCmd"))
                : null)
          : null);
    }
    /**
     * 模型选择 + 生成/更新 + 阶段进度 + 取消。作业在宿主后台跑，面板保持打开。
     * gate：宿主 /api/jobs 的闸门 { known, disabled, reason }；缺省/未确认一律按关闭处理（fail closed）。
     * 闸门关闭：不再单独渲染作业卡片。宿主在闸门关闭时 active/last 恒为 null，卡片里除了那个被挡住的
     * 主按钮没有别的可报告，于是只剩一个空框里飘着一个禁用按钮 —— 和之前那张孤零零的只读模型卡片
     * 是同一类问题。主按钮因此搬进 GateNotice：能力看得见、原因（title 与提示条正文）读得懂，
     * 「复制命令」兜底就在它旁边，原因 / 被挡住的主动作 / 前台兜底成为同一块。
     * 闸门开启：卡片照旧 —— 模型下拉 + 启用的主按钮，作业在跑时换成阶段进度与取消。
     * 前台兜底自始至终只有「复制命令」，它只写剪贴板，绝不开会话。
     * props: { t, root, generated, catalog, model, onModel, job, gate, onStart, onCancel, onOpenSession, onCopy, onCopyCommand, busy }
     */
    function JobControls(props) {
      var t = props.t, catalog = props.catalog || { phase: "loading", models: [], failures: [], def: null }, job = props.job, model = props.model;
      var gate = props.gate;
      var gateDisabled = jobGateClosed(gate);
      var gateText = gateDisabled ? jobGateText(t, gate) : "";
      var disabled = gateDisabled || catalog.phase !== "ready" || !model || props.busy;
      // 闸门关闭分支到此为止：提示条是唯一的动作区。回调仍走上面那份 disabled 判定，与卡片里的
      // 启用路径完全一致（此处 disabled 恒为 true，所以永远不会发出注定 503 的请求）。
      if (gateDisabled) {
        return h(GateNotice, {
          t: t, text: gateText, model: model, generated: props.generated,
          onStart: function (action) { if (disabled) return; props.onStart(action); },
          onCopy: props.onCopyCommand ? function () { props.onCopyCommand(); } : null,
        });
      }
      var active = job && job.phase === "running" ? job : null;
      var lastDone = job && job.phase !== "running" ? job : null;
      var pct = active ? Math.round((jobStageIndex(active.stage) / (JOB_STAGES.length - 1)) * 100) : (lastDone && lastDone.phase === "done" ? 100 : 0);
      var elapsed = active && active.startedAt ? Math.max(0, Math.round((Date.now() - new Date(active.startedAt).getTime()) / 1000)) : null;
      var errText = lastDone && lastDone.phase === "failed" && lastDone.error ? String(lastDone.error.message || "") : "";
      var btnTitle = disabled ? (catalog.phase === "error" ? t("job.noCatalogHint") : props.busy ? t("job.busy") : "") : t("job.modelLocked");
      // 闸门开启：卡片里没有“闸门关闭时收起某项”的分支残留，模型选择始终是真实控件
      return h("div", { className: "dw-job" },
        h("div", { className: "dw-jobrow" },
          h(ModelSelect, { t: t, catalog: catalog, model: model, onModel: props.onModel,
            disabled: !!active }),
          h("span", { style: { flex: 1 } }),
          active
            ? h("button", { type: "button", className: "dw-btn", onClick: function () { props.onCancel(); } }, "✕ ", t("job.cancel"))
            : h("button", { type: "button", className: "dw-btn primary", disabled: disabled, title: btnTitle,
                onClick: function () {
                  if (disabled) return; // 目录缺失/作业占用时按钮已禁用；这里再挡一次，绝不发注定 503 的请求
                  props.onStart(props.generated ? "update" : "generate");
                } },
              props.generated ? "↻ " + t("job.update") : "✨ " + t("job.generate"))),
        active ? h("div", null,
          h("div", { className: "dw-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct },
            h("i", { style: { width: pct + "%" } })),
          h("div", { className: "dw-stages", "aria-live": "polite" },
            h("b", null, t("job.running") + " · " + (t("job.stage." + active.stage) || active.stage)),
            h("span", null, t("job.model") + ": " + active.model.provider + " / " + active.model.model),
            elapsed !== null ? h("span", { className: "dw-clock" }, elapsed + " s") : null,
            active.pages ? h("span", null, active.pages + " " + t("job.pages")) : null)) : null,
        active && active.sessionId
          ? h("div", { className: "dw-jobrow" },
              h("span", { className: "dw-muted" }, t("job.session") + ": " + active.sessionId.slice(0, 12) + "…"),
              props.onOpenSession ? h("button", { type: "button", className: "dw-btn", onClick: function () { props.onOpenSession(active.sessionId); } }, t("job.openSession")) : null,
              h("button", { type: "button", className: "dw-btn", onClick: function () { props.onCopy(active.sessionId); } }, t("job.copySession")))
          : null,
        lastDone && lastDone.phase === "done"
          ? h("div", { className: "dw-stages" }, "✓ ", t("job.done"), lastDone.pages ? " (" + lastDone.pages + " " + t("job.pages") + ")" : "")
          : null,
        lastDone && lastDone.phase === "canceled" ? h("div", { className: "dw-stages" }, t("job.canceled")) : null,
        errText ? h("div", { className: "dw-joberr", role: "alert" }, t("job.failed"), errText) : null,
        // 闸门关闭时走不到这里（那时唯一的动作区是提示条），这条说明只会在开启时成立
        h("div", { className: "dw-muted", style: { fontSize: 11.5 } }, t("job.keepOpen")));
    }

    /**
     * 语言选择器：en（规范）外加宿主持有的每一种已翻译语言；列表为空或请求失败时在旁边显示 —。
     * 它是选择器而不是动作：切换只重取 /api/wiki?lang=，不发起任何作业。
     * 标签视觉隐藏（.dw-sr）但仍是这个 <select> 的可访问名；文案由紧邻的标题/药丸说明。
     * props: { t, lang, tags, phase, onPick }
     */
    function LanguageSelect(props) {
      var t = props.t, tags = Array.isArray(props.tags) ? props.tags : [];
      var options = ["en"].concat(tags.filter(function (tag) { return tag !== "en"; }));
      // 已持久化但尚未出现在列表里（首次刷新/回退途中）：仍作为一个选项显示，不让控件假装选了别的语言
      if (props.lang && options.indexOf(props.lang) < 0) options = options.concat([props.lang]);
      return h("div", { className: "dw-lang" },
        h("label", { htmlFor: "dw-lang-select", className: "dw-sr" }, t("lang.label")),
        h("select", {
          id: "dw-lang-select", className: "dw-select", value: props.lang || "en", title: t("lang.label"),
          onChange: function (e) { props.onPick(e.target.value); },
        }, options.map(function (tag) { return h("option", { key: tag, value: tag }, langLabel(tag)); })),
        // 没有额外语言（空列表或请求失败）：明确显示 —，而不是一个看起来坏掉的空控件
        tags.length ? null
          : h("span", { className: "dw-langnone", title: props.phase === "error" ? t("lang.listFail") : t("lang.noneTitle") }, "—"));
    }

    /**
     * 未翻译状态：宿主对 /api/wiki?lang=<tag> 回 404 translation-missing 时显示。
     * 这是“还没有”，不是错误——文案不报错，唯一动作是启动一次翻译作业；
     * 作业闸门关闭时该动作禁用并原样给出宿主原因（与 Generate/Update 同一套解释）。
     * props: { t, lang, gate, job, busy, catalogPhase, hasModel, onTranslate, onCancel }
     */
    function UntranslatedPanel(props) {
      var t = props.t, gate = props.gate;
      var gateDisabled = jobGateClosed(gate);
      var gateText = gateDisabled ? jobGateText(t, gate) : "";
      var active = props.job && props.job.phase === "running" ? props.job : null;
      var disabled = gateDisabled || props.catalogPhase !== "ready" || !props.hasModel || !!props.busy;
      var pct = active ? Math.round((jobStageIndex(active.stage) / (JOB_STAGES.length - 1)) * 100) : 0;
      var btnTitle = !disabled ? "" : gateDisabled ? gateText : props.catalogPhase !== "ready" ? t("job.noCatalogHint") : t("job.busy");
      // 失败的翻译不会自动重试：把作业错误留在这一屏，否则界面只是悄悄退回可再点的按钮
      var errText = props.job && props.job.phase === "failed" && props.job.error ? String(props.job.error.message || "") : "";
      return h("div", { className: "dw-doc" },
        h("h1", null, t("lang.missing.title")),
        h("div", { className: "dw-pagemeta" }, h("code", { className: "dw-mono" }, String(props.lang || "")),
          h("span", null, langLabel(props.lang))),
        h("p", { className: "dw-muted" }, t("lang.missing.body")),
        // 与 JobControls 同一个提示条组件：两处的闸门解释长得一样
        gateDisabled ? h(GateNotice, { t: t, text: gateText }) : null,
        h("div", { className: "dw-actions" },
          active
            ? h("button", { type: "button", className: "dw-btn", onClick: function () { props.onCancel(); } }, "✕ ", t("job.cancel"))
            : h("button", { type: "button", className: "dw-btn primary", disabled: disabled, title: btnTitle,
                onClick: function () {
                  if (disabled) return; // 闸门关闭/目录缺失时按钮已禁用；这里再挡一次，绝不发注定失败的请求
                  props.onTranslate(props.lang);
                } }, "🌐 ", t("lang.translate") + String(props.lang || ""))),
        active
          ? h("div", { className: "dw-job" },
              h("div", { className: "dw-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct },
                h("i", { style: { width: pct + "%" } })),
              h("div", { className: "dw-stages", "aria-live": "polite" },
                h("b", null, t("job.running") + " · " + (t("job.stage." + active.stage) || active.stage)),
                active.model ? h("span", null, t("job.model") + ": " + active.model.provider + " / " + active.model.model) : null))
          : null,
        errText ? h("div", { className: "dw-joberr", role: "alert" }, t("job.failed"), errText) : null);
    }

    // ---------- 项目网格 ----------
    function Home(props) {
      var t = props.t;
      var st = React.useState({ phase: "loading", projects: [], error: null });
      var data = st[0], setData = st[1];
      var tabS = React.useState("all"), tab = tabS[0], setTab = tabS[1];
      var qS = React.useState(""), q = qS[0], setQ = qS[1];
      var modeS = React.useState("grid"), mode = modeS[0], setMode = modeS[1];
      var load = React.useCallback(function () {
        setData(function (s) { return { phase: "loading", projects: s.projects, error: null }; });
        getJson(ROUTE + "/api/projects").then(function (b) {
          setData({ phase: "ready", projects: Array.isArray(b.projects) ? b.projects : [], error: null });
        }, function (e) { setData(function (s) { return { phase: "error", projects: s.projects, error: String(e.message || e) }; }); });
      }, []);
      React.useEffect(function () { load(); }, [load]);
      var list = data.projects.filter(function (p) {
        if (tab === "generated" && !p.generated) return false;
        if (tab === "missing" && p.generated) return false;
        var s = q.trim().toLowerCase();
        return !s || (p.title + " " + p.root).toLowerCase().indexOf(s) >= 0;
      });
      var badge = function (p) {
        if (!p.generated) return h("span", { className: "dw-badge" }, t("badge.missing"));
        if (p.updateAvailable) return h("span", { className: "dw-badge upd" }, t("badge.update"));
        return h("span", { className: "dw-badge ok" }, t("badge.generated"));
      };
      var body;
      if (data.phase === "loading" && !data.projects.length) body = h("div", { className: "dw-muted" }, t("loading"));
      else if (data.phase === "error") body = h("div", null, t("error"), data.error, " ", h("button", { className: "dw-btn", onClick: load }, t("retry")));
      else if (!list.length) body = h("div", { className: "dw-muted" }, t("empty"));
      else body = h("div", { className: mode === "grid" ? "dw-grid" : "dw-list" }, list.map(function (p) {
        return h("button", { key: p.root, className: "dw-card", onClick: function () { props.open(p); } },
          h("div", { style: { minWidth: 0, flex: mode === "list" ? 1 : "none" } },
            h("div", { className: "dw-card-name" }, "📖 ", p.title),
            h("div", { className: "dw-mono dw-muted" }, p.root)),
          badge(p),
          p.generated
            ? h("div", { className: "dw-muted" }, p.pageCount + " " + t("pages") + " · " + p.cardCount + " " + t("cards") + " · " + t("updated") + " " + fmtDate(p.updatedAt))
            : h("span", { className: "dw-link" }, t("go.generate") + " →"));
      }));
      return h("div", { className: "dw-scroll" }, h("div", { className: "dw-home" },
        h("h1", { className: "dw-h1" }, t("home.title")),
        h("p", { className: "dw-sub" }, t("home.sub")),
        h("div", { className: "dw-bar" },
          h("div", { className: "dw-tabs" }, ["all", "generated", "missing"].map(function (k) {
            return h("button", { key: k, className: "dw-tab" + (tab === k ? " on" : ""), onClick: function () { setTab(k); } }, t("tab." + k));
          })),
          h("input", { className: "dw-input", placeholder: t("search"), value: q, onChange: function (e) { setQ(e.target.value); } }),
          h("button", { className: "dw-btn", onClick: load, title: t("refresh") }, "⟳ ", t("refresh")),
          h("button", { className: "dw-btn", onClick: function () { setMode(mode === "grid" ? "list" : "grid"); } },
            mode === "grid" ? "☰ " + t("view.list") : "▦ " + t("view.grid"))),
        // 主屏模型选择（来自宿主真实目录）：打开项目后同一个选择用于生成/更新
        h("div", { className: "dw-bar" }, h(ModelSelect, { t: t, catalog: props.catalog, model: props.model, onModel: props.onModel })),
        body));
    }

    // ---------- 详情 ----------
    function genCommand(root) { return "/wiki generate " + root; }
    // 仓库路径拆成「前段 + 尾段」：窄面板里让省略号吃掉前段，最后两段（如 plugins\dsh-wiki）始终保留，
    // 因为认出仓库靠的是尾段。完整路径仍放在 title 里；拼接起来仍是原始字符串，不做任何改写。
    function splitPath(root) {
      var s = String(root == null ? "" : root);
      var last = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      if (last <= 0) return { head: "", tail: s };
      var prev = Math.max(s.lastIndexOf("\\", last - 1), s.lastIndexOf("/", last - 1));
      if (prev <= 0) return { head: "", tail: s };
      return { head: s.slice(0, prev), tail: s.slice(prev) };
    }

    // 可选客户端服务（uiWorkspace / workspaces / layout）：apply 时记下 ctx，用时再取；
    // 缺任何一个都退回"复制命令"。服务不进 inject 列表，避免缺服务时整个插件不激活。
    var clientCtx = null;
    var svc = function (name) {
      try {
        if (!clientCtx) return null;
        var v = typeof clientCtx.get === "function" ? clientCtx.get(name) : null;
        return v || null;
      } catch (e) { return null; }
    };
    // 在 repo 对应的工作区里开新会话并切到 conversation 面板；返回是否成功。
    // workspaceId 来自宿主 /api/project（workspaceRegistry）；没有则尝试 workspaces.create({path})，
    // 失败（例如已存在）即放弃，由调用方退回"复制命令"。客户端 workspaces 服务没有 list()。
    function startGenerateSession(root, workspaceId) {
      var ui = svc("uiWorkspace"), wss = svc("workspaces"), layout = svc("layout");
      if (!ui || typeof ui.startSession !== "function") return Promise.resolve(false);
      var idP = workspaceId
        ? Promise.resolve(workspaceId)
        : (wss && typeof wss.create === "function"
          ? Promise.resolve().then(function () { return wss.create({ path: root }); }).then(function (w) {
              return (w && (w.id || (w.workspace && w.workspace.id))) || null;
            }, function () { return null; })
          : Promise.resolve(null));
      return idP.then(function (id) {
        if (!id) return false; // never start a session in an unrelated workspace
        return Promise.resolve(ui.startSession(id, {})).then(function () {
          try { if (layout && typeof layout.selectPanel === "function") layout.selectPanel("conversation"); } catch (e) { /* ignore */ }
          return true;
        });
      }).catch(function () { return false; });
    }

    function Detail(props) {
      var t = props.t, project = props.project;
      var st = React.useState({ phase: "loading", wiki: null, info: null, missing: false, error: null });
      var data = st[0], setData = st[1];
      var root = project.root;
      // 语言选择：按项目根持久化（重开面板仍是上次选的语言）；en 是规范内容，等同未选
      var langS = React.useState(function () { return readStoredLang(root); });
      var lang = langS[0], setLang = langS[1];
      var selS = React.useState(null), sel = selS[0], setSel = selS[1]; // {type:'page'|'card'|'cards', id}
      var srcS = React.useState(false), showSrc = srcS[0], setShowSrc = srcS[1];
      var qS = React.useState(""), q = qS[0], setQ = qS[1];
      var openS = React.useState(function () { return Object.create(null); }), open = openS[0], setOpen = openS[1];
      var menuS = React.useState(false), menu = menuS[0], setMenu = menuS[1];
      var toastS = React.useState(null), toast = toastS[0], setToast = toastS[1];
      var mainRef = React.useRef(null);
      // 后台作业状态：有活动作业时 1.5s 轮询；结束（成功/失败/取消）后刷新一次内容
      var jvS = useJobView(root), jobView = jvS[0], refreshJobs = jvS[1];
      var lvS = useLanguages(root), langView = lvS[0], refreshLanguages = lvS[1];
      var job = jobView.active || jobView.last;
      // 闸门：宿主说 disabled:false 之前一律按关闭处理；关闭时面板里没有任何“更新”动作可用
      var gate = jobView.gate;
      var gateDisabled = jobGateClosed(gate);
      var gateText = gateDisabled ? jobGateText(t, gate) : "";
      var jobPhase = jobView.active ? "running" : (jobView.last ? jobView.last.phase : "idle");
      var prevJobPhase = React.useRef(jobPhase);
      React.useEffect(function () {
        var previous = prevJobPhase.current;
        prevJobPhase.current = jobPhase;
        var finished = jobView.last; // jobPhase is derived from this same jobView, so it is current here
        // 作业由运行转为终态：成功即换成新 wiki；失败/取消时旧 wiki 未被改动，刷新只为清掉进度条
        if (previous === "running" && jobPhase !== "running") {
          load();
          // 一次成功的 translate 会在 .dsh-wiki/locales/<tag>/ 下产生新的翻译：列表与内容都要重取
          if (finished && finished.phase === "done" && finished.action === "translate") refreshLanguages();
        }
      }, [jobPhase, load, refreshLanguages]);
      var load = React.useCallback(function () {
        var info = getJson(ROUTE + "/api/project?root=" + encodeURIComponent(root));
        var translated = !!lang && lang !== "en";
        var wiki = project.generated
          ? getJson(ROUTE + "/api/wiki?root=" + encodeURIComponent(root) + (translated ? "&lang=" + encodeURIComponent(lang) : ""))
            .then(function (b) { return b; }, function (e) {
              // 宿主 404 translation-missing：该语言还没有翻译，不是读取失败——交给未翻译状态
              if (translated && e && e.code === "translation-missing") return { untranslated: true };
              throw e;
            })
          : Promise.resolve(null);
        Promise.all([info, wiki]).then(function (r) {
          var w = r[1];
          setData({ phase: "ready", info: r[0].project, wiki: w && !w.untranslated ? w : null,
            missing: !!(w && w.untranslated), error: null });
        }, function (e) { setData({ phase: "error", info: null, wiki: null, missing: false, error: String(e.message || e) }); });
      }, [root, project.generated, lang]);
      React.useEffect(function () { load(); }, [load]);
      // 换语言后旧的选中页面/卡片通常不存在：回到概览，别让用户停在“页面不存在”上
      React.useEffect(function () { setSel(null); setShowSrc(false); }, [lang]);
      React.useEffect(function () { if (mainRef.current) mainRef.current.scrollTop = 0; setShowSrc(false); }, [sel]);
      // 持久化的语言已不在宿主列表里（locale 目录被删除或不再可读）：退回规范 en
      React.useEffect(function () {
        if (langView.phase !== "ready" || !lang || lang === "en") return;
        if (langView.tags.indexOf(lang) >= 0) return;
        storeLang(root, "en");
        setLang("en");
      }, [langView.phase, langView.tags, lang, root]);
      var pickLang = function (tag) { storeLang(root, tag); setLang(tag || "en"); };
      var said = function (msg) { setToast(msg); setTimeout(function () { setToast(null); }, 6000); };
      var copy = function (text, label) {
        copyText(text).then(function (ok) { said((label || t("copied")) + " " + text + (ok ? "" : " (clipboard unavailable — copy manually)")); });
      };
      // 面板内启动/取消作业：不导航、不关面板；作业在宿主后台运行
      // targetLang 缺省 en：generate/update 只写规范 wiki，translate 必须带非 en 的 tag
      var startJob = function (action, targetLang) {
        var m = props.model;
        if (!m) return;
        postJson(ROUTE + "/api/jobs", { root: root, action: action, targetLang: targetLang || "en", model: { provider: m.provider, model: m.model } })
          .then(function () { refreshJobs(); }, function (e) { said(String(e.message || e)); refreshJobs(); });
      };
      var cancelJob = function () {
        postJson(ROUTE + "/api/jobs/cancel", { root: root }).then(function () { refreshJobs(); },
          function (e) { said(String(e.message || e)); refreshJobs(); });
      };
      // 作业会话：能开就开（uiWorkspace.openSession 已在本机客户端源码中确认），否则复制 id
      var openJobSession = function (sessionId) {
        var ui = svc("uiWorkspace");
        if (ui && typeof ui.openSession === "function") {
          try { ui.openSession(sessionId); return; } catch (e) { /* 退回复制 */ }
        }
        copy(sessionId, t("job.session") + ": ");
      };
      var wiki = data.wiki, info = data.info;
      var pages = wiki ? wiki.pages : [];
      var cards = wiki ? wiki.cards : [];
      // id 字典必须无原型：页面/卡片 id 可能叫 "constructor"、"toString"、"__proto__"，
      // 用 {} 会把内建属性当成已存在的 id（或赋值时静默丢弃），导致页面消失或树错乱。
      var pageById = Object.create(null); pages.forEach(function (p) { pageById[p.id] = p; });
      var cardById = Object.create(null); cards.forEach(function (c) { cardById[c.id] = c; });
      var env = {
        t: t,
        hasCard: function (id) { return !!cardById[id]; },
        hasPage: function (id) { return !!pageById[id]; },
        openCard: function (id) { setSel({ type: "card", id: id }); },
        openPage: function (id) { setSel({ type: "page", id: id }); },
        cite: function (ref) {
          var file = ref.replace(/:\d+(?:-\d+)?$/, "");
          copy(root.replace(/[\\/]+$/, "") + (root.indexOf("\\") >= 0 ? "\\" + file.replace(/\//g, "\\") : "/" + file) + ref.slice(file.length));
        },
      };
      // 页面树（无原型字典：id 可能是 constructor/toString/__proto__）
      var children = Object.create(null), roots = [];
      var sorted = pages.slice().sort(function (a, b) {
        var ao = a.order == null ? 1e9 : a.order, bo = b.order == null ? 1e9 : b.order;
        return ao - bo;
      });
      sorted.forEach(function (p) {
        if (p.parentId && pageById[p.parentId] && p.parentId !== p.id) (children[p.parentId] = children[p.parentId] || []).push(p);
        else roots.push(p);
      });
      var qq = q.trim().toLowerCase();
      var matches = function (p) { return !qq || (p.title + " " + p.description).toLowerCase().indexOf(qq) >= 0; };
      var visible = function (p, seen) {
        if (seen[p.id]) return false;
        seen[p.id] = 1;
        return matches(p) || (children[p.id] || []).some(function (c) { return visible(c, seen); });
      };
      var renderNode = function (p, depth, seen) {
        if (seen[p.id] || !visible(p, Object.assign(Object.create(null), seen))) return null;
        var nextSeen = Object.assign(Object.create(null), seen); nextSeen[p.id] = 1;
        var kids = children[p.id] || [];
        var isOpen = qq ? true : open[p.id] !== false;
        var on = sel && sel.type === "page" && sel.id === p.id;
        return h(React.Fragment, { key: p.id },
          h("button", { className: "dw-node" + (on ? " on" : ""), style: { paddingLeft: 6 + depth * 14 },
            onClick: function () { setSel({ type: "page", id: p.id }); } },
            h("span", { className: "dw-caret", onClick: function (e) {
              if (!kids.length) return;
              e.stopPropagation(); var o = Object.assign(Object.create(null), open); o[p.id] = !isOpen; setOpen(o);
            } }, kids.length ? (isOpen ? "▾" : "▸") : ""),
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.title || p.id)),
          isOpen ? kids.map(function (c) { return renderNode(c, depth + 1, nextSeen); }) : null);
      };
      var runGenerate = function () {
        var cmd = genCommand(root);
        startGenerateSession(root, (info && info.workspaceId) || project.workspaceId || null).then(function (started) {
          // 无法预填输入框：开会话后把命令放进剪贴板并提示粘贴
          copy(cmd, started ? t("gen.started") : t("gen.copied"));
        });
      };
      // 主区
      var pathParts = splitPath(root);
      var mainContent;
      // 概览（hero）自带头部：这时语言控件在 hero 里；其他视图（加载/错误/页面/卡片/未翻译）
      // 仍需要语言控件，所以它留在面包屑行 —— 任何时刻只出现一个语言控件。
      var showHero = data.phase === "ready" && !data.missing && !sel;
      if (data.phase === "loading") mainContent = h("div", { className: "dw-muted" }, t("loading"));
      else if (data.phase === "error") mainContent = h("div", null, t("error"), data.error, " ", h("button", { className: "dw-btn", onClick: load }, t("retry")));
      // 未翻译（宿主 404 translation-missing）优先于概览/选中项：此时没有任何该语言的内容可显示
      else if (data.missing) mainContent = h(UntranslatedPanel, {
        t: t, lang: lang, gate: gate, job: job, busy: jobPhase === "running",
        catalogPhase: props.catalog && props.catalog.phase, hasModel: !!props.model,
        onTranslate: function (tag) { startJob("translate", tag); }, onCancel: cancelJob });
      else if (!sel) {
        var short = info && info.sourceCommit ? info.sourceCommit.slice(0, 7) : "—";
        var generated = !!(info && info.generated);
        var pillCls = !generated ? "idle" : info.updateAvailable ? "warn" : "ok";
        var pillText = !generated ? t("badge.missing") : info.updateAvailable ? t("badge.update") : t("badge.generated");
        mainContent = h("div", { className: "dw-doc" },
          // 头部：标题 + 路径在左；状态药丸、唯一的语言控件、「更多操作」在右。
          // 旧的 h1 + 路径 + 横幅 + 按钮行都收进这里，因此不再有两个语言控件、三个“更新”入口。
          h("div", { className: "dw-hero" },
            h("div", { className: "dw-hero-main" },
              h("h1", null, info ? info.title : project.title),
              h("div", { className: "dw-hero-path dw-mono", title: root },
                pathParts.head ? h("span", { className: "dw-path-head" }, pathParts.head) : null,
                h("span", { className: "dw-path-tail" }, pathParts.tail))),
            h("div", { className: "dw-hero-aside" },
              h("span", { className: "dw-pill " + pillCls }, h("i", { "aria-hidden": "true" }), pillText),
              h(LanguageSelect, { t: t, lang: lang, tags: langView.tags, phase: langView.phase, onPick: pickLang }),
              h("div", { className: "dw-more" },
                h("button", { type: "button", className: "dw-btn", title: t("btn.more"),
                  onClick: function () { setMenu(!menu); } }, t("btn.more"), " ▾"),
                menu ? h("div", { className: "dw-menu", onMouseLeave: function () { setMenu(false); } },
                  // 「在会话中…」开的是会话，和后台作业是两件事：留在菜单里，不再和主按钮抢位置
                  gateDisabled ? null
                    : h("button", { onClick: function () { setMenu(false); runGenerate(); } },
                      info && info.generated ? t("btn.update") : t("btn.generate")),
                  h("button", { onClick: function () { setMenu(false); copy(genCommand(root), t("btn.copyCmd") + ": "); } }, t("btn.copyCmd")),
                  info && info.hasSite ? h("button", { onClick: function () {
                    setMenu(false);
                    var url = ROUTE + "/site?path=" + encodeURIComponent(info.dir);
                    var w = window.open(url, "dsh-wiki"); if (!w) window.location.assign(url);
                  } }, t("btn.site")) : null,
                  h("button", { onClick: function () { setMenu(false); copy(root); } }, t("btn.folder"))) : null))),
          // 仓库有新提交：一行 muted 警告文字，不再是带按钮的横幅（唯一的动作在作业控件里）
          info && info.updateAvailable
            ? h("div", { className: "dw-hero-sub" }, "⚠ ", t("ov.newCommits"), " (HEAD ", String(info.head || "").slice(0, 7), ")")
            : null,
          // 六个事实全部保留：语言、状态、页数、卡片数、更新时间、提交；时间用紧凑格式，完整时间在 title 里
          h("div", { className: "dw-stats" },
            h("div", { className: "dw-stat" }, h("span", null, t("ov.language")), h("b", null, (info && info.language) || "—")),
            h("div", { className: "dw-stat" }, h("span", null, t("ov.status")), h("b", null, pillText)),
            h("div", { className: "dw-stat" }, h("span", null, t("ov.pages")), h("b", null, info ? info.pageCount : 0)),
            h("div", { className: "dw-stat" }, h("span", null, t("ov.cards")), h("b", null, info ? info.cardCount : 0)),
            h("div", { className: "dw-stat" }, h("span", null, t("ov.updatedAt")),
              h("b", { title: fmtDate(info && info.updatedAt) }, fmtDateShort(info && info.updatedAt))),
            h("div", { className: "dw-stat" }, h("span", null, t("ov.commit")), h("b", { className: "dw-mono" }, short))),
          h(JobControls, {
            t: t, root: root, generated: generated,
            catalog: props.catalog, model: props.model, onModel: props.onModel,
            job: job, gate: gate, busy: jobPhase === "running",
            onStart: startJob, onCancel: cancelJob, onOpenSession: openJobSession,
            onCopy: function (sessionId) { copy(sessionId, t("job.session") + ": "); },
            // 闸门关闭时的前台入口：只复制命令，绝不开会话（不调用 startGenerateSession）
            onCopyCommand: function () { copy(genCommand(root), t("btn.copyCmd") + ": "); },
          }),
          // 「在会话中生成」的说明只在那个菜单项真实存在时显示（闸门关闭时它已被复制命令取代）
          gateDisabled ? null : h("p", { className: "dw-hint" }, t("gen.hint")),
          // 模型锁定说明只在后台作业真实可用时成立（闸门关闭时它描述的是不存在的动作）
          gateDisabled ? null : h("p", { className: "dw-hint" }, t("job.modelLocked")),
          !wiki ? h("p", { className: "dw-muted" }, t("noWiki")) : null);
      } else if (sel.type === "page") {
        var p = pageById[sel.id];
        var siteLink = p && info && info.hasSite ? (location.origin + ROUTE + "/site?path=" + encodeURIComponent(info.dir) + "#" + p.id) : null;
        // env 副本带上页标题：缩放工具栏用它显示「<页面> · 图表 N」
        var pageEnv = Object.assign({}, env, { diagramTitle: (p && (p.title || p.id)) || "" });
        mainContent = p ? h("div", { className: "dw-doc" },
          h("h1", null, p.title || p.id),
          h("div", { className: "dw-pagemeta" },
            info && info.sourceCommit ? h("span", { className: "dw-mono" }, "⎇ " + info.sourceCommit.slice(0, 7)) : null,
            info && info.updatedAt ? h("span", null, t("updated") + " " + fmtDate(info.updatedAt)) : null,
            h("span", { style: { flex: 1 } }),
            h("button", { className: "dw-btn", onClick: function () { setShowSrc(!showSrc); } }, showSrc ? t("btn.rendered") : t("btn.source")),
            siteLink ? h("button", { className: "dw-btn", onClick: function () { copy(siteLink); } }, t("btn.copyLink")) : null),
          p.description ? h("p", { className: "dw-muted" }, p.description) : null,
          p.filePaths.length ? h("div", { className: "dw-tags" }, p.filePaths.map(function (f) {
            return h("code", { key: f, className: "dw-cite", onClick: function () { env.cite(f); } }, f);
          })) : null,
          showSrc ? h("pre", null, h("code", null, p.markdown)) : renderMarkdown(p.markdown, pageEnv)) : h("div", { className: "dw-muted" }, t("noPage"));
      } else if (sel.type === "cards") {
        mainContent = h("div", { className: "dw-doc", style: { maxWidth: "none" } },
          h("h1", null, t("cards.entry")),
          h("div", { className: "dw-grid" }, cards.map(function (c) {
            return h("button", { key: c.id, className: "dw-card", onClick: function () { setSel({ type: "card", id: c.id }); } },
              h("span", { className: "dw-badge" }, c.kind || "concept"),
              h("div", { className: "dw-card-name" }, c.title || c.id),
              h("div", { className: "dw-muted" }, c.summary),
              h("div", { className: "dw-tags" }, c.tags.map(function (x) { return h("span", { key: x, className: "dw-tag" }, "#" + x); })));
          })));
      } else {
        var c = cardById[sel.id];
        var refBy = c ? pages.filter(function (p) {
          return c.pageIds.indexOf(p.id) >= 0 || p.markdown.indexOf("](#card-" + c.id + ")") >= 0;
        }) : [];
        mainContent = c ? h("div", { className: "dw-doc" },
          h("div", { className: "dw-muted" }, h("a", { className: "dw-link", onClick: function () { setSel({ type: "cards" }); } }, t("cards.entry")), " · ", c.kind),
          h("h1", null, c.title || c.id),
          h("p", { style: { fontSize: 15 } }, c.summary),
          h("div", { className: "dw-tags" }, c.tags.map(function (x) { return h("span", { key: x, className: "dw-tag" }, "#" + x); })),
          h("h3", null, t("keyFiles")),
          h("ul", null, c.keyFiles.map(function (f) { return h("li", { key: f }, h("code", { className: "dw-cite", onClick: function () { env.cite(f); } }, f)); })),
          c.related.length ? h("h3", null, t("related")) : null,
          c.related.length ? h("ul", null, c.related.filter(function (r) { return cardById[r]; }).map(function (r) {
            return h("li", { key: r }, h("a", { className: "dw-link", onClick: function () { setSel({ type: "card", id: r }); } }, cardById[r].title || r));
          })) : null,
          refBy.length ? h("h3", null, t("refBy")) : null,
          refBy.length ? h("ul", null, refBy.map(function (p) {
            return h("li", { key: p.id }, h("a", { className: "dw-link", onClick: function () { setSel({ type: "page", id: p.id }); } }, p.title || p.id));
          })) : null) : h("div", { className: "dw-muted" }, t("noPage"));
      }
      return h("div", { className: "dw-detail" },
        h("div", { className: "dw-crumb" },
          h("a", { onClick: props.back }, t("crumb.root")), h("span", { className: "dw-muted" }, "/"),
          h("a", { onClick: function () { setSel(null); } }, project.title),
          // 概览里语言控件已经在 hero 里；页面/卡片/未翻译视图在这里提供同一个控件
          showHero ? null
            : h(LanguageSelect, { t: t, lang: lang, tags: langView.tags, phase: langView.phase, onPick: pickLang })),
        h("div", { className: "dw-split" },
          h("div", { className: "dw-side" },
            h("input", { className: "dw-input", placeholder: t("pages.search"), value: q, onChange: function (e) { setQ(e.target.value); } }),
            h("div", { className: "dw-tree" },
              h("button", { className: "dw-node" + (!sel ? " on" : ""), onClick: function () { setSel(null); } },
                h("span", { className: "dw-caret" }), "ⓘ ", t("overview")),
              cards.length ? h("button", { className: "dw-node" + (sel && (sel.type === "cards" || sel.type === "card") ? " on" : ""),
                onClick: function () { setSel({ type: "cards" }); } }, h("span", { className: "dw-caret" }), "🗂 ", t("cards.entry") + " (" + cards.length + ")") : null,
              roots.map(function (p) { return renderNode(p, 0, Object.create(null)); }))),
          h("div", { className: "dw-main", ref: mainRef }, mainContent,
            toast ? h("div", { className: "dw-toast" }, toast) : null)));
    }

    function WikiApp(props) {
      var t = activeT;
      var pS = React.useState(null), project = pS[0], setProject = pS[1];
      // 模型目录与选择放在面板根：主屏与项目概览共用同一个选择
      var catalog = useCatalog();
      var mS = React.useState(null), model = mS[0], setModel = mS[1];
      var effectiveModel = model || (catalog.def && catalog.def.provider && catalog.def.model ? catalog.def : null);
      // 缩放浮层状态放在面板根：浮层作为 .dw-root 的子元素渲染（position:absolute;inset:0），
      // 只覆盖 Wiki 面板，不会盖住桌面标题栏/窗口按钮。
      var zS = React.useState(null), zoom = zS[0], setZoom = zS[1];
      var openZoom = React.useCallback(function (next) { setZoom(next); }, []);
      var closeZoom = React.useCallback(function () { setZoom(null); }, []);
      // 样式作为组件内 <style> 渲染：卸载即移除，不往 document.head 写东西
      return h("div", { className: "dw-root" }, h("style", null, CSS),
        h(ZoomCtx.Provider, { value: openZoom },
          project
            ? h(Detail, { key: project.root, t: t, project: project, back: function () { setProject(null); },
                catalog: catalog, model: effectiveModel, onModel: setModel })
            : h(Home, { t: t, open: setProject, catalog: catalog, model: effectiveModel, onModel: setModel })),
        zoom ? h(MermaidZoom, { key: "zoom", t: t, src: zoom.src, dark: zoom.dark, size: zoom.size,
          label: zoom.label, index: zoom.index, trigger: zoom.trigger, onClose: closeZoom }) : null);
    }

    function WikiPanelIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 16;
      return h("span", { style: { fontSize: size, lineHeight: 1, display: "inline-block" }, "aria-hidden": "true" }, "📖");
    }

    var BUTTON_STYLE = {
      display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", margin: "0 2px", fontSize: 12,
      lineHeight: "18px", borderRadius: 7, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
      color: "inherit", cursor: "pointer", userSelect: "none",
    };
    // 会话头部按钮：选中插件自己的 main 面板（宿主原生面板切换），绝不导航、绝不 window.open。
    // 唯一受支持的接口是 layout.selectPanel(panelId)；它对未注册的面板会抛错，因此这里
    // 捕获后返回 false，并把可读错误交给按钮的本地提示（toast），不再派发任何自造事件
    // （宿主没有该事件约定）。打开独立站点只允许走「更多操作」里的显式菜单项
    // （见 Detail 的 btn.site），避免一个按钮同时承担两种语义。
    var NAV_ERROR_MS = 5000;
    var HEADER_TOAST_STYLE = {
      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30, minWidth: 220, maxWidth: 320,
      padding: "8px 10px", borderRadius: 8, fontSize: 12, lineHeight: 1.45, whiteSpace: "normal",
      background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
      border: "0.5px solid var(--dsw-alias-border-l2)", boxShadow: "0 6px 20px rgba(0,0,0,.2)",
    };
    function selectWikiPanel(onError) {
      var fail = function () {
        if (typeof onError === "function") {
          try { onError(activeT("nav.unavailable")); } catch (e) { /* caller owns its UI */ }
        }
        return false;
      };
      var layout = svc("layout");
      if (!layout || typeof layout.selectPanel !== "function") return fail();
      try { return layout.selectPanel(PANEL_ID) === false ? fail() : true; } catch (e) { return fail(); }
    }
    function WikiButton() {
      var toastS = React.useState(""), toast = toastS[0], setToast = toastS[1];
      var timerRef = React.useRef(null);
      React.useEffect(function () {
        return function () { if (timerRef.current) clearTimeout(timerRef.current); };
      }, []);
      var onClick = function () {
        selectWikiPanel(function (msg) {
          setToast(msg);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(function () { setToast(""); }, NAV_ERROR_MS);
        });
      };
      return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", {
          type: "button", style: BUTTON_STYLE, title: activeT("sidebar.label"),
          "aria-label": activeT("sidebar.label"), onClick: onClick,
        }, "📖", h("span", null, "Wiki")),
        toast ? h("span", { className: "dw-header-toast", role: "alert", style: HEADER_TOAST_STYLE }, toast) : null);
    }

    var inject = ["slots", "locale"];
    function apply(ctx) {
      clientCtx = ctx;
      hostLocale = function () {
        var l = ctx.locale;
        if (!l) return "";
        if (typeof l.getSnapshot === "function") { var s = l.getSnapshot(); return (s && (s.active || s.locale)) || ""; }
        return l.active || l.current || "";
      };
      if (typeof ctx.effect === "function") ctx.effect(function () { return function () { if (clientCtx === ctx) clientCtx = null; }; }, "dsh-wiki: ctx ref");
      if (typeof ctx.effect === "function" && ctx.locale && ctx.locale.register) {
        ctx.effect(function () { return ctx.locale.register(NS, DICT); }, "dsh-wiki: dictionaries");
      }
      var localizedLabel = function () {
        return activeT("sidebar.label");
      };
      ctx.slots.inject("main", function () {
        return ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, function (ownerProps) {
          return h(WikiApp, ownerProps);
        });
      });
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: localizedLabel, locale: NS }, WikiPanelIcon);
      });
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({ name: "conversation.session.header.actions", id: "dsh-wiki-open", order: 90 }, WikiButton);
      });
    }

    module.exports = { inject: inject, apply: apply, _test: {
      renderMarkdown: renderMarkdown, Detail: Detail, startGenerateSession: startGenerateSession,
      selectWikiPanel: selectWikiPanel, WikiButton: WikiButton, MermaidZoom: MermaidZoom, Mermaid: Mermaid,
      DICT: DICT, CSS: CSS, MAX_BLOCKQUOTE_DEPTH: MAX_BLOCKQUOTE_DEPTH,
      // spec 007 第一切片：模型选择 + 面板内后台作业控件
      Home: Home, WikiApp: WikiApp, JobControls: JobControls, ModelSelect: ModelSelect,
      useCatalog: useCatalog, useJobView: useJobView, jobStageIndex: jobStageIndex,
      jobGateFrom: jobGateFrom, jobGateClosed: jobGateClosed, jobGateText: jobGateText,
      postJson: postJson, JOB_STAGES: JOB_STAGES, JOB_POLL_MS: JOB_POLL_MS, JOB_IDLE_POLL_MS: JOB_IDLE_POLL_MS,
      // T017b：语言控件 + 未翻译状态
      LanguageSelect: LanguageSelect, UntranslatedPanel: UntranslatedPanel, useLanguages: useLanguages,
      langLabel: langLabel, readStoredLang: readStoredLang, storeLang: storeLang,
      LANG_NAMES: LANG_NAMES, LANG_STORE_PREFIX: LANG_STORE_PREFIX,
    } };
    return module.exports;
  },
});
