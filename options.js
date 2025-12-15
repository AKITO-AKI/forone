/* global chrome */
"use strict";

const $ = (id) => document.getElementById(id);

const MSG = {
  GET_CONFIG: "FORONE_GET_CONFIG",
  SET_CONFIG: "FORONE_SET_CONFIG",
  PING: "FORONE_PING",
  RESET: "FORONE_RESET",
  DEBUG_LEXICON: "FORONE_DEBUG_LEXICON",
  DEBUG_LOCAL: "FORONE_DEBUG_LOCAL",
};

const els = {};
let currentCfg = null;

function toast(text, ms = 1800) {
  const t = els.toast;
  t.textContent = text || "";
  if (!text) return;
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => (t.textContent = ""), ms);
}

function setConn(ok, text) {
  const p = els.connPill;
  p.classList.remove("ok", "ng");
  if (ok === true) p.classList.add("ok");
  if (ok === false) p.classList.add("ng");
  p.textContent = text;
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

async function send(type, payload) {
  try {
    return await chrome.runtime.sendMessage({ type, ...(payload || {}) });
  } catch (e) {
    return null;
  }
}

function readFormToPatch() {
  const enabled = !!els.enabled.checked;

  const analysisMode =
    els.modeLLM.checked ? "llm" :
    els.modeLocal.checked ? "local" : "local";

  const riskThreshold = clampNum(els.riskThresholdNum.value, 0, 100, 75);

  const ui = {
    bootAnimation: !!els.bootAnimation.checked,
    bootMinShowMs: clampNum(els.bootMinShowMs.value, 0, 12000, 1800),
    bootMaxShowMs: clampNum(els.bootMaxShowMs.value, 500, 20000, 6500),
  };

  const debug = !!els.debug.checked;

  // LLM block
  const llmEnabled = !!els.llmEnabled.checked;
  const llm = {
    enabled: llmEnabled,
    apiKey: String(els.apiKey.value || ""),
    model: String(els.model.value || "gpt-4o-mini"),
    temperature: clampNum(els.temperature.value, 0, 2, 0.2),
    maxOutputTokens: clampNum(els.maxOutputTokens.value, 32, 2000, 450),
    candidateThreshold: clampNum(els.candidateThreshold.value, 0, 100, 35),
    store: !!els.store.checked,
  };

  // 注意: sw.jsはObject.assignでuiを上書きするので「丸ごと送る」方が安全
  const patch = {
    enabled,
    analysisMode,
    riskThreshold,
    ui,
    debug,
    llm,
  };

  return patch;
}

function fillForm(cfg) {
  currentCfg = cfg;

  els.enabled.checked = !!cfg.enabled;

  const mode = cfg.analysisMode || "local";
  els.modeLocal.checked = mode === "local";
  els.modeLLM.checked = mode === "llm";

  const rt = clampNum(cfg.riskThreshold, 0, 100, 75);
  els.riskThreshold.value = String(rt);
  els.riskThresholdNum.value = String(rt);

  const ui = cfg.ui || {};
  els.bootAnimation.checked = ui.bootAnimation !== false;
  els.bootMinShowMs.value = String(clampNum(ui.bootMinShowMs, 0, 12000, 1800));
  els.bootMaxShowMs.value = String(clampNum(ui.bootMaxShowMs, 500, 20000, 6500));

  els.debug.checked = !!cfg.debug;

  const llm = cfg.llm || {};
  els.llmEnabled.checked = !!llm.enabled;
  els.apiKey.value = String(llm.apiKey || "");
  els.model.value = String(llm.model || "gpt-4o-mini");
  els.temperature.value = String(clampNum(llm.temperature, 0, 2, 0.2));
  els.maxOutputTokens.value = String(clampNum(llm.maxOutputTokens, 32, 2000, 450));
  els.candidateThreshold.value = String(clampNum(llm.candidateThreshold, 0, 100, 35));
  els.store.checked = !!llm.store;

  // AI判定カードの見せ方（OFFなら薄く）
  updateLLMCard();
}

function updateLLMCard() {
  const on = !!els.llmEnabled.checked;
  const card = $("llmCard");
  card.style.opacity = on ? "1" : "0.82";
}

function renderLexiconSummary(summary) {
  const wrap = els.lexWrap;
  wrap.innerHTML = "";

  const keys = Object.keys(summary || {});
  if (keys.length === 0) {
    wrap.innerHTML = `<div class="mono">辞書情報が見つかりませんでした。</div>`;
    return;
  }

  for (const k of keys) {
    const v = summary[k] || {};
    const len = Number(v.len ?? 0);
    const sample = Array.isArray(v.sample) ? v.sample : [];
    const div = document.createElement("div");
    div.className = "lexCard";
    div.innerHTML = `
      <div class="lexTop">
        <div class="lexName">${escapeHtml(k)}</div>
        <div class="lexLen">${Number.isFinite(len) ? `${len}語` : ""}</div>
      </div>
      <div class="chips">
        ${sample.slice(0, 10).map(s => `<span class="chip">${escapeHtml(String(s))}</span>`).join("")}
      </div>
    `;
    wrap.appendChild(div);
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

async function refreshConn() {
  const pong = await send(MSG.PING, {});
  if (pong?.ok) {
    const m = pong.enabled ? "接続OK（ふぉろね準備できてる）" : "接続OK（今はOFF）";
    setConn(true, m);
  } else {
    setConn(false, "接続できません（拡張機能をReloadしてみてください）");
  }
}

async function loadConfig() {
  const res = await send(MSG.GET_CONFIG, {});
  if (!res?.ok || !res.cfg) {
    toast("設定を読み込めませんでした。");
    return;
  }
  fillForm(res.cfg);
}

function wireEvents() {
  els.riskThreshold.addEventListener("input", () => {
    els.riskThresholdNum.value = els.riskThreshold.value;
  });
  els.riskThresholdNum.addEventListener("input", () => {
    const v = clampNum(els.riskThresholdNum.value, 0, 100, 75);
    els.riskThreshold.value = String(v);
  });

  els.llmEnabled.addEventListener("change", updateLLMCard);

  els.saveBtn.addEventListener("click", async () => {
    const patch = readFormToPatch();

    // 使いやすさ：AI判定ONでキー空なら一応注意（強制はしない）
    if (patch.analysisMode === "llm" && patch.llm.enabled && !patch.llm.apiKey) {
      toast("AI判定がONだけど、キーが空っぽかも。必要なら入力してね。", 2400);
    }

    const res = await send(MSG.SET_CONFIG, { patch });
    if (res?.ok) {
      toast("保存したよ。Xのタブを更新すると確実。");
      // 保存後に再読込して整合
      await loadConfig();
      await refreshConn();
    } else {
      toast("保存に失敗しました。");
    }
  });

  els.pingBtn.addEventListener("click", async () => {
    await refreshConn();
    toast("接続を確認しました。");
  });

  els.reloadLexBtn.addEventListener("click", async () => {
    const res = await send(MSG.DEBUG_LEXICON, {});
    if (res?.ok && res.summary) {
      renderLexiconSummary(res.summary);
      els.lexPill.textContent = "表示中";
      els.lexPill.classList.remove("ng");
      els.lexPill.classList.add("ok");
      toast("辞書状態を表示しました。");
    } else {
      els.lexPill.textContent = "失敗";
      els.lexPill.classList.remove("ok");
      els.lexPill.classList.add("ng");
      toast("辞書状態を取得できませんでした。");
    }
  });

  els.testBtn.addEventListener("click", async () => {
    const text = String(els.testText.value || "").trim();
    if (!text) {
      toast("テスト文章を入れてね。");
      return;
    }
    const res = await send(MSG.DEBUG_LOCAL, { text });
    if (res?.ok && res.analysis) {
      els.testPill.textContent = `risk: ${res.analysis.risk} / ${res.analysis.category}`;
      els.testPill.classList.remove("ng");
      els.testPill.classList.add("ok");
      els.testOut.textContent = JSON.stringify(res.analysis, null, 2);
      toast("判定しました。");
    } else {
      els.testPill.textContent = "失敗";
      els.testPill.classList.remove("ok");
      els.testPill.classList.add("ng");
      els.testOut.textContent = "";
      toast("判定に失敗しました。");
    }
  });

  els.resetBtn.addEventListener("click", async () => {
    const ok = confirm("内部の状態をいったん空にします。実行しますか？");
    if (!ok) return;
    const res = await send(MSG.RESET, {});
    if (res?.ok) {
      toast("初期化しました。");
      // 表示も軽くリセット
      els.testPill.textContent = "未実行";
      els.testPill.classList.remove("ok","ng");
      els.testPill.classList.add("subtle");
      els.testOut.textContent = "";
    } else {
      toast("初期化に失敗しました。");
    }
  });
}

function cacheEls() {
  const ids = [
    "connPill","toast",
    "enabled","modeLocal","modeLLM",
    "riskThreshold","riskThresholdNum",
    "bootAnimation","bootMinShowMs","bootMaxShowMs",
    "llmEnabled","apiKey","model","temperature","maxOutputTokens","candidateThreshold","store",
    "debug",
    "pingBtn","saveBtn",
    "reloadLexBtn","lexPill","lexWrap",
    "testText","testBtn","testPill","testOut",
    "resetBtn",
  ];
  for (const id of ids) els[id] = $(id);
}

(async function init() {
  cacheEls();
  wireEvents();
  await loadConfig();
  await refreshConn();

  // pill初期化
  els.lexPill.classList.add("subtle");
  els.testPill.classList.add("subtle");
})();
