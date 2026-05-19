const express = require('express');
const path = require('path');
const promBundle = require('express-prom-bundle');

const app = express();
const PORT = process.env.PORT || 3000;

const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: {
    app: 'todoapp',
    component: 'web'
  },
  promClient: {
    collectDefaultMetrics: {}
  }
});
app.use(metricsMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`WEB server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
