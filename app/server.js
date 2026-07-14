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
    console.log('Querying metrics API...');
    const result = await queryK8sAPI('/apis/metrics.k8s.io/v1beta1/namespaces/default/pods?labelSelector=app=test-workload');
    console.log('Metrics result:', JSON.stringify(result).substring(0, 300));
    if (!result || !result.items || result.items.length === 0) {
      console.log('No metrics items found');
      return { cpu: 'N/A', memory: 'N/A' };
    }

    let totalCpuNano = 0, totalMemoryKi = 0;
    result.items.forEach(pod => {
      const container = pod.containers[0];
      if (container) {
        // cpu usage is a string like "8254438n" (nanocores) or occasionally "23m" (millicores)
        const cpuStr = container.usage.cpu;
        const cpuNano = cpuStr.endsWith('n')
          ? parseInt(cpuStr)
          : cpuStr.endsWith('m')
            ? parseInt(cpuStr) * 1e6
            : parseInt(cpuStr) * 1e9; // bare cores, rare
        // memory usage is a string like "41008Ki"
        const memStr = container.usage.memory;
        const memKi = memStr.endsWith('Ki') ? parseInt(memStr) : parseInt(memStr) / 1024;

        totalCpuNano += cpuNano || 0;
        totalMemoryKi += memKi || 0;
      }
    });

    const avgCpuMillicores = Math.round(totalCpuNano / result.items.length / 1e6);
    const avgMemoryMi = Math.round(totalMemoryKi / result.items.length / 1024);

    console.log('Metrics:', avgCpuMillicores, avgMemoryMi);
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

const path = require('path');

app.get('/scaling', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scaling.html'));
});

app.get('/api/scaling', async (req, res) => {
  const podCount = await getPodCount();
  const metrics = await getPodMetrics(); // { cpu: '7m', memory: '54Mi' }

  const cpuMillicores = parseInt(metrics.cpu) || 0;
  const memMi = parseInt(metrics.memory) || 0;

  const CPU_LIMIT_M = 200;      // from your Deployment's resources.limits.cpu
  const MEM_LIMIT_MI = 128;     // from your Deployment's resources.limits.memory
  const HPA_TARGET_PCT = 0.80;  // your HPA's target CPU utilization

  // Progress toward the HPA's scale-up trigger, not just raw usage vs limit
  const cpuUtilPct = cpuMillicores / CPU_LIMIT_M;           // e.g. 7/200 = 0.035
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

// --- Start ---

app.listen(port, () => {
  process.stdout.write(JSON.stringify({
    level: 'info',
    ts: new Date().toISOString(),
    msg: `listening on port ${port}`,
  }) + '\n');
});
