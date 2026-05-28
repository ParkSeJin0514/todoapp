const express = require('express');
const mysql = require('mysql2/promise');
const morgan = require('morgan');
const promBundle = require('express-prom-bundle');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

// ============================================================
// 환경변수 - ECS Task Definition으로 주입
//   COGNITO_USER_POOL_ID = <예: ap-northeast-2_q1K9fLuEl>
//   COGNITO_CLIENT_ID    = <앱 클라이언트 ID>
//   DB_HOST     = <DB_HOST>
//   DB_PORT     = <DB_PORT>      (기본값: 3306)
//   DB_USER     = <DB_USER>
//   DB_PASSWORD = <DB_PASSWORD>
//   DB_NAME     = <DB_NAME>
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID) {
  console.error('Fatal: COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID environment variables are not set');
  process.exit(1);
}

// Cognito 액세스 토큰 검증기 (공개키 JWKS 자동 조회·캐시)
const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: 'access',
  clientId: process.env.COGNITO_CLIENT_ID
});

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

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }
  try {
    const payload = await jwtVerifier.verify(authHeader.slice(7));
    req.user = { sub: payload.sub, username: payload.username };
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

      // 사용자 식별은 Cognito sub(UUID 문자열)이므로 user_id는 VARCHAR
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(255),
          title VARCHAR(255) NOT NULL,
          done BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 기존 배포 마이그레이션: user_id 컬럼 추가 또는 타입 보정(INT → VARCHAR)
      const [columns] = await pool.execute(
        `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'user_id'`,
        [process.env.DB_NAME]
      );
      if (columns.length === 0) {
        await pool.execute('ALTER TABLE todos ADD COLUMN user_id VARCHAR(255)');
      } else if (columns[0].DATA_TYPE === 'int') {
        await pool.execute('ALTER TABLE todos MODIFY COLUMN user_id VARCHAR(255)');
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

app.get('/todoapp/api/todos', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM todos WHERE user_id = ? ORDER BY id DESC',
      [req.user.sub]
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
      [req.user.sub, title]
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
      [req.body.done, req.params.id, req.user.sub]
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
      [req.params.id, req.user.sub]
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
