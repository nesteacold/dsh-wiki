// dsh-wiki 客户端半区：左侧栏「Wiki」面板（列表 + 内嵌阅读）+ 会话头部"Wiki"按钮（独立窗口）。
// 装载方式与 @jieai/dsh-plugin-vet 一致：window.__ModuleLoader__.load + factory(require)。
// 侧栏入口 = sidebar.panellist（全局面板行）+ main（keyed 主面板，key 与 panellist id 对应）。
window.__ModuleLoader__.load({
  id: "@acfufu/dsh-wiki",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-wiki";
    var PANEL_ID = "dsh-wiki";
    var PANEL_ORDER = 20;
    var ROUTE = "/dsh-wiki";

    // ---------- 双语字典（宿主 locale face；t 由 slot 渲染器按 locale: NS 注入） ----------
    var DICT = {
      zh: {
        "sidebar.label": "Wiki",
        "panel.title": "Repo Wiki",
        "panel.refresh": "刷新",
        "panel.loading": "正在读取 wiki 列表…",
        "panel.empty": "还没有任何 wiki。",
        "panel.emptyHint": "在仓库会话里运行 /wiki generate，或对 agent 说「给这个仓库生成 wiki」。",
        "panel.openIndex": "打开索引页",
        "panel.back": "返回列表",
        "panel.newWindow": "新窗口",
        "panel.error": "读取 wiki 列表失败。",
        "panel.retry": "重试",
      },
      en: {
        "sidebar.label": "Wiki",
        "panel.title": "Repo Wiki",
        "panel.refresh": "Refresh",
        "panel.loading": "Loading wiki list…",
        "panel.empty": "No wikis yet.",
        "panel.emptyHint": "Run /wiki generate in a repo session, or ask the agent to generate a wiki.",
        "panel.openIndex": "Open index page",
        "panel.back": "Back to list",
        "panel.newWindow": "New window",
        "panel.error": "Failed to load the wiki list.",
        "panel.retry": "Retry",
      },
    };
    var fallbackT = function (key) {
      return (DICT.zh[key] ?? DICT.en[key] ?? key);
    };

    // ---------- 面板样式：走宿主主题 token，深浅色自动跟随 ----------
    var STYLE_ID = "dsh-wiki-panel-style";
    var PANEL_CSS = [
      ".dshwiki-panel{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;",
      "background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);",
      "font-size:13px;line-height:1.5}",
      ".dshwiki-head{display:flex;align-items:center;justify-content:space-between;gap:8px;",
      "padding:14px 16px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l2);flex:none}",
      ".dshwiki-title{font-size:14px;font-weight:600}",
      ".dshwiki-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:7px;",
      "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);",
      "font-size:12px;line-height:18px;cursor:pointer;user-select:none;flex:none}",
      ".dshwiki-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshwiki-list{flex:1;min-height:0;overflow-y:auto;padding:8px 10px}",
      ".dshwiki-item{display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;",
      "border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);",
      "color:inherit;cursor:pointer}",
      ".dshwiki-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshwiki-item-title{font-size:13px;font-weight:500;color:var(--dsw-alias-link)}",
      ".dshwiki-item-path{display:block;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);",
      "word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".dshwiki-note{padding:16px;color:var(--dsw-alias-label-secondary)}",
      ".dshwiki-note code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".dshwiki-foot{flex:none;padding:10px 16px;border-top:0.5px solid var(--dsw-alias-border-l2);",
      "font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".dshwiki-readerbar{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none;",
      "border-bottom:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".dshwiki-readertitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      "font-size:13px;font-weight:500}",
      ".dshwiki-frame{flex:1;min-height:0;width:100%;border:0;background:var(--dsw-alias-bg-base)}",
    ].join("");
    var ensureStyle = function () {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      (document.head ?? document.documentElement)?.appendChild?.(style);
    };

    // ---------- 左侧栏面板行图标：渲染器给 { size, active } ----------
    function WikiPanelIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 16;
      return h(
        "span",
        { style: { fontSize: size, lineHeight: 1, display: "inline-block" }, "aria-hidden": "true" },
        "📖"
      );
    }

    // ---------- 主面板：列表 ⇄ 内嵌阅读 ----------
    function WikiPanel(props) {
      var t = typeof props.t === "function" ? props.t : fallbackT;
      var [state, setState] = React.useState({ phase: "loading", wikis: [], message: null });
      var [selected, setSelected] = React.useState(null); // { title, url }

      var refresh = React.useCallback(function () {
        setState(function (s) { return { ...s, phase: "loading" }; });
        fetch(`${ROUTE}/api/status`, { headers: { accept: "application/json" } })
          .then(function (res) {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then(function (body) {
            setState({ phase: "ready", wikis: Array.isArray(body?.wikis) ? body.wikis : [], message: null });
          })
          .catch(function (err) {
            setState(function (s) { return { phase: "error", wikis: s.wikis, message: String(err?.message ?? err) }; });
          });
      }, []);
      React.useEffect(function () { refresh(); }, [refresh]);

      if (selected) {
        return h("div", { className: "dshwiki-panel" },
          h("div", { className: "dshwiki-readerbar" },
            h("button", { className: "dshwiki-btn", onClick: function () { setSelected(null); } }, "← ", t("panel.back")),
            h("span", { className: "dshwiki-readertitle" }, selected.title),
            h("button", {
              className: "dshwiki-btn",
              title: t("panel.newWindow"),
              onClick: function () {
                var win = window.open(selected.url, "dsh-wiki");
                if (!win) window.location.assign(selected.url);
              },
            }, "↗ ", t("panel.newWindow"))
          ),
          h("iframe", {
            className: "dshwiki-frame",
            key: selected.url,
            src: selected.url,
            title: selected.title,
          })
        );
      }

      var body;
      if (state.phase === "loading") {
        body = h("div", { className: "dshwiki-note" }, t("panel.loading"));
      } else if (state.phase === "error") {
        body = h("div", { className: "dshwiki-note" },
          t("panel.error"),
          state.message ? h("div", { style: { marginTop: 4, fontSize: 11 } }, state.message) : null,
          h("div", { style: { marginTop: 8 } },
            h("button", { className: "dshwiki-btn", onClick: refresh }, t("panel.retry")))
        );
      } else if (!state.wikis.length) {
        body = h("div", { className: "dshwiki-note" },
          t("panel.empty"),
          h("div", { style: { marginTop: 4 } }, t("panel.emptyHint")),
          h("div", { style: { marginTop: 8 } },
            h("button", { className: "dshwiki-btn", onClick: refresh }, t("panel.retry")))
        );
      } else {
        body = h("div", { className: "dshwiki-list" },
          h("button", {
            className: "dshwiki-item",
            onClick: function () { setSelected({ title: t("panel.openIndex"), url: `${ROUTE}/` }); },
          },
            h("span", { className: "dshwiki-item-title" }, "📋 ", t("panel.openIndex"))
          ),
          state.wikis.map(function (w) {
            return h("button", {
              key: w.root,
              className: "dshwiki-item",
              onClick: function () { setSelected({ title: w.title, url: w.url }); },
            },
              h("span", { className: "dshwiki-item-title" }, "📖 ", w.title),
              h("span", { className: "dshwiki-item-path" }, w.root)
            );
          })
        );
      }

      return h("div", { className: "dshwiki-panel" },
        h("div", { className: "dshwiki-head" },
          h("span", { className: "dshwiki-title" }, "📖 ", t("panel.title")),
          h("button", { className: "dshwiki-btn", onClick: refresh }, "⟳ ", t("panel.refresh"))
        ),
        body,
        h("div", { className: "dshwiki-foot" }, "/wiki generate · /wiki list")
      );
    }

    // ---------- 会话头部按钮：独立窗口打开索引（保留原入口） ----------
    var BUTTON_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "3px 9px",
      margin: "0 2px",
      fontSize: 12,
      lineHeight: "18px",
      borderRadius: 7,
      border: "1px solid rgba(127,127,127,0.28)",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      userSelect: "none",
    };

    function WikiButton() {
      var [busy, setBusy] = React.useState(false);
      var openIndex = function () {
        if (busy) return;
        setBusy(true);
        try {
          var win = window.open(`${ROUTE}/`, "dsh-wiki");
          if (!win) window.location.assign(`${ROUTE}/`);
        } finally {
          setBusy(false);
        }
      };
      return h(
        "button",
        {
          style: BUTTON_STYLE,
          title: "打开本地 Repo Wiki 索引（独立窗口）",
          onClick: openIndex,
          onMouseOver: function (e) { e.currentTarget.style.borderColor = "rgba(127,127,127,0.55)"; },
          onMouseOut: function (e) { e.currentTarget.style.borderColor = "rgba(127,127,127,0.28)"; },
        },
        "📖",
        h("span", null, busy ? "…" : "Wiki")
      );
    }

    var inject = ["slots", "locale"];
    function apply(ctx) {
      // 双语字典：panel/侧栏 label 的 t 与 label thunk 都走这里
      if (typeof ctx.effect === "function" && ctx.locale?.register) {
        ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-wiki: dictionaries");
      }
      var localizedLabel = function () {
        try {
          return ctx.locale?.bind ? ctx.locale.bind(NS)("sidebar.label") : fallbackT("sidebar.label");
        } catch {
          return fallbackT("sidebar.label");
        }
      };

      // 左侧栏入口：全局面板行（图标行）+ 对应 main 主面板，二者 key/id 一致
      ctx.slots.inject("main", () => ctx.slots.register(
        { name: "main", key: PANEL_ID, locale: NS },
        function (ownerProps) { ensureStyle(); return h(WikiPanel, ownerProps); }
      ));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
        { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: localizedLabel, locale: NS },
        WikiPanelIcon
      ));

      // 会话头部按钮（独立窗口）
      ctx.slots.inject(
        "conversation.session.header.actions",
        function () {
          return ctx.slots.register(
            { name: "conversation.session.header.actions", id: "dsh-wiki-open", order: 90 },
            WikiButton
          );
        }
      );
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  },
});
