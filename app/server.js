require('./tracing');

const express = require('express');
const client = require('prom-client');
const { trace, context } = require('@opentelemetry/api');
const swaggerUi = require('swagger-ui-express');

const app = express();
const port = 3000;

// --- Metrics ---

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// --- Middleware: metrics + structured request logging ---
// Writes one JSON line per request to stdout so Promtail picks it up.
// The traceId comes from the active OTel span (set by auto-instrumentation),
// which is the same ID Tempo stores — Grafana uses it to jump between log and trace.

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const span = trace.getActiveSpan();
    const spanContext = span ? span.spanContext() : null;
    const traceId = spanContext ? spanContext.traceId : undefined;

    const labels = { method: req.method, route: req.path, status_code: res.statusCode };
    httpRequestDuration.observe(labels, durationMs / 1000);
    httpRequestsTotal.inc(labels);

    process.stdout.write(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs),
      traceId,
    }) + '\n');
  });

  next();
});

// --- OpenAPI spec ---

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'k8s-test-workload',
    version: '1.0.0',
    description: 'Simple test workload running on Kubernetes with Prometheus metrics, Loki logs, and Tempo traces.',
  },
  paths: {
    '/': {
      get: {
        summary: 'Hello endpoint',
        description: 'Returns a greeting with the pod hostname and current timestamp.',
        responses: {
          200: {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', example: 'Hello from Kubernetes!' },
                    hostname: { type: 'string', example: 'test-workload-6d9f7b8c4-xk9tz' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Health check',
        description: 'Used by Kubernetes liveness and readiness probes.',
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics',
        description: 'Scraped by Prometheus. Exposes HTTP request counters/histograms and Node.js runtime metrics.',
        responses: {
          200: {
            description: 'Prometheus text format',
            content: { 'text/plain': {} },
          },
        },
      },
    },
    '/docs': {
      get: {
        summary: 'Swagger UI',
        description: 'This page.',
        responses: {
          200: { description: 'HTML page' },
        },
      },
    },
  },
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// --- Routes ---

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Hello from Kubernetes!',
    hostname: process.env.HOSTNAME,
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/scaling', (req, res) => {
  res.status(200).json({
    message: 'HPA Scaling Information',
    info: 'View HPA status with: kubectl get hpa test-workload-hpa',
    pod_name: process.env.HOSTNAME,
    note: 'This pod is part of an auto-scaling deployment (2-10 replicas based on CPU/memory usage)'
  });
});

// --- Start ---

app.listen(port, () => {
  process.stdout.write(JSON.stringify({
    level: 'info',
    ts: new Date().toISOString(),
    msg: `listening on port ${port}`,
  }) + '\n');
});
