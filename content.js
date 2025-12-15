// content.js (MV3) - X専用
// White main + Pink accent UI theme (Step5)
// Uses Service Worker protocol: FORONE_* (Usage A)

(() => {
  "use strict";

  const TAG = "[Forone]";

  const FALLBACK_CFG = {
    enabled: true,
    analysisMode: "local",
    riskThreshold: 75,
    debug: true,
    ui: {
      boot: {
        enabled: true,
        minShowMs: 2400,      // Step5: 少し長め
        maxShowMs: 7000,
        lettersDelayMs: 80
      },
      highlight: {
        veil: true,
        cooldownMs: 6 * 60 * 1000, // “同一投稿の連打”を抑えるが、時間が経てば再介入可能
        centerScroll: true
      }
    }
  };

  // ---------------- utils ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();

  function clamp(n, a, b) {
    n = Number(n);
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }

  function log(...args) {
    if (!state.cfg?.debug) return;
    // eslint-disable-next-line no-console
    console.log(TAG, ...args);
  }

  function normText(s) {
    return String(s || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(res || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  function mergeDeep(a, b) {
    if (!b || typeof b !== "object") return a;
    const out = a;
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = mergeDeep(out[k] && typeof out[k] === "object" ? out[k] : {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function isElementVisible(el, minRatio = 0.35) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;

    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;

    const x1 = Math.max(0, r.left);
    const y1 = Math.max(0, r.top);
    const x2 = Math.min(vw, r.right);
    const y2 = Math.min(vh, r.bottom);

    const interW = Math.max(0, x2 - x1);
    const interH = Math.max(0, y2 - y1);
    const interA = interW * interH;
    const area = Math.max(1, r.width * r.height);
    return interA / area >= minRatio;
  }

  async function scrollToCenter(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      await sleep(260);

      // まだズレる場合の補正
      const r = el.getBoundingClientRect();
      const targetTop = (window.innerHeight / 2) - (r.height / 2);
      const delta = r.top - targetTop;
      if (Math.abs(delta) > 18) {
        window.scrollBy({ top: delta, behavior: "smooth" });
        await sleep(260);
      }
    } catch (_) {
      const r = el.getBoundingClientRect();
      const targetTop = (window.innerHeight / 2) - (r.height / 2);
      const delta = r.top - targetTop;
      window.scrollBy({ top: delta, behavior: "smooth" });
      await sleep(260);
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function categoryLabel(cat) {
    switch (cat) {
      case "aggression_violence": return "攻撃/暴力";
      case "prejudice_identityhate": return "偏見/決めつけ";
      case "extreme_shock": return "煽り/ショック";
      case "misinfo_speculation": return "根拠薄/憶測";
      case "scam_solicitation": return "勧誘/詐欺っぽさ";
      case "polarization_bubble": return "分断/陣営化";
      default: return "その他";
    }
  }

  // ---------------- tweet extraction ----------------
  function pickStatus(article) {
    const a = article.querySelector('a[href*="/status/"]');
    const href = a?.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    if (!m) return null;
    return { tweetId: m[1], url: new URL(href, location.origin).toString() };
  }

  function extractAuthor(article) {
    const a =
      article.querySelector('div[data-testid="User-Name"] a[href^="/"][role="link"]') ||
      article.querySelector('a[href^="/"][role="link"]');
    const href = a?.getAttribute("href") || "";
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})/);
    if (m && m[1] && !["home", "explore", "i", "settings"].includes(m[1])) return "@" + m[1];
    const t = (a?.innerText || "").trim();
    const at = t.match(/@([A-Za-z0-9_]{1,15})/);
    if (at) return "@" + at[1];
    return "";
  }

  function extractText(article) {
    const nodes = [...article.querySelectorAll('div[data-testid="tweetText"]')];
    if (!nodes.length) return "";
    const parts = nodes.map(n => normText(n.innerText)).filter(Boolean);

    const uniq = [];
    const seen = new Set();
    for (const p of parts) {
      if (seen.has(p)) continue;
      seen.add(p);
      uniq.push(p);
    }
    return uniq.join("\n").trim();
  }

  function buildPost(article) {
    const s = pickStatus(article);
    if (!s?.tweetId) return null;
    return {
      source: "x",
      tweetId: s.tweetId,
      url: s.url,
      author: extractAuthor(article),
      text: extractText(article),
      capturedAt: new Date().toISOString()
    };
  }

  // ---------------- UI (White + Pink) ----------------
  function ensureStyle() {
    if (document.getElementById("forone-style")) return;

    const style = document.createElement("style");
    style.id = "forone-style";

    style.textContent = `
      :root{
        --forone-white: rgba(255,255,255,0.96);
        --forone-ink: rgba(18,18,22,0.92);
        --forone-muted: rgba(18,18,22,0.62);
        --forone-border: rgba(18,18,22,0.10);
        --forone-shadow: 0 18px 60px rgba(0,0,0,0.18);
        --forone-pink: rgba(255, 110, 160, 0.95);
        --forone-pink2: rgba(255, 160, 200, 0.85);
        --forone-veil: rgba(255, 110, 160, 0.10);
        --forone-badge-bg: rgba(255,255,255,0.92);
      }

      /* Boot overlay */
      #forone-boot{
        position: fixed; inset: 0;
        z-index: 2147483646;
        display:flex; align-items:center; justify-content:center;
        background: rgba(255,255,255,0.68);
        backdrop-filter: blur(10px);
      }
      #forone-boot .boot-inner{
        display:flex; flex-direction:column; align-items:center;
        gap: 14px;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;
      }
      #forone-boot .brand{
        display:flex; gap: 2px;
        font-weight: 850;
        letter-spacing: 0.10em;
        font-size: 28px;
        color: var(--forone-ink);
      }
      #forone-boot .brand span{
        opacity:0;
        transform: translateY(7px);
        filter: blur(8px);
        animation: forone-letter 560ms cubic-bezier(.2,.9,.2,1) forwards;
      }
      @keyframes forone-letter{
        0%{ opacity:0; transform: translateY(7px); filter: blur(8px); }
        70%{ opacity:1; filter: blur(0); }
        100%{ opacity:1; transform: translateY(0); filter: blur(0); }
      }
      #forone-boot .line{
        width: 260px; height: 2px;
        background: linear-gradient(90deg,
          rgba(255,110,160,0),
          rgba(255,110,160,0.75),
          rgba(255,110,160,0)
        );
        filter: drop-shadow(0 0 12px rgba(255,110,160,0.22));
        animation: forone-line 1.25s ease-in-out infinite;
      }
      @keyframes forone-line{
        0%{ opacity:.35; transform: scaleX(.86); }
        50%{ opacity:.95; transform: scaleX(1.0); }
        100%{ opacity:.35; transform: scaleX(.86); }
      }
      #forone-boot .sub{
        font-size: 12px;
        color: var(--forone-muted);
        letter-spacing: 0.02em;
      }

      /* Veil */
      #forone-veil{
        position: fixed; inset: 0;
        z-index: 2147483644;
        background: var(--forone-veil);
        backdrop-filter: blur(1px);
      }

      /* Highlighted tweet */
      .forone-highlight{
        outline: 3px solid var(--forone-pink) !important;
        outline-offset: 4px !important;
        border-radius: 16px !important;
        position: relative !important;
      }

      /* Badge */
      .forone-badge{
        position:absolute;
        right: 10px; top: 10px;
        z-index: 2;
        display:inline-flex; align-items:center; gap: 8px;
        padding: 7px 10px;
        border-radius: 999px;
        background: var(--forone-badge-bg);
        border: 1px solid rgba(255,110,160,0.28);
        color: var(--forone-ink);
        font-size: 12px;
        line-height: 1;
        box-shadow: 0 12px 30px rgba(0,0,0,0.14);
        backdrop-filter: blur(10px);
      }
      .forone-badge b{ font-weight: 850; }
      .forone-badge .dot{
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--forone-pink);
        box-shadow: 0 0 14px rgba(255,110,160,0.25);
      }

      /* Card */
      #forone-card{
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483645;
        width: min(440px, calc(100vw - 24px));
        border-radius: 20px;
        background: var(--forone-white);
        border: 1px solid rgba(255,110,160,0.22);
        box-shadow: var(--forone-shadow);
        backdrop-filter: blur(10px);
        padding: 14px 14px 12px;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;
        color: var(--forone-ink);
      }
      #forone-card .top{
        display:flex; align-items:center; justify-content:space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      #forone-card .title{
        display:flex; flex-direction:column;
        gap: 3px;
        min-width:0;
      }
      #forone-card .nameRow{
        display:flex; align-items:center; gap: 10px;
      }
      #forone-card .name{
        font-weight: 900;
        letter-spacing: 0.04em;
      }
      #forone-card .meta{
        font-size: 12px;
        color: var(--forone-muted);
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        max-width: 380px;
      }
      #forone-card .pill{
        display:inline-flex; align-items:center; gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,110,160,0.10);
        border: 1px solid rgba(255,110,160,0.20);
        font-size: 12px;
        font-weight: 800;
      }
      #forone-card .msg{
        font-size: 13px;
        line-height: 1.6;
        color: rgba(18,18,22,0.90);
        margin: 10px 0 12px;
        white-space: pre-wrap;
      }
      #forone-card .actions{
        display:flex; gap: 10px; justify-content:flex-end;
      }
      #forone-card button{
        appearance:none; border:0; cursor:pointer;
        border-radius: 999px;
        padding: 10px 12px;
        font-size: 12px;
        font-weight: 850;
        letter-spacing: 0.02em;
        transition: transform .08s ease, opacity .15s ease;
      }
      #forone-card button:active{ transform: scale(0.985); }

      #forone-card .btn-ghost{
        background: rgba(18,18,22,0.06);
        color: rgba(18,18,22,0.86);
      }
      #forone-card .btn-primary{
        background: var(--forone-pink);
        color: rgba(255,255,255,0.96);
        box-shadow: 0 12px 30px rgba(255,110,160,0.24);
      }
      #forone-card .hint{
        margin-top: 8px;
        font-size: 11px;
        color: var(--forone-muted);
      }

      /* keep X UI safe: do not block pointer on whole page except veil */
      #forone-veil{ pointer-events:none; }
      #forone-card{ pointer-events:auto; }

      @media (max-width: 520px){
        #forone-card{ right: 12px; bottom: 12px; }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function removeNode(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function showBootOverlay() {
    ensureStyle();
    removeNode("forone-boot");

    const boot = document.createElement("div");
    boot.id = "forone-boot";

    const inner = document.createElement("div");
    inner.className = "boot-inner";

    const brand = document.createElement("div");
    brand.className = "brand";

    const word = "follone";
    const delay = clamp(state.cfg?.ui?.boot?.lettersDelayMs ?? FALLBACK_CFG.ui.boot.lettersDelayMs, 40, 160);

    [...word].forEach((ch, i) => {
      const s = document.createElement("span");
      s.textContent = ch;
      s.style.animationDelay = `${i * delay}ms`;
      brand.appendChild(s);
    });

    const line = document.createElement("div");
    line.className = "line";

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = "ふぉろねが起動中…（焦らなくて大丈夫）";

    inner.appendChild(brand);
    inner.appendChild(line);
    inner.appendChild(sub);
    boot.appendChild(inner);

    document.documentElement.appendChild(boot);
  }

  function hideBootOverlay() {
    removeNode("forone-boot");
  }

  function applyBadge(article, analysis) {
    if (!article) return;
    const old = article.querySelector(".forone-badge");
    if (old) old.remove();

    const badge = document.createElement("div");
    badge.className = "forone-badge";
    badge.innerHTML = `
      <span class="dot"></span>
      <span><b>注意</b>: ${escapeHtml(categoryLabel(analysis.category))} / risk ${escapeHtml(String(analysis.risk ?? 0))}</span>
    `;
    article.appendChild(badge);
  }

  function showVeil(on) {
    if (!on) {
      removeNode("forone-veil");
      return;
    }
    ensureStyle();
    removeNode("forone-veil");
    const veil = document.createElement("div");
    veil.id = "forone-veil";
    document.documentElement.appendChild(veil);
  }

  function showCard(article, analysis) {
    ensureStyle();
    removeNode("forone-card");

    const risk = clamp(Number(analysis?.risk) || 0, 0, 100);
    const catLabel = categoryLabel(analysis?.category || "other");
    const line = analysis?.forone?.line
      ? String(analysis.forone.line)
      : "刺激が強いかも…。今はそっと離れても大丈夫だよ。";

    const card = document.createElement("div");
    card.id = "forone-card";
    card.innerHTML = `
      <div class="top">
        <div class="title">
          <div class="nameRow">
            <div class="name">ふぉろね</div>
            <div class="pill">${escapeHtml(catLabel)} / ${escapeHtml(String(risk))}</div>
          </div>
          <div class="meta">必要なときだけ、そっと知らせるよ。</div>
        </div>
      </div>

      <div class="msg">${escapeHtml(line)}</div>

      <div class="actions">
        <button class="btn-ghost" data-act="close">閉じる</button>
        <button class="btn-ghost" data-act="next">別の投稿へ</button>
        <button class="btn-primary" data-act="keep">読む</button>
      </div>

      <div class="hint">これは「禁止」じゃなくて、今どうするかを君が選べるようにする表示です。</div>
    `;

    card.addEventListener("click", async (e) => {
      const btn = e.target?.closest("button");
      const act = btn?.getAttribute("data-act");
      if (!act) return;

      if (act === "close" || act === "keep") {
        removeNode("forone-card");
        showVeil(false);
        clearActiveHighlight();
        return;
      }

      if (act === "next") {
        removeNode("forone-card");
        showVeil(false);
        await scrollToNextTweet(article);
        clearActiveHighlight();
      }
    });

    document.documentElement.appendChild(card);
  }

  async function scrollToNextTweet(currentArticle) {
    try {
      const all = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const idx = all.indexOf(currentArticle);
      const next = idx >= 0 ? all[idx + 1] : null;
      if (next) await scrollToCenter(next);
      else window.scrollBy({ top: Math.round(window.innerHeight * 0.75), behavior: "smooth" });
    } catch (_) {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.75), behavior: "smooth" });
    }
  }

  // ---------------- state ----------------
  const state = {
    cfg: structuredClone(FALLBACK_CFG),

    seenIds: new Set(),
    idToArticle: new Map(),
    observed: new WeakSet(),
    visibleIds: new Set(),

    highlightActive: false,
    highlightQueue: [],
    lastHighlightAt: new Map(), // tweetId -> ts

    scanTimer: null,
    pollTimer: null,
    bootDone: false,

    _io: null,
    _mo: null
  };

  // ---------------- logic ----------------
  function canHighlight(tweetId) {
    const cd = clamp(state.cfg?.ui?.highlight?.cooldownMs ?? FALLBACK_CFG.ui.highlight.cooldownMs, 0, 60 * 60 * 1000);
    const last = state.lastHighlightAt.get(tweetId) || 0;
    return now() - last >= cd;
  }

  async function triggerHighlightById(tweetId) {
    if (!tweetId) return;

    // 介入中はキューへ
    if (state.highlightActive) {
      if (!state.highlightQueue.includes(tweetId)) state.highlightQueue.push(tweetId);
      return;
    }

    const article = state.idToArticle.get(tweetId);
    if (!article) return;

    // “画面に入ってから”のみ
    if (!isElementVisible(article, 0.15)) return;

    // 分析取得
    const ares = await sendMessage({ type: "FORONE_GET_ANALYSIS", ids: [tweetId] });
    const analysis = ares?.results?.[tweetId];
    if (!analysis) return;

    const risk = clamp(Number(analysis.risk) || 0, 0, 100);
    const threshold = clamp(Number(state.cfg?.riskThreshold) || 75, 0, 100);

    if (risk < threshold) return;
    if (!canHighlight(tweetId)) return;

    state.highlightActive = true;
    state.lastHighlightAt.set(tweetId, now());

    // 中央へ寄せてから表示
    if (state.cfg?.ui?.highlight?.centerScroll !== false) {
      await scrollToCenter(article);
    }
    // 念押しで可視判定
    if (!isElementVisible(article, 0.12)) {
      state.highlightActive = false;
      return;
    }

    // UI付与
    ensureStyle();
    article.classList.add("forone-highlight");
    applyBadge(article, analysis);

    if (state.cfg?.ui?.highlight?.veil !== false) showVeil(true);
    showCard(article, analysis);

    log("HIGHLIGHT", { tweetId, risk, category: analysis.category });
  }

  function clearActiveHighlight() {
    state.highlightActive = false;

    // 次が溜まっていれば起動
    if (state.highlightQueue.length) {
      const id = state.highlightQueue.shift();
      triggerHighlightById(id).catch(() => {});
    }
  }

  async function pollVisibleAnalyses() {
    if (!state.cfg?.enabled) return;

    const ids = [...state.visibleIds].slice(0, 12);
    if (!ids.length) return;

    const res = await sendMessage({ type: "FORONE_GET_ANALYSIS", ids });
    if (!res?.ok) return;

    const results = res.results || {};
    const threshold = clamp(Number(state.cfg?.riskThreshold) || 75, 0, 100);

    // 高リスク優先で 1件だけ介入
    const candidates = [];
    for (const id of ids) {
      const a = results[id];
      if (!a) continue;
      const r = clamp(Number(a.risk) || 0, 0, 100);
      if (r >= threshold && canHighlight(id)) candidates.push({ id, r });
    }
    candidates.sort((x, y) => y.r - x.r);

    if (!candidates.length) return;
    await triggerHighlightById(candidates[0].id);
  }

  function ensureObservers() {
    // IntersectionObserver: 画面に入った投稿は優先解析
    if (!state._io) {
      state._io = new IntersectionObserver((entries) => {
        const ids = [];
        for (const ent of entries) {
          const art = ent.target;
          const id = art?.getAttribute("data-forone-id");
          if (!id) continue;

          if (ent.isIntersecting && ent.intersectionRatio >= 0.35) {
            state.visibleIds.add(id);
            ids.push(id);
          } else {
            state.visibleIds.delete(id);
          }
        }
        if (ids.length) sendMessage({ type: "FORONE_PRIORITIZE", ids }).catch(() => {});
      }, { threshold: [0.0, 0.35, 0.6] });
    }

    // MutationObserver: 新規ツイート検出
    if (!state._mo) {
      state._mo = new MutationObserver(() => {
        scanAndEnqueue("mutation").catch(() => {});
      });
      state._mo.observe(document.documentElement, { subtree: true, childList: true });
    }
  }

  async function scanAndEnqueue(reason = "tick") {
    if (!state.cfg?.enabled) return;

    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    if (!articles.length) return;

    const posts = [];
    for (const art of articles) {
      if (state.observed.has(art)) {
        const id = art.getAttribute("data-forone-id");
        if (id) state.idToArticle.set(id, art);
        continue;
      }

      const post = buildPost(art);
      state.observed.add(art);

      if (!post?.tweetId) continue;

      art.setAttribute("data-forone-id", post.tweetId);
      state.idToArticle.set(post.tweetId, art);

      try { state._io.observe(art); } catch (_) {}

      // enqueue once per discovered tweetId
      if (!state.seenIds.has(post.tweetId)) {
        state.seenIds.add(post.tweetId);
        posts.push(post);
      }
    }

    if (!posts.length) return;

    log("DETECT", { reason, count: posts.length, sample: posts[0]?.tweetId });
    const res = await sendMessage({ type: "FORONE_ENQUEUE", posts });
    log("ENQUEUE_RES", res);
  }

  function startLoops() {
    clearInterval(state.scanTimer);
    clearInterval(state.pollTimer);

    scanAndEnqueue("init").catch(() => {});

    // detect/enqueue: 体感優先で軽く
    state.scanTimer = setInterval(() => {
      scanAndEnqueue("tick").catch(() => {});
    }, 1300);

    // poll analyses for visible: highlight trigger
    state.pollTimer = setInterval(() => {
      pollVisibleAnalyses().catch(() => {});
    }, 950);
  }

  // ---------------- boot ----------------
  async function boot() {
    ensureStyle();

    // Options反映前でも“ブランド演出”を出す
    showBootOverlay();

    const start = now();

    // Configを取りに行く
    const cfgRes = await sendMessage({ type: "FORONE_GET_CONFIG" });
    if (cfgRes?.ok && cfgRes.cfg) {
      state.cfg = mergeDeep(structuredClone(FALLBACK_CFG), cfgRes.cfg);
    }

    // boot設定反映（表示時間など）
    const bootCfg = state.cfg?.ui?.boot || FALLBACK_CFG.ui.boot;
    const minShow = clamp(bootCfg.minShowMs ?? FALLBACK_CFG.ui.boot.minShowMs, 0, 12000);
    const maxShow = clamp(bootCfg.maxShowMs ?? FALLBACK_CFG.ui.boot.maxShowMs, 500, 20000);

    // SWが生きてるか（表示には出さない）
    const pingP = sendMessage({ type: "FORONE_PING" });

    // 最低表示 & 最大表示のレース
    const minP = sleep(Math.max(0, minShow - (now() - start)));
    const maxP = sleep(Math.max(0, maxShow - (now() - start)));

    await Promise.race([
      (async () => { await Promise.all([pingP, minP]); })(),
      maxP
    ]);

    hideBootOverlay();
    state.bootDone = true;

    log("boot done", { enabled: state.cfg.enabled, mode: state.cfg.analysisMode });
  }

  // ---------------- public debug ----------------
  globalThis.__forone_content = {
    rescan: () => scanAndEnqueue("manual"),
    dump: () => ({
      seen: state.seenIds.size,
      visible: state.visibleIds.size,
      highlightActive: state.highlightActive,
      queue: state.highlightQueue.slice(0, 10)
    })
  };

  // ---------------- init ----------------
  (async () => {
    try {
      await boot();

      if (!state.cfg?.enabled) {
        log("disabled by config");
        return;
      }

      ensureObservers();
      startLoops();

      // タブ復帰で設定を軽く同期
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState !== "visible") return;
        const cfgRes = await sendMessage({ type: "FORONE_GET_CONFIG" });
        if (cfgRes?.ok && cfgRes.cfg) {
          state.cfg = mergeDeep(structuredClone(FALLBACK_CFG), cfgRes.cfg);
        }
      });

      log("started", { threshold: state.cfg.riskThreshold });

    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(TAG, "init error:", e);
      hideBootOverlay();
    }
  })();
})();
