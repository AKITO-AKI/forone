// sw.js (MV3 service worker, type=module)

const CONFIG_KEY = "forone_config_v1";

const DEFAULT_CONFIG = {
  enabled: true,

  analysisMode: "local", // "local" | "llm"
  riskThreshold: 75,     // highlight threshold

  // LLM settings (optional)
  llm: {
    enabled: false,
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxOutputTokens: 650,
    candidateThreshold: 35,
    usePromptId: false,
    promptId: "",
    store: false
  },

  // scheduler
  batchSize: 5,
  tickMs: 20000,

  debug: true
};

let cfg = null;

// lexicon cache
let lexicon = null;
let lexiconLoaded = false;

// state
const pendingById = new Map();  // tweetId -> post snapshot
const analyzedById = new Map(); // tweetId -> analysis result
const inQueue = new Set();      // tweetId
let queue = [];                 // tweetId[]
const priorityIds = new Set();  // tweetId (visible prioritization)

const TICK_ALARM = "forone_tick_v1";
let scheduledAt = 0;
let busy = false;
let lastSchedule = null;

function log(...args) {
  if (!cfg?.debug) return;
  console.log("[Forone]", ...args);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sanitizeApiKey(key) {
  // ヘッダに非ISO文字が混じると fetch が落ちるので強制除去
  return String(key || "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

async function loadConfig() {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  const saved = got?.[CONFIG_KEY];
  cfg = { ...structuredClone(DEFAULT_CONFIG), ...(saved || {}) };
  if (saved?.llm) cfg.llm = { ...structuredClone(DEFAULT_CONFIG.llm), ...saved.llm };
  return cfg;
}

async function saveConfig(next) {
  cfg = next;
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  return cfg;
}

// -------- Lexicon --------

async function loadLexiconOnce() {
  if (lexiconLoaded && lexicon) return lexicon;
  try {
    // ここはあなたの lexicon 取得実装に合わせてください
    // 例: fetch(chrome.runtime.getURL("lexicon.json")) など
    // 既存 sw.js の実装がある前提で保持します
    const url = chrome.runtime.getURL("lexicon.json");
    const res = await fetch(url);
    const data = await res.json();
    lexicon = normalizeLexicon(data);
    lexiconLoaded = true;
    log("[lexicon] loaded", summarizeLexicon(lexicon));
    return lexicon;
  } catch (e) {
    log("[lexicon] load error", e);
    lexiconLoaded = true;
    lexicon = {};
    return lexicon;
  }
}

function normalizeLexicon(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v && typeof v === "object") {
      // { words: [...] } などにも対応したい場合はここで調整
      out[k] = Array.isArray(v.words) ? v.words.map(String) : [];
    } else {
      out[k] = [];
    }
  }
  return out;
}

function summarizeLexicon(L) {
  const sum = {};
  for (const [k, v] of Object.entries(L || {})) {
    sum[k] = { kind: typeof v, len: Array.isArray(v) ? v.length : 0, sample: Array.isArray(v) ? v.slice(0, 5) : [] };
  }
  return sum;
}

// -------- Local analysis --------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordMatchers(L) {
  // 文字列包含で十分なら includes でも良いが、ここは「簡易な正規化 + 正規表現」にしておく
  const groups = {};
  for (const [cat, words] of Object.entries(L || {})) {
    const cleaned = (Array.isArray(words) ? words : [])
      .map(w => String(w || "").trim())
      .filter(Boolean);

    // 長い語を優先して当たりやすくする
    cleaned.sort((a, b) => b.length - a.length);

    const patterns = cleaned.map(w => escapeRegExp(w));
    // 例：日本語は単語境界が弱いので、基本は部分一致
    const re = patterns.length ? new RegExp(patterns.join("|"), "i") : null;
    groups[cat] = { words: cleaned, re };
  }
  return groups;
}

let _cachedMatchers = null;
let _cachedLexiconSig = "";

function sigLexicon(L) {
  try {
    return JSON.stringify(Object.fromEntries(Object.entries(L || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])));
  } catch {
    return String(Date.now());
  }
}

function getMatchers() {
  if (!lexicon) return {};
  const sig = sigLexicon(lexicon);
  if (_cachedMatchers && _cachedLexiconSig === sig) return _cachedMatchers;
  _cachedLexiconSig = sig;
  _cachedMatchers = buildKeywordMatchers(lexicon);
  return _cachedMatchers;
}

