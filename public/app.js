// REVA mobile app (PWA). Vanilla JS, no build step.
// Streams agent events over SSE so the thinking process is visible live.
const $ = (sel) => document.querySelector(sel);

const state = {
  token: sessionStorage.getItem('reva_token') ?? localStorage.getItem('reva_token') ?? null,
  sessionId: null,
  es: null,          // EventSource
  activeTab: 'chat',
  selectedBot: null,
  extensionApi: null,
  extensionsLoaded: new Set(),
};

// ---- api -------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.token) {
    logout();
    throw new Error('session expired — log in again');
  }
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

// ---- auth --------------------------------------------------------------------

function saveToken(token, remember) {
  state.token = token;
  sessionStorage.setItem('reva_token', token);
  if (remember) localStorage.setItem('reva_token', token);
}

function logout() {
  if (state.es) { state.es.close(); state.es = null; }
  state.token = null;
  sessionStorage.removeItem('reva_token');
  localStorage.removeItem('reva_token');
  $('#view-main').classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
}

async function initAuth() {
  try {
    const boot = await fetch('/api/keystore').then((r) => r.json()).catch(() => null);
    // bootstrap only when no accounts exist yet (login returns 401 with code)
    if (state.token) {
      const me = await api('/api/me');
      enterApp(me.actor);
      return;
    }
    // no token: decide login vs bootstrap by trying a probe
    const probe = await fetch('/api/me').catch(() => null);
    if (probe && probe.status === 401) {
      const body = await probe.json().catch(() => ({}));
      if (body.code === 'no_token' || body.code === 'invalid_token') showLogin();
      else showLogin();
    } else {
      showLogin();
    }
    void boot;
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#auth-error').classList.add('hidden');
  // try bootstrap detection: attempt login with dummy → error text reveals state
  $('#auth-existing').classList.remove('hidden');
  $('#auth-bootstrap').classList.add('hidden');
}

async function detectBootstrap() {
  // If no admin exists the server returns 400 already_bootstrapped=false on
  // bootstrap probe; we simply attempt a dummy login and inspect the error.
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: '__probe__', password: '__probe__' } });
  } catch (err) {
    return err.message;
  }
  return null;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#login-user').value, password: $('#login-pass').value },
    });
    saveToken(data.token, true);
    enterApp(data.account);
  } catch (err) {
    setError(err.message);
  }
});

$('#bootstrap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('');
  try {
    const data = await api('/api/auth/bootstrap', {
      method: 'POST',
      body: { username: $('#boot-user').value, password: $('#boot-pass').value },
    });
    // auto-login after bootstrap
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#boot-user').value, password: $('#boot-pass').value },
    });
    saveToken(login.token, true);
    enterApp(data.account);
  } catch (err) {
    setError(err.message);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  logout();
});

function setError(msg) {
  const el = $('#auth-error');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

// On first load, check whether bootstrap is needed.
(async () => {
  try {
    const probe = await fetch('/api/health');
    if (!probe.ok) throw new Error('server unreachable');
    // Attempt to learn if accounts exist: bootstrap endpoint tells us.
    const fake = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '__probe__', password: '__probe__probe__' }),
    });
    const body = await fake.json().catch(() => ({}));
    if (body.code === 'already_bootstrapped') {
      $('#auth-existing').classList.remove('hidden');
    } else if (body.code === 'invalid_username' || body.code === 'none') {
      // no accounts yet → show bootstrap (username was invalid only because of __)
      $('#auth-existing').classList.add('hidden');
      $('#auth-bootstrap').classList.remove('hidden');
    } else {
      $('#auth-existing').classList.remove('hidden');
    }
  } catch {
    setError('server unreachable — is `reva serve` running?');
  }
  initAuth();
  void detectBootstrap;
})();

// ---- app shell -----------------------------------------------------------------

function enterApp(actor) {
  $('#view-auth').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  $('#header-status').textContent = `${actor.username}${actor.anonymous ? ' (local)' : ''}`;
  loadMoreTab();
  loadBots();
  loadSessions();
  loadExtensions();
  registerServiceWorker();
}

function switchTab(name) {
  state.activeTab = name;
  for (const tab of ['chat', 'sessions', 'bots', 'more']) {
    $(`#tab-${tab}`).classList.toggle('hidden', tab !== name);
  }
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'sessions') loadSessions();
  if (name === 'bots') loadBots();
  if (name === 'more') loadMoreTab();
}

