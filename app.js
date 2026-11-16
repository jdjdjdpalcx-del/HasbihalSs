(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const LIMIT = 280;
  const ICON = {
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M5 5h14v10H10l-5 4z"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
  };

  const state = {
    user: null, config: {}, mode: 'login', formShownAt: Date.now(),
    posts: [], hasMore: false, tag: null, q: '',
    open: new Set(), comments: {}, drafts: {},
    pending: [], tsToken: null, tsWidget: null, googleReady: false, pollTimer: null
  };

  /* ---------- Yardımcılar ---------- */

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      if (res.status === 401 && state.user && !opts.quiet) signedOut();
      const err = new Error(data.error || 'Bir hata oluştu. Tekrar dene.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  function icon(markup) {
    const s = document.createElement('span');
    s.style.display = 'inline-flex';
    s.innerHTML = markup; // yalnızca yukarıdaki sabit SVG'ler
    return s.firstChild;
  }

  function avatar(name, cls) {
    let hue = 0;
    const s = name || '?';
    for (let i = 0; i < s.length; i++) hue = (hue * 31 + s.charCodeAt(i)) % 360;
    const parts = s.trim().split(/\s+/);
    const ini = ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toLocaleUpperCase('tr');
    const a = h('div', { class: 'avatar ' + (cls || ''), 'aria-hidden': 'true' }, ini);
    a.style.background = `hsl(${hue} 48% 36%)`;
    return a;
  }

  function ago(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return 'şimdi';
    if (d < 3600000) return Math.floor(d / 60000) + ' dk';
    if (d < 86400000) return Math.floor(d / 3600000) + ' sa';
    return Math.floor(d / 86400000) + ' g';
  }

  const tagsRe = /(#[\p{L}\p{N}_]{1,30})/u;
  function bodyNodes(text) {
    return text.split(tagsRe).map((part) =>
      /^#[\p{L}\p{N}_]{1,30}$/u.test(part)
        ? h('button', { class: 'tag', type: 'button', onclick: () => setTag(part.toLocaleLowerCase('tr')) }, part)
        : part);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = reject;
      document.head.append(s);
    });
  }

  /* ---------- Görünümler ---------- */

  function show(view) {
    $('#boot').hidden = true;
    $('#auth').hidden = view !== 'auth';
    $('#app').hidden = view !== 'app';
  }

  function signedOut() {
    state.user = null;
    clearInterval(state.pollTimer);
    show('auth');
    setMode('login');
    initGoogle();
  }

  function onSignedIn(user) {
    state.user = user;
    $('#f-password').value = '';
    show('app');
    $('#me-name').textContent = user.name;
    const slot = $('#me-avatar');
    slot.replaceChildren(avatar(user.name));
    state.tag = null; state.q = ''; $('#search').value = '';
    loadFeed();
    loadTrending();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, 25000);
  }

  /* ---------- Giriş / kayıt ---------- */

  function setMode(mode) {
    state.mode = mode;
    state.formShownAt = Date.now();
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== mode; });
    $('#tab-login').setAttribute('aria-selected', String(mode === 'login'));
    $('#tab-register').setAttribute('aria-selected', String(mode === 'register'));
    $('#auth-title').textContent = mode === 'login' ? 'Tekrar hoş geldin' : 'Aramıza katıl';
    $('#auth-sub').textContent = mode === 'login'
      ? 'Hesabınla giriş yap, sohbete kaldığın yerden devam et.'
      : 'Hesap açmak birkaç saniye sürer. Ücretsiz.';
    $('#auth-submit').textContent = mode === 'login' ? 'Giriş yap' : 'Hesap oluştur';
    $('#f-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    setAuthError('');
    resetTurnstile();
  }

  function setAuthError(msg) { $('#auth-error').textContent = msg; }

  async function initGoogle() {
    const id = state.config.googleClientId;
    if (!id) return;
    $('#google-wrap').hidden = false;
    try {
      if (!window.google || !window.google.accounts) await loadScript('https://accounts.google.com/gsi/client');
      if (!state.googleReady) {
        window.google.accounts.id.initialize({
          client_id: id, ux_mode: 'popup', auto_select: false,
          callback: async (resp) => {
            setAuthError('');
            try {
              const data = await api('/google', { method: 'POST', body: { credential: resp.credential } });
              onSignedIn(data.user);
            } catch (err) { setAuthError(err.message); }
          }
        });
        state.googleReady = true;
      }
      const width = Math.max(200, Math.min(400, $('.auth-box').clientWidth || 360));
      window.google.accounts.id.renderButton($('#google-btn'), {
        theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', locale: 'tr', width
      });
    } catch (_) {
      $('#google-wrap').hidden = true; // Google yüklenemezse e-posta ile devam
    }
  }

  async function initTurnstile() {
    const key = state.config.turnstileSiteKey;
    if (!key) return;
    try {
      await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      state.tsWidget = window.turnstile.render('#turnstile', {
        sitekey: key,
        callback: (t) => { state.tsToken = t; },
        'expired-callback': () => { state.tsToken = null; },
        'error-callback': () => { state.tsToken = null; }
      });
    } catch (_) {
      setAuthError('Robot doğrulaması yüklenemedi. Sayfayı yenile.');
    }
  }

  function resetTurnstile() {
    state.tsToken = null;
    if (state.tsWidget !== null && window.turnstile) window.turnstile.reset(state.tsWidget);
  }

  function bindAuth() {
    $('#tab-login').addEventListener('click', () => setMode('login'));
    $('#tab-register').addEventListener('click', () => setMode('register'));
    $('#pw-toggle').addEventListener('click', () => {
      const input = $('#f-password');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      $('#pw-toggle').textContent = showing ? 'Göster' : 'Gizle';
      $('#pw-toggle').setAttribute('aria-label', showing ? 'Şifreyi göster' : 'Şifreyi gizle');
    });

    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setAuthError('');
      const btn = $('#auth-submit');
      const password = $('#f-password').value;
      if (state.config.turnstileSiteKey && !state.tsToken) {
        return setAuthError('Önce robot doğrulamasını tamamla.');
      }
      if (state.mode === 'login' && (!$('#f-identifier').value.trim() || !password)) {
        return setAuthError('Kullanıcı adını (veya e-postanı) ve şifreni yaz.');
      }
      btn.disabled = true;
      try {
        const data = state.mode === 'login'
          ? await api('/login', { method: 'POST', body: {
              identifier: $('#f-identifier').value, password, turnstile: state.tsToken } })
          : await api('/register', { method: 'POST', body: {
              name: $('#f-name').value, username: $('#f-username').value, email: $('#f-email').value, password,
              website: $('#website').value, elapsed: Date.now() - state.formShownAt, turnstile: state.tsToken } });
        onSignedIn(data.user);
      } catch (err) {
        setAuthError(err.message);
        resetTurnstile();
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---------- Akış ---------- */

  function feedQuery(extra) {
    const p = new URLSearchParams(extra || {});
    if (state.tag) p.set('tag', state.tag);
    if (state.q) p.set('q', state.q);
    return '?' + p.toString();
  }

  async function loadFeed(append) {
    try {
      const extra = append && state.posts.length ? { before: state.posts[state.posts.length - 1].id } : {};
      const data = await api('/posts' + feedQuery(extra));
      state.posts = append ? state.posts.concat(data.posts) : data.posts;
      state.hasMore = data.hasMore;
      if (!append) { state.pending = []; $('#newbtn').hidden = true; }
      renderFeed();
    } catch (err) {
      if (err.status !== 401) $('#feed').replaceChildren(h('div', { class: 'card empty' }, err.message));
    }
  }

  async function loadTrending() {
    try {
      const data = await api('/trending', { quiet: true });
      const box = $('#trend');
      box.replaceChildren();
      if (!data.tags.length) box.append(h('p', { class: 'note' }, 'Henüz etiket yok. İlk etiketi sen ekle.'));
      for (const t of data.tags) {
        box.append(h('button', { class: 'chip', type: 'button', onclick: () => setTag(t.tag) }, t.tag, h('small', {}, String(t.n))));
      }
    } catch (_) {}
  }

  async function poll() {
    if (document.visibilityState !== 'visible' || !state.user || state.tag || state.q) return;
    const top = Math.max(0, ...state.posts.map((p) => p.id), ...state.pending.map((p) => p.id));
    if (!top) return;
    try {
      const data = await api('/posts?after=' + top, { quiet: true });
      const fresh = data.posts.filter((p) => !p.mine);
      if (fresh.length) {
        state.pending = data.posts.concat(state.pending);
        const btn = $('#newbtn');
        btn.textContent = state.pending.length + ' yeni gönderi';
        btn.hidden = false;
      }
      loadTrending();
    } catch (_) {}
  }

  function setTag(tag) { state.tag = tag; loadFeed(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  function renderFilter() {
    const bar = $('#filterbar');
    bar.replaceChildren();
    if (state.tag) {
      bar.append(h('div', { class: 'card filter' },
        h('span', {}, 'Etiket: ', h('b', {}, state.tag)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.tag = null; loadFeed(); } }, 'Temizle')));
    }
  }

  function renderFeed() {
    renderFilter();
    const feed = $('#feed');
    feed.replaceChildren();
    if (!state.posts.length) {
      feed.append(h('div', { class: 'card empty' },
        state.tag || state.q ? 'Bu aramayla eşleşen gönderi yok.' : 'Henüz gönderi yok. İlk sözü sen söyle.'));
    }
    for (const p of state.posts) feed.append(postCard(p));
    $('#more').hidden = !state.hasMore;
  }

  function postCard(p) {
    const isOpen = state.open.has(p.id);
    const likeBtn = h('button', {
      class: 'act' + (p.liked ? ' liked' : ''), type: 'button', 'aria-pressed': String(p.liked), 'aria-label': 'Beğen',
      onclick: async () => {
        try {
          const r = await api('/posts/' + p.id + '/like', { method: 'POST' });
          p.liked = r.liked; p.likes = r.likes; renderFeed();
        } catch (_) {}
      }
    }, icon(ICON.heart), String(p.likes));

    const commentBtn = h('button', {
      class: 'act', type: 'button', 'aria-label': 'Yorumlar', 'aria-expanded': String(isOpen),
      onclick: async () => {
        if (state.open.has(p.id)) state.open.delete(p.id);
        else {
          state.open.add(p.id);
          if (!state.comments[p.id]) {
            try { state.comments[p.id] = (await api('/posts/' + p.id + '/comments')).comments; } catch (_) { state.comments[p.id] = []; }
          }
        }
        renderFeed();
      }
    }, icon(ICON.chat), String(p.comments));

    const copyBtn = h('button', { class: 'act', type: 'button', 'aria-label': 'Metni kopyala',
      onclick: (e) => {
        const label = e.currentTarget.lastChild;
        try {
          navigator.clipboard.writeText(p.text).then(() => {
            label.textContent = 'Kopyalandı';
            setTimeout(() => { label.textContent = 'Kopyala'; }, 1400);
          }, () => {});
        } catch (_) {}
      } }, icon(ICON.link), 'Kopyala');

    const delBtn = p.mine ? h('button', { class: 'act danger', type: 'button', 'aria-label': 'Gönderiyi sil',
      onclick: async () => {
        try {
          await api('/posts/' + p.id, { method: 'DELETE' });
          state.posts = state.posts.filter((x) => x.id !== p.id);
          renderFeed(); loadTrending();
        } catch (_) {}
      } }, icon(ICON.trash)) : null;

    let extra = null;
    if (isOpen) {
      const list = state.comments[p.id] || [];
      const input = h('input', { type: 'text', id: 'c-' + p.id, maxlength: '200', placeholder: 'Yorum yaz…',
        'aria-label': 'Yorum yaz', value: state.drafts[p.id] || '' });
      input.addEventListener('input', () => { state.drafts[p.id] = input.value; });
      const err = h('p', { class: 'error', role: 'alert' });
      const send = async () => {
        const v = input.value.trim();
        if (!v) return;
        try {
          const r = await api('/posts/' + p.id + '/comments', { method: 'POST', body: { text: v } });
          state.comments[p.id].push(r.comment);
          p.comments += 1; state.drafts[p.id] = '';
          renderFeed();
          const again = document.getElementById('c-' + p.id);
          if (again) again.focus();
        } catch (e) { err.textContent = e.message; }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      extra = h('div', { class: 'comments' },
        list.map((c) => h('div', { class: 'comment' }, avatar(c.user.name, 'sm'),
          h('div', {}, h('p', {}, h('b', {}, c.user.name + ' '), c.text), h('small', {}, ago(c.createdAt))))),
        h('div', { class: 'cform' }, input, h('button', { class: 'btn primary', type: 'button', onclick: send }, 'Gönder')),
        err);
    }

    return h('article', { class: 'card post post-card' },
      avatar(p.user.name),
      h('div', {},
        h('div', { class: 'meta' }, h('b', {}, p.user.name), h('span', {}, '@' + p.user.username + ' · ' + ago(p.createdAt))),
        h('p', { class: 'text' }, bodyNodes(p.text)),
        h('div', { class: 'actions' }, likeBtn, commentBtn, copyBtn, delBtn),
        extra));
  }

  /* ---------- Yeni gönderi ---------- */

  function bindApp() {
    const draft = $('#draft'), send = $('#send'), count = $('#count');
    const update = () => {
      const n = draft.value.length;
      count.textContent = n + ' / ' + LIMIT;
      count.className = 'count' + (n > LIMIT ? ' over' : '');
      send.disabled = !draft.value.trim() || n > LIMIT;
    };
    const submit = async () => {
      const text = draft.value.trim();
      if (!text || text.length > LIMIT) return;
      send.disabled = true;
      $('#post-error').textContent = '';
      try {
        await api('/posts', { method: 'POST', body: { text } });
        draft.value = ''; update();
        state.tag = null; state.q = ''; $('#search').value = '';
        await loadFeed();
        loadTrending();
      } catch (err) {
        $('#post-error').textContent = err.message;
        update();
      }
    };
    draft.addEventListener('input', update);
    draft.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit(); });
    send.addEventListener('click', submit);

    let t;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { state.q = e.target.value.trim(); loadFeed(); }, 300);
    });
    $('#more').addEventListener('click', () => loadFeed(true));
    $('#newbtn').addEventListener('click', () => {
      state.posts = state.pending.concat(state.posts);
      state.pending = [];
      $('#newbtn').hidden = true;
      renderFeed();
    });
    $('#logout').addEventListener('click', async () => {
      try { await api('/logout', { method: 'POST', quiet: true }); } catch (_) {}
      signedOut();
    });
    update();
  }

  /* ---------- Başlangıç ---------- */

  async function init() {
    bindAuth();
    bindApp();
    try {
      const [config, me] = await Promise.all([api('/config'), api('/me')]);
      state.config = config;
      initTurnstile();
      if (me.user) return onSignedIn(me.user);
    } catch (_) {}
    signedOut();
  }

  init();
})();
