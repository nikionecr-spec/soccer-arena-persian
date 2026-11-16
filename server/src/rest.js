/* REST API: register/login, profile, leaderboard, history, friends, shop, health. */
'use strict';
const config = require('./config');
const { signToken, hashPassword, checkPassword, verifyToken } = require('./crypto');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error('payload_too_large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

async function authUser(req, store) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const payload = verifyToken(m[1]);
  if (!payload || !payload.uid) return null;
  const profile = await store.getProfile(payload.uid);
  return profile ? { profile, token: m[1], uid: payload.uid } : null;
}

/* simple per-IP REST rate limit (memory) */
const ipHits = new Map();
function allowIp(ip) {
  const t = Date.now();
  const arr = (ipHits.get(ip) || []).filter(x => t - x < 10000);
  arr.push(t);
  ipHits.set(ip, arr);
  return arr.length <= 30;
}

function makeRestHandler(store) {
  return async function handleRest(req, res, pathname) {
    const ip = (req.socket.remoteAddress || 'unknown').replace('::ffff:', '');
    if (!allowIp(ip)) return json(res, 429, { ok: false, code: 'rate_limited', message: 'درخواست‌ها بیش از حد مجاز است.' });

    if (req.method === 'OPTIONS') return json(res, 204, {});

    /* ---- public ---- */
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), time: Date.now() });
    }
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.username || '').trim();
      const pass = String(body.password || '');
      if (name.length < 3 || name.length > config.MAX_NAME_LEN) {
        return json(res, 400, { ok: false, code: 'bad_username', message: 'نام کاربری باید ۳ تا ۲۰ نویسه باشد.' });
      }
      if (!/^[\u0600-\u06FFa-zA-Z0-9_\u200C ]+$/.test(name)) {
        return json(res, 400, { ok: false, code: 'bad_username', message: 'نام کاربری فقط حروف فارسی/انگلیسی، عدد، خط زیر و فاصله می‌پذیرد.' });
      }
      if (pass.length < 6) {
        return json(res, 400, { ok: false, code: 'bad_password', message: 'رمز عبور حداقل ۶ نویسه است.' });
      }
      const user = await store.createUser(name, hashPassword(pass));
      if (!user) return json(res, 409, { ok: false, code: 'name_taken', message: 'این نام کاربری قبلاً گرفته شده است.' });
      const profile = await store.getProfile(user.userId);
      await store.auditLog('register', { userId: user.userId });
      return json(res, 200, { ok: true, token: signToken({ uid: user.userId }), profile });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const user = await store.getUserByName(String(body.username || '').trim());
      if (!user || !checkPassword(String(body.password || ''), user.passHash)) {
        return json(res, 401, { ok: false, code: 'bad_credentials', message: 'نام کاربری یا رمز عبور اشتباه است.' });
      }
      const profile = await store.getProfile(user.userId);
      await store.auditLog('login', { userId: user.userId });
      return json(res, 200, { ok: true, token: signToken({ uid: user.userId }), profile });
    }
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      const top = await store.topProfiles(50);
      return json(res, 200, { ok: true, top });
    }

    /* ---- authenticated ---- */
    const auth = await authUser(req, store);
    if (pathname === '/api/profile' && req.method === 'GET') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      return json(res, 200, { ok: true, profile: auth.profile });
    }
    if (pathname === '/api/matches/history' && req.method === 'GET') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const url = new URL(req.url, 'http://x');
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
      const history = await store.matchHistory(auth.uid, limit);
      return json(res, 200, { ok: true, history });
    }

    /* ---- shop ---- */
    if (pathname === '/api/shop' && req.method === 'GET') {
      const catalog = store.catalog;
      const owned = auth ? await store.getInventory(auth.uid) : [];
      return json(res, 200, { ok: true, catalog, owned, coins: auth ? auth.profile.coins : null });
    }
    if (pathname === '/api/shop/buy' && req.method === 'POST') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const body = await readBody(req);
      const item = store.catalog.find(x => x.id === body.itemId);
      if (!item) return json(res, 404, { ok: false, code: 'no_item', message: 'این کالا وجود ندارد.' });
      if (await store.ownsItem(auth.uid, item.id)) return json(res, 409, { ok: false, code: 'owned', message: 'این کالا را دارید.' });
      if (auth.profile.coins < item.price) return json(res, 402, { ok: false, code: 'no_coins', message: 'سکه کافی ندارید.' });
      const p = auth.profile;
      p.coins -= item.price;
      await store.saveProfile(auth.uid, p);
      await store.grantItem(auth.uid, item.id);
      await store.auditLog('buy', { userId: auth.uid, itemId: item.id, price: item.price });
      return json(res, 200, { ok: true, profile: p, owned: await store.getInventory(auth.uid) });
    }
    if (pathname === '/api/shop/equip' && req.method === 'POST') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const body = await readBody(req);
      const item = store.catalog.find(x => x.id === body.itemId);
      if (!item) return json(res, 404, { ok: false, code: 'no_item', message: 'این کالا وجود ندارد.' });
      if (!(await store.ownsItem(auth.uid, item.id))) return json(res, 403, { ok: false, code: 'not_owned', message: 'ابتدا این کالا را بخرید.' });
      const p = auth.profile;
      if (item.kind === 'piece') p.selectedPiece = item.id;
      else p.selectedField = item.id;
      await store.saveProfile(auth.uid, p);
      return json(res, 200, { ok: true, profile: p });
    }

    /* ---- friends ---- */
    if (pathname === '/api/friends' && req.method === 'GET') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const list = await store.listFriendships(auth.uid);
      const out = [];
      for (const f of list) {
        const otherId = f.a === auth.uid ? f.b : f.a;
        const other = await store.getUserById(otherId);
        const prof = await store.getProfile(otherId);
        out.push({
          userId: otherId, name: other ? other.name : '?', rating: prof ? prof.rating : 0,
          status: f.status, reqBy: f.reqBy,
          direction: f.reqBy === auth.uid ? 'outgoing' : 'incoming'
        });
      }
      return json(res, 200, { ok: true, friends: out });
    }
    if (pathname === '/api/friends/request' && req.method === 'POST') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const body = await readBody(req);
      const target = await store.getUserByName(String(body.username || '').trim());
      if (!target) return json(res, 404, { ok: false, code: 'no_user', message: 'کاربری با این نام پیدا نشد.' });
      if (target.userId === auth.uid) return json(res, 400, { ok: false, code: 'self', message: 'نمی‌توانید خودتان را اضافه کنید.' });
      await store.upsertFriendship(auth.uid, target.userId, { status: 'pending', reqBy: auth.uid });
      await store.auditLog('friend_request', { from: auth.uid, to: target.userId });
      return json(res, 200, { ok: true, message: 'درخواست دوستی ارسال شد.' });
    }
    if (pathname === '/api/friends/respond' && req.method === 'POST') {
      if (!auth) return json(res, 401, { ok: false, code: 'unauthorized', message: 'ابتدا وارد شوید.' });
      const body = await readBody(req);
      const f = await store.getFriendship(auth.uid, String(body.userId || ''));
      if (!f || f.status !== 'pending' || f.reqBy === auth.uid) {
        return json(res, 404, { ok: false, code: 'no_request', message: 'درخواست دویی برای پاسخ وجود ندارد.' });
      }
      await store.upsertFriendship(f.a, f.b, { status: body.accept ? 'accepted' : 'none', reqBy: null });
      return json(res, 200, { ok: true, message: body.accept ? 'دوست شما شدید.' : 'درخواست رد شد.' });
    }

    return json(res, 404, { ok: false, code: 'not_found', message: 'مسیر یافت نشد.' });
  };
}

module.exports = { makeRestHandler, json };