document.querySelectorAll('.tabbtn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---- chat ---------------------------------------------------------------------

async function newSession() {
  const data = await api('/api/sessions', { method: 'POST', body: {} });
  state.sessionId = data.id;
  $('#messages').innerHTML = '';
  openEventStream(data.id);
  switchTab('chat');
  return data.id;
}

async function openSession(id) {
  state.sessionId = id;
  $('#messages').innerHTML = '';
  switchTab('chat');
  openEventStream(id, 0); // replay everything
}

function openEventStream(sessionId, since = -1) {
  if (state.es) state.es.close();
  const url = `/api/sessions/${sessionId}/events?since=${since}`;
  state.es = new EventSource(url);
  state.es.onmessage = (evt) => {
    try {
      const event = JSON.parse(evt.data);
      renderEvent(event);
    } catch { /* ignore */ }
  };
  state.es.onerror = () => {
    $('#header-status').textContent = 'stream disconnected';
  };
}

function setBusy(busy, label) {
  $('#header-status').textContent = busy ? (label ?? 'working…') : 'ready';
  $('#send-btn').disabled = busy;
  $('#abort-btn').classList.toggle('hidden', !busy);
}

async function sendMessage() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.sessionId) await newSession();
  input.value = '';
  setBusy(true);
  try {
    await api(`/api/sessions/${state.sessionId}/messages`, { method: 'POST', body: { text } });
  } catch (err) {
    if (err.message.includes('busy')) {
      addNotice('the agent is still working — press stop first');
    } else {
      addNotice(`error: ${err.message}`);
    }
    setBusy(false);
  }
}

$('#send-btn').addEventListener('click', sendMessage);
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('#abort-btn').addEventListener('click', async () => {
  if (state.sessionId) {
    await api(`/api/sessions/${state.sessionId}/abort`, { method: 'POST', body: {} }).catch(() => {});
  }
});
$('#new-session-btn').addEventListener('click', () => newSession());
document.querySelectorAll('[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.cmd === 'new-session') newSession();
    if (b.dataset.cmd === 'sessions') switchTab('sessions');
  });
});

// ---- event rendering (the visible thinking process) -----------------------------

const toolCards = new Map(); // call_id -> element

function renderEvent(e) {
  switch (e.type) {
    case 'user_message':
      addMessage('user', e.text);
      setBusy(true);
      break;
    case 'stream':
      // thinking/text deltas arrive as their own event types
      break;
    case 'thinking':
      appendThinking(e.delta ?? '');
      break;
    case 'assistant_message':
      closeThinking();
      addMessage('assistant', e.text ?? '');
      if (e.thinking) attachThinking(e.thinking);
      break;
    case 'tool_start': {
      closeThinking();
      const card = addToolCard(e.call_id, e.tool, e.args);
      toolCards.set(e.call_id, card);
      break;
    }
    case 'tool_result': {
      const card = toolCards.get(e.call_id);
      if (card) {
        card.querySelector('.tool-status').textContent = `${e.ok ? 'ok' : 'failed'} · ${e.elapsed_ms ?? 0}ms`;
        if (e.ok === false) card.classList.add('failed');
      }
      break;
    }
    case 'subagent_start':
      addNotice(`◈ subagent started (${e.mode ?? 'general'})`);
      break;
    case 'subagent_done':
      addNotice('◈ subagent finished');
      break;
    case 'compaction_started':
      addNotice('◌ context long — saving project memory, then compacting…');
      break;
    case 'compaction_done':
      addNotice(`◌ compacted (${e.tokens_before} → ${e.tokens_after} est. tokens) — memory saved`);
      break;
    case 'session_done':
      closeThinking();
      setBusy(false);
      break;
    case 'session_error':
      addNotice(`✗ ${e.error}`);
      setBusy(false);
      break;
    default:
      break;
  }
  scrollChat();
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'you' : 'reva';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  div.append(who, body);
  $('#messages').append(div);
  return div;
}

let thinkingEl = null;
function appendThinking(delta) {
  if (!thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-block';
    thinkingEl.innerHTML = '<div class="who">thinking</div><div class="body"></div>';
    $('#messages').append(thinkingEl);
  }
  thinkingEl.querySelector('.body').textContent += delta;
  scrollChat();
}
function closeThinking() {
  if (thinkingEl) {
    thinkingEl.classList.add('closed');
    thinkingEl = null;
  }
}
function attachThinking(text) {
  const details = document.createElement('details');
  details.className = 'thinking-block';
  details.innerHTML = `<summary>thinking process</summary><div class="body"></div>`;
  details.querySelector('.body').textContent = text;
  $('#messages').append(details);
}

