require('./tracing');

const express = require('express');
const client = require('prom-client');
const { trace, context } = require('@opentelemetry/api');
const swaggerUi = require('swagger-ui-express');
const https = require('https');
const fs = require('fs');

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

// --- Kubernetes API ---

function queryK8sAPI(path) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');

    const options = {
      hostname: 'kubernetes.default.svc.cluster.local',
      path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      ca,
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject).end();
  });
}

async function getPodCount() {
  try {
    console.log('Querying K8s API for pods...');
    const result = await queryK8sAPI('/api/v1/namespaces/default/pods?labelSelector=app=test-workload');
    console.log('K8s API response kind:', result.kind, 'items count:', result.items ? result.items.length : 'N/A');
    if (result && result.items && result.items.length > 0) {
      console.log(`Found ${result.items.length} pods:`, result.items.map(p => p.metadata.name));
      return result.items.length;
    }
    console.log('Query succeeded but no items. Full response:', JSON.stringify(result).substring(0, 200));
    return result.items ? result.items.length : 0;
  } catch (e) {
    console.error('Error fetching pod count:', e.message);
    console.error('Stack:', e.stack);
    return 0;
  }
}

async function getPodMetrics() {
  try {
    const result = await queryK8sAPI('/apis/metrics.k8s.io/v1beta1/namespaces/default/pods?labelSelector=app=test-workload');
    if (!result || !result.items || result.items.length === 0) {
      return { cpu: 'N/A', memory: 'N/A' };
    }

    let totalCpu = 0, totalMemory = 0;
    result.items.forEach(pod => {
      const container = pod.containers[0];
      if (container) {
        const cpu = parseInt(container.usage.cpu) || 0;
        const mem = parseInt(container.usage.memory) || 0;
        totalCpu += cpu;
        totalMemory += mem;
      }
    });

    const avgCpu = Math.round(totalCpu / result.items.length);
    const avgMemory = Math.round(totalMemory / result.items.length / 1024 / 1024);

    return { cpu: avgCpu + 'm', memory: avgMemory + 'Mi' };
  } catch (e) {
    console.error('Error fetching metrics:', e.message);
    return { cpu: 'N/A', memory: 'N/A' };
  }
}

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

app.get('/scaling', async (req, res) => {
  console.log('GET /scaling called');
  const podCount = await getPodCount();
  const metrics = await getPodMetrics();
  console.log('Pod count result:', podCount);
  const podCountDisplay = podCount !== null ? podCount : 'Unable to fetch';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HPA Scaling Information</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-top: 0; }
    .info-box { background: #e3f2fd; border-left: 4px solid #2196F3; padding: 15px; margin: 15px 0; border-radius: 4px; }
    .label { font-weight: 600; color: #555; }
    .value { color: #333; margin: 5px 0 15px 0; }
    .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
    .metric-card { background: #f9f9f9; padding: 15px; border-radius: 4px; border: 1px solid #ddd; }
    .metric-card .label { font-size: 12px; text-transform: uppercase; color: #999; }
    .metric-card .value { font-size: 24px; font-weight: bold; color: #2196F3; }
    .current-pods { background: #c8e6c9; border-left: 4px solid #4caf50; }
    .current-pods .value { color: #2e7d32; }
    .refresh-hint { font-size: 12px; color: #999; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚙️ HPA Scaling Information</h1>

    <div class="info-box">
      <div class="label">Pod Name (Hostname)</div>
      <div class="value">${process.env.HOSTNAME || 'unknown'}</div>
    </div>

    <div class="metrics">
      <div class="metric-card current-pods">
        <div class="label">Current Running Pods</div>
        <div class="value">${podCountDisplay}</div>
        <div class="refresh-hint">Refresh to see updates</div>
      </div>
      <div class="metric-card">
        <div class="label">Max Replicas</div>
        <div class="value">10</div>
      </div>
      <div class="metric-card">
        <div class="label">Min Replicas</div>
        <div class="value">2</div>
      </div>
      <div class="metric-card">
        <div class="label">Target CPU</div>
        <div class="value">80%</div>
      </div>
      <div class="metric-card">
        <div class="label">Avg CPU Usage</div>
        <div class="value">${metrics.cpu}</div>
      </div>
      <div class="metric-card">
        <div class="label">Avg Memory Usage</div>
        <div class="value">${metrics.memory}</div>
      </div>
    </div>

    <div class="info-box">
      <div class="label">Current Status</div>
      <div class="value">✅ This pod is part of an auto-scaling deployment. The Horizontal Pod Autoscaler (HPA) monitors CPU and memory usage and automatically scales the number of replicas between 2-10.</div>
    </div>

    <div class="info-box">
      <div class="label">How to view HPA status</div>
      <div class="value"><code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px;">kubectl get hpa test-workload-hpa</code></div>
    </div>

    <script>
      setInterval(() => location.reload(), 3000);
    </script>
  </div>
</body>
</html>
  `;
  res.set('Content-Type', 'text/html');
  res.status(200).send(html);
});

// --- Start ---

app.listen(port, () => {
  process.stdout.write(JSON.stringify({
    level: 'info',
    ts: new Date().toISOString(),
    msg: `listening on port ${port}`,
  }) + '\n');
});
