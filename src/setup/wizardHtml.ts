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
  .choice button{width:100%;text-align:left;padding:14px 16px;background:var(--panel2);color:var(--paper);border:1px solid var(--line)}
  .choice button:hover{border-color:var(--sky);background:var(--panel2)}
  .choice small{display:block;color:var(--dim);font-weight:400;margin-top:3px}

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
        receipt('Bot verified — <b>@' + esc(r.username) + '</b>');
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
      '<p class="why">Only you will be allowed to command this agent. Press START in your bot’s chat and you’ll appear here — no IDs to look up.</p>' +
      '<div class="row" style="margin-top:0">' +
        '<button id="openBot" style="flex:1">Open @' + esc(state.bot.username) + ' in Telegram</button>' +
      '</div>' +
      '<p class="why" style="margin:10px 0 0">On your phone instead? Search for <b style="color:var(--paper)">@' + esc(state.bot.username) + '</b> in Telegram and press START.</p>' +
      '<div class="waiting" id="waiting"><span class="dot"></span> Waiting for you to say hi…</div>' +
      '<div class="people" id="people"></div>' +
      '<p class="warn hidden" id="pollWarn"></p>' +
      '<p class="warn hidden" id="stuckHint">Messaged the bot but nothing shows up? Telegram hands each message to only one listener — if this token is already used by a running bot or an older install, stop that one (or make a fresh bot with @BotFather) and send another message. You can also enter your user ID manually below.</p>' +
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
        receipt('That’s you — <b>' + esc(label) + '</b> <code>' + esc(String(id)) + '</code> (check Telegram for a ✅)');
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
          '<span>' + esc(String(c.id)) + (c.lastText ? ' — “' + esc(c.lastText) + '”' : '') + '</span></div>' +
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
            : 'Can\\'t reach the setup service — is the terminal window still open?';
          w.classList.remove('hidden');
        }
      });
    }, 2000);
  }

  // ---- step 3: claude -----------------------------------------------------
  function showClaudeStep(){
    markStep(2);
    stopPolling();
    voice('Now connect my brain. A Claude subscription or an API key — either works.');
    stage(
      '<h2>Connect Claude</h2>' +
      '<p class="why">This is the AI that does the thinking. Checking for an existing sign-in…</p>' +
      '<div id="claudeBody"></div>' +
      '<p class="err" id="claudeErr"></p>' +
      '<p class="linkline"><button id="claudeSkip" type="button">Skip for now — I’ll connect it later in the panel</button></p>'
    );
    el('claudeSkip').addEventListener('click', function(){
      api('claude/skip', {}).then(function(){
        receipt('Claude connection <b>skipped</b> — add it in the panel before first chat');
        state.claudeMethod = 'skipped';
        showLaunchStep();
      }).catch(function(e){ err('claudeErr', e.message); });
    });
    api('claude/status').then(function(s){
      if (s.loggedIn) {
        state.claudeMethod = 'cli';
        el('claudeBody').innerHTML =
          '<div class="receipt" style="margin:0 0 14px"><span class="tick">✓</span><span>Already signed in' +
          (s.email ? ' as <b>' + esc(s.email) + '</b>' : '') + (s.subscriptionType ? ' (' + esc(s.subscriptionType) + ')' : '') +
          '</span></div><button id="claudeNext">Continue</button>';
        el('claudeNext').addEventListener('click', function(){
          receipt('Claude connected — <b>' + esc(s.email || 'existing sign-in') + '</b>');
          showLaunchStep();
        });
      } else {
        claudeChoices(s.cliInstalled);
      }
    }).catch(function(){ claudeChoices(false); });
  }

  function claudeChoices(cliInstalled){
    el('claudeBody').innerHTML =
      '<div class="choice">' +
        (cliInstalled ? '<button id="optPlan">Sign in with Claude<small>Use a Claude Pro or Max subscription — opens Anthropic’s sign-in page</small></button>' : '') +
        '<button id="optKey" class="ghost" style="text-align:left">Use an API key<small>Pay-as-you-go key from console.anthropic.com — starts with sk-ant-</small></button>' +
      '</div><div id="claudeFlow"></div>';
    var plan = el('optPlan');
    if (plan) plan.addEventListener('click', startPlanLogin);
    el('optKey').addEventListener('click', showKeyEntry);
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
            receipt('Claude connected — <b>subscription sign-in</b>');
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
        receipt('Claude connected — <b>API key verified</b>');
        showLaunchStep();
      }).catch(function(e){
        btn.disabled = false; btn.textContent = 'Verify';
        err('claudeErr', e.message);
      });
    });
  }

  // ---- step 4: launch -----------------------------------------------------
  var MODEL_META = {
    'claude-opus-4-8': ['Claude Opus 4.8', 'smartest — recommended'],
    'claude-sonnet-5': ['Claude Sonnet 5', 'fast and capable'],
    'claude-haiku-4-5-20251001': ['Claude Haiku 4.5', 'light and cheap']
  };
  function showLaunchStep(){
    markStep(3);
    stopPolling();
    voice('Everything checks out. Pick my brain size and launch me.');
    var models = state.models.length ? state.models : Object.keys(MODEL_META);
    stage(
      '<h2>Launch</h2>' +
      '<p class="why">You can change the model any time later — this is just the starting point.</p>' +
      '<div class="models">' + models.map(function(m){
        var meta = MODEL_META[m] || [m, ''];
        return '<label><input type="radio" name="model" value="' + esc(m) + '"' + (m === (state.defaultModel || 'claude-opus-4-8') ? ' checked' : '') + '>' +
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
      '<label style="margin-top:18px">Your panel login link — save it</label>' +
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
          voice('I’m online. See you inside — and on Telegram.');
          el('bootMsg').textContent = 'Online! Redirecting…';
          setTimeout(function(){ location.href = panelPath; }, 900);
        }
      }).catch(function(){ /* still restarting */ });
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(t);
        el('bootMsg').textContent = 'This is taking longer than expected. Keep this page open and try your panel link above in a minute — or check the terminal window.';
      }
    }, 2000);
  }

  // ---- boot ---------------------------------------------------------------
  markStep(0);
  if (!setupKey) {
    stage('<h2>Open the setup link</h2><p class="why">For your security this page only works with the private link shown in the terminal window — it looks like <code style="font-family:var(--mono)">http://127.0.0.1:…/?k=…</code>. Copy it into this browser.</p>');
    voice('I can’t let just any page configure me — use the link from the terminal.');
  } else {
    api('state').then(function(s){
      state.models = s.models || [];
      state.defaultModel = s.defaultModel || 'claude-opus-4-8';
      if (s.bot) { state.bot = s.bot; receipt('Bot verified — <b>@' + esc(s.bot.username) + '</b>'); }
      if (s.confirmedUser) {
        state.user = s.confirmedUser;
        receipt('That’s you — <b>' + esc(s.confirmedUser.firstName || 'you') + '</b> <code>' + esc(String(s.confirmedUser.id)) + '</code>');
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
        voice('That link isn’t mine — use the one from the terminal.');
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
