/**
 * RAKUDA Chat Module
 * Claude API（Workers経由）とSSE接続し、リアルタイムで応答を表示する共通チャットモジュール
 * 全4ページ（p1〜p4等）で共有して使用する
 *
 * 使い方:
 *   RakudaChat.init({ apiBase: '', page: 'p2', containerId: 'chatbotMessages', ... });
 *   RakudaChat.send('こんにちは');
 *   RakudaChat.destroy();
 */
(function () {
  'use strict';

  // ============================================================
  //  定数
  // ============================================================

  /** メッセージ履歴の最大ターン数（user + assistant で1ターン） */
  var MAX_TURNS = 20;

  /** クライアント側メッセージ最大文字数 */
  var MAX_MESSAGE_LENGTH = 500;

  /** レートリミット: 1分間あたりの最大リクエスト数 */
  var RATE_LIMIT_PER_MIN = 3;

  /** レートリミットのウィンドウ（ミリ秒） */
  var RATE_LIMIT_WINDOW_MS = 60 * 1000;

  /** sessionStorage に保存する際のキー接頭辞 */
  var STORAGE_KEY_PREFIX = 'rakuda_chat_';

  /** API 障害時のフォールバック応答（正規表現パターン → 応答テキスト） */
  var FALLBACK_RESPONSES = {
    '料金|価格|費用': '初回のAI診断は完全無料です。詳しくはお問い合わせください。',
    '事例|実績|導入': '製造業で年間1,200万円、IT企業で800万円の削減実績があります。',
    '診断|分析': '業種と売上規模をお伝えいただければ、すぐにAI診断が可能です。',
    default: 'ご質問ありがとうございます。より詳しいご説明は専門チームが対応いたします。お問い合わせフォームからご連絡ください。'
  };

  // ============================================================
  //  内部状態
  // ============================================================

  /** 初期化済みかどうか */
  var _initialized = false;

  /** 設定オブジェクト */
  var _config = {
    apiBase: '',        // APIのベースURL（空文字の場合は同一オリジン）
    page: '',           // ページ識別子（p1, p2, p3, p4 等）
    containerId: '',    // チャットメッセージ表示領域のDOM ID
    inputId: '',        // テキスト入力欄のDOM ID
    sendBtnId: '',      // 送信ボタンのDOM ID
    quickActions: []    // クイックアクション配列 [{ label, text }]
  };

  /** DOM参照キャッシュ */
  var _els = {
    container: null,
    input: null,
    sendBtn: null
  };

  /** メッセージ履歴配列 [{ role: 'user'|'assistant', content: '...' }] */
  var _messages = [];

  /** レートリミット用タイムスタンプ配列 */
  var _requestTimestamps = [];

  /** 現在ストリーミング中の AbortController */
  var _currentAbort = null;

  /** 送信処理中フラグ（二重送信防止） */
  var _isSending = false;

  // ============================================================
  //  ユーティリティ
  // ============================================================

  /**
   * XSS防止: HTMLエスケープ
   * @param {string} str - エスケープする文字列
   * @returns {string} エスケープ済み文字列
   */
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * sessionStorage からメッセージ履歴を復元
   */
  function loadMessages() {
    try {
      var key = STORAGE_KEY_PREFIX + _config.page;
      var raw = sessionStorage.getItem(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          _messages = parsed;
        }
      }
    } catch (e) {
      // sessionStorage が使えない環境では無視
      _messages = [];
    }
  }

  /**
   * sessionStorage にメッセージ履歴を保存
   */
  function saveMessages() {
    try {
      var key = STORAGE_KEY_PREFIX + _config.page;
      sessionStorage.setItem(key, JSON.stringify(_messages));
    } catch (e) {
      // 容量超過等は無視
    }
  }

  /**
   * メッセージ履歴にエントリを追加（MAX_TURNS を超えたら古いものを削除）
   * @param {string} role - 'user' または 'assistant'
   * @param {string} content - メッセージ本文
   */
  function pushMessage(role, content) {
    _messages.push({ role: role, content: content });
    // MAX_TURNS はペア単位なので、配列長の上限は MAX_TURNS * 2
    while (_messages.length > MAX_TURNS * 2) {
      _messages.shift();
    }
    saveMessages();
  }

  /**
   * レートリミットチェック
   * @returns {boolean} 送信可能なら true
   */
  function checkRateLimit() {
    var now = Date.now();
    // ウィンドウ外のタイムスタンプを削除
    _requestTimestamps = _requestTimestamps.filter(function (ts) {
      return now - ts < RATE_LIMIT_WINDOW_MS;
    });
    return _requestTimestamps.length < RATE_LIMIT_PER_MIN;
  }

  /**
   * レートリミットに記録
   */
  function recordRequest() {
    _requestTimestamps.push(Date.now());
  }

  /**
   * レートリミット超過時の残り待ち時間（秒）を返す
   * @returns {number} 待ち秒数
   */
  function getRateLimitWaitSeconds() {
    if (_requestTimestamps.length === 0) return 0;
    var oldest = _requestTimestamps[0];
    var waitMs = RATE_LIMIT_WINDOW_MS - (Date.now() - oldest);
    return Math.max(0, Math.ceil(waitMs / 1000));
  }

  /**
   * フォールバック応答を取得
   * @param {string} text - ユーザー入力テキスト
   * @returns {string} フォールバック応答
   */
  function getFallbackResponse(text) {
    var keys = Object.keys(FALLBACK_RESPONSES);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === 'default') continue;
      var regex = new RegExp(key, 'i');
      if (regex.test(text)) {
        return FALLBACK_RESPONSES[key];
      }
    }
    return FALLBACK_RESPONSES['default'];
  }

  // ============================================================
  //  DOM操作
  // ============================================================

  /**
   * チャットコンテナにメッセージバブルを追加
   * @param {string} role - 'user' または 'assistant'
   * @param {string} html - 表示するHTML（assistantの場合はストリーミングで徐々に追加）
   * @returns {HTMLElement} 生成されたバブルの内側要素（.bubble-inner）
   */
  function appendBubble(role, html) {
    if (!_els.container) return null;

    var bubble = document.createElement('div');
    bubble.className = (role === 'user' ? 'bubble-user' : 'bubble-ai') + ' bubble-appear';

    var inner = document.createElement('div');
    inner.className = 'bubble-inner';
    inner.innerHTML = html;

    bubble.appendChild(inner);
    _els.container.appendChild(bubble);
    scrollToBottom();

    return inner;
  }

  /**
   * タイピングインジケーターを表示
   * @returns {HTMLElement} インジケーター要素（削除用）
   */
  function showTypingIndicator() {
    if (!_els.container) return null;

    var bubble = document.createElement('div');
    bubble.className = 'bubble-ai bubble-appear';
    bubble.id = 'rakuda-chat-typing';

    var inner = document.createElement('div');
    inner.className = 'bubble-inner';
    inner.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

    bubble.appendChild(inner);
    _els.container.appendChild(bubble);
    scrollToBottom();

    return bubble;
  }

  /**
   * タイピングインジケーターを削除
   */
  function removeTypingIndicator() {
    var el = document.getElementById('rakuda-chat-typing');
    if (el) el.remove();
  }

  /**
   * チャットコンテナを最下部にスクロール
   */
  function scrollToBottom() {
    if (_els.container) {
      _els.container.scrollTop = _els.container.scrollHeight;
    }
  }

  /**
   * レートリミット警告を表示
   * @param {number} waitSec - 待ち秒数
   */
  function showRateLimitWarning(waitSec) {
    appendBubble('assistant', escapeHtml(
      '送信制限に達しました（' + RATE_LIMIT_PER_MIN + '回/分）。' +
      waitSec + '秒後に再度お試しください。'
    ));
  }

  /**
   * 入力欄の有効/無効を切り替え
   * @param {boolean} disabled
   */
  function setInputDisabled(disabled) {
    if (_els.input) _els.input.disabled = disabled;
    if (_els.sendBtn) _els.sendBtn.disabled = disabled;
  }

  // ============================================================
  //  SSE ストリーミング
  // ============================================================

  /**
   * Claude API にメッセージを送信し、SSEストリームを読み取る
   * @param {string} userText - ユーザーの入力テキスト
   */
  function streamResponse(userText) {
    _isSending = true;
    setInputDisabled(true);

    // ユーザーメッセージを表示・履歴に追加
    appendBubble('user', escapeHtml(userText));
    pushMessage('user', userText);

    // チャット開始イベントを発火（ABトラッカー連携）
    try {
      document.dispatchEvent(new CustomEvent('rakuda:chat_start'));
    } catch (e) {
      // CustomEvent 未対応環境は無視
    }

    // レートリミットチェック
    if (!checkRateLimit()) {
      var waitSec = getRateLimitWaitSeconds();
      showRateLimitWarning(waitSec);
      _isSending = false;
      setInputDisabled(false);
      return;
    }

    recordRequest();

    // タイピングインジケーター表示
    showTypingIndicator();

    // APIリクエスト用データ
    var requestBody = JSON.stringify({
      messages: _messages.slice(), // 履歴コピー（最新のuserメッセージを含む）
      page: _config.page
    });

    var apiUrl = (_config.apiBase || '') + '/api/chat';

    // AbortController でキャンセル可能に
    _currentAbort = new AbortController();

    fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: _currentAbort.signal
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('API error: ' + response.status);
        }

        // タイピングインジケーターを削除し、AI応答バブルを作成
        removeTypingIndicator();
        var aiInner = appendBubble('assistant', '');

        // SSE ストリームを読み取る
        var reader = response.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';       // 未処理の受信データバッファ
        var fullResponse = ''; // 完全な応答テキスト

        /**
         * ストリームを再帰的に読み取る
         */
        function readChunk() {
          reader.read().then(function (result) {
            if (result.done) {
              // ストリーム終了
              finishStream(fullResponse);
              return;
            }

            buffer += decoder.decode(result.value, { stream: true });

            // 行単位で処理（SSE形式: "data: ..." の行）
            var lines = buffer.split('\n');
            // 最後の不完全な行はバッファに残す
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();

              // 空行はスキップ
              if (!line) continue;

              // SSEコメント行はスキップ
              if (line.charAt(0) === ':') continue;

              // "data: " プレフィックスを処理
              if (line.indexOf('data: ') === 0) {
                var data = line.substring(6);

                // ストリーム終了シグナル
                if (data === '[DONE]') {
                  finishStream(fullResponse);
                  return;
                }

                // JSONデータをパース
                try {
                  var parsed = JSON.parse(data);
                  // Claude APIのレスポンス形式に対応
                  // content_block_delta の text、または直接 text フィールド
                  var text = '';
                  if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
                    text = parsed.delta.text;
                  } else if (parsed.text) {
                    text = parsed.text;
                  } else if (parsed.content) {
                    text = parsed.content;
                  } else if (typeof parsed === 'string') {
                    text = parsed;
                  }

                  if (text) {
                    fullResponse += text;
                    if (aiInner) {
                      aiInner.innerHTML = escapeHtml(fullResponse);
                      scrollToBottom();
                    }
                  }
                } catch (parseErr) {
                  // JSON以外のデータ行はプレーンテキストとして扱う
                  if (data && data !== '') {
                    fullResponse += data;
                    if (aiInner) {
                      aiInner.innerHTML = escapeHtml(fullResponse);
                      scrollToBottom();
                    }
                  }
                }
              }
            }

            // 次のチャンクを読む
            readChunk();
          }).catch(function (readErr) {
            // ストリーム読み取りエラー
            if (readErr.name === 'AbortError') return;
            removeTypingIndicator();
            handleStreamError(userText, fullResponse);
          });
        }

        readChunk();
      })
      .catch(function (fetchErr) {
        // fetch自体のエラー（ネットワーク障害等）
        if (fetchErr.name === 'AbortError') return;
        removeTypingIndicator();
        handleStreamError(userText, '');
      });
  }

  /**
   * ストリーム正常完了時の処理
   * @param {string} fullResponse - 完全な応答テキスト
   */
  function finishStream(fullResponse) {
    if (fullResponse) {
      pushMessage('assistant', fullResponse);
    }
    _isSending = false;
    _currentAbort = null;
    setInputDisabled(false);
    // 入力欄にフォーカスを戻す
    if (_els.input) _els.input.focus();
  }

  /**
   * ストリームエラー時の処理（フォールバック応答を使用）
   * @param {string} userText - ユーザーの入力テキスト（フォールバック選択用）
   * @param {string} partialResponse - 途中まで受信した応答
   */
  function handleStreamError(userText, partialResponse) {
    // 部分応答がある場合はそれを保存
    if (partialResponse) {
      pushMessage('assistant', partialResponse);
    } else {
      // フォールバック応答を表示
      var fallback = getFallbackResponse(userText);
      appendBubble('assistant', escapeHtml(fallback));
      pushMessage('assistant', fallback);
    }
    _isSending = false;
    _currentAbort = null;
    setInputDisabled(false);
    if (_els.input) _els.input.focus();
  }

  // ============================================================
  //  イベントハンドラ
  // ============================================================

  /**
   * キー入力ハンドラ（Enter / Cmd+Enter で送信）
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  }

  /**
   * 送信ボタンクリックハンドラ
   */
  function onSendClick() {
    sendMessage();
  }

  /**
   * メッセージ送信の共通処理
   */
  function sendMessage() {
    if (_isSending) return;
    if (!_els.input) return;

    var text = _els.input.value.trim();
    if (!text) return;

    // クライアント側文字数制限
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH);
    }

    _els.input.value = '';
    streamResponse(text);
  }

  // ============================================================
  //  クイックアクション
  // ============================================================

  /**
   * クイックアクションボタンを生成・配置
   * @param {Array<{label: string, text: string}>} actions
   */
  function setupQuickActions(actions) {
    if (!actions || actions.length === 0) return;
    if (!_els.container) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'chatbot-quick-actions';
    wrapper.id = 'rakuda-chat-quick-actions';

    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.className = 'chatbot-quick-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        // クイックアクションを削除
        var qa = document.getElementById('rakuda-chat-quick-actions');
        if (qa) qa.remove();
        // テキストを送信
        streamResponse(action.text);
      });
      wrapper.appendChild(btn);
    });

    _els.container.appendChild(wrapper);
  }

  /**
   * sessionStorage に保存済みの履歴をチャットUIに復元表示
   */
  function restoreHistory() {
    if (_messages.length === 0) return;
    for (var i = 0; i < _messages.length; i++) {
      var msg = _messages[i];
      appendBubble(msg.role === 'user' ? 'user' : 'assistant', escapeHtml(msg.content));
    }
  }

  // ============================================================
  //  公開API
  // ============================================================

  var RakudaChat = {

    /**
     * チャットモジュールを初期化
     * @param {Object} config - 設定オブジェクト
     * @param {string} [config.apiBase=''] - APIのベースURL
     * @param {string} config.page - ページ識別子（p1, p2 等）
     * @param {string} config.containerId - メッセージ表示領域のDOM ID
     * @param {string} config.inputId - テキスト入力欄のDOM ID
     * @param {string} config.sendBtnId - 送信ボタンのDOM ID
     * @param {Array<{label: string, text: string}>} [config.quickActions] - クイックアクション
     */
    init: function (config) {
      if (_initialized) {
        this.destroy();
      }

      // 設定を適用
      _config.apiBase = config.apiBase || (window.RAKUDA_API_BASE || '');
      _config.page = config.page || '';
      _config.containerId = config.containerId || 'chatbotMessages';
      _config.inputId = config.inputId || 'chatbotInput';
      _config.sendBtnId = config.sendBtnId || '';
      _config.quickActions = config.quickActions || [];

      // DOM要素を取得
      _els.container = document.getElementById(_config.containerId);
      _els.input = document.getElementById(_config.inputId);
      _els.sendBtn = _config.sendBtnId ? document.getElementById(_config.sendBtnId) : null;

      if (!_els.container) {
        console.warn('[RakudaChat] コンテナ要素が見つかりません: ' + _config.containerId);
        return;
      }

      if (!_els.input) {
        console.warn('[RakudaChat] 入力要素が見つかりません: ' + _config.inputId);
        return;
      }

      // sessionStorage から履歴を復元
      loadMessages();

      // 履歴があればUIに復元表示
      if (_messages.length > 0) {
        restoreHistory();
      } else {
        // クイックアクションを設置（履歴がない場合のみ）
        setupQuickActions(_config.quickActions);
      }

      // イベントリスナーを登録
      _els.input.addEventListener('keydown', onKeyDown);
      if (_els.sendBtn) {
        _els.sendBtn.addEventListener('click', onSendClick);
      }

      _initialized = true;
    },

    /**
     * メッセージを送信
     * 外部から直接テキストを送信する場合に使用
     * @param {string} text - 送信するテキスト
     */
    send: function (text) {
      if (!_initialized) {
        console.warn('[RakudaChat] 初期化されていません。先に init() を呼んでください。');
        return;
      }
      if (!text || !text.trim()) return;
      if (_isSending) return;

      streamResponse(text.trim());
    },

    /**
     * モジュールを破棄（イベントリスナー解除・状態リセット）
     */
    destroy: function () {
      // 進行中のストリームをキャンセル
      if (_currentAbort) {
        _currentAbort.abort();
        _currentAbort = null;
      }

      // イベントリスナーを解除
      if (_els.input) {
        _els.input.removeEventListener('keydown', onKeyDown);
      }
      if (_els.sendBtn) {
        _els.sendBtn.removeEventListener('click', onSendClick);
      }

      // 状態リセット
      _els.container = null;
      _els.input = null;
      _els.sendBtn = null;
      _messages = [];
      _requestTimestamps = [];
      _isSending = false;
      _initialized = false;
    }
  };

  // グローバルに公開
  window.RakudaChat = RakudaChat;

})();
