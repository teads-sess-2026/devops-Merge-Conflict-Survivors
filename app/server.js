require('./tracing');

const express = require('express');
const client = require('prom-client');
const { trace, context } = require('@opentelemetry/api');
const swaggerUi = require('swagger-ui-express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

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
        responses: { 200: { description: 'Successful response' } },
      },
    },
    '/health': {
      get: {
        summary: 'Health check',
        responses: { 200: { description: 'Service is healthy' } },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics',
        responses: { 200: { description: 'Prometheus text format' } },
      },
    },
    '/docs': {
      get: {
        summary: 'Swagger UI',
        responses: { 200: { description: 'HTML page' } },
      },
    },
  },
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// --- Kubernetes API ---

function queryK8sAPI(apiPath) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');

    const options = {
      hostname: 'kubernetes.default.svc.cluster.local',
      path: apiPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
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
    const result = await queryK8sAPI('/api/v1/namespaces/default/pods?labelSelector=app=test-workload');
    return result && result.items ? result.items.length : 0;
  } catch (e) {
    console.error('Error fetching pod count:', e.message);
    return 0;
  }
}

async function getPodMetrics() {
  try {
    const result = await queryK8sAPI('/apis/metrics.k8s.io/v1beta1/namespaces/default/pods?labelSelector=app=test-workload');
    if (!result || !result.items || result.items.length === 0) {
      return { cpu: 'N/A', memory: 'N/A' };
    }

    let totalCpuNano = 0, totalMemoryKi = 0;
    result.items.forEach(pod => {
      const c = pod.containers[0];
      if (c) {
        const cpuStr = c.usage.cpu;
        const cpuNano = cpuStr.endsWith('n')
          ? parseInt(cpuStr)
          : cpuStr.endsWith('m')
            ? parseInt(cpuStr) * 1e6
            : parseInt(cpuStr) * 1e9;
        const memStr = c.usage.memory;
        const memKi = memStr.endsWith('Ki') ? parseInt(memStr) : parseInt(memStr) / 1024;

        totalCpuNano += cpuNano || 0;
        totalMemoryKi += memKi || 0;
      }
    });

    const avgCpuMillicores = Math.round(totalCpuNano / result.items.length / 1e6);
    const avgMemoryMi = Math.round(totalMemoryKi / result.items.length / 1024);

    return { cpu: avgCpuMillicores + 'm', memory: avgMemoryMi + 'Mi' };
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

app.get('/scaling', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scaling.html'));
});

app.get('/api/scaling', async (req, res) => {
  const podCount = await getPodCount();
  const metrics = await getPodMetrics();

  const cpuMillicores = parseInt(metrics.cpu) || 0;
  const memMi = parseInt(metrics.memory) || 0;

  const CPU_REQUEST_M = 150;
  const MEM_LIMIT_MI = 128;
  const HPA_TARGET_PCT = 0.70;

  const cpuUtilPct = cpuMillicores / CPU_REQUEST_M;
  const cpuProgressPct = Math.min(100, Math.round((cpuUtilPct / HPA_TARGET_PCT) * 100));

  res.json({
    hostname: process.env.HOSTNAME,
    current: podCount,
    min: 2,
    max: 10,
    cpu: { value: metrics.cpu, pct: cpuProgressPct },
    memory: { value: metrics.memory, pct: Math.min(100, Math.round((memMi / MEM_LIMIT_MI) * 100)) },
  });
});

// --- Load test ---

let loadTestActive = false;
let activeWorker = null;

app.post('/api/load-test', (req, res) => {
  if (loadTestActive) {
    return res.status(409).json({ error: 'Load test already running' });
  }
  loadTestActive = true;

  const durationMs = 30000;
  activeWorker = new Worker(`
    const { parentPort, workerData } = require('worker_threads');
    const end = Date.now() + workerData.durationMs;
    while (Date.now() < end) {
      Math.sqrt(Math.random() * 1e9);
    }
    parentPort.postMessage('done');
  `, { eval: true, workerData: { durationMs } });

  activeWorker.on('message', () => {
    loadTestActive = false;
    activeWorker = null;
  });
  activeWorker.on('error', () => {
    loadTestActive = false;
    activeWorker = null;
  });
  activeWorker.on('exit', () => {
    loadTestActive = false;
    activeWorker = null;
  });

  res.json({ status: 'started', durationMs });
});

app.post('/api/load-test/stop', async (req, res) => {
  if (!loadTestActive || !activeWorker) {
    return res.status(409).json({ error: 'No load test running' });
  }
  await activeWorker.terminate();
  loadTestActive = false;
  activeWorker = null;
  res.json({ status: 'stopped' });
});

app.get('/api/load-test/status', (req, res) => {
  res.json({ active: loadTestActive });
});

// --- Start ---

app.listen(port, () => {
  process.stdout.write(JSON.stringify({
    level: 'info',
    ts: new Date().toISOString(),
    msg: `listening on port ${port}`,
  }) + '\n');
});