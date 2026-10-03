import express from 'express';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'vp_optimizer';

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
app.use(express.json({ limit: '250kb' }));

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
  if (!name) throw new Error('Product name is required.');
  if (!Number.isFinite(mrp) || mrp < 0) throw new Error('MRP must be zero or more integer paise.');
  if (!Number.isFinite(vp) || vp < 0) throw new Error('VP must be zero or more.');
  const min = optionalQuantity(input.min);
  const max = optionalQuantity(input.max);
  if (min !== undefined && max !== undefined && min > max) throw new Error('Maximum quantity must be at least the minimum.');
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
  // Reserved product fields remain safe to store when the UI starts using them.
  if (input.rates && typeof input.rates === 'object' && !Array.isArray(input.rates)) product.rates = input.rates;
  if (input.profit && typeof input.profit === 'object' && !Array.isArray(input.profit)) product.profit = input.profit;
  return product;
}
function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
function sendError(response, error, status = 400) {
  response.status(status).json({ error: error.message || 'Request could not be completed.' });
}

app.get('/api/health', (_request, response) => response.json({ ok: true, database: DB_NAME }));

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
    next(error);
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

// Serve the browser app and its framework-free tests from the same origin.
app.use(express.static(ROOT, { extensions: ['html'], maxAge: 0, etag: false }));
app.use((error, _request, response, _next) => {
  console.error(error);
  sendError(response, error, 500);
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
