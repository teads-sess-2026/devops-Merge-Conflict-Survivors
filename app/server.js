const express = require('express');
const app = express();
const port = 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Hello from Kubernetes!',
    hostname: process.env.HOSTNAME,
    timestamp: new Date().toISOString()
  });
});

app.get('/metrics', (req, res) => {
  res.status(200).send('# Kubernetes test workload is running\n');
});

app.listen(port, () => {
  console.log(`Test workload listening on port ${port}`);
});
