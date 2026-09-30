// Production-grade SMPP Client with auto-reconnect, TPS rate limiting, and DLR handling
const smpp = require('smpp');
const EventEmitter = require('events');
const db = require('../db');
const { prepareSegments, parseDeliveryReceipt, analyzeMessage } = require('./encoder');
const { getStatusDescription } = require('./errors');

class SmppClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.session = null;
    this.state = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED | BOUND | ERROR
    this.reconnectTimer = null;
    this.enquireLinkTimer = null;
    this.missedEnquireLinks = 0;
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;

    // Outbound message queue & throttling
    this.queue = [];
    this.isProcessingQueue = false;
    this.lastSendTimestamp = 0;
    this.tokens = 0;
    this.lastTokenRefill = Date.now();

    // Metrics
    this.stats = {
      submittedTotal: 0,
      submittedSuccess: 0,
      submittedFailed: 0,
      dlrReceived: 0,
      lastSubmitTime: null,
      lastDlrTime: null,
      currentTps: 0
    };

    // Calculate rolling TPS
    this.tpsWindow = [];
    setInterval(() => {
      const oneSecAgo = Date.now() - 1000;
      this.tpsWindow = this.tpsWindow.filter(ts => ts > oneSecAgo);
      this.stats.currentTps = this.tpsWindow.length;
    }, 500);
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  getState() {
    return {
      state: this.state,
      queueLength: this.queue.length,
      config: {
        host: this.config.host,
        port: this.config.port,
        systemId: this.config.systemId,
        bindMode: this.config.bindMode || 'transceiver',
        tps: this.config.tps || 10,
        sourceTon: this.config.sourceTon,
        sourceNpi: this.config.sourceNpi,
        destTon: this.config.destTon,
        destNpi: this.config.destNpi
      },
      stats: {
        ...this.stats,
        queueLength: this.queue.length
      }
    };
  }

  setState(newState, error = null) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('stateChange', { oldState, newState, error });
      db.log('INFO', 'SMPP', `State transition: ${oldState} -> ${newState}`, error ? { error: error.message || error } : null);
    }
  }

  connect() {
    if (this.state === 'CONNECTING' || this.state === 'BOUND') {
      return Promise.resolve();
    }

    this.manualDisconnect = false;
    this.clearTimers();
    this.setState('CONNECTING');

    const host = this.config.host || '127.0.0.1';
    const port = this.config.port || 2775;

    db.log('INFO', 'SMPP', `Connecting to aggregator at ${host}:${port}...`);

    return new Promise((resolve, reject) => {
      let resolved = false;

      try {
        const isTls = Boolean(this.config.tls);
        this.session = smpp.connect({
          host,
          port,
          tls: isTls,
          rejectUnauthorized: this.config.rejectUnauthorized !== undefined ? Boolean(this.config.rejectUnauthorized) : true,
          auto_enquire_link_period: false // Handled manually for strict monitoring
        }, () => {
          this.setState('CONNECTED');
          db.log('INFO', 'SMPP', `${isTls ? 'TLS Encrypted' : 'TCP'} Connection established with ${host}:${port}. Sending bind request...`);
          this.bind()
            .then(() => {
              if (!resolved) {
                resolved = true;
                resolve();
              }
            })
            .catch(err => {
              if (!resolved) {
                resolved = true;
                reject(err);
              }
            });
        });

        this.setupSessionListeners();

        // Connection timeout
        setTimeout(() => {
          if (!resolved && this.state === 'CONNECTING') {
            resolved = true;
            const err = new Error('Connection timeout');
            this.handleDisconnect(err);
            reject(err);
          }
        }, 15000);
      } catch (err) {
        this.setState('ERROR', err);
        this.handleDisconnect(err);
        reject(err);
      }
    });
  }

  setupSessionListeners() {
    if (!this.session) return;

    this.session.on('error', (err) => {
      db.log('ERROR', 'SMPP', `Socket error: ${err.message}`, { code: err.code });
      this.emit('error', err);
      this.handleDisconnect(err);
    });

    this.session.on('close', () => {
      db.log('WARN', 'SMPP', 'SMPP connection closed by remote aggregator');
      this.handleDisconnect(new Error('Connection closed'));
    });

    // Handle incoming Deliver SM (Delivery Receipts and Incoming MO SMS)
    this.session.on('deliver_sm', (pdu) => {
      this.handleIncomingDeliverSm(pdu);
    });

    // Handle keep-alive responses
    this.session.on('enquire_link_resp', (pdu) => {
      this.missedEnquireLinks = 0;
      this.emit('pdu', { command: 'enquire_link_resp', status: 'OK' });
    });
  }

  bind() {
    return new Promise((resolve, reject) => {
      if (!this.session) return reject(new Error('No active session'));

      const bindMode = this.config.bindMode || 'transceiver';
      const bindParams = {
        system_id: this.config.systemId || '',
        password: this.config.password || '',
        system_type: this.config.systemType || '',
        interface_version: 0x34 // SMPP 3.4
      };

      const handleBindResp = (pdu) => {
        if (pdu.command_status === smpp.ESME_ROK) {
          this.reconnectAttempts = 0;
          this.setState('BOUND');
          db.log('INFO', 'SMPP', `Successfully bound as ${bindMode} (system_id: ${bindParams.system_id})`);
          this.startKeepalive();
          this.startQueueWorker();
          resolve();
        } else {
          const desc = getStatusDescription(pdu.command_status);
          const err = new Error(`Bind failed with status: ${desc} (0x${pdu.command_status.toString(16)})`);
          db.log('ERROR', 'SMPP', err.message);
          this.setState('ERROR', err);
          reject(err);
        }
      };

      if (bindMode === 'transmitter') {
        this.session.bind_transmitter(bindParams, handleBindResp);
      } else if (bindMode === 'receiver') {
        this.session.bind_receiver(bindParams, handleBindResp);
      } else {
        this.session.bind_transceiver(bindParams, handleBindResp);
      }
    });
  }

  startKeepalive() {
    clearInterval(this.enquireLinkTimer);
    const intervalSec = this.config.keepaliveInterval || 30;
    this.missedEnquireLinks = 0;

    this.enquireLinkTimer = setInterval(() => {
      if (this.state === 'BOUND' && this.session) {
        if (this.missedEnquireLinks >= 2) {
          db.log('WARN', 'SMPP', 'EnquireLink timeout: aggregator did not respond. Reconnecting...');
          this.handleDisconnect(new Error('Keepalive timeout'));
          return;
        }

        this.missedEnquireLinks += 1;
        try {
          this.session.enquire_link({}, (pdu) => {
            this.missedEnquireLinks = 0;
          });
        } catch (err) {
          this.handleDisconnect(err);
        }
      }
    }, intervalSec * 1000);
  }

  handleDisconnect(err) {
    this.clearTimers();
    this.setState('DISCONNECTED', err);

    if (this.session) {
      try {
        this.session.destroy();
      } catch (_) {}
      this.session = null;
    }

    if (!this.manualDisconnect) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    // Exponential backoff: 3s, 6s, 12s, 24s, capped at 30s
    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    db.log('INFO', 'SMPP', `Scheduling reconnection in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect && this.state !== 'BOUND') {
        this.connect().catch(() => {});
      }
    }, delay);
  }

  disconnect() {
    this.manualDisconnect = true;
    this.clearTimers();

    return new Promise((resolve) => {
      if (!this.session) {
        this.setState('DISCONNECTED');
        return resolve();
      }

      db.log('INFO', 'SMPP', 'Unbinding and closing SMPP session...');
      try {
        if (this.state === 'BOUND') {
          this.session.unbind(() => {
            this.session.close();
            this.session = null;
            this.setState('DISCONNECTED');
            resolve();
          });
        } else {
          this.session.close();
          this.session = null;
          this.setState('DISCONNECTED');
          resolve();
        }
      } catch (_) {
        this.session = null;
        this.setState('DISCONNECTED');
        resolve();
      }
    });
  }

  clearTimers() {
    clearInterval(this.enquireLinkTimer);
    clearTimeout(this.reconnectTimer);
    this.enquireLinkTimer = null;
    this.reconnectTimer = null;
  }

  /**
   * Handles incoming deliver_sm PDU (Delivery Receipts & MO messages)
   */
  handleIncomingDeliverSm(pdu) {
    try {
      // Send deliver_sm_resp immediately to acknowledge receipt
      this.session.deliver_sm_resp({
        sequence_number: pdu.sequence_number,
        command_status: smpp.ESME_ROK
      });

      const messageContent = pdu.short_message?.message || pdu.short_message;
      const dlr = parseDeliveryReceipt(messageContent);

      if (dlr && dlr.aggregatorMsgId) {
        this.stats.dlrReceived += 1;
        this.stats.lastDlrTime = new Date().toISOString();

        db.log('INFO', 'SMPP', `Received DLR for ID: ${dlr.aggregatorMsgId} -> ${dlr.stat}`, dlr);

        const updated = db.handleDlr(dlr.aggregatorMsgId, dlr.stat, dlr.raw);
        this.emit('dlr', {
          aggregatorMsgId: dlr.aggregatorMsgId,
          status: dlr.stat,
          raw: dlr.raw,
          message: updated
        });
      } else {
        // Incoming subscriber message (2-Way SMS / MO SMS)
        const incoming = {
          source: pdu.source_addr?.toString(),
          destination: pdu.destination_addr?.toString(),
          text: messageContent ? messageContent.toString() : ''
        };
        db.log('INFO', 'SMPP', `Received incoming SMS from ${incoming.source}: ${incoming.text}`);
        this.emit('incomingSms', incoming);
      }
    } catch (err) {
      db.log('ERROR', 'SMPP', `Failed to process deliver_sm: ${err.message}`);
    }
  }

  /**
   * Queue one or multiple SMS for transmission
   */
  sendSms(params) {
    const text = params.text || '';
    const recipient = params.recipient || params.to;
    const sender = params.sender || params.from || this.config.defaultSender || 'RetailSMS';
    const forceUnicode = params.forceUnicode || params.unicode || false;
    const source = params.source || 'api';

    if (!recipient) {
      throw new Error('Recipient phone number is required');
    }
    if (!text) {
      throw new Error('Message text cannot be empty');
    }

    // Clean phone number (strip whitespace, ensure standard formatting)
    const cleanedRecipient = recipient.toString().trim().replace(/[^0-9+]/g, '');

    // Analyze message parts & encoding
    const analysis = analyzeMessage(text, forceUnicode);
    const segments = prepareSegments(text, { forceUnicode });

    // Store message record in database
    const dbRecord = db.createMessage({
      source,
      sender,
      recipient: cleanedRecipient,
      text,
      encoding: analysis.encoding,
      parts_count: segments.length,
      status: 'QUEUED'
    });

    // Add to outbound queue
    this.queue.push({
      dbId: dbRecord.id,
      sender,
      recipient: cleanedRecipient,
      segments,
      created_at: Date.now()
    });

    this.startQueueWorker();

    return {
      id: dbRecord.id,
      messageId: dbRecord.id,
      recipient: cleanedRecipient,
      sender,
      parts: segments.length,
      encoding: analysis.encoding,
      characters: analysis.characterCount,
      status: 'QUEUED'
    };
  }

  /**
   * Worker loop that respects TPS rate limits
   */
  startQueueWorker() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    const processNext = async () => {
      if (this.queue.length === 0) {
        this.isProcessingQueue = false;
        return;
      }

      if (this.state !== 'BOUND' || !this.session) {
        // Not bound yet, wait and re-check
        setTimeout(processNext, 1000);
        return;
      }

      // Throttling: respect configured TPS (e.g. 10 TPS = minimum 100ms interval)
      const tpsLimit = Math.max(1, this.config.tps || 10);
      const minIntervalMs = 1000 / tpsLimit;
      const now = Date.now();
      const elapsed = now - this.lastSendTimestamp;

      if (elapsed < minIntervalMs) {
        setTimeout(processNext, minIntervalMs - elapsed);
        return;
      }

      const item = this.queue.shift();
      if (!item) {
        this.isProcessingQueue = false;
        return;
      }

      this.lastSendTimestamp = Date.now();
      this.tpsWindow.push(Date.now());

      await this.dispatchMessage(item);
      setImmediate(processNext);
    };

    setImmediate(processNext);
  }

  /**
   * Dispatches message segments over SMPP session
   */
  async dispatchMessage(item) {
    const { dbId, sender, recipient, segments } = item;
    let lastAggregatorMsgId = null;
    let anyError = null;

    db.updateMessage(dbId, { status: 'SENDING' });

    for (const segment of segments) {
      try {
        const result = await this.sendSinglePdu({
          source_addr: sender,
          destination_addr: recipient,
          source_addr_ton: this.config.sourceTon !== undefined ? this.config.sourceTon : 5,
          source_addr_npi: this.config.sourceNpi !== undefined ? this.config.sourceNpi : 0,
          dest_addr_ton: this.config.destTon !== undefined ? this.config.destTon : 1,
          dest_addr_npi: this.config.destNpi !== undefined ? this.config.destNpi : 1,
          esm_class: segment.esm_class,
          data_coding: segment.data_coding,
          short_message: segment.short_message,
          registered_delivery: 1 // Request delivery receipt
        });

        if (result.message_id) {
          lastAggregatorMsgId = result.message_id;
        }
      } catch (err) {
        anyError = err;
        break;
      }
    }

    if (anyError) {
      this.stats.submittedFailed += 1;
      db.updateMessage(dbId, {
        status: 'FAILED',
        error_code: anyError.message
      });
      db.log('ERROR', 'SMPP', `Failed to send SMS ${dbId} to ${recipient}: ${anyError.message}`);
      this.emit('messageStatus', { id: dbId, status: 'FAILED', error: anyError.message });
    } else {
      this.stats.submittedTotal += 1;
      this.stats.submittedSuccess += 1;
      this.stats.lastSubmitTime = new Date().toISOString();

      const updated = db.updateAggregatorMessageId(dbId, lastAggregatorMsgId, 'SUBMITTED');
      db.log('INFO', 'SMPP', `Submitted SMS ${dbId} to ${recipient} (Aggregator ID: ${lastAggregatorMsgId})`);
      this.emit('messageStatus', { id: dbId, status: 'SUBMITTED', aggregatorMsgId: lastAggregatorMsgId });
    }
  }

  sendSinglePdu(params) {
    return new Promise((resolve, reject) => {
      if (!this.session || this.state !== 'BOUND') {
        return reject(new Error('SMPP connection is not bound to aggregator'));
      }

      this.session.submit_sm(params, (pdu) => {
        if (!pdu) {
          return reject(new Error('No response PDU received from aggregator'));
        }

        if (pdu.command_status === smpp.ESME_ROK) {
          resolve({
            message_id: pdu.message_id,
            sequence_number: pdu.sequence_number
          });
        } else {
          const desc = getStatusDescription(pdu.command_status);
          reject(new Error(`Aggregator error: ${desc} (code 0x${pdu.command_status.toString(16)})`));
        }
      });
    });
  }
}

module.exports = SmppClient;