function analyzeLocalQuick(post) {
  const text = String(post?.text || "");
  const t = text.replace(/\s+/g, " ").trim();
  const matchers = getMatchers();

  let best = { risk: 0, category: "other", tags: [] };

  for (const [cat, g] of Object.entries(matchers)) {
    if (!g?.re) continue;
    const m = t.match(g.re);
    if (!m) continue;

    // 超単純スコア：マッチした語の長さ + 固定ブースト
    const hit = String(m[0] || "");
    const base = clamp(10 + hit.length * 6, 12, 85);

    if (base > best.risk) {
      best = {
        risk: base,
        category: cat,
        tags: [hit]
      };
    }
  }

  return {
    tweetId: String(post?.tweetId || ""),
    risk: best.risk,
    category: best.category,
    tags: best.tags,
    model: "local"
  };
}

// -------- LLM analysis (optional) --------

async function llmBatchAnalyze(posts) {
  const key = sanitizeApiKey(cfg?.llm?.apiKey);
  if (!cfg?.llm?.enabled || !key) return null;

  const model = cfg.llm.model || "gpt-4o-mini";
  const temperature = Number(cfg.llm.temperature ?? 0.2);

  // 最低限のプロンプト。ここは Step6 以降で精緻化していけば良い
  const payload = {
    model,
    temperature,
    // Responses API / Chat Completions どちらでも良いが、あなたの実装方針に合わせてください
    // ここは「汎用 fetch で動く」形にしてあります
    messages: [
      {
        role: "system",
        content:
          "You are a safety classifier for social posts. Return JSON per item with fields: tweetId, risk(0-100), category, tags(array). Category must be one of: aggression_violence, prejudice_identityhate, extreme_shock, misinfo_speculation, scam_solicitation, polarization_bubble, other."
      },
      {
        role: "user",
        content: JSON.stringify(
          posts.map(p => ({
            tweetId: p.tweetId,
            author: p.author,
            text: p.text
          }))
        )
      }
    ],
    max_tokens: Number(cfg.llm.maxOutputTokens ?? 650)
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status} ${txt}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // JSONで返ってこなかった場合の雑フォールバック
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  // 正規化
  return parsed.map(x => ({
    tweetId: String(x?.tweetId || ""),
    risk: clamp(Number(x?.risk ?? 0), 0, 100),
    category: String(x?.category || "other"),
    tags: Array.isArray(x?.tags) ? x.tags.map(String) : [],
    model: "llm"
  }));
}

// -------- Scheduler --------

function schedule(reason, delayMs) {
  if (!cfg?.enabled) return;

  const ms = Math.max(0, Number(delayMs) || 0);
  const due = Date.now() + ms;

  // NOTE:
  // - “enqueue(0)” の直後に “periodic(20000)” を呼ぶと、後者で即時実行が上書きされて
  //   tick が永遠に先送りになることがある。
  // - なので「より早い実行」だけ採用し、遅いスケジュールは無視する。
  const keep = scheduledAt && due >= (scheduledAt - 10);
  lastSchedule = { reason, delayMs: ms, pending: queue.length, kept: keep, nextDueAt: scheduledAt || due };
  log("SCHEDULE", lastSchedule);

  if (keep) return;

  scheduledAt = due;
  try {
    chrome.alarms.clear(TICK_ALARM, () => {
      chrome.alarms.create(TICK_ALARM, { when: due });
    });
  } catch (_) {
    // alarms が使えない状況（極めて稀）用の最終フォールバック
    // ※ MV3 SW は idle で setTimeout が止まる可能性があるので、これは保険
    setTimeout(runTick, ms);
  }
}

async function runTick() {
  // alarm fired; allow re-scheduling
  scheduledAt = 0;

  if (busy) return;
  if (!cfg?.enabled) return;
  busy = true;

  try {
    await loadLexiconOnce();

    // pick batch
    const batch = [];
    const pickedIds = [];

    while (queue.length && batch.length < (cfg.batchSize || 5)) {
      const id = queue.shift();
      if (!id) continue;
      inQueue.delete(id);

      // already analyzed?
      if (analyzedById.has(id)) continue;

      const post = pendingById.get(id);
      if (!post) continue;

      batch.push(post);
      pickedIds.push(id);
    }

    if (!batch.length) return;

    log("DISPATCH", { count: batch.length, pendingLeft: queue.length });

    // local pre-check
    const localAnalyses = batch.map(p => analyzeLocalQuick(p));

    // candidates for LLM upgrade (optional)
    const askLLM =
      cfg.analysisMode === "llm" &&
      cfg.llm?.enabled &&
      sanitizeApiKey(cfg.llm.apiKey || "").length > 0;

    let finalById = new Map();

    if (askLLM) {
      const candidates = [];
      for (let i = 0; i < batch.length; i++) {
        const a = localAnalyses[i];
        const p = batch[i];
        const isPriority = priorityIds.has(p.tweetId);
        if (isPriority || (a.risk >= (cfg.llm.candidateThreshold ?? 35))) candidates.push(p);
      }

      if (candidates.length) {
        try {
          const llmRes = await llmBatchAnalyze(candidates);
          if (llmRes) {
            for (const r of llmRes) finalById.set(r.tweetId, r);
          }
        } catch (e) {
          log("LLM batch failed -> fallback local:", e);
        }
      }
    }

    // merge: llm result if exists, else local
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      const id = String(p.tweetId || "");
      if (!id) continue;

      const best = finalById.get(id) || localAnalyses[i];
      analyzedById.set(id, best);

      log("ANALYZED", best);
    }
  } catch (e) {
    log("TICK ERROR", e);
  } finally {
    busy = false;
    // schedule next if remaining
    if (queue.length) schedule("tick_continue", 250);
  }
}