function addToolCard(callId, tool, args) {
  const card = document.createElement('div');
  card.className = 'toolcard';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = `● ${tool}`;
  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = 'running';
  const argLine = document.createElement('div');
  argLine.className = 'dim';
  argLine.textContent = JSON.stringify(args ?? {}).slice(0, 200);
  card.append(name, status, argLine);
  $('#messages').append(card);
  return card;
}

function addNotice(text) {
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  $('#messages').append(div);
}

function scrollChat() {
  const el = $('#chat-scroll');
  el.scrollTop = el.scrollHeight;
}

// ---- sessions / bots tabs --------------------------------------------------------

async function loadSessions() {
  try {
    const data = await api('/api/sessions');
    const list = $('#sessions-list');
    list.innerHTML = '';
    for (const s of data.sessions) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="sub">${new Date(s.updated_at).toLocaleString()} · ${s.mode}${s.bot ? `:${s.bot}` : ''}</span>${escapeHtml(s.title ?? s.id)}`;
      li.addEventListener('click', () => openSession(s.id));
      if (s.id === state.sessionId) li.classList.add('active');
      list.append(li);
    }
    if (data.sessions.length === 0) list.innerHTML = '<li class="dim">no sessions yet</li>';
  } catch (err) {
    $('#sessions-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

async function loadBots() {
  try {
    const data = await api('/api/bots');
    const list = $('#bots-list');
    list.innerHTML = '';
    for (const b of data.bots) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${escapeHtml(b.name)}</strong> <span class="sub">${escapeHtml(`${b.provider}/${b.model}`)} — ${escapeHtml(b.description)}</span>`;
      li.addEventListener('click', () => {
        state.selectedBot = b.name;
        document.querySelectorAll('#bots-list li').forEach((x) => x.classList.remove('active'));
        li.classList.add('active');
        $('#bot-run-btn').disabled = false;
      });
      list.append(li);
    }
  } catch (err) {
    $('#bots-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

$('#bot-run-btn').addEventListener('click', async () => {
  const prompt = $('#bot-prompt').value.trim();
  if (!state.selectedBot || !prompt) return;
  $('#bot-run-btn').disabled = true;
  try {
    const data = await api(`/api/bots/${encodeURIComponent(state.selectedBot)}/run`, { method: 'POST', body: { prompt } });
    addMessage('assistant', `[${state.selectedBot}] ${data.text}`);
    switchTab('chat');
  } catch (err) {
    addNotice(`✗ bot failed: ${err.message}`);
  } finally {
    $('#bot-run-btn').disabled = false;
  }
});

// ---- more tab -----------------------------------------------------------------------

async function loadMoreTab() {
  await Promise.all([
    loadProviders(), loadSkills(), loadPlugins(), loadMcp(), loadMemory(), loadAutomation(),
  ]);
}

async function loadProviders() {
  const box = $('#providers-box');
  try {
    const data = await api('/api/providers');
    box.innerHTML = '';
    for (const p of data.catalog) {
      const configured = data.configured[p.key]?.has_key;
      const row = document.createElement('div');
      row.className = 'form-row';
      row.innerHTML = `<label>${p.key} — ${configured ? 'key configured' : 'no key'}</label>
        <div class="form-row">
          <input type="password" placeholder="paste ${p.key} api key" data-provider="${p.key}" />
          <button class="btn small" data-save="${p.key}" type="button">save</button>
        </div>`;
      box.append(row);
    }
    box.querySelectorAll('[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.save;
        const input = box.querySelector(`input[data-provider="${provider}"]`);
        try {
          await api('/api/keys', { method: 'POST', body: { provider, key: input.value } });
          input.value = '';
          btn.textContent = 'saved ✓';
          loadProviders();
        } catch (err) {
          btn.textContent = err.message.includes('locked') ? 'keystore locked' : 'failed';
        }
      });
    });
  } catch (err) {
    box.textContent = err.message;
  }
}

