/**
 * RAKUDA AB Test Event Tracker
 * ページビュー・スクロール・CTA・フォーム・チャット等のイベントを自動計測し、
 * バックエンドの /api/ab/event エンドポイントに送信する
 *
 * 自動トラッキング対象:
 *   - view:        ページ読み込み時
 *   - scroll_50:   ページの50%をスクロールした時
 *   - cta_click:   [data-track="cta"] 要素のクリック時
 *   - form_open:   .modal または .is-open が表示された時
 *   - form_submit: カスタムイベント 'rakuda:form_submit' 発火時
 *   - chat_start:  カスタムイベント 'rakuda:chat_start' 発火時
 */
(function () {
  'use strict';

  // ============================================================
  //  定数
  // ============================================================

  /** イベント送信先エンドポイント */
  var API_ENDPOINT = (window.RAKUDA_API_BASE || '') + '/api/ab/event';

  /** visitor_id の localStorage キー */
  var VISITOR_ID_KEY = 'rakuda_visitor_id';

  /** セッション内の送信済みイベント記録用キー（sessionStorage） */
  var SENT_EVENTS_KEY = 'rakuda_ab_sent_events';

  /** スクロールイベントのデバウンス間隔（ミリ秒） */
  var SCROLL_DEBOUNCE_MS = 200;

  /** 重複送信を許可するイベント（同セッション内で複数回送信可） */
  var REPEATABLE_EVENTS = ['cta_click', 'chat_start'];

  // ============================================================
  //  ユーティリティ
  // ============================================================

  /**
   * UUID v4 を生成（crypto API使用、フォールバックあり）
   * @returns {string} UUID文字列
   */
  function generateUUID() {
    // crypto.randomUUID が使える場合はそちらを使用
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // フォールバック: crypto.getRandomValues ベース
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      var buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      // variant と version ビットをセット
      buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
      buf[8] = (buf[8] & 0x3f) | 0x80; // variant 1
      var hex = '';
      for (var i = 0; i < 16; i++) {
        hex += ('0' + buf[i].toString(16)).slice(-2);
      }
      return (
        hex.slice(0, 8) + '-' +
        hex.slice(8, 12) + '-' +
        hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' +
        hex.slice(20, 32)
      );
    }
    // 最終フォールバック: Math.random（非推奨だが動作保証用）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * visitor_id を取得（なければ生成して localStorage に保存）
   * @returns {string} visitor_id
   */
  function getVisitorId() {
    try {
      var id = localStorage.getItem(VISITOR_ID_KEY);
      if (id) return id;
      id = generateUUID();
      localStorage.setItem(VISITOR_ID_KEY, id);
      return id;
    } catch (e) {
      // localStorage が使えない場合はセッション限りのIDを返す
      return generateUUID();
    }
  }

  /**
   * 現在のページ識別子を取得
   * 優先順: <meta name="rakuda-page"> > URLパスから推定
   * @returns {string} ページ識別子（例: 'p2'）
   */
  function getPage() {
    // meta タグから取得
    var meta = document.querySelector('meta[name="rakuda-page"]');
    if (meta && meta.content) {
      return meta.content;
    }
    // URLパスから推定（例: /p2.html → 'p2', /p3 → 'p3'）
    var path = window.location.pathname;
    var match = path.match(/\/(p\d+)/);
    if (match) return match[1];
    // index.html やルートの場合
    if (path === '/' || path.indexOf('index') !== -1) return 'index';
    // ファイル名から拡張子を除去
    var filename = path.split('/').pop() || '';
    return filename.replace(/\.html?$/, '') || 'unknown';
  }

  /**
   * セッション内で既に送信済みのイベントかどうかを判定
   * @param {string} eventType - イベント種別
   * @returns {boolean} 送信済みなら true
   */
  function isEventSent(eventType) {
    // 繰り返し可能なイベントは常に false を返す
    if (REPEATABLE_EVENTS.indexOf(eventType) !== -1) return false;
    try {
      var raw = sessionStorage.getItem(SENT_EVENTS_KEY);
      if (!raw) return false;
      var sent = JSON.parse(raw);
      return Array.isArray(sent) && sent.indexOf(eventType) !== -1;
    } catch (e) {
      return false;
    }
  }

  /**
   * イベントを送信済みとして記録
   * @param {string} eventType - イベント種別
   */
  function markEventSent(eventType) {
    // 繰り返し可能なイベントは記録しない
    if (REPEATABLE_EVENTS.indexOf(eventType) !== -1) return;
    try {
      var raw = sessionStorage.getItem(SENT_EVENTS_KEY);
      var sent = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(sent)) sent = [];
      if (sent.indexOf(eventType) === -1) {
        sent.push(eventType);
      }
      sessionStorage.setItem(SENT_EVENTS_KEY, JSON.stringify(sent));
    } catch (e) {
      // 無視
    }
  }

  // ============================================================
  //  イベント送信
  // ============================================================

  /** visitor_id（初期化時に確定） */
  var _visitorId = '';

  /** ページ識別子（初期化時に確定） */
  var _page = '';

  /**
   * イベントをバックエンドに送信
   * navigator.sendBeacon を優先使用し、フォールバックとして fetch を使用
   * @param {string} eventType - イベント種別
   * @param {Object} [metadata={}] - 追加メタデータ
   */
  function sendEvent(eventType, metadata) {
    // 重複チェック
    if (isEventSent(eventType)) return;

    var payload = JSON.stringify({
      visitor_id: _visitorId,
      page: _page,
      event: eventType,
      metadata: JSON.stringify(metadata || {})
    });

    var sent = false;

    // sendBeacon を優先（ページ離脱時にも送信可能）
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        var blob = new Blob([payload], { type: 'application/json' });
        sent = navigator.sendBeacon(API_ENDPOINT, blob);
      } catch (e) {
        sent = false;
      }
    }

    // sendBeacon が使えない、または失敗した場合は fetch でフォールバック
    if (!sent) {
      try {
        fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          // keepalive: ページ離脱時にもリクエストを完了させる
          keepalive: true
        }).catch(function () {
          // 送信失敗は無視（トラッキングはベストエフォート）
        });
      } catch (e) {
        // fetch 自体が使えない環境は無視
      }
    }

    // 送信済みとして記録
    markEventSent(eventType);
  }

  // ============================================================
  //  自動トラッキング: スクロール50%
  // ============================================================

  /** スクロール50%検知済みフラグ */
  var _scrollTracked = false;

  /** デバウンス用タイマーID */
  var _scrollTimer = null;

  /**
   * スクロール位置を判定し、50%超過でイベントを発火
   */
  function checkScroll() {
    if (_scrollTracked) return;

    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
    var winHeight = window.innerHeight || document.documentElement.clientHeight;
    var scrollableHeight = docHeight - winHeight;

    if (scrollableHeight <= 0) return;

    var scrollPercent = scrollTop / scrollableHeight;

    if (scrollPercent >= 0.5) {
      _scrollTracked = true;
      sendEvent('scroll_50', { percent: Math.round(scrollPercent * 100) });
      // リスナーを解除（不要な処理を止める）
      window.removeEventListener('scroll', onScrollDebounced);
    }
  }

  /**
   * デバウンス付きスクロールハンドラ
   */
  function onScrollDebounced() {
    if (_scrollTimer) clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(checkScroll, SCROLL_DEBOUNCE_MS);
  }

  // ============================================================
  //  自動トラッキング: CTAクリック
  // ============================================================

  /**
   * CTA要素のクリックハンドラ（イベント委任）
   * @param {MouseEvent} e
   */
  function onCtaClick(e) {
    // クリックされた要素または祖先に [data-track="cta"] があるか
    var target = e.target;
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute('data-track') === 'cta') {
        var meta = {};
        // ボタンテキストをメタデータに含める
        var label = target.textContent || target.innerText || '';
        if (label) {
          meta.label = label.trim().substring(0, 100); // 100文字に制限
        }
        // data-track-id があればそれも記録
        var trackId = target.getAttribute('data-track-id');
        if (trackId) {
          meta.id = trackId;
        }
        sendEvent('cta_click', meta);
        return;
      }
      target = target.parentElement;
    }
  }

  // ============================================================
  //  自動トラッキング: モーダル/フォーム表示
  // ============================================================

  /** MutationObserver インスタンス */
  var _modalObserver = null;

  /**
   * DOM変更を監視し、モーダルの表示を検知
   */
  function setupModalObserver() {
    if (typeof MutationObserver === 'undefined') return;

    _modalObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          var el = mutation.target;
          if (!el || !el.classList) continue;

          // .modal, .modal-overlay 等で .active / .is-open が付いた時
          var isModal = el.classList.contains('modal') ||
                        el.classList.contains('modal-overlay') ||
                        el.classList.contains('is-open');
          var isActive = el.classList.contains('active') || el.classList.contains('is-open');

          if (isModal && isActive) {
            var modalId = el.id || 'unknown';
            sendEvent('form_open', { modal: modalId });
          }
        }
      }
    });

    // body 以下の class 属性変更を監視
    _modalObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    });
  }

  // ============================================================
  //  自動トラッキング: カスタムイベント
  // ============================================================

  /**
   * カスタムイベント 'rakuda:form_submit' のハンドラ
   * @param {CustomEvent} e
   */
  function onFormSubmit(e) {
    var meta = {};
    if (e.detail) {
      meta = typeof e.detail === 'object' ? e.detail : { info: String(e.detail) };
    }
    sendEvent('form_submit', meta);
  }

  /**
   * カスタムイベント 'rakuda:chat_start' のハンドラ
   * @param {CustomEvent} e
   */
  function onChatStart(e) {
    var meta = {};
    if (e.detail) {
      meta = typeof e.detail === 'object' ? e.detail : { info: String(e.detail) };
    }
    sendEvent('chat_start', meta);
  }

  // ============================================================
  //  初期化
  // ============================================================

  /**
   * トラッカーを初期化（DOMContentLoaded で自動実行）
   */
  function initialize() {
    // visitor_id とページを確定
    _visitorId = getVisitorId();
    _page = getPage();

    // 1. ページビューイベント
    sendEvent('view', {
      referrer: document.referrer || '',
      url: window.location.href
    });

    // 2. スクロール50%検知
    if (!isEventSent('scroll_50')) {
      window.addEventListener('scroll', onScrollDebounced, { passive: true });
      // 初回チェック（ページ遷移で既にスクロール位置が50%超の場合）
      checkScroll();
    }

    // 3. CTAクリック（イベント委任で document に設置）
    document.addEventListener('click', onCtaClick);

    // 4. モーダル表示検知
    setupModalObserver();

    // 5. カスタムイベントリスナー
    document.addEventListener('rakuda:form_submit', onFormSubmit);
    document.addEventListener('rakuda:chat_start', onChatStart);
  }

  // DOMContentLoaded で自動初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    // 既にDOMロード済みの場合は即実行
    initialize();
  }

})();
