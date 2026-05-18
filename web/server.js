async function initDB(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      // Step 1: DB 지정 없이 연결해서 DB 생성
      const adminConn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      });
      await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
      await adminConn.end();

      // Step 2: 이제 DB 지정해서 pool 생성
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