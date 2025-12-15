(() => {
  'use strict';

  const DEBUG = true;
  const LOG_PREFIX = '[Forone][Step1]';

  const STATUS_RE = /\/status\/(\d+)/;

  const seenTweetIds = new Set();

  // TICK: SWがアイドルで止まっても、X閲覧中は定期的に起こして期限チェックする
  // 20秒ぴったりで回したい気持ちは分かるが、MV3の都合でSWが寝る可能性があるため
  // 「数秒ごとにTICKで起こす」方式が実運用では堅い。
  const TICK_INTERVAL_MS = 5_000;

  function log(...args) {
    if (!DEBUG) return;
    console.log(LOG_PREFIX, ...args);
  }

  function extractTweetIdAndUrl(article) {
    const aList = article.querySelectorAll('a[href*="/status/"]');
    for (const a of aList) {
      const href = a.getAttribute('href') || '';
      const m = href.match(STATUS_RE);
      if (m) {
        const tweetId = m[1];
        const url = new URL(href, location.origin).toString();
        return { tweetId, url, hrefRaw: href };
      }
    }
    return { tweetId: null, url: null, hrefRaw: null };
  }

  function extractText(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (textEl && textEl.innerText) return textEl.innerText.trim();

    const blocks = article.querySelectorAll('div[lang]');
    const texts = [];
    for (const b of blocks) {
      const t = (b.innerText || '').trim();
      if (t) texts.push(t);
    }
    const uniq = [...new Set(texts)];
    return uniq.join('\n').trim();
  }

  function extractAuthor(article, url) {
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      const raw = userNameEl.innerText || '';
      const handleMatch = raw.match(/@([A-Za-z0-9_]+)/);
      if (handleMatch) return '@' + handleMatch[1];
    }

    try {
      if (url) {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 3 && parts[1] === 'status') {
          return '@' + parts[0];
        }
      }
    } catch (_) {}

    return null;
  }

  function extractTime(article) {
    const timeEl = article.querySelector('time');
    if (!timeEl) return { datetime: null, display: null };
    const datetime = timeEl.getAttribute('datetime');
    const display = (timeEl.innerText || '').trim();
    return { datetime: datetime || null, display: display || null };
  }

  function extractEngagement(article) {
    const out = { replies: null, reposts: null, likes: null, bookmarks: null, views: null };

    const map = [
      { key: 'replies', testid: 'reply' },
      { key: 'reposts', testid: 'retweet' },
      { key: 'likes', testid: 'like' },
      { key: 'bookmarks', testid: 'bookmark' }
    ];

    for (const { key, testid } of map) {
      const btn = article.querySelector(`[data-testid="${testid}"]`);
      if (!btn) continue;
      const aria = btn.getAttribute('aria-label') || '';
      const m = aria.replace(/,/g, '').match(/(\d+)/);
      if (m) out[key] = Number(m[1]);
    }

    const viewEl = article.querySelector('a[href*="/analytics"]') || article.querySelector('[data-testid="viewCount"]');
    if (viewEl) {
      const t = (viewEl.getAttribute('aria-label') || viewEl.innerText || '').replace(/,/g, '');
      const m = t.match(/(\d+)/);
      if (m) out.views = Number(m[1]);
    }

    return out;
  }

  async function enqueueToSW(payload) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'FORONE_ENQUEUE', payload });
      if (DEBUG) log('ENQUEUE_RES', res);
    } catch (e) {
      // SWがまだ起動していない等
      if (DEBUG) log('ENQUEUE_ERR', String(e));
    }
  }

  function emitTweet(article) {
    if (!article || article.nodeType !== Node.ELEMENT_NODE) return;

    if (article.dataset.foroneSeen === '1') return;
    article.dataset.foroneSeen = '1';

    const { tweetId, url } = extractTweetIdAndUrl(article);
    if (!tweetId) return;

    if (seenTweetIds.has(tweetId)) return;
    seenTweetIds.add(tweetId);

    const payload = {
      source: 'x',
      tweetId,
      url,
      author: extractAuthor(article, url),
      text: extractText(article),
      time: extractTime(article),
      engagement: extractEngagement(article),
      capturedAt: new Date().toISOString()
    };

    log('DETECT', payload);
    enqueueToSW(payload);
  }

  function scanInitial() {
    const articles = document.querySelectorAll('article');
    for (const a of articles) emitTweet(a);
    log(`Initial scan done. seenTweetIds=${seenTweetIds.size}`);
  }

  function startObserver() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.matches?.('article')) {
            emitTweet(node);
          } else {
            const articles = node.querySelectorAll?.('article');
            if (articles && articles.length) {
              for (const a of articles) emitTweet(a);
            }
          }
        }
      }
    });

    mo.observe(document.documentElement, { childList: true, subtree: true });
    log('MutationObserver started.');
  }

  function startTick() {
    setInterval(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'FORONE_TICK' });
      } catch (_) {
        // ignore
      }
    }, TICK_INTERVAL_MS);
    log('TICK started', { everyMs: TICK_INTERVAL_MS });
  }

  function boot() {
    setTimeout(() => {
      scanInitial();
      startObserver();
      startTick();
    }, 800);
  }

  boot();
})();