async function loadSkills() {
  try {
    const data = await api('/api/skills');
    $('#skills-list').innerHTML = data.skills
      .map((s) => `<li><strong>${escapeHtml(s.name)}</strong><span class="sub">${escapeHtml(s.description)}</span></li>`).join('')
      || '<li class="dim">none installed</li>';
  } catch (err) {
    $('#skills-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

async function loadPlugins() {
  try {
    const data = await api('/api/plugins');
    $('#plugins-list').innerHTML = data.plugins
      .map((p) => `<li><strong>${escapeHtml(p.name)}@${escapeHtml(p.version)}</strong> [${p.status}]<span class="sub">${escapeHtml(p.description)}</span></li>`).join('')
      || '<li class="dim">none installed</li>';
  } catch (err) {
    $('#plugins-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

async function loadMcp() {
  try {
    const data = await api('/api/mcp');
    $('#mcp-box').innerHTML = `<div class="dim">configured: ${data.configured.length ? escapeHtml(data.configured.join(', ')) : 'none'}</div>
      <div>tools: ${data.tools.length ? data.tools.map((t) => escapeHtml(t.name)).join(', ') : '—'}</div>`;
  } catch (err) {
    $('#mcp-box').textContent = err.message;
  }
}

$('#mcp-connect-btn').addEventListener('click', async () => {
  try {
    await api('/api/mcp/connect', { method: 'POST', body: {} });
    loadMcp();
  } catch (err) {
    $('#mcp-box').textContent = err.message;
  }
});

async function loadMemory() {
  try {
    const data = await api('/api/memory');
    const topics = Object.entries(data.topics ?? {});
    $('#memory-box').textContent = topics.length
      ? topics.map(([t, c]) => `== ${t} ==\n${c}`).join('\n\n')
      : '(no memory yet — the agent saves durable notes here before compaction)';
  } catch (err) {
    $('#memory-box').textContent = err.message;
  }
}

async function loadAutomation() {
  try {
    const data = await api('/api/automation');
    $('#automation-list').innerHTML = data.jobs
      .map((j) => `<li><strong>${escapeHtml(j.name)}</strong> [${j.enabled ? 'on' : 'off'}]
        <span class="sub">${j.schedule.every_ms ? `every ${Math.round(j.schedule.every_ms / 60000)} min` : `daily @${j.schedule.daily_at}`} · runs ${j.run_count ?? 0} · ${escapeHtml(j.last_status ?? '-')}</span></li>`).join('')
      || '<li class="dim">no jobs</li>';
  } catch (err) {
    $('#automation-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

$('#auto-add-btn').addEventListener('click', async () => {
  const name = $('#auto-name').value.trim();
  const prompt = $('#auto-prompt').value.trim();
  const every = Number($('#auto-every').value);
  if (!name || !prompt || !every) return;
  try {
    await api('/api/automation', { method: 'POST', body: { name, prompt, schedule: { every_ms: every * 60000 } } });
    $('#auto-name').value = ''; $('#auto-prompt').value = ''; $('#auto-every').value = '';
    loadAutomation();
  } catch (err) {
    addNotice(`✗ ${err.message}`);
  }
});

$('#audit-check-btn').addEventListener('click', async () => {
  try {
    const data = await api('/api/audit');
    $('#audit-box').textContent = `chain ${data.ok ? 'INTACT' : 'BROKEN'} · ${data.total} entries\n\n`
      + data.entries.slice(-30).map((e) => `${e.ts} ${e.actor} ${e.event}`).join('\n');
  } catch (err) {
    $('#audit-box').textContent = err.message;
  }
});

// ---- extensions (mobile) ---------------------------------------------------------------

const EXTENSION_API = {
  version: 1,
  registerCard(def) {
    const card = document.createElement('div');
    card.className = 'ext-card';
    const h = document.createElement('h4');
    h.textContent = def.title ?? 'extension card';
    const body = document.createElement('div');
    card.append(h, body);
    $('#extension-cards').append(card);
    if (typeof def.render === 'function') def.render(body);
  },
  addCommand(def) {
    if (typeof def.run !== 'function') return;
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = def.label ?? def.name ?? 'run';
    btn.addEventListener('click', () => def.run(EXTENSION_API));
    $('#extension-cards').append(btn);
  },
  async fetch(path, init) {
    return api(path, init ?? {});
  },
  notify(text) { addNotice(text); },
};

async function loadExtensions() {
  try {
    const data = await api('/api/extensions');
    const list = $('#extensions-list');
    list.innerHTML = data.extensions
      .map((x) => `<li><strong>${escapeHtml(x.name)}@${x.version}</strong>${x.valid ? '' : ' [INVALID]'}
        <span class="sub">${escapeHtml(x.description)} · perms: ${escapeHtml(x.permissions.join(', '))}</span></li>`).join('')
      || '<li class="dim">none installed</li>';
    for (const ext of data.extensions) {
      if (!ext.valid || state.extensionsLoaded.has(ext.name)) continue;
      state.extensionsLoaded.add(ext.name);
      try {
        const mod = await import(ext.url);
        if (typeof mod.activate === 'function') mod.activate(EXTENSION_API);
      } catch (err) {
        addNotice(`extension ${ext.name} failed: ${err.message}`);
      }
    }
  } catch (err) {
    $('#extensions-list').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
  }
}

// ---- misc ------------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

window.REVA = { api, state, switchTab, newSession };
