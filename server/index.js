import express from 'express';
import { MongoClient } from 'mongodb';
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'vp_optimizer';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || '';
const SESSION_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE = 'vp_optimizer_session';
const GOOGLE_STATE_COOKIE = 'vp_optimizer_google_state';

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required. Set it before starting VP Optimizer.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set. Sessions end whenever the server restarts.');

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
try { await client.connect(); } catch (error) {
  console.error(`Could not connect to MongoDB at ${MONGODB_URI}. Start MongoDB or set MONGODB_URI.`, error.message);
  process.exit(1);
}
const db = client.db(DB_NAME);
const products = db.collection('products');
const prefs = db.collection('preferences');
const users = db.collection('users');
const trafficEvents = db.collection('traffic_events');
const activities = db.collection('user_activities');
const baskets = db.collection('saved_baskets');
await Promise.all([
  products.createIndex({ id: 1 }, { unique: true }),
  users.createIndex({ email: 1 }, { unique: true }),
  users.createIndex({ googleSubject: 1 }, { unique: true, sparse: true }),
  trafficEvents.createIndex({ at: -1 }),
  trafficEvents.createIndex({ visitorId: 1, at: -1 }),
  activities.createIndex({ userId: 1, at: -1 }),
  baskets.createIndex({ userId: 1, updatedAt: -1 }),
  baskets.createIndex({ id: 1 }, { unique: true }),
]);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '250kb' }));

