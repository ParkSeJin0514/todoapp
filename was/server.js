const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let pool;

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
        CREATE TABLE IF NOT EXISTS todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          done BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('DB initialized');
      return;
    } catch (err) {
      console.log(`DB connection attempt ${i+1}/${retries} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('DB connection failed after retries');
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/todos', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM todos ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { title } = req.body;
    const [result] = await pool.execute('INSERT INTO todos (title) VALUES (?)', [title]);
    res.status(201).json({ id: result.insertId, title, done: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/:id', async (req, res) => {
  try {
    await pool.execute('UPDATE todos SET done = ? WHERE id = ?', [req.body.done, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM todos WHERE id = ?', [req.params.id]);
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
