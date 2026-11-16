'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// .env dosyasını (varsa) okur; ek paket gerekmez.
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (_) { /* .env yok, sorun değil */ }

const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'hasbihal.db');
const SESSION_DAYS = 30;
const COOKIE = 'hb_session';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (post_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tr = (s) => s.toLocaleLowerCase('tr');
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// Var olmayan kullanıcıda da aynı sürede cevap vermek için sahte hash.
const DUMMY_HASH = bcrypt.hashSync('hasbihal-dummy-password', 11);

/* ---------- Oturum ---------- */

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_DAYS * 86400000, path: '/'
  });
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.username, u.display_name AS name, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha(token), Date.now()) || null;
}

setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (_) {}
}, 3600000).unref();

/* ---------- Uygulama ---------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://accounts.google.com', 'https://challenges.cloudflare.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'frame-src': ['https://accounts.google.com', 'https://challenges.cloudflare.com'],
      'connect-src': ["'self'", 'https://accounts.google.com'],
      'upgrade-insecure-requests': IS_PROD ? [] : null
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
app.use(express.json({ limit: '10kb' }));

// Başka bir siteden gelen yazma isteklerini reddeder.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (_) {}
    if (host !== req.get('host')) return res.status(403).json({ error: 'İstek reddedildi.' });
  }
  next();
});

const limit = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: message }
});
app.use('/api', limit(60000, 240, 'Çok fazla istek. Biraz bekleyip tekrar dene.'));
const loginLimiter = limit(15 * 60000, 20, 'Çok fazla giriş denemesi. Birkaç dakika sonra tekrar dene.');
const registerLimiter = limit(60 * 60000, 8, 'Bu bağlantıdan çok fazla kayıt açıldı. Daha sonra tekrar dene.');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Oturum gerekli.' });
  req.user = user;
  next();
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token), remoteip: ip || '' })
    });
    const data = await r.json();
    return data.success === true;
  } catch (_) {
    return false;
  }
}

const publicUser = (u) => ({ username: u.username, name: u.name });

app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, turnstileSiteKey: TURNSTILE_SITE_KEY });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json({ user: u ? publicUser(u) : null });
});

/* ---------- Kayıt / giriş ---------- */

app.post('/api/register', registerLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  // Bot tuzakları: görünmeyen alan dolu ya da form çok hızlı gönderilmiş.
  if (b.website) return res.status(400).json({ error: 'Kayıt tamamlanamadı.' });
  if (!(Number(b.elapsed) >= 2000)) return res.status(400).json({ error: 'Form çok hızlı gönderildi. Tekrar dene.' });
  if (!(await verifyTurnstile(b.turnstile, req.ip))) {
    return res.status(400).json({ error: 'Robot doğrulaması başarısız. Sayfayı yenileyip tekrar dene.' });
  }

  const username = String(b.username || '').trim();
  const email = String(b.email || '').trim();
  const password = String(b.password || '');
  const name = String(b.name || '').trim().slice(0, 40) || username;

  if (!/^[a-z0-9_]{3,20}$/i.test(username)) {
    return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı; harf (a-z), rakam ve _ kullanabilirsin.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
    return res.status(400).json({ error: 'Geçerli bir e-posta adresi yaz.' });
  }
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Şifre en az 8 karakter olmalı.' });
  }

  const hash = await bcrypt.hash(password, 11);
  try {
    const r = db.prepare(
      'INSERT INTO users (username, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, email, name, hash, Date.now());
    startSession(res, Number(r.lastInsertRowid));
    res.status(201).json({ user: { username, name } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
      return res.status(409).json({ error: taken ? 'Bu kullanıcı adı alınmış.' : 'Bu e-posta ile zaten bir hesap var.' });
    }
    throw e;
  }
}));

app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  if (!(await verifyTurnstile(b.turnstile, req.ip))) {
    return res.status(400).json({ error: 'Robot doğrulaması başarısız. Sayfayı yenileyip tekrar dene.' });
  }
  const id = String(b.identifier || '').trim();
  const password = String(b.password || '');
  const row = id
    ? db.prepare('SELECT id, username, display_name, password_hash FROM users WHERE username = ? OR email = ?').get(id, id)
    : null;
  const ok = await bcrypt.compare(password.slice(0, 200), (row && row.password_hash) || DUMMY_HASH);
  if (!row || !row.password_hash || !ok) {
    if (row && !row.password_hash) {
      return res.status(401).json({ error: 'Bu hesap Google ile açılmış. "Google ile devam et" düğmesini kullan.' });
    }
    return res.status(401).json({ error: 'Kullanıcı adı, e-posta veya şifre hatalı.' });
  }
  startSession(res, row.id);
  res.json({ user: { username: row.username, name: row.display_name } });
}));

