const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const dbPath = process.env.STORE_DB_PATH || path.join(__dirname, 'store.db');
const db = new sqlite3.Database(dbPath);
const scrypt = promisify(crypto.scrypt);
const PORT = 5000;
const GUEST_EMAIL = 'guest-checkout@northstar.local';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

app.use(cors());
app.use(express.json());

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function setStatus(error, status) {
  error.status = status;
  return error;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getSession(req) {
  const authorization = req.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) {
    throw setStatus(new Error('A valid bearer token is required.'), 401);
  }

  const token = match[1];
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    throw setStatus(new Error('Your session has expired. Please sign in again.'), 401);
  }
  return { token, ...session };
}

async function getGuestUserId() {
  const guestPasswordHash = [
    crypto.randomBytes(16).toString('hex'),
    crypto.randomBytes(64).toString('hex'),
  ].join(':');

  await run(
    `INSERT OR IGNORE INTO users (name, email, password_hash)
     VALUES (?, ?, ?)`,
    ['Guest Checkout', GUEST_EMAIL, guestPasswordHash],
  );

  const guest = await get('SELECT id FROM users WHERE email = ?', [GUEST_EMAIL]);
  if (!guest) {
    throw new Error('Could not create or find the guest checkout user.');
  }
  return guest.id;
}

async function initializeDatabase() {
  await run('PRAGMA foreign_keys = ON');
  await new Promise((resolve, reject) => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price REAL NOT NULL CHECK (price >= 0)
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        total REAL NOT NULL CHECK (total >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      (error) => (error ? reject(error) : resolve()),
    );
  });

  const productCount = await get('SELECT COUNT(*) AS count FROM products');
  if (productCount.count === 0) {
    const sampleProducts = [
      ['Wireless Headphones', 'Comfortable over-ear headphones with clear sound.', 79.99],
      ['Smart Watch', 'Track your activity and stay connected throughout the day.', 129.99],
      ['Travel Backpack', 'A durable backpack with room for everyday essentials.', 49.99],
      ['Portable Speaker', 'A compact Bluetooth speaker for music on the go.', 39.99],
    ];

    await run('BEGIN TRANSACTION');
    try {
      for (const product of sampleProducts) {
        await run(
          'INSERT INTO products (name, description, price) VALUES (?, ?, ?)',
          product,
        );
      }
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }
}

app.get('/api/products', async (req, res) => {
  console.log('GET /api/products requested');
  const products = await all(
    'SELECT id, name, description, price FROM products ORDER BY id',
  );
  res.json(products);
});

app.get('/api/products/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return next(setStatus(new Error('Product ID must be a positive integer.'), 400));
  }

  const product = await get(
    'SELECT id, name, description, price FROM products WHERE id = ?',
    [id],
  );
  if (!product) {
    return next(setStatus(new Error('Product not found.'), 404));
  }
  res.json(product);
});

app.post('/api/register', async (req, res, next) => {
  const { name, email, password } = req.body || {};
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    typeof password !== 'string' ||
    password.length < 6
  ) {
    return next(
      setStatus(
        new Error('Provide a name, valid email, and password of at least 6 characters.'),
        400,
      ),
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await get('SELECT id FROM users WHERE email = ?', [
    normalizedEmail,
  ]);
  if (existingUser) {
    return next(setStatus(new Error('An account with this email already exists.'), 409));
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordKey = await scrypt(password, salt, 64);
  const passwordHash = `${salt}:${passwordKey.toString('hex')}`;

  try {
    const result = await run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name.trim(), normalizedEmail, passwordHash],
    );
    const user = { id: result.lastID, name: name.trim(), email: normalizedEmail };
    res.status(201).json({
      message: 'Registration successful.',
      token: createSession(user),
      user,
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return next(setStatus(new Error('An account with this email already exists.'), 409));
    }
    return next(error);
  }
});

app.post('/api/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return next(setStatus(new Error('Email and password are required.'), 400));
  }

  const user = await get(
    'SELECT id, name, email, password_hash FROM users WHERE email = ?',
    [email.trim().toLowerCase()],
  );
  if (!user) {
    return next(setStatus(new Error('Invalid email or password.'), 401));
  }

  const [salt, storedKeyHex] = user.password_hash.split(':');
  if (!salt || !/^[a-f0-9]{128}$/i.test(storedKeyHex || '')) {
    return next(new Error('Stored password hash is invalid.'));
  }

  const storedKey = Buffer.from(storedKeyHex, 'hex');
  const suppliedKey = await scrypt(password, salt, storedKey.length);
  if (!crypto.timingSafeEqual(storedKey, suppliedKey)) {
    return next(setStatus(new Error('Invalid email or password.'), 401));
  }

  const authenticatedUser = { id: user.id, name: user.name, email: user.email };
  res.json({
    message: 'Login successful.',
    token: createSession(authenticatedUser),
    user: authenticatedUser,
  });
});

app.post('/api/logout', (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session) {
      return next(setStatus(new Error('You are not signed in.'), 401));
    }
    sessions.delete(session.token);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders', async (req, res, next) => {
  const { userId, productId, quantity } = req.body || {};
  if (
    !Number.isInteger(productId) ||
    productId < 1 ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    return next(
      setStatus(
        new Error('Provide positive integer values for productId and quantity.'),
        400,
      ),
    );
  }

  const product = await get('SELECT id, price FROM products WHERE id = ?', [productId]);
  if (!product) {
    return next(setStatus(new Error('Product not found.'), 404));
  }

  let session;
  try {
    session = getSession(req);
  } catch (error) {
    return next(error);
  }
  const orderUserId = session ? session.userId : await getGuestUserId();

  const total = Math.round(product.price * quantity * 100) / 100;
  const result = await run(
    'INSERT INTO orders (user_id, product_id, quantity, total) VALUES (?, ?, ?, ?)',
    [orderUserId, productId, quantity, total],
  );
  res.status(201).json({
    message: 'Order placed successfully.',
    order: {
      id: result.lastID,
      userId: orderUserId,
      productId,
      quantity,
      total,
    },
  });
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({
    error: status === 500 ? 'Internal server error.' : error.message,
  });
});

if (require.main === module) {
  initializeDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`E-commerce API listening on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Failed to initialize the database:', error);
      process.exitCode = 1;
    });
}

module.exports = { app, db, initializeDatabase };
