/**
 * The first-run setup wizard page, embedded as a single self-contained string
 * (no build step, no external assets — the setup server's CSP allows nothing
 * off-origin anyway). Served by setup/server.ts on every non-API path.
 *
 * Design: a short "agent coming online" sequence. Completed steps collapse
 * into a stack of verified receipts, and a first-person status line narrates
 * progress — the user meets the product's voice during setup. Sky = Telegram
 * actions, peach = the agent/Claude, mint = verified.
 */
export function wizardHtml(): string {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MyAgens setup</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2308131a'/%3E%3Cpath d='M32 16 50 26.5 32 37 14 26.5 Z' fill='%23a5ddef'/%3E%3Cpath d='M14 26.5 32 37 V53 L14 42.5 Z' fill='%233ec7e6'/%3E%3Cpath d='M50 26.5 32 37 V53 L50 42.5 Z' fill='%230a97b7'/%3E%3Ccircle cx='51' cy='11' r='4' fill='%236cd6ee'/%3E%3Ccircle cx='51' cy='11' r='7.5' stroke='%236cd6ee' stroke-width='1.8' fill='none'/%3E%3C/svg%3E">
<style>
  :root{
    --ink:#0e141b; --panel:#161e27; --panel2:#1b2531; --line:#24303c;
    --paper:#e8edf2; --dim:#8a99a8; --sky:#4ca9f5; --sky-deep:#2e8ee0;
    --peach:#f5a97f; --mint:#7fd8a4; --red:#f28b82;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{background:var(--ink)}
  body{
    font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;
    color:var(--paper); min-height:100vh; display:flex; justify-content:center;
    padding:40px 20px 80px;
  }
  .wrap{width:100%;max-width:560px}
  header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px}
  .mark{font-weight:700;letter-spacing:.02em;font-size:14px;color:var(--dim)}
  .mark b{color:var(--paper)}
  .steps{font:11px/1 var(--mono);color:var(--dim);letter-spacing:.08em;text-transform:uppercase}
  .steps span{opacity:.45}
  .steps span.on{opacity:1;color:var(--sky)}
  .steps span.done{opacity:.8;color:var(--mint)}
  h1{font-size:30px;line-height:1.15;font-weight:750;letter-spacing:-.02em;margin:26px 0 6px}
  .sub{color:var(--dim);margin-bottom:26px}

  /* Atlas voice — first-person status line */
  .voice{
    display:flex;gap:10px;align-items:flex-start;
    border-left:2px solid var(--peach); padding:10px 14px; margin:0 0 22px;
    background:linear-gradient(90deg,rgba(245,169,127,.07),transparent 70%);
    border-radius:0 10px 10px 0; color:var(--peach); font-size:14px;
  }
  .voice .dot{width:8px;height:8px;border-radius:50%;background:var(--peach);margin-top:6px;flex:none}
  .voice.listening .dot{animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
  @media (prefers-reduced-motion:reduce){.voice .dot{animation:none!important}.card{animation:none!important}}

  /* receipts — verified facts accumulate */
  .receipt{
    display:flex;align-items:center;gap:10px;
    padding:9px 14px;margin-bottom:8px;border:1px solid var(--line);
    border-radius:10px;background:var(--panel);color:var(--dim);font-size:13.5px;
  }
  .receipt .tick{color:var(--mint);font-weight:700}
  .receipt b{color:var(--paper);font-weight:600}
  .receipt code{font-family:var(--mono);font-size:12.5px;color:var(--paper)}

  .card{
    border:1px solid var(--line);border-radius:14px;background:var(--panel);
    padding:22px;margin-top:14px;animation:rise .18s ease-out;
  }
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .card h2{font-size:18px;font-weight:700;letter-spacing:-.01em;margin-bottom:4px}
  .card .why{color:var(--dim);font-size:13.5px;margin-bottom:16px}
  .how{margin:0 0 16px;padding:0;list-style:none;counter-reset:n}
  .how li{
    counter-increment:n;position:relative;padding:6px 0 6px 34px;color:var(--paper);font-size:14px;
  }
  .how li::before{
    content:counter(n);position:absolute;left:0;top:6px;width:22px;height:22px;
    border:1px solid var(--line);border-radius:50%;display:flex;align-items:center;justify-content:center;
    font:11px var(--mono);color:var(--dim);
  }
  .how a{color:var(--sky);text-decoration:none}
  .how a:hover{text-decoration:underline}

  label{display:block;font-size:12px;color:var(--dim);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
  input[type=text],input[type=password],select{
    width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);
    background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:13.5px;outline:none;
  }
  input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{
    outline:2px solid var(--sky);outline-offset:2px;
  }
  .row{display:flex;gap:10px;margin-top:12px}
  .row input{flex:1}
  button{
    font:600 14px/1 inherit;padding:12px 18px;border-radius:10px;border:0;cursor:pointer;
    background:var(--sky);color:#08111a;transition:background .12s;
  }
  button:hover{background:var(--sky-deep)}
  button:disabled{opacity:.45;cursor:default}
  button.ghost{background:transparent;color:var(--sky);border:1px solid var(--line)}
  button.ghost:hover{background:var(--panel2)}
  .linkline{margin-top:14px;font-size:13px;color:var(--dim);text-align:center}
  .linkline a,.linkline button{background:none;border:0;color:var(--dim);text-decoration:underline;cursor:pointer;font:inherit;padding:0}
  .err{color:var(--red);font-size:13.5px;margin-top:10px;display:none}
  .warn{color:var(--peach);font-size:13.5px;margin-top:10px}

  /* candidate cards */
  .people{margin-top:14px;display:flex;flex-direction:column;gap:8px}
  .person{
    display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);
    border-radius:12px;background:var(--panel2);
  }
  .person .av{
    width:36px;height:36px;border-radius:50%;background:var(--sky);color:#08111a;
    display:flex;align-items:center;justify-content:center;font-weight:700;flex:none;
  }
  .person .who{flex:1;min-width:0}
  .person .who b{display:block;font-size:14px}
  .person .who span{font-size:12.5px;color:var(--dim);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .waiting{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:13.5px;margin-top:14px}
  .waiting .dot{width:8px;height:8px;border-radius:50%;background:var(--sky);animation:pulse 1.6s infinite}

  .choice{display:flex;flex-direction:column;gap:10px}
  .choice button{width:100%;text-align:left;padding:13px 15px;background:var(--panel2);color:var(--paper);border:1px solid var(--line);display:flex;gap:13px;align-items:center}
  .choice button:hover{border-color:var(--sky);background:var(--panel2)}
  .choice button:hover .ci{border-color:var(--sky)}
  .choice .ci{
    width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;
    border-radius:10px;background:var(--ink);border:1px solid var(--line);color:var(--sky);transition:border-color .12s;
  }
  .choice .ci svg{width:19px;height:19px}
  .choice .ct{flex:1;min-width:0;font-weight:600}
  .choice small{display:block;color:var(--dim);font-weight:400;margin-top:2px}

  .models{display:flex;flex-direction:column;gap:8px;margin:6px 0 18px}
  .models label{all:unset;display:flex;gap:10px;align-items:center;padding:11px 14px;border:1px solid var(--line);border-radius:10px;cursor:pointer;font-size:14px}
  .models label:has(input:checked){border-color:var(--sky);background:var(--panel2)}
  .models input{accent-color:var(--sky)}
  .models small{color:var(--dim)}

  .keybox{
    margin-top:14px;padding:12px 14px;border:1px dashed var(--line);border-radius:10px;
    font-family:var(--mono);font-size:12.5px;word-break:break-all;color:var(--paper);background:var(--ink);
  }
  .copy{margin-left:8px;padding:4px 10px;font-size:12px;background:var(--panel2);color:var(--sky);border:1px solid var(--line)}

  /* highlighted help callout (e.g. sign in from a terminal) */
  .callout{
    border:1px solid var(--line);border-left:3px solid var(--sky);border-radius:12px;
    background:linear-gradient(180deg,var(--panel2),var(--panel));padding:16px 18px;margin-top:16px;
  }
  .callout-h{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14.5px;margin-bottom:5px}
  .callout-i{
    width:24px;height:24px;border-radius:7px;background:rgba(76,169,245,.16);color:var(--sky);
    display:flex;align-items:center;justify-content:center;font-size:13px;flex:none;
  }
  .callout .why{margin:0 0 14px}
  .callout .how{margin-bottom:14px}
  .callout .how li{padding-top:5px;padding-bottom:5px}
  /* copyable command chip */
  .cmd{
    display:flex;align-items:center;gap:8px;margin-top:8px;padding:9px 12px;border:1px solid var(--line);
    border-radius:9px;background:var(--ink);font-family:var(--mono);font-size:12.5px;color:var(--paper);word-break:break-all;
  }
  .cmd code{flex:1;font-family:var(--mono);color:var(--paper)}
  .cmd .copy{margin-left:auto;flex:none}
  .kbd{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;color:var(--sky)}
  .btn-wide{width:100%;margin-top:2px}
  details{margin-top:16px}
  summary{cursor:pointer;color:var(--dim);font-size:13px}
  .hidden{display:none!important}
  footer{margin-top:34px;text-align:center;font-size:12px;color:var(--dim)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark"><b>MyAgens</b> setup</div>
    <div class="steps" id="steps"></div>
  </header>

  <h1 id="title">Let’s bring your agent online.</h1>
  <p class="sub" id="subtitle">Four short steps. Everything is checked as you go, so nothing can be saved with a typo in it.</p>

  <div class="voice" id="voice" aria-live="polite"><span class="dot"></span><span id="voiceText">Hi, I’m your agent. First I need a Telegram body to live in.</span></div>

  <div id="receipts"></div>
  <div id="stage"></div>

  <footer>Running privately on this computer · nothing here leaves your machine except the checks you trigger</footer>
</div>

<script>
(function(){
  'use strict';

  // ---- evict stale service workers ----------------------------------------
  // A previous install's panel may have registered its PWA service worker on
  // this origin+port. It intercepts every fetch this page makes (replaying
  // cached empty API responses) and serves the cached dashboard for bare "/"
  // navigations. Unregister it, purge Cache Storage, and — if this page load
  // is still controlled by it — reload once so fetches go to the network.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(rs){
      if (!rs.length) return;
      Promise.all(rs.map(function(r){ return r.unregister().catch(function(){}); })).then(function(){
        var purge = (typeof caches !== 'undefined' && caches.keys)
          ? caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return caches.delete(k); })); }).catch(function(){})
          : Promise.resolve();
        purge.then(function(){
          var GUARD = 'myagens.setup.swReloaded';
          var done = false;
          try { done = sessionStorage.getItem(GUARD) === '1'; sessionStorage.setItem(GUARD, '1'); } catch(e){ done = true; }
          if (navigator.serviceWorker.controller && !done) location.reload();
        });
      });
    }).catch(function(){});
  }

  // ---- setup key ----------------------------------------------------------
  var KEY_STORE = 'myagens.setup.key';
  var url = new URL(location.href);
  var k = url.searchParams.get('k');
  if (k) {
    // Only strip the key from the address bar once sessionStorage provably
    // holds it — otherwise a refresh (private browsing, storage disabled)
    // would lose the key and dead-end the wizard.
    var stored = false;
    try { sessionStorage.setItem(KEY_STORE, k); stored = sessionStorage.getItem(KEY_STORE) === k; } catch(e){}
    if (stored) {
      url.searchParams.delete('k');
      history.replaceState(null, '', url.pathname + (url.search || ''));
    }
  }
  var setupKey = k || (function(){ try { return sessionStorage.getItem(KEY_STORE); } catch(e){ return null; } })();

  function api(path, body){
    // cache:'no-store' — polled GETs must never be satisfied from a previous
    // (possibly previous-boot) response; the server sends no-store too.
    var opts = { method: body ? 'POST' : 'GET', headers: { 'x-setup-key': setupKey || '' }, cache: 'no-store' };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/setup/api/' + path, opts).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok) { var e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
        return data;
      });
    });
  }

  // ---- tiny dom helpers ---------------------------------------------------
  function el(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); }
  function voice(text, listening){
    el('voiceText').textContent = text;
    el('voice').classList.toggle('listening', !!listening);
  }
  function receipt(html){
    var d = document.createElement('div');
    d.className = 'receipt';
    d.innerHTML = '<span class="tick">✓</span><span>' + html + '</span>';
    el('receipts').appendChild(d);
  }
  function stage(html){ el('stage').innerHTML = '<div class="card">' + html + '</div>'; }
  function err(id, msg){ var n = el(id); if (n){ n.textContent = msg || ''; n.style.display = msg ? 'block' : 'none'; } }

  var STEP_NAMES = ['bot','you','claude','launch'];
  var stepIdx = 0;
  function markStep(i){
    stepIdx = i;
    el('steps').innerHTML = STEP_NAMES.map(function(n, j){
      var cls = j < i ? 'done' : (j === i ? 'on' : '');
      return '<span class="' + cls + '">' + n + '</span>';
    }).join(' · ');
  }

  var state = { bot: null, user: null, claudeMethod: 'none', models: [], defaultModel: '' };
  var pollTimer = null;
  function stopPolling(){ if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---- step 1: bot token --------------------------------------------------
  function showBotStep(){
    markStep(0);
    voice('First I need a Telegram body to live in. It takes about a minute to make one.');
    stage(
      '<h2>Create your bot</h2>' +
      '<p class="why">Your agent talks to you through its own Telegram bot. Telegram’s official BotFather creates one for free.</p>' +
      '<ol class="how">' +
        '<li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram</li>' +
        '<li>Send <a href="https://t.me/BotFather" target="_blank" rel="noopener">/newbot</a> and follow the two questions (any name works)</li>' +
        '<li>Copy the token it gives you and paste it below</li>' +
      '</ol>' +
      '<p class="linkline"><a href="https://myagens.com/help/create-telegram-bot-botfather" target="_blank" rel="noopener">New to this? Step-by-step guide with screenshots →</a></p>' +
      '<label for="botToken">Bot token</label>' +
      '<div class="row">' +
        '<input id="botToken" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:AbCd…">' +
        '<button id="botVerify">Verify</button>' +
      '</div>' +
      '<p class="err" id="botErr"></p>'
    );
    var input = el('botToken');
    input.focus();
    function go(){
      err('botErr', '');
      var btn = el('botVerify');
      btn.disabled = true; btn.textContent = 'Checking…';
      api('telegram/token', { token: input.value }).then(function(r){
        state.bot = { username: r.username, name: r.name };
        receipt('Bot verified: <b>@' + esc(r.username) + '</b>');
        showYouStep();
      }).catch(function(e){
        btn.disabled = false; btn.textContent = 'Verify';
        err('botErr', e.message);
      });
    }
    el('botVerify').addEventListener('click', go);
    input.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') go(); });
  }

  // ---- step 2: who are you ------------------------------------------------
  function showYouStep(){
    markStep(1);
    voice('I’m listening on Telegram… open the chat and press START so I know it’s you.', true);
    stage(
      '<h2>Prove it’s you</h2>' +
      '<p class="why">Only you will be allowed to command this agent. Press START in your bot’s chat and you’ll appear here, no IDs to look up.</p>' +
      '<div class="row" style="margin-top:0">' +
        '<button id="openBot" style="flex:1">Open @' + esc(state.bot.username) + ' in Telegram</button>' +
      '</div>' +
      '<p class="why" style="margin:10px 0 0">On your phone instead? Search for <b style="color:var(--paper)">@' + esc(state.bot.username) + '</b> in Telegram and press START.</p>' +
      '<div class="waiting" id="waiting"><span class="dot"></span> Waiting for you to say hi…</div>' +
      '<div class="people" id="people"></div>' +
      '<p class="warn hidden" id="pollWarn"></p>' +
      '<p class="warn hidden" id="stuckHint">Messaged the bot but nothing shows up? Telegram hands each message to only one listener. If this token is already used by a running bot or an older install, stop that one (or make a fresh bot with @BotFather) and send another message. You can also enter your user ID manually below.</p>' +
      '<p class="err" id="youErr"></p>' +
      '<details><summary>Enter your Telegram user ID manually</summary>' +
        '<div class="row"><input id="manualId" type="text" inputmode="numeric" placeholder="e.g. 123456789"><button id="manualGo" class="ghost">Confirm</button></div>' +
      '</details>'
    );
    el('openBot').addEventListener('click', function(){
      window.open('https://t.me/' + state.bot.username, '_blank', 'noopener');
    });
    function confirm(id, label){
      err('youErr', '');
      api('telegram/confirm', { userId: id }).then(function(){
        stopPolling();
        state.user = { id: id, label: label };
        receipt('That’s you: <b>' + esc(label) + '</b> <code>' + esc(String(id)) + '</code> (check Telegram for a ✅)');
        showClaudeStep();
      }).catch(function(e){ err('youErr', e.message); });
    }
    el('manualGo').addEventListener('click', function(){
      var v = parseInt(el('manualId').value, 10);
      if (!v || v <= 0) { err('youErr', 'A Telegram user ID is a positive number.'); return; }
      confirm(v, 'you');
    });
    function render(list){
      var box = el('people');
      box.innerHTML = list.map(function(c){
        var name = (c.firstName || '') + (c.lastName ? ' ' + c.lastName : '');
        return '<div class="person">' +
          '<div class="av">' + esc((name || '?').charAt(0).toUpperCase()) + '</div>' +
          '<div class="who"><b>' + esc(name || 'Unknown') + (c.username ? ' · @' + esc(c.username) : '') + '</b>' +
          '<span>' + esc(String(c.id)) + (c.lastText ? ': “' + esc(c.lastText) + '”' : '') + '</span></div>' +
          '<button data-id="' + c.id + '" data-name="' + esc(name || ('id ' + c.id)) + '">That’s me</button>' +
        '</div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('button'), function(b){
        b.addEventListener('click', function(){ confirm(parseInt(b.getAttribute('data-id'), 10), b.getAttribute('data-name')); });
      });
      el('waiting').classList.toggle('hidden', list.length > 0);
    }
    stopPolling();
    var waitingSince = Date.now();
    var pollFails = 0;
    pollTimer = setInterval(function(){
      api('telegram/candidates').then(function(r){
        pollFails = 0;
        var list = r.candidates || [];
        render(list);
        var w = el('pollWarn');
        if (w){ w.textContent = r.warning || ''; w.classList.toggle('hidden', !r.warning); }
        var h = el('stuckHint');
        if (h){ h.classList.toggle('hidden', list.length > 0 || !!r.warning || Date.now() - waitingSince < 20000); }
      }).catch(function(e){
        // Transient errors happen; a stale tab (setup was restarted — this
        // tab's key belongs to the old run) or a gone server fails forever.
        pollFails++;
        if (pollFails < 5) return;
        var w = el('pollWarn');
        if (w){
          w.textContent = (e.status === 401 || e.status === 410)
            ? 'This tab belongs to an older setup run. Open the newest link shown in the terminal window.'
            : 'Can\\'t reach the setup service. Is the terminal window still open?';
          w.classList.remove('hidden');
        }
      });
    }, 2000);
  }

  // ---- step 3: claude -----------------------------------------------------
  function showClaudeStep(){
    markStep(2);
    stopPolling();
    voice('Now connect my brain. A Claude subscription or an API key, either one works.');
    stage(
      '<h2>Connect Claude</h2>' +
      '<p class="why">This is the AI that does the thinking. Checking for an existing sign-in…</p>' +
      '<div id="claudeBody"></div>' +
      '<p class="err" id="claudeErr"></p>'
    );
    api('claude/status').then(function(s){
      if (s.loggedIn) {
        state.claudeMethod = 'cli';
        el('claudeBody').innerHTML =
          '<div class="receipt" style="margin:0 0 14px"><span class="tick">✓</span><span>Already signed in' +
          (s.email ? ' as <b>' + esc(s.email) + '</b>' : '') + (s.subscriptionType ? ' (' + esc(s.subscriptionType) + ')' : '') +
          '</span></div><button id="claudeNext">Continue</button>';
        el('claudeNext').addEventListener('click', function(){
          receipt('Claude connected: <b>' + esc(s.email || 'existing sign-in') + '</b>');
          showLaunchStep();
        });
      } else {
        claudeChoices(s.cliInstalled);
      }
    }).catch(function(){ claudeChoices(false); });
  }

  // Three sibling ways to connect, none escalating into another:
  //  browser  — drives claude setup-token in-browser (needs the CLI present)
  //  terminal — the user runs claude + /login themselves, then we recheck
  //  api key  — pay-as-you-go console key (a different billing category)
  // All three land the same credential the SDK reads; browser vs terminal are
  // just two ways to create the same Pro/Max OAuth login.
  var SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var CICON = {
    browser: '<svg ' + SVG + '><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>',
    terminal: '<svg ' + SVG + '><rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="12.5" y1="15" x2="17" y2="15"/></svg>',
    key: '<svg ' + SVG + '><circle cx="8" cy="8" r="4.5"/><line x1="11.2" y1="11.2" x2="20" y2="20"/><line x1="19.2" y1="14" x2="16.7" y2="16.5"/></svg>'
  };
  function choiceBtn(id, cls, icon, title, sub){
    return '<button id="' + id + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      '<span class="ci">' + icon + '</span>' +
      '<span class="ct">' + title + '<small>' + sub + '</small></span></button>';
  }
  function claudeChoices(cliInstalled){
    el('claudeBody').innerHTML =
      '<div class="choice">' +
        choiceBtn('optBrowser', '', CICON.browser, 'Sign in in your browser', 'One-click with your Claude Pro or Max subscription. The easiest way.') +
        choiceBtn('optTerminal', '', CICON.terminal, 'Sign in from a terminal', 'Prefer the command line? Use the Claude app’s /login') +
        choiceBtn('optKey', '', CICON.key, 'Use an API key', 'Pay-as-you-go key from console.anthropic.com. Not your Pro or Max subscription.') +
      '</div><div id="claudeFlow"></div>';
    el('optBrowser').addEventListener('click', cliInstalled ? startPlanLogin : browserNeedsCli);
    el('optTerminal').addEventListener('click', function(){ showTerminalLogin(cliInstalled); });
    el('optKey').addEventListener('click', showKeyEntry);
  }

  function cmdChip(cmd){
    return '<div class="cmd"><code>' + esc(cmd) + '</code>' +
      '<button class="copy" type="button" data-copy="' + esc(cmd) + '">copy</button></div>';
  }
  function wireCopies(){
    Array.prototype.forEach.call(el('claudeFlow').querySelectorAll('.copy'), function(b){
      b.addEventListener('click', function(){
        try { navigator.clipboard && navigator.clipboard.writeText(b.getAttribute('data-copy')); } catch(e){}
        var t = b.textContent; b.textContent = 'copied'; setTimeout(function(){ b.textContent = t; }, 1200);
      });
    });
  }

  // The in-browser sign-in drives the Claude CLI (claude setup-token); with no
  // CLI present it cannot run, so point at the terminal option (which installs
  // it) rather than dead-ending. This is guidance, not a silent hand-off.
  function browserNeedsCli(){
    stopPolling();
    err('claudeErr', '');
    el('claudeFlow').innerHTML =
      '<div class="callout">' +
        '<div class="callout-h"><span class="callout-i">!</span>Install the Claude app first</div>' +
        '<p class="why">The one-click browser sign-in runs the Claude command-line app, which isn’t installed here yet. Choose <b>“Sign in from a terminal”</b> above. It installs the app and signs you in. Or install it and reload this page.</p>' +
      '</div>';
  }

  // Explicit terminal path: the user signs in with claude + /login themselves.
  // Recheck ONLY confirms the login landed — it never falls through to the
  // browser flow, so the two methods stay cleanly separate.
  function showTerminalLogin(cliInstalled){
    stopPolling();
    err('claudeErr', '');
    var installStep = cliInstalled ? '' :
      '<li>Install the Claude app:' + cmdChip('npm install -g @anthropic-ai/claude-code') + '</li>';
    el('claudeFlow').innerHTML =
      '<div class="callout">' +
        '<div class="callout-h"><span class="callout-i">⌘</span>Sign in from a terminal</div>' +
        '<p class="why">Signs in with your Pro or Max subscription using the Claude command-line app. It only takes a minute.</p>' +
        '<ol class="how">' +
          '<li>Open a terminal (Command Prompt, PowerShell, or Terminal)</li>' +
          installStep +
          '<li>Enter <span class="kbd">claude</span> to start it, then type <span class="kbd">/login</span> and follow the steps in your browser:' + cmdChip('claude') + '</li>' +
          '<li>Come back here and press <b>Recheck</b> below</li>' +
        '</ol>' +
        '<button id="claudeRecheck" class="btn-wide">Recheck for sign-in</button>' +
      '</div>';
    wireCopies();
    el('claudeRecheck').addEventListener('click', function(){
      var b = el('claudeRecheck');
      b.disabled = true; b.textContent = 'Checking…';
      api('claude/status').then(function(s){
        if (s.loggedIn) {
          state.claudeMethod = 'cli';
          receipt('Claude connected: <b>' + esc(s.email || 'subscription sign-in') + '</b>');
          showLaunchStep();
        } else {
          b.disabled = false; b.textContent = 'Recheck for sign-in';
          err('claudeErr', 'Not signed in yet. Finish the /login step above, then press Recheck.');
        }
      }).catch(function(e){ b.disabled = false; b.textContent = 'Recheck for sign-in'; err('claudeErr', e.message); });
    });
  }

  function startPlanLogin(){
    err('claudeErr', '');
    el('claudeFlow').innerHTML = '<div class="waiting"><span class="dot"></span> Starting Anthropic sign-in…</div>';
    api('claude/login', {}).then(function(){
      var shownUrl = false;
      stopPolling();
      pollTimer = setInterval(function(){
        api('claude/login/status').then(function(st){
          if (st.loggedIn) {
            stopPolling();
            state.claudeMethod = 'cli';
            receipt('Claude connected: <b>subscription sign-in</b>');
            showLaunchStep();
            return;
          }
          if (st.url && !shownUrl) {
            shownUrl = true;
            el('claudeFlow').innerHTML =
              '<ol class="how" style="margin-top:14px">' +
                '<li><a href="' + esc(st.url) + '" target="_blank" rel="noopener">Open the Anthropic sign-in page</a> and approve</li>' +
                '<li>Copy the code it shows you</li>' +
                '<li>Paste it here</li>' +
              '</ol>' +
              '<div class="row"><input id="oauthCode" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the code"><button id="codeGo">Connect</button></div>';
            el('codeGo').addEventListener('click', function(){
              api('claude/login/code', { code: el('oauthCode').value }).catch(function(e){ err('claudeErr', e.message); });
              el('codeGo').textContent = 'Checking…';
            });
          }
          if (!st.running && st.exitCode !== 0 && st.exitCode !== undefined && st.exitCode !== null && !st.loggedIn) {
            stopPolling();
            err('claudeErr', st.error || 'Sign-in didn’t finish. Try again, or use an API key instead.');
            el('claudeFlow').innerHTML = '';
          }
        }).catch(function(){});
      }, 1200);
    }).catch(function(e){ err('claudeErr', e.message); });
  }

  function showKeyEntry(){
    stopPolling();
    err('claudeErr', '');
    el('claudeFlow').innerHTML =
      '<label for="apiKey" style="margin-top:16px">Anthropic API key</label>' +
      '<div class="row" style="margin-top:6px"><input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"><button id="keyGo">Verify</button></div>';
    el('apiKey').focus();
    el('keyGo').addEventListener('click', function(){
      var btn = el('keyGo');
      btn.disabled = true; btn.textContent = 'Checking…';
      api('claude/apikey', { key: el('apiKey').value }).then(function(){
        state.claudeMethod = 'apikey';
        receipt('Claude connected: <b>API key verified</b>');
        showLaunchStep();
      }).catch(function(e){
        btn.disabled = false; btn.textContent = 'Verify';
        err('claudeErr', e.message);
      });
    });
  }

  // ---- step 4: launch -----------------------------------------------------
  var MODEL_META = {
    'claude-sonnet-5': ['Claude Sonnet 5', 'fast and capable, recommended'],
    'claude-opus-4-8': ['Claude Opus 4.8', 'smartest, higher cost'],
    'claude-haiku-4-5-20251001': ['Claude Haiku 4.5', 'light and cheap']
  };
  function showLaunchStep(){
    markStep(3);
    stopPolling();
    voice('Everything checks out. Pick my brain size and launch me.');
    var models = state.models.length ? state.models : Object.keys(MODEL_META);
    stage(
      '<h2>Launch</h2>' +
      '<p class="why">You can change the model any time later. This is just the starting point.</p>' +
      '<div class="models">' + models.map(function(m){
        var meta = MODEL_META[m] || [m, ''];
        return '<label><input type="radio" name="model" value="' + esc(m) + '"' + (m === (state.defaultModel || 'claude-sonnet-5') ? ' checked' : '') + '>' +
          '<span>' + esc(meta[0]) + ' <small>· ' + esc(meta[1]) + '</small></span></label>';
      }).join('') + '</div>' +
      '<button id="launch" style="width:100%">Launch my agent</button>' +
      '<p class="err" id="launchErr"></p>'
    );
    el('launch').addEventListener('click', function(){
      var btn = el('launch');
      btn.disabled = true; btn.textContent = 'Saving…';
      var model = (document.querySelector('input[name=model]:checked') || {}).value;
      api('finish', { model: model }).then(function(r){
        waitForPanel(r.panelPath);
      }).catch(function(e){
        btn.disabled = false; btn.textContent = 'Launch my agent';
        err('launchErr', e.message);
      });
    });
  }

  function waitForPanel(panelPath){
    var token = (panelPath.split('token=')[1] || '');
    var panelUrl = location.origin + panelPath;
    voice('Starting up… this can take a minute the first time.', true);
    stage(
      '<h2>Starting your agent</h2>' +
      '<p class="why">The background service is being installed and started. You’ll be signed in to the control panel automatically.</p>' +
      '<div class="waiting"><span class="dot"></span> <span id="bootMsg">Waiting for the agent to come online…</span></div>' +
      '<label style="margin-top:18px">Your panel login link, save it</label>' +
      '<div class="keybox" id="panelLink">' + esc(panelUrl) + '<button class="copy" id="copyLink" type="button">copy</button></div>' +
      '<p class="why" style="margin-top:10px">Also sent to you on Telegram. It only works on this computer.</p>'
    );
    el('copyLink').addEventListener('click', function(){
      navigator.clipboard && navigator.clipboard.writeText(panelUrl);
      el('copyLink').textContent = 'copied';
    });
    var started = Date.now();
    var t = setInterval(function(){
      fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } }).then(function(res){
        if (res.ok) {
          clearInterval(t);
          voice('I’m online. See you inside, and on Telegram.');
          el('bootMsg').textContent = 'Online! Redirecting…';
          setTimeout(function(){ location.href = panelPath; }, 900);
        }
      }).catch(function(){ /* still restarting */ });
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(t);
        el('bootMsg').textContent = 'This is taking longer than expected. Keep this page open and try your panel link above in a minute, or check the terminal window.';
      }
    }, 2000);
  }

  // ---- boot ---------------------------------------------------------------
  markStep(0);
  if (!setupKey) {
    stage('<h2>Open the setup link</h2><p class="why">For your security this page only works with the private link shown in the terminal window. It looks like <code style="font-family:var(--mono)">http://127.0.0.1:…/?k=…</code>. Copy it into this browser.</p>');
    voice('I can’t let just any page configure me. Use the link from the terminal.');
  } else {
    api('state').then(function(s){
      state.models = s.models || [];
      state.defaultModel = s.defaultModel || 'claude-sonnet-5';
      if (s.bot) { state.bot = s.bot; receipt('Bot verified: <b>@' + esc(s.bot.username) + '</b>'); }
      if (s.confirmedUser) {
        state.user = s.confirmedUser;
        receipt('That’s you: <b>' + esc(s.confirmedUser.firstName || 'you') + '</b> <code>' + esc(String(s.confirmedUser.id)) + '</code>');
      }
      state.claudeMethod = s.claudeMethod || 'none';
      if (!s.bot) showBotStep();
      else if (!s.confirmedUser) showYouStep();
      else if (state.claudeMethod === 'none') showClaudeStep();
      else showLaunchStep();
    }).catch(function(e){
      if (e.status === 410) {
        stage('<h2>Setup is already done</h2><p class="why">This agent is configured. <a href="/" style="color:var(--sky)">Open the panel</a>.</p>');
        voice('I’m already set up. Head to the panel.');
      } else if (e.status === 401) {
        stage('<h2>Open the setup link</h2><p class="why">This page only works with the private link shown in the terminal window. Copy that link into this browser.</p>');
        voice('That link isn’t mine. Use the one from the terminal.');
      } else {
        stage('<h2>Connection problem</h2><p class="why">Couldn’t reach the setup service. Is the terminal window still open?</p>');
      }
    });
  }
})();
</script>
</body>
</html>
`;
