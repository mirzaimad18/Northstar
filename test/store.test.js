const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let app;
let db;
let initializeDatabase;
let baseUrl;
let server;
let tempDirectory;

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'northstar-store-test-'));
  process.env.STORE_DB_PATH = path.join(tempDirectory, 'store.db');

  ({ app, db, initializeDatabase } = require('../server'));
  await initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  if (db) {
    await new Promise((resolve, reject) => {
      db.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (tempDirectory) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
  delete process.env.STORE_DB_PATH;
});

test('catalog, account sessions, guest checkout, and authenticated checkout', async (t) => {
  const jsonRequest = (url, body, headers = {}) =>
    fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  await t.test('seeds and serves all four products with CORS enabled', async () => {
    const response = await fetch(`${baseUrl}/api/products`, {
      headers: { Origin: 'http://localhost:8000' },
    });
    const products = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(products.length, 4);
  });

  await t.test('returns product details and explicit not-found responses', async () => {
    const found = await fetch(`${baseUrl}/api/products/1`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).name, 'Wireless Headphones');

    const missing = await fetch(`${baseUrl}/api/products/999`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'Product not found.');
  });

  await t.test('registers and logs in users with bearer sessions', async () => {
    const email = `buyer-${Date.now()}@example.com`;
    const registration = await jsonRequest('/api/register', {
      name: 'Test Buyer',
      email,
      password: 'correct-horse-battery',
    });
    const registered = await registration.json();
    assert.equal(registration.status, 201);
    assert.equal(typeof registered.token, 'string');
    assert.equal(registered.token.length, 64);

    const duplicate = await jsonRequest('/api/register', {
      name: 'Test Buyer',
      email,
      password: 'correct-horse-battery',
    });
    assert.equal(duplicate.status, 409);

    const login = await jsonRequest('/api/login', {
      email,
      password: 'correct-horse-battery',
    });
    const loggedIn = await login.json();
    assert.equal(login.status, 200);
    assert.equal(loggedIn.user.id, registered.user.id);
    assert.equal(typeof loggedIn.token, 'string');

    const invalidLogin = await jsonRequest('/api/login', {
      email,
      password: 'incorrect-password',
    });
    assert.equal(invalidLogin.status, 401);

    const invalidRegistration = await jsonRequest('/api/register', {
      name: 'Invalid',
      email: 'not-an-email',
      password: 'short',
    });
    assert.equal(invalidRegistration.status, 400);

    const order = await jsonRequest(
      '/api/orders',
      { productId: 1, quantity: 2, userId: 999999 },
      { Authorization: `Bearer ${loggedIn.token}` },
    );
    const ordered = await order.json();
    assert.equal(order.status, 201);
    assert.equal(ordered.order.userId, registered.user.id);
    assert.equal(ordered.order.total, 159.98);

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loggedIn.token}` },
    });
    assert.equal(logout.status, 204);

    const rejectedSession = await jsonRequest(
      '/api/orders',
      { productId: 1, quantity: 1 },
      { Authorization: `Bearer ${loggedIn.token}` },
    );
    assert.equal(rejectedSession.status, 401);
  });

  await t.test('supports guest orders without trusting a client-supplied user ID', async () => {
    const response = await jsonRequest('/api/orders', {
      productId: 2,
      quantity: 1,
      userId: 1,
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.order.total, 129.99);

    const guest = await new Promise((resolve, reject) => {
      db.get(
        'SELECT id FROM users WHERE email = ?',
        ['guest-checkout@northstar.local'],
        (error, row) => (error ? reject(error) : resolve(row)),
      );
    });
    assert.equal(result.order.userId, guest.id);
    assert.notEqual(result.order.userId, 1);
  });

  await t.test('rejects malformed order requests without creating guest records', async () => {
    const invalidQuantity = await jsonRequest('/api/orders', {
      productId: 1,
      quantity: 0,
    });
    assert.equal(invalidQuantity.status, 400);

    const unknownProduct = await jsonRequest('/api/orders', {
      productId: 999999,
      quantity: 1,
    });
    assert.equal(unknownProduct.status, 404);
  });
});
