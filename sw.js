// sw.js (MV3 service worker)
'use strict';

const LOG_PREFIX = '[Forone][SW][Step1]';

// Queue tuning
const MAX_PENDING = 200;
const BATCH_SIZE = 5;
const BATCH_INTERVAL_MS = 20_000;

// In-memory state (OK for Step1; Step2以降でstorageへ移行)
const pendingQueue = [];           // tweetId[]
const pendingSet = new Set();      // tweetId
const payloadById = new Map();     // tweetId -> payload
const dispatchedSet = new Set();   // tweetId (Step1では「バッチに出した」ものを再度出さない)

let lastDispatchAt = 0;
let nextDueAt = 0;
let running = false;
let timeoutId = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function nowMs() {
  return Date.now();
}

function computeNextDue() {
  const base = lastDispatchAt || nowMs();
  return base + BATCH_INTERVAL_MS;
}

function ensureQueueLimit() {
  while (pendingQueue.length > MAX_PENDING) {
    const dropId = pendingQueue.shift();
    if (dropId) {
      pendingSet.delete(dropId);
      payloadById.delete(dropId);
      log('DROP(oldest) due to MAX_PENDING', { dropId, pending: pendingQueue.length });
    }
  }
}

function enqueue(payload) {
  const tweetId = payload?.tweetId;
  if (!tweetId) return { ok: false, reason: 'no_tweetId' };

  // already dispatched -> ignore (Step1仕様)
  if (dispatchedSet.has(tweetId)) return { ok: false, reason: 'already_dispatched' };

  // already pending -> update payload only
  if (pendingSet.has(tweetId)) {
    payloadById.set(tweetId, payload);
    return { ok: true, deduped: true, pending: pendingQueue.length };
  }

  pendingQueue.push(tweetId);
  pendingSet.add(tweetId);
  payloadById.set(tweetId, payload);

  ensureQueueLimit();

  // Dispatch policy:
  // - if queue already has enough items => dispatch soon
  // - else dispatch at nextDueAt
  if (!nextDueAt) nextDueAt = computeNextDue();

  scheduleMaybe('enqueue');

  return { ok: true, deduped: false, pending: pendingQueue.length };
}

function scheduleMaybe(reason) {
  // If already scheduled, don't stack timers.
  if (timeoutId !== null) return;

  const n = pendingQueue.length;
  if (n === 0) return;

  const t = nowMs();

  // If enough items, dispatch ASAP.
  const shouldImmediate = n >= BATCH_SIZE;

  // If time is due, dispatch ASAP.
  const due = nextDueAt && t >= nextDueAt;

  const delay = (shouldImmediate || due) ? 0 : Math.max(0, nextDueAt - t);

  timeoutId = setTimeout(async () => {
    timeoutId = null;
    await dispatchBatch('timer');
  }, delay);

  log('SCHEDULE', { reason, delayMs: delay, pending: n, nextDueAt });
}

async function dispatchBatch(trigger) {
  if (running) return;
  if (pendingQueue.length === 0) return;

  const t = nowMs();
  if (nextDueAt && t < nextDueAt && pendingQueue.length < BATCH_SIZE && trigger !== 'force') {
    // Not due yet; keep waiting unless we have enough items
    scheduleMaybe('not_due');
    return;
  }

  running = true;
  try {
    const batchIds = pendingQueue.splice(0, BATCH_SIZE);
    for (const id of batchIds) pendingSet.delete(id);

    const batchPayloads = batchIds
      .map((id) => payloadById.get(id))
      .filter(Boolean);

    // Mark as dispatched (Step1: 再度出さない)
    for (const id of batchIds) {
      dispatchedSet.add(id);
      payloadById.delete(id); // Step1では不要なので破棄（Step2では保持 or storageへ）
    }

    lastDispatchAt = nowMs();
    nextDueAt = computeNextDue();

    log('DISPATCH', {
      trigger,
      count: batchPayloads.length,
      ids: batchIds,
      pendingLeft: pendingQueue.length,
      nextDueAt
    });

    // Step1: ここで実際のLLM呼び出しはまだしない。代わりに内容をログで確認。
    for (const p of batchPayloads) {
      log('ITEM', {
        tweetId: p.tweetId,
        author: p.author,
        textPreview: (p.text || '').slice(0, 120),
        url: p.url
      });
    }

  } finally {
    running = false;
    // If still pending, schedule next
    if (pendingQueue.length > 0) scheduleMaybe('post_dispatch');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'FORONE_ENQUEUE') {
      const res = enqueue(msg.payload);
      sendResponse(res);
      return true;
    }

    if (msg.type === 'FORONE_TICK') {
      // TICK: service workerが寝てても、content側から定期的に起こして「期限チェック」できる
      if (!nextDueAt) nextDueAt = computeNextDue();

      const t = nowMs();
      const due = pendingQueue.length > 0 && t >= nextDueAt;
      const enough = pendingQueue.length >= BATCH_SIZE;

      if (due || enough) {
        dispatchBatch('tick').then(() => sendResponse({ ok: true, action: 'dispatched' }));
      } else {
        scheduleMaybe('tick');
        sendResponse({ ok: true, action: 'scheduled', pending: pendingQueue.length, nextDueAt });
      }
      return true;
    }

    if (msg.type === 'FORONE_STATS') {
      sendResponse({
        ok: true,
        pending: pendingQueue.length,
        pendingSet: pendingSet.size,
        dispatched: dispatchedSet.size,
        nextDueAt,
        lastDispatchAt
      });
      return true;
    }
  } catch (e) {
    log('onMessage error', e);
    sendResponse({ ok: false, error: String(e) });
    return true;
  }
});
