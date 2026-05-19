const express = require('express');
const path = require('path');
const morgan = require('morgan');
const promBundle = require('express-prom-bundle');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan((tokens, req, res) => {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    method: tokens.method(req, res),
    path: tokens.url(req, res),
    status: parseInt(tokens.status(req, res), 10) || 0,
    duration_ms: parseFloat(tokens['response-time'](req, res)) || 0,
    content_length: parseInt(tokens.res(req, res, 'content-length') || 0, 10),
    user_agent: tokens['user-agent'](req, res),
    component: 'web'
  });
}, {
  skip: (req) => req.url === '/todoapp/' || req.url === '/metrics'
}));

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

app.get(['/', '/todoapp', '/todoapp/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`WEB server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
