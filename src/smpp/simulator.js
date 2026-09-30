// Built-in Mock SMPP Server (Simulator) for local testing without external aggregator
const smpp = require('smpp');
const EventEmitter = require('events');

class SmppSimulator extends EventEmitter {
  constructor(port = 2775) {
    super();
    this.port = port;
    this.server = null;
    this.isRunning = false;
    this.activeSessions = new Set();
    this.messageCounter = 1000;
  }

  start(port) {
    if (port) this.port = port;
    if (this.isRunning) {
      return Promise.resolve(this.port);
    }

    return new Promise((resolve, reject) => {
      try {
        this.server = smpp.createServer((session) => {
          this.handleSession(session);
        });

        this.server.on('error', (err) => {
          this.emit('error', err);
          if (!this.isRunning) {
            reject(err);
          }
        });

        this.server.listen(this.port, () => {
          this.isRunning = true;
          this.emit('started', this.port);
          resolve(this.port);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning || !this.server) {
        this.isRunning = false;
        return resolve();
      }

      for (const session of this.activeSessions) {
        try {
          session.close();
        } catch (_) {}
      }
      this.activeSessions.clear();

      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.emit('stopped');
        resolve();
      });
    });
  }

  handleSession(session) {
    this.activeSessions.add(session);
    this.emit('clientConnected', { remoteAddress: session.socket?.remoteAddress });

    session.on('bind_transceiver', (pdu) => {
      session.send(pdu.response({ system_id: 'RetailSMS-MockSMSC' }));
      this.emit('bind', { type: 'transceiver', system_id: pdu.system_id });
    });

    session.on('bind_transmitter', (pdu) => {
      session.send(pdu.response({ system_id: 'RetailSMS-MockSMSC' }));
      this.emit('bind', { type: 'transmitter', system_id: pdu.system_id });
    });

    session.on('bind_receiver', (pdu) => {
      session.send(pdu.response({ system_id: 'RetailSMS-MockSMSC' }));
      this.emit('bind', { type: 'receiver', system_id: pdu.system_id });
    });

    session.on('enquire_link', (pdu) => {
      session.send(pdu.response());
    });

    session.on('unbind', (pdu) => {
      session.send(pdu.response());
      session.close();
    });

    session.on('submit_sm', (pdu) => {
      this.messageCounter += 1;
      const msgId = `SIM-${Date.now().toString(36).toUpperCase()}-${this.messageCounter}`;

      // Acknowledge submit_sm with ESME_ROK and unique message_id
      session.send(pdu.response({ message_id: msgId }));

      this.emit('submit_sm', {
        messageId: msgId,
        source: pdu.source_addr?.toString(),
        destination: pdu.destination_addr?.toString(),
        registeredDelivery: pdu.registered_delivery
      });

      // If registered delivery is requested (DLR enabled), simulate a DELIVRD receipt after 1.5 seconds
      if (pdu.registered_delivery === 1) {
        setTimeout(() => {
          if (this.activeSessions.has(session) && session.socket && !session.socket.destroyed) {
            const now = new Date();
            const yy = String(now.getFullYear()).slice(-2);
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const mi = String(now.getMinutes()).padStart(2, '0');
            const dateStr = `${yy}${mm}${dd}${hh}${mi}`;

            const dlrText = `id:${msgId} sub:001 dlvrd:001 submit date:${dateStr} done date:${dateStr} stat:DELIVRD err:000 text:`;

            try {
              session.deliver_sm({
                source_addr: pdu.destination_addr,
                destination_addr: pdu.source_addr,
                esm_class: 0x04, // SMSC Delivery Receipt
                short_message: dlrText
              });
              this.emit('dlrSent', { messageId: msgId, stat: 'DELIVRD' });
            } catch (err) {
              this.emit('error', err);
            }
          }
        }, 1500);
      }
    });

    session.on('deliver_sm_resp', (pdu) => {
      this.emit('deliver_sm_resp', { sequence_number: pdu.sequence_number });
    });

    session.on('close', () => {
      this.activeSessions.delete(session);
      this.emit('clientDisconnected');
    });

    session.on('error', (err) => {
      this.emit('error', err);
    });
  }
}

// Singleton simulator instance
const simulator = new SmppSimulator();

module.exports = simulator;
