import express from 'express';
import { MongoClient } from 'mongodb';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'vp_optimizer';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE = 'vp_optimizer_admin';

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required. Set it before starting VP Optimizer.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set. Sessions will end whenever the server restarts.');

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
} catch (error) {
  console.error(`Could not connect to MongoDB at ${MONGODB_URI}. Start MongoDB or set MONGODB_URI.`, error.message);
  process.exit(1);
}
const db = client.db(DB_NAME);
const products = db.collection('products');
const prefs = db.collection('preferences');
await products.createIndex({ id: 1 }, { unique: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '250kb' }));

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
function plainText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function optionalQuantity(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return Math.max(0, Math.trunc(number(value)));
}
function serialise(document) {
  if (!document) return null;
  const { _id, ...product } = document;
  return product;
}
function catalogueIdentity(product) {
  return [
    plainText(product.name).toLowerCase(),
    plainText(product.sku, 60).toLowerCase(),
    Math.round(number(product.mrp)),
    Math.round(number(product.vp) * 100) / 100,
  ].join('\u0000');
}
function cleanProduct(input = {}, forcedId) {
  const name = plainText(input.name, 120);
  const mrp = Math.round(number(input.mrp, NaN));
  const vp = Math.round(number(input.vp, NaN) * 100) / 100;
  if (!name) throw invalid('Product name is required.');
  if (!Number.isFinite(mrp) || mrp < 0) throw invalid('MRP must be zero or more integer paise.');
  if (!Number.isFinite(vp) || vp < 0) throw invalid('VP must be zero or more.');
  const min = optionalQuantity(input.min);
  const max = optionalQuantity(input.max);
  if (min !== undefined && max !== undefined && min > max) throw invalid('Maximum quantity must be at least the minimum.');
  const product = {
    id: forcedId || plainText(input.id, 100) || randomUUID(),
    name,
    mrp,
    vp,
    category: plainText(input.category, 60),
    sku: plainText(input.sku, 60),
    active: input.active !== false && input.active !== 'false' && input.active !== '0',
  };
  if (min !== undefined) product.min = min;
  if (max !== undefined) product.max = max;
  if (input.rates && typeof input.rates === 'object' && !Array.isArray(input.rates)) product.rates = input.rates;
  if (input.profit && typeof input.profit === 'object' && !Array.isArray(input.profit)) product.profit = input.profit;
  return product;
}
function sendError(response, error, status = 400) {
  response.status(status).json({ error: error.message || 'Request could not be completed.' });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}
