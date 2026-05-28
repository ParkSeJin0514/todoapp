const express = require('express');
const mysql = require('mysql2/promise');
const morgan = require('morgan');
const promBundle = require('express-prom-bundle');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// ============================================================
// 민감한 정보 - ECS Task Definition 환경변수로 주입 필요
//   JWT_SECRET  = <JWT_SECRET>   (랜덤 32자 이상 문자열 권장)
//   DB_HOST     = <DB_HOST>
//   DB_PORT     = <DB_PORT>      (기본값: 3306)
//   DB_USER     = <DB_USER>
//   DB_PASSWORD = <DB_PASSWORD>
//   DB_NAME     = <DB_NAME>
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('Fatal: JWT_SECRET environment variable is not set');
  process.exit(1);
}

app.use(morgan((tokens, req, res) => {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    method: tokens.method(req, res),
    path: tokens.url(req, res),
    status: parseInt(tokens.status(req, res), 10) || 0,
    duration_ms: parseFloat(tokens['response-time'](req, res)) || 0,
    content_length: parseInt(tokens.res(req, res, 'content-length') || 0, 10),
    user_agent: tokens['user-agent'](req, res),
    component: 'was'
  });
}, {
  skip: (req) => req.url === '/todoapp/api/health' || req.url === '/metrics'
}));

const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: { app: 'todoapp', component: 'was' },
  promClient: { collectDefaultMetrics: {} }
});
app.use(metricsMiddleware);
app.use(express.json());

let pool;

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
}

async function initDB(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const adminConn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      });
      await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
      await adminConn.end();

      pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10
      });

      await pool.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.execute(`
        CREATE TABLE IF NOT EXISTS todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT,
          title VARCHAR(255) NOT NULL,
          done BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 기존 배포에 user_id 컬럼이 없을 경우 추가 (마이그레이션)
      const [columns] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'user_id'`,
        [process.env.DB_NAME]
      );
      if (columns.length === 0) {
        await pool.execute('ALTER TABLE todos ADD COLUMN user_id INT');
      }

      console.log('DB initialized');
      return;
    } catch (err) {
      console.log(`DB connection attempt ${i+1}/${retries} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('DB connection failed after retries');
}

app.get('/todoapp/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/todoapp/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ error: '아이디는 3~50자여야 합니다.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );
    const token = jwt.sign({ id: result.insertId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, username });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/todoapp/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: rows[0].username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/todoapp/api/todos', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM todos WHERE user_id = ? ORDER BY id DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/todoapp/api/todos', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    const [result] = await pool.execute(
      'INSERT INTO todos (user_id, title) VALUES (?, ?)',
      [req.user.id, title]
    );
    res.status(201).json({ id: result.insertId, title, done: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/todoapp/api/todos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.execute(
      'UPDATE todos SET done = ? WHERE id = ? AND user_id = ?',
      [req.body.done, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/todoapp/api/todos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM todos WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`WAS server listening on port ${PORT}`);
  });
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server');
    server.close(async () => {
      if (pool) await pool.end();
      process.exit(0);
    });
  });
}).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