function invalid(message) { const error = new Error(message); error.status = 400; return error; }
function plainText(value, max = 160) { return String(value ?? '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function optionalQuantity(value) { return value === undefined || value === null || value === '' ? undefined : Math.max(0, Math.trunc(number(value))); }
function serialise(document) { if (!document) return null; const { _id, passwordHash, passwordSalt, ...value } = document; return value; }
function catalogueIdentity(product) { return [plainText(product.name).toLowerCase(), plainText(product.sku, 60).toLowerCase(), Math.round(number(product.mrp)), Math.round(number(product.vp) * 100) / 100].join('\u0000'); }
function sendError(response, error, status = 400) { response.status(status).json({ error: error.message || 'Request could not be completed.' }); }
function cleanProduct(input = {}, forcedId) {
  const name = plainText(input.name, 120);
  const mrp = Math.round(number(input.mrp, NaN));
  const vp = Math.round(number(input.vp, NaN) * 100) / 100;
  if (!name) throw invalid('Product name is required.');
  if (!Number.isFinite(mrp) || mrp < 0) throw invalid('MRP must be zero or more integer paise.');
  if (!Number.isFinite(vp) || vp < 0) throw invalid('VP must be zero or more.');
  const min = optionalQuantity(input.min); const max = optionalQuantity(input.max);
  if (min !== undefined && max !== undefined && min > max) throw invalid('Maximum quantity must be at least the minimum.');
  const product = { id: forcedId || plainText(input.id, 100) || randomUUID(), name, mrp, vp, category: plainText(input.category, 60), sku: plainText(input.sku, 60), active: input.active !== false && input.active !== 'false' && input.active !== '0' };
  if (min !== undefined) product.min = min;
  if (max !== undefined) product.max = max;
  if (input.rates && typeof input.rates === 'object' && !Array.isArray(input.rates)) product.rates = input.rates;
  if (input.profit && typeof input.profit === 'object' && !Array.isArray(input.profit)) product.profit = input.profit;
  return product;
}
function normaliseEmail(value) {
  const email = plainText(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email address.');
  return email;
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10) throw invalid('Password must contain at least 10 characters.');
  if (value.length > 200) throw invalid('Password is too long.');
  return value;
}
async function hashPassword(password) { const salt = randomBytes(16).toString('base64url'); return { salt, hash: (await scrypt(password, salt, 64)).toString('base64url') }; }
async function passwordHashMatches(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const expected = Buffer.from(user.passwordHash, 'base64url'); const actual = await scrypt(password, user.passwordSalt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function safeJson(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === 'string') return plainText(value, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) if (!key.startsWith('$') && !key.includes('.')) output[plainText(key, 60)] = safeJson(item, depth + 1);
    return output;
  }
  return null;
}

function parseCookies(request) {
  const output = {};
  for (const part of (request.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    try { output[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { /* malformed cookie ignored */ }
  }
  return output;
}
function sign(value) { return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function makeCookie(name, value, maxAge, { sameSite = 'Strict', httpOnly = true } = {}) {
  // Render/production uses HTTPS. Do not force Secure on localhost, otherwise
  // browsers can discard the OAuth session after returning to http://localhost.
  const localCallback = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?\//.test(GOOGLE_CALLBACK_URL);
  const secureCookie = process.env.COOKIE_SECURE === 'true' || (process.env.NODE_ENV === 'production' && !localCallback);
  return `${name}=${encodeURIComponent(value)}; Path=/; ${httpOnly ? 'HttpOnly; ' : ''}SameSite=${sameSite}; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
}
function issueSession({ userId, role, email = '', displayName = '', avatarUrl = '' }) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, role, email, displayName, avatarUrl, exp: Date.now() + SESSION_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE]; if (!token || typeof token !== 'string') return null;
  const [encoded, signature, extra] = token.split('.'); if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(sign(encoded)); const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload?.sub && ['admin', 'user'].includes(payload.role) && Number.isFinite(payload.exp) && payload.exp >= Date.now() ? payload : null;
  } catch (_) { return null; }
}
function clearSession(response) { response.setHeader('Set-Cookie', makeCookie(SESSION_COOKIE, '', 0)); }
function adminPasswordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(ADMIN_PASSWORD); const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
async function requireAuth(request, response, next) {
  try {
    const session = readSession(request);
    if (!session) return response.status(401).json({ error: 'Please sign in.' });
    if (session.role === 'user') {
      const user = await users.findOne({ id: session.sub, active: true }, { projection: { id: 1, email: 1, displayName: 1, analyticsConsent: 1, active: 1 } });
      if (!user) { clearSession(response); return response.status(403).json({ error: 'This account is unavailable.' }); }
      request.user = user;
    }
    request.auth = session;
    return next();
  } catch (error) { return next(error); }
}
function requireAdmin(request, response, next) {
  const session = request.auth || readSession(request);
  if (!session) return response.status(401).json({ error: 'Please sign in.' });
  if (session.role !== 'admin') return response.status(403).json({ error: 'Administrator access is required.' });
  request.auth = session;
  return next();
}

const attempts = new Map();
function loginAllowed(request) { const key = request.ip || 'unknown'; const now = Date.now(); const current = (attempts.get(key) || []).filter((time) => now - time < 10 * 60 * 1000); attempts.set(key, current); return current.length < 5; }
function failedLogin(request) { const key = request.ip || 'unknown'; attempts.set(key, [...(attempts.get(key) || []), Date.now()]); }
const telemetryHits = new Map();
function telemetryAllowed(request) { const key = request.ip || 'unknown'; const now = Date.now(); const recent = (telemetryHits.get(key) || []).filter((time) => now - time < 60_000); recent.push(now); telemetryHits.set(key, recent); return recent.length <= 60; }
async function recordTraffic(request, type, details = {}, actor = readSession(request)) {
  const visitorId = /^[a-zA-Z0-9-]{8,80}$/.test(String(request.body?.visitorId || '')) ? String(request.body.visitorId) : null;
  const ipHash = createHmac('sha256', SESSION_SECRET).update(request.ip || '').digest('hex').slice(0, 24);
  await trafficEvents.insertOne({ type, at: new Date(), visitorId, ipHash, userId: actor?.sub || null, role: actor?.role || 'anonymous', details: safeJson(details) || {} });
}
function googleReady() { return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL); }
function authErrorRedirect(code) { return `/?auth=${encodeURIComponent(code)}`; }

app.get('/api/health', (_request, response) => response.json({ ok: true, database: DB_NAME, googleSignIn: googleReady() }));
app.get('/api/auth/session', async (request, response, next) => {
  try {
    const session = readSession(request); if (!session) return response.status(401).json({ authenticated: false });
    if (session.role === 'user') {
      const user = await users.findOne({ id: session.sub, active: true }, { projection: { id: 1, email: 1, displayName: 1, avatarUrl: 1, analyticsConsent: 1 } });
      if (!user) { clearSession(response); return response.status(401).json({ authenticated: false }); }
      return response.json({ authenticated: true, role: 'user', userId: user.id, email: user.email, displayName: user.displayName || user.email.split('@')[0], avatarUrl: user.avatarUrl || '', analyticsConsent: Boolean(user.analyticsConsent), googleSignIn: googleReady() });
    }
    return response.json({ authenticated: true, role: 'admin', userId: 'admin', email: '', displayName: 'Administrator', avatarUrl: '', analyticsConsent: false, googleSignIn: googleReady() });
  } catch (error) { return next(error); }
});
app.post('/api/auth/admin-login', async (request, response) => {
  if (!loginAllowed(request)) return response.status(429).json({ error: 'Too many password attempts. Try again in 10 minutes.' });
  if (!adminPasswordMatches(request.body?.password)) { failedLogin(request); return response.status(401).json({ error: 'Incorrect administrator password.' }); }
  attempts.delete(request.ip || 'unknown');
  const actor = { sub: 'admin', role: 'admin' };
  response.setHeader('Set-Cookie', makeCookie(SESSION_COOKIE, issueSession({ userId: 'admin', role: 'admin', displayName: 'Administrator' }), SESSION_SECONDS));
  void recordTraffic(request, 'admin_login', {}, actor).catch(() => {});
  return response.json({ authenticated: true, role: 'admin' });
});
app.post('/api/auth/register', async (request, response, next) => {
  try {
    if (!loginAllowed(request)) return response.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const email = normaliseEmail(request.body?.email); const password = validatePassword(request.body?.password); const credentials = await hashPassword(password);
    const user = { id: randomUUID(), email, displayName: plainText(request.body?.displayName || email.split('@')[0], 80), passwordSalt: credentials.salt, passwordHash: credentials.hash, provider: 'password', role: 'user', analyticsConsent: request.body?.analyticsConsent === true, createdAt: new Date(), lastLoginAt: new Date(), active: true };
    await users.insertOne(user); attempts.delete(request.ip || 'unknown');
    const actor = { sub: user.id, role: 'user' };
    response.setHeader('Set-Cookie', makeCookie(SESSION_COOKIE, issueSession({ userId: user.id, role: 'user', email: user.email, displayName: user.displayName }), SESSION_SECONDS));
    void recordTraffic(request, 'account_registered', { consent: user.analyticsConsent }, actor).catch(() => {});
    return response.status(201).json({ authenticated: true, role: 'user', email: user.email, displayName: user.displayName });
  } catch (error) { if (error?.code === 11000) return response.status(409).json({ error: 'An account already exists for this email address.' }); failedLogin(request); return next(error); }
});
app.post('/api/auth/login', async (request, response, next) => {
  try {
    if (!loginAllowed(request)) return response.status(429).json({ error: 'Too many login attempts. Try again in 10 minutes.' });
    const email = normaliseEmail(request.body?.email); const password = validatePassword(request.body?.password); const user = await users.findOne({ email });
    if (!user || !user.active || !(await passwordHashMatches(password, user))) { failedLogin(request); return response.status(401).json({ error: 'Email or password is incorrect.' }); }
    await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }); attempts.delete(request.ip || 'unknown');
    const actor = { sub: user.id, role: 'user' };
    response.setHeader('Set-Cookie', makeCookie(SESSION_COOKIE, issueSession({ userId: user.id, role: 'user', email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl || '' }), SESSION_SECONDS));
    void recordTraffic(request, 'user_login', {}, actor).catch(() => {});
    return response.json({ authenticated: true, role: 'user', email: user.email, displayName: user.displayName || user.email.split('@')[0] });
  } catch (error) { failedLogin(request); return next(error); }
});
app.get('/api/auth/google', (request, response) => {
  if (!googleReady()) return response.redirect(authErrorRedirect('google-not-configured'));
  const state = randomBytes(24).toString('base64url');
  response.setHeader('Set-Cookie', makeCookie(GOOGLE_STATE_COOKIE, `${state}.${sign(state)}`, 600, { sameSite: 'Lax' }));
  const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_CALLBACK_URL, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  return response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
app.get('/api/auth/google/callback', async (request, response, next) => {
  try {
    if (!googleReady()) return response.redirect(authErrorRedirect('google-not-configured'));
    if (request.query.error) return response.redirect(authErrorRedirect('google-cancelled'));
    const stateCookie = parseCookies(request)[GOOGLE_STATE_COOKIE] || ''; const [savedState, savedSignature] = stateCookie.split('.');
    const expected = Buffer.from(sign(savedState || '')); const received = Buffer.from(savedSignature || '');
    if (!request.query.code || !request.query.state || savedState !== request.query.state || expected.length !== received.length || !timingSafeEqual(expected, received)) return response.redirect(authErrorRedirect('google-state-error'));
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(request.query.code), client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_CALLBACK_URL, grant_type: 'authorization_code' }) });
    const tokens = await tokenResponse.json(); if (!tokenResponse.ok || !tokens.access_token) throw invalid('Google sign-in could not be completed.');
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileResponse.json(); if (!profileResponse.ok || !profile.email || profile.email_verified === false || !profile.sub) throw invalid('Google did not return a verified email address.');
    const email = normaliseEmail(profile.email); const now = new Date(); const displayName = plainText(profile.name || email.split('@')[0], 80); const avatarUrl = plainText(profile.picture || '', 500);
    let user = await users.findOne({ $or: [{ googleSubject: profile.sub }, { email }] });
    if (user && !user.active) return response.redirect(authErrorRedirect('account-disabled'));
    if (user) {
      await users.updateOne({ _id: user._id }, { $set: { googleSubject: profile.sub, provider: user.provider === 'password' ? 'password+google' : 'google', displayName, avatarUrl, lastLoginAt: now } });
      user = { ...user, displayName, avatarUrl };
    } else {
      user = { id: randomUUID(), email, displayName, avatarUrl, googleSubject: profile.sub, provider: 'google', role: 'user', analyticsConsent: false, createdAt: now, lastLoginAt: now, active: true };
      await users.insertOne(user);
    }
    const actor = { sub: user.id, role: 'user' };
    response.setHeader('Set-Cookie', [makeCookie(SESSION_COOKIE, issueSession({ userId: user.id, role: 'user', email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl }), SESSION_SECONDS), makeCookie(GOOGLE_STATE_COOKIE, '', 0, { sameSite: 'Lax' })]);
    void recordTraffic(request, 'google_login', {}, actor).catch(() => {});
    return response.redirect('/?auth=google-success');
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message);
    response.setHeader('Set-Cookie', makeCookie(GOOGLE_STATE_COOKIE, '', 0, { sameSite: 'Lax' }));
    return response.redirect(authErrorRedirect('google-error'));
  }
});
app.post('/api/auth/logout', (request, response) => { void recordTraffic(request, 'logout').catch(() => {}); clearSession(response); response.status(204).end(); });

app.post('/api/telemetry', async (request, response, next) => {
  try {
    if (!telemetryAllowed(request)) return response.status(429).json({ error: 'Too many telemetry events.' });
    const type = plainText(request.body?.type, 50); if (!['page_view', 'view_change'].includes(type)) throw invalid('Unsupported telemetry event.');
    await recordTraffic(request, type, { path: plainText(request.body?.path, 160), view: plainText(request.body?.view, 30) });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.patch('/api/me/analytics-consent', requireAuth, async (request, response, next) => {
  try {
    const consent = request.body?.consent === true;
    if (request.auth.role === 'user') await users.updateOne({ id: request.auth.sub }, { $set: { analyticsConsent: consent } });
    response.json({ consent });
  } catch (error) { next(error); }
});
app.post('/api/activity', requireAuth, async (request, response, next) => {
  try {
    const type = plainText(request.body?.type, 40); if (!['optimize', 'calculator'].includes(type)) throw invalid('Unsupported activity type.');
    const data = safeJson(request.body?.data); if (!data || JSON.stringify(data).length > 12_000) throw invalid('Activity data is invalid or too large.');
    await activities.insertOne({ userId: request.auth.sub, role: request.auth.role, type, data, at: new Date() });
    await recordTraffic(request, 'activity_saved', { type }); response.status(201).json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/me/activities', requireAuth, async (request, response, next) => {
  try { const limit = Math.max(1, Math.min(100, Math.trunc(number(request.query.limit, 50)))); response.json((await activities.find({ userId: request.auth.sub }).sort({ at: -1 }).limit(limit).toArray()).map(serialise)); } catch (error) { next(error); }
});
app.get('/api/me/baskets', requireAuth, async (request, response, next) => {
  try { response.json((await baskets.find({ userId: request.auth.sub }).sort({ updatedAt: -1 }).limit(100).toArray()).map(serialise)); } catch (error) { next(error); }
});
app.post('/api/me/baskets', requireAuth, async (request, response, next) => {
  try {
    const name = plainText(request.body?.name, 80); const type = plainText(request.body?.type, 30); const data = safeJson(request.body?.data);
    if (!name) throw invalid('Give this basket a name.'); if (!['calculator', 'optimizer'].includes(type)) throw invalid('Unsupported basket type.'); if (!data || JSON.stringify(data).length > 12_000) throw invalid('Basket data is invalid or too large.');
    const basket = { id: randomUUID(), userId: request.auth.sub, type, name, data, createdAt: new Date(), updatedAt: new Date() };
    await baskets.insertOne(basket); await recordTraffic(request, 'basket_saved', { type }); response.status(201).json(serialise(basket));
  } catch (error) { next(error); }
});
app.delete('/api/me/baskets/:id', requireAuth, async (request, response, next) => {
  try { const result = await baskets.deleteOne({ id: request.params.id, userId: request.auth.sub }); if (!result.deletedCount) return response.status(404).json({ error: 'Saved basket not found.' }); return response.status(204).end(); } catch (error) { return next(error); }
});

// Every signed-in user can read the shared catalogue; only admin can write it.
app.use('/api/products', requireAuth);
app.get('/api/products', async (_request, response, next) => { try { response.json(await products.find({}, { projection: { _id: 0 } }).sort({ name: 1, id: 1 }).toArray()); } catch (error) { next(error); } });
app.get('/api/products/prefs', async (request, response, next) => {
  try { let saved = await prefs.findOne({ _id: request.auth.sub }); if (!saved && request.auth.role === 'admin') saved = await prefs.findOne({ _id: 'default' }); response.json(saved?.value || {}); } catch (error) { next(error); }
});
app.patch('/api/products/prefs', async (request, response, next) => {
  try { const current = (await prefs.findOne({ _id: request.auth.sub }))?.value || {}; const value = { ...current, ...(safeJson(request.body) || {}) }; await prefs.updateOne({ _id: request.auth.sub }, { $set: { value } }, { upsert: true }); response.json(value); } catch (error) { next(error); }
});
app.get('/api/products/:id', async (request, response, next) => { try { const product = await products.findOne({ id: request.params.id }); if (!product) return response.status(404).json({ error: 'Product not found.' }); return response.json(serialise(product)); } catch (error) { return next(error); } });
app.post('/api/products', requireAdmin, async (request, response, next) => { try { const product = cleanProduct(request.body); await products.insertOne(product); response.status(201).json(product); } catch (error) { if (error?.code === 11000) return response.status(409).json({ error: 'A product with this id already exists.' }); return next(error); } });
app.put('/api/products/:id', requireAdmin, async (request, response, next) => { try { const product = cleanProduct(request.body, request.params.id); await products.updateOne({ id: request.params.id }, { $set: product }, { upsert: true }); response.json(product); } catch (error) { next(error); } });
app.post('/api/products/bulk', requireAdmin, async (request, response, next) => {
  try {
    if (!Array.isArray(request.body)) throw invalid('Bulk import must be an array of products.');
    const identities = new Set((await products.find({}, { projection: { _id: 0 } }).toArray()).map(catalogueIdentity)); const added = [];
    for (const row of request.body) { const product = cleanProduct(row); const identity = catalogueIdentity(product); if (!identities.has(identity)) { identities.add(identity); added.push(product); } }
    if (added.length) await products.insertMany(added, { ordered: true }); response.status(201).json(added);
  } catch (error) { next(error); }
});
app.delete('/api/products/:id', requireAdmin, async (request, response, next) => { try { const result = await products.deleteOne({ id: request.params.id }); if (!result.deletedCount) return response.status(404).json({ error: 'Product not found.' }); return response.status(204).end(); } catch (error) { return next(error); } });
app.delete('/api/products', requireAdmin, async (_request, response, next) => { try { await products.deleteMany({}); response.status(204).end(); } catch (error) { next(error); } });

async function trafficSummary() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [usersCount, activityCount, eventCount, visitors] = await Promise.all([
    users.countDocuments({}), activities.countDocuments({ at: { $gte: since } }), trafficEvents.countDocuments({ at: { $gte: since } }),
    trafficEvents.aggregate([{ $match: { at: { $gte: since }, visitorId: { $ne: null } } }, { $group: { _id: '$visitorId' } }, { $count: 'count' }]).toArray(),
  ]);
  return { days: 30, users: usersCount, activities: activityCount, events: eventCount, uniqueVisitors: visitors[0]?.count || 0 };
}
app.get('/api/admin/traffic-summary', requireAuth, requireAdmin, async (_request, response, next) => { try { response.json(await trafficSummary()); } catch (error) { next(error); } });
app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (_request, response, next) => {
  try {
    const [summary, userRows, activityRows] = await Promise.all([
      trafficSummary(),
      users.find({}, { projection: { passwordHash: 0, passwordSalt: 0 } }).sort({ createdAt: -1 }).limit(200).toArray(),
      activities.find({}, { projection: { data: 0 } }).sort({ at: -1 }).limit(30).toArray(),
    ]);
    const counts = await activities.aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }]).toArray(); const activityCounts = new Map(counts.map((row) => [row._id, row.count]));
    const userMap = new Map(userRows.map((user) => [user.id, user]));
    response.json({ summary, users: userRows.map((user) => ({ ...serialise(user), activityCount: activityCounts.get(user.id) || 0 })), recentActivities: activityRows.map((activity) => ({ ...serialise(activity), userEmail: activity.userId === 'admin' ? 'Administrator' : userMap.get(activity.userId)?.email || 'Unknown user' })) });
  } catch (error) { next(error); }
});
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (request, response, next) => {
  try {
    if (typeof request.body?.active !== 'boolean') throw invalid('Provide an active true/false value.');
    const result = await users.findOneAndUpdate({ id: request.params.id }, { $set: { active: request.body.active } }, { returnDocument: 'after', projection: { passwordHash: 0, passwordSalt: 0 } });
    const updated = result?.value ?? result;
    if (!updated) return response.status(404).json({ error: 'User not found.' });
    response.json(serialise(updated));
  } catch (error) { next(error); }
});

const staticOptions = { maxAge: 0, etag: false, dotfiles: 'deny' };
app.use('/css', express.static(path.join(ROOT, 'css'), staticOptions));
app.use('/js', express.static(path.join(ROOT, 'js'), staticOptions));
app.use('/tests', express.static(path.join(ROOT, 'tests'), staticOptions));
app.get('/', (_request, response) => response.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'deny' }));
app.use((error, _request, response, _next) => { console.error(error); sendError(response, error, error.status || 500); });

const server = app.listen(PORT, '0.0.0.0', () => { console.log(`VP Optimizer API and app listening on http://0.0.0.0:${PORT}`); console.log(`MongoDB database: ${DB_NAME}`); });
async function shutdown() { await new Promise((resolve) => server.close(resolve)); await client.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