app.post('/api/google', loginLimiter, wrap(async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google girişi bu sitede açık değil.' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: String((req.body || {}).credential || ''), audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (_) {
    return res.status(401).json({ error: 'Google girişi doğrulanamadı.' });
  }
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    return res.status(401).json({ error: 'Google hesabının e-postası doğrulanmamış.' });
  }

  let user = db.prepare('SELECT id, username, display_name FROM users WHERE google_sub = ?').get(payload.sub);
  if (!user) {
    const existing = db.prepare('SELECT id, username, display_name FROM users WHERE email = ?').get(payload.email);
    if (existing) {
      db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(payload.sub, existing.id);
      user = existing;
    } else {
      const base = (payload.email.split('@')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 14) || 'uye').toLowerCase();
      let username = base.length >= 3 ? base : base + '123';
      while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        username = base.slice(0, 14) + crypto.randomInt(100, 9999);
      }
      const name = String(payload.name || username).slice(0, 40);
      const r = db.prepare(
        'INSERT INTO users (username, email, display_name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(username, payload.email, name, payload.sub, Date.now());
      user = { id: Number(r.lastInsertRowid), username, display_name: name };
    }
  }
  startSession(res, user.id);
  res.json({ user: { username: user.username, name: user.display_name } });
}));

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------- Gönderiler ---------- */

const POST_SELECT = `
  SELECT p.id, p.text, p.created_at AS createdAt, p.user_id AS userId,
         u.username, u.display_name AS name,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
         EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments
    FROM posts p JOIN users u ON u.id = p.user_id`;

const shapePost = (r, me) => ({
  id: r.id, text: r.text, createdAt: r.createdAt,
  user: { username: r.username, name: r.name },
  likes: r.likes, liked: !!r.liked, comments: r.comments, mine: r.userId === me
});

const getPost = (id, me) => {
  const r = db.prepare(POST_SELECT + ' WHERE p.id = ?').get(me, id);
  return r ? shapePost(r, me) : null;
};

app.get('/api/posts', requireAuth, (req, res) => {
  const me = req.user.id;
  const where = [];
  const params = [me];
  const before = parseInt(req.query.before, 10);
  const after = parseInt(req.query.after, 10);
  if (before > 0) { where.push('p.id < ?'); params.push(before); }
  if (after > 0) { where.push('p.id > ?'); params.push(after); }
  if (req.query.tag) {
    where.push('EXISTS (SELECT 1 FROM tags t WHERE t.post_id = p.id AND t.tag = ?)');
    params.push(tr(String(req.query.tag)).slice(0, 40));
  }
  if (req.query.q) {
    const like = '%' + String(req.query.q).slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(p.text LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const sql = POST_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY p.id DESC LIMIT ' + (after > 0 ? 50 : 20);
  const rows = db.prepare(sql).all(...params).map((r) => shapePost(r, me));
  res.json({ posts: rows, hasMore: after > 0 ? false : rows.length === 20 });
});

app.post('/api/posts', requireAuth, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Boş gönderi paylaşılamaz.' });
  if (text.length > 280) return res.status(400).json({ error: 'Gönderi en fazla 280 karakter olabilir.' });
  const recent = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at > ?')
    .get(req.user.id, Date.now() - 10 * 60000).n;
  if (recent >= 8) return res.status(429).json({ error: 'Kısa sürede çok fazla gönderi paylaştın. Biraz bekle.' });

  const r = db.prepare('INSERT INTO posts (user_id, text, created_at) VALUES (?, ?, ?)').run(req.user.id, text, Date.now());
  const id = Number(r.lastInsertRowid);
  const tags = new Set((text.match(/#[\p{L}\p{N}_]{1,30}/gu) || []).map(tr));
  const ins = db.prepare('INSERT OR IGNORE INTO tags (post_id, tag) VALUES (?, ?)');
  for (const t of tags) ins.run(id, t);
  res.status(201).json({ post: getPost(id, req.user.id) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  const del = db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(id, req.user.id);
  if (!del.changes) db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id).n;
  res.json({ liked: !del.changes, likes });
});

app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.text, c.created_at AS createdAt, u.username, u.display_name AS name
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 200`
  ).all(Number(req.params.id));
  res.json({ comments: rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt, user: { username: r.username, name: r.name } })) });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Boş yorum gönderilemez.' });
  if (text.length > 200) return res.status(400).json({ error: 'Yorum en fazla 200 karakter olabilir.' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  const recent = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?')
    .get(req.user.id, Date.now() - 10 * 60000).n;
  if (recent >= 20) return res.status(429).json({ error: 'Kısa sürede çok fazla yorum yazdın. Biraz bekle.' });
  const now = Date.now();
  const r = db.prepare('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(id, req.user.id, text, now);
  res.status(201).json({ comment: { id: Number(r.lastInsertRowid), text, createdAt: now, user: publicUser(req.user) } });
});

app.get('/api/trending', requireAuth, (_req, res) => {
  const rows = db.prepare(
    `SELECT t.tag, COUNT(*) AS n FROM tags t JOIN posts p ON p.id = t.post_id
      WHERE p.created_at > ? GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 8`
  ).all(Date.now() - 7 * 86400000);
  res.json({ tags: rows });
});

/* ---------- Arayüz ---------- */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Bulunamadı.' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Bir şeyler ters gitti. Biraz sonra tekrar dene.' });
});

app.listen(PORT, () => {
  console.log(`Hasbihal çalışıyor: http://localhost:${PORT}`);
  if (!GOOGLE_CLIENT_ID) console.log('Not: GOOGLE_CLIENT_ID tanımlı değil, Google ile giriş kapalı.');
  if (!TURNSTILE_SECRET) console.log('Not: Turnstile tanımlı değil, robot doğrulaması yalnızca gizli alan ve hız sınırıyla yapılıyor.');
});