function sign(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function issueSession() {
  const expiresAt = String(Date.now() + SESSION_SECONDS * 1000);
  return `${expiresAt}.${sign(expiresAt)}`;
}
function validSession(token) {
  if (!token || typeof token !== 'string') return false;
  const [expiresAt, signature, extra] = token.split('.');
  if (!expiresAt || !signature || extra || !/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  const expected = Buffer.from(sign(expiresAt));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
function cookie(value, maxAge = SESSION_SECONDS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function passwordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(ADMIN_PASSWORD);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const attempts = new Map();
function loginAllowed(request) {
  const key = request.ip || 'unknown';
  const now = Date.now();
  const current = (attempts.get(key) || []).filter((time) => now - time < 10 * 60 * 1000);
  attempts.set(key, current);
  return current.length < 5;
}
function failedLogin(request) {
  const key = request.ip || 'unknown';
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}
function requireAdmin(request, response, next) {
  if (validSession(parseCookies(request)[SESSION_COOKIE])) return next();
  return response.status(401).json({ error: 'Please sign in as the administrator.' });
}

app.get('/api/health', (_request, response) => response.json({ ok: true, database: DB_NAME }));
app.get('/api/auth/session', (request, response) => {
  if (!validSession(parseCookies(request)[SESSION_COOKIE])) return response.status(401).json({ authenticated: false });
  return response.json({ authenticated: true });
});
app.post('/api/auth/login', (request, response) => {
  if (!loginAllowed(request)) return response.status(429).json({ error: 'Too many password attempts. Try again in 10 minutes.' });
  if (!passwordMatches(request.body?.password)) {
    failedLogin(request);
    return response.status(401).json({ error: 'Incorrect password.' });
  }
  attempts.delete(request.ip || 'unknown');
  response.setHeader('Set-Cookie', cookie(issueSession()));
  return response.json({ authenticated: true });
});
app.post('/api/auth/logout', (_request, response) => {
  response.setHeader('Set-Cookie', cookie('', 0));
  response.status(204).end();
});

// Every catalogue and preference endpoint requires the signed HttpOnly session.
app.use('/api/products', requireAdmin);

app.get('/api/products', async (_request, response, next) => {
  try {
    const rows = await products.find({}, { projection: { _id: 0 } }).sort({ name: 1, id: 1 }).toArray();
    response.json(rows);
  } catch (error) { next(error); }
});
app.get('/api/products/prefs', async (_request, response, next) => {
  try {
    const saved = await prefs.findOne({ _id: 'default' });
    response.json(saved?.value || {});
  } catch (error) { next(error); }
});
app.patch('/api/products/prefs', async (request, response, next) => {
  try {
    const current = (await prefs.findOne({ _id: 'default' }))?.value || {};
    const value = { ...current, ...(request.body || {}) };
    await prefs.updateOne({ _id: 'default' }, { $set: { value } }, { upsert: true });
    response.json(value);
  } catch (error) { next(error); }
});
app.get('/api/products/:id', async (request, response, next) => {
  try {
    const product = await products.findOne({ id: request.params.id });
    if (!product) return response.status(404).json({ error: 'Product not found.' });
    response.json(serialise(product));
  } catch (error) { next(error); }
});
app.post('/api/products', async (request, response, next) => {
  try {
    const product = cleanProduct(request.body);
    await products.insertOne(product);
    response.status(201).json(product);
  } catch (error) {
    if (error?.code === 11000) return response.status(409).json({ error: 'A product with this id already exists.' });
    return next(error);
  }
});
app.put('/api/products/:id', async (request, response, next) => {
  try {
    const product = cleanProduct(request.body, request.params.id);
    await products.updateOne({ id: request.params.id }, { $set: product }, { upsert: true });
    response.json(product);
  } catch (error) { next(error); }
});
app.post('/api/products/bulk', async (request, response, next) => {
  try {
    if (!Array.isArray(request.body)) throw invalid('Bulk import must be an array of products.');
    const existingRows = await products.find({}, { projection: { _id: 0 } }).toArray();
    const identities = new Set(existingRows.map(catalogueIdentity));
    const added = [];
    for (const row of request.body) {
      const product = cleanProduct(row);
      const identity = catalogueIdentity(product);
      if (identities.has(identity)) continue;
      identities.add(identity);
      added.push(product);
    }
    if (added.length) await products.insertMany(added, { ordered: true });
    response.status(201).json(added);
  } catch (error) { next(error); }
});
app.delete('/api/products/:id', async (request, response, next) => {
  try {
    const result = await products.deleteOne({ id: request.params.id });
    if (!result.deletedCount) return response.status(404).json({ error: 'Product not found.' });
    response.status(204).end();
  } catch (error) { next(error); }
});
app.delete('/api/products', async (_request, response, next) => {
  try {
    await products.deleteMany({});
    response.status(204).end();
  } catch (error) { next(error); }
});

// Deliberately expose only browser assets, not server source, project files, or .env.
const staticOptions = { maxAge: 0, etag: false, dotfiles: 'deny' };
app.use('/css', express.static(path.join(ROOT, 'css'), staticOptions));
app.use('/js', express.static(path.join(ROOT, 'js'), staticOptions));
app.use('/tests', express.static(path.join(ROOT, 'tests'), staticOptions));
app.get('/', (_request, response) => response.sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'deny' }));
app.use((error, _request, response, _next) => {
  console.error(error);
  sendError(response, error, error.status || 500);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`VP Optimizer API and app listening on http://0.0.0.0:${PORT}`);
  console.log(`MongoDB database: ${DB_NAME}`);
});
async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await client.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
