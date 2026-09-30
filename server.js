// RetailSMS Main Application Entry Point
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { getActiveConfig } = require('./src/config');
const db = require('./src/db');
const SmppClient = require('./src/smpp/client');
const simulator = require('./src/smpp/simulator');
const createApiRouter = require('./src/routes/api');

const config = getActiveConfig();
const app = express();
const server = http.createServer(app);

// WebSocket Server for live UI updates
const wss = new WebSocketServer({ server });

function broadcastWs(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      try {
        client.send(payload);
      } catch (_) {}
    }
  }
}

// Instantiate SMPP Client
const smppClient = new SmppClient({
  host: config.smpp.host,
  port: config.smpp.port,
  tls: config.smpp.tls,
  systemId: config.smpp.systemId,
  password: config.smpp.password,
  systemType: config.smpp.systemType,
  bindMode: config.smpp.bindMode,
  sourceTon: config.smpp.sourceTon,
  sourceNpi: config.smpp.sourceNpi,
  destTon: config.smpp.destTon,
  destNpi: config.smpp.destNpi,
  tps: config.smpp.tps,
  keepaliveInterval: config.smpp.keepaliveInterval,
  defaultSender: config.defaultSender
});

// Wire SMPP Client events to WebSockets and DB logs
smppClient.on('stateChange', ({ oldState, newState, error }) => {
  broadcastWs({
    type: 'SMPP_STATE_CHANGE',
    state: newState,
    error: error ? error.message : null
  });
});

smppClient.on('messageStatus', (data) => {
  broadcastWs({
    type: 'MESSAGE_STATUS',
    data,
    stats: db.getStats()
  });
});

smppClient.on('dlr', (dlrData) => {
  broadcastWs({
    type: 'DLR_RECEIVED',
    data: dlrData,
    stats: db.getStats()
  });
});

// Wire Simulator events
simulator.on('started', (port) => {
  db.log('INFO', 'SIMULATOR', `Mock SMPP Server listening on port ${port}`);
  broadcastWs({ type: 'SIMULATOR_STATE', isRunning: true, port });
});

simulator.on('stopped', () => {
  db.log('INFO', 'SIMULATOR', 'Mock SMPP Server stopped');
  broadcastWs({ type: 'SIMULATOR_STATE', isRunning: false });
});

simulator.on('submit_sm', (info) => {
  db.log('INFO', 'SIMULATOR', `Mock SMSC received message for ${info.destination} (assigned ID: ${info.messageId})`);
});

// Express Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Mount REST API
app.use('/api/v1', createApiRouter({ smppClient, simulator, broadcastWs }));

// Catch-all route to serve the Single Page Application
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  // Send initial state snapshot upon connection
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    smppState: smppClient.state,
    stats: db.getStats(),
    simulator: {
      isRunning: simulator.isRunning,
      port: simulator.port
    }
  }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (_) {}
  });
});

// Start HTTP Server
const PORT = config.port || 3000;
server.listen(PORT, async () => {
  console.log(`\n=================================================`);
  console.log(`🚀 RetailSMS Gateway is running!`);
  console.log(`🌐 Web Portal:    http://localhost:${PORT}`);
  console.log(`📡 REST API:      http://localhost:${PORT}/api/v1`);
  console.log(`📦 Database:      ${path.join(__dirname, 'retailsms.db')}`);
  console.log(`=================================================\n`);

  db.log('INFO', 'SYSTEM', `RetailSMS Gateway started on port ${PORT}`);

  // If simulator is enabled by default or autoConnect is enabled
  if (config.simulator.enabled) {
    try {
      await simulator.start(config.simulator.port);
      console.log(`🤖 Mock SMPP Simulator started on port ${config.simulator.port}`);
    } catch (err) {
      console.error(`Failed to start SMPP simulator: ${err.message}`);
    }
  }

  if (config.smpp.autoConnect) {
    console.log(`🔄 Auto-connecting to SMPP Aggregator at ${config.smpp.host}:${config.smpp.port}...`);
    smppClient.connect().catch((err) => {
      console.warn(`Initial SMPP connection attempt failed: ${err.message}. Auto-reconnect will retry.`);
    });
  }
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\nShutting down gracefully...');
  await smppClient.disconnect();
  await simulator.stop();
  server.close(() => {
    console.log('HTTP & WebSocket servers closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, smppClient, simulator };