// ---- Messaging ----

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await loadLexiconOnce();
  schedule("installed", 500);
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  await loadLexiconOnce();
  schedule("startup", 500);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name !== TICK_ALARM) return;
  try {
    if (!cfg) await loadConfig();
    await runTick();
  } catch (e) {
    log("TICK ERROR", e);
    busy = false;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!cfg) await loadConfig();

    const type = msg?.type || "";

    if (type === "FORONE_GET_CONFIG") {
      sendResponse({ ok: true, cfg });
      return;
    }

    // --- PING（生存確認）---
    if (type === "FORONE_PING") {
      sendResponse({ ok: true, ts: Date.now(), cfg: { enabled: cfg.enabled, analysisMode: cfg.analysisMode } });
      return;
    }

    if (type === "FORONE_SET_CONFIG") {
      const patch = msg?.patch || {};
      const next = structuredClone(cfg);
      Object.assign(next, patch);
      if (patch.llm) next.llm = { ...next.llm, ...patch.llm };
      await saveConfig(next);
      sendResponse({ ok: true, cfg });
      return;
    }

    if (type === "FORONE_RESET") {
      pendingById.clear();
      analyzedById.clear();
      inQueue.clear();
      queue = [];
      priorityIds.clear();
      sendResponse({ ok: true });
      return;
    }

    if (type === "FORONE_ENQUEUE") {
      await loadLexiconOnce();

      const posts = Array.isArray(msg.posts) ? msg.posts : [];
      let deduped = 0;
      let added = 0;

      for (const p of posts) {
        const id = String(p?.tweetId || "");
        if (!id) continue;

        // always keep latest snapshot
        pendingById.set(id, p);

        if (analyzedById.has(id)) {
          deduped++;
          continue;
        }
        if (inQueue.has(id)) {
          deduped++;
          continue;
        }
        inQueue.add(id);
        queue.push(id);
        added++;
      }

      if (added > 0) {
        // 即時に回す（periodic で上書きしない）
        schedule("enqueue", 0);
      }

      sendResponse({ ok: true, added, deduped, pending: queue.length });
      return;
    }

    if (type === "FORONE_PRIORITIZE") {
      const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
      for (const id of ids) {
        if (!id) continue;

        priorityIds.add(id);

        if (!analyzedById.has(id)) {
          if (!inQueue.has(id)) {
            inQueue.add(id);
            queue.unshift(id);
          } else {
            // 既にキューにあるなら前に寄せる
            queue = [id, ...queue.filter(x => x !== id)];
          }
        }
      }
      schedule("prioritize", 0);
      sendResponse({ ok: true, pending: queue.length });
      return;
    }

    if (type === "FORONE_GET_ANALYSIS") {
      const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
      const out = [];
      for (const id of ids) {
        const a = analyzedById.get(id);
        if (a) out.push(a);
      }
      sendResponse({ ok: true, items: out });
      return;
    }

    if (type === "FORONE_DEBUG_LEXICON") {
      const L = await loadLexiconOnce();
      sendResponse({ ok: true, summary: summarizeLexicon(L) });
      return;
    }

    if (type === "FORONE_DEBUG_LOCAL") {
      await loadLexiconOnce();
      const text = String(msg?.text || "");
      const a = analyzeLocalQuick({ tweetId: "debug", text });
      sendResponse({ ok: true, analysis: a });
      return;
    }

    sendResponse({ ok: false, error: "unknown_type", type });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // async response
});

// debug helper (service worker console)
globalThis._forone = {
  reloadLexicon: async () => {
    lexiconLoaded = false;
    lexicon = null;
    return loadLexiconOnce();
  },
  lexiconSummary: async () => summarizeLexicon(await loadLexiconOnce()),
  localAnalyze: async (text) => analyzeLocalQuick({ tweetId: "debug", text }),
  dumpState: () => ({
    pending: pendingById.size,
    analyzed: analyzedById.size,
    inQueue: inQueue.size,
    queue: queue.slice(0, 20),
    lastSchedule
  })
};
