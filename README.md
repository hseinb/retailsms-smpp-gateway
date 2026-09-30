# RetailSMS — Lightweight SMPP SMS Gateway & Web Portal

RetailSMS is a fast, lightweight, and self-contained SMS gateway application built with **Node.js**, **SMPP v3.4**, and **SQLite**. It connects to SMS aggregators or telecommunication SMSCs via the Short Message Peer-to-Peer (SMPP) protocol, allowing you to send messages through both an interactive **Web Portal** and a developer-friendly **REST API**.

---

## 🚀 Key Features

- **SMPP v3.4 Protocol Support**: Full duplex `transceiver`, `transmitter`, and `receiver` bind modes.
- **Modern Web Portal Dashboard**:
  - Live connection status badge with real-time WebSocket updates.
  - SMS Composer with real-time character counter, segment calculation, and automatic encoding detection (`GSM-7` vs `UCS-2 Unicode`).
  - Single and bulk number dispatching (comma/newline separated).
  - Pre-built quick message templates (Order shipped, OTP verification, discount alerts, Arabic).
  - Searchable message history with delivery receipts (DLR) and 1-click retry.
  - CSV export for reporting.
  - Live SMPP protocol PDU traffic terminal.
- **REST API for External Integrations**:
  - `POST /api/v1/sms/send`: Send single or bulk SMS.
  - `GET /api/v1/sms/:id`: Query message delivery status and aggregator IDs.
  - `GET /api/v1/sms`: Filtered message history and reporting.
  - `GET /api/v1/status`: Live gateway health, SMPP bound state, and queue metrics.
  - API Key authentication via `X-API-Key` or `Authorization: Bearer <key>`.
- **Built-in Mock SMPP Simulator**:
  - Test sending messages, receiving aggregator IDs, and processing delivery receipts immediately out of the box without needing an external aggregator account or paying for SMS credits!
  - Can be toggled on/off with one click directly from the portal header.
- **Automatic Multipart & Concatenated SMS**:
  - Transparently segments messages exceeding 160 GSM characters or 70 Unicode characters with 6-byte User Data Headers (UDH).
- **International & Arabic Support**:
  - Automatic detection of UCS-2 (UTF-16 Big Endian) for Arabic, Cyrillic, Greek, and emojis.
- **TPS Rate Limiting & Queueing**:
  - Internal token-bucket rate limiter prevents aggregator throttling (`ESME_RTHROTTLED 0x00000058`).
- **Resilient Connectivity**:
  - Auto-reconnect with exponential backoff on network dropouts.
  - Active `enquire_link` keep-alive monitoring to maintain persistent sessions.
- **Zero-Configuration SQLite Storage**:
  - High performance WAL mode database with zero external database dependencies.

---

## 📋 Prerequisites

- **Node.js** v18+ or v20+
- **npm** (comes with Node.js)

---

## ⚡ Quick Start

1. **Clone or Navigate to the Directory**:
   ```bash
   cd RetailSMS
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Start the Gateway**:
   ```bash
   npm start
   ```

4. **Open the Web Portal**:
   Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.

---

## ⚙️ Configuration

Settings can be managed either via the `.env` file or directly through the **Web Portal (SMPP Settings tab)** without restarting the server:

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port for the Web Portal and REST API |
| `DEFAULT_SENDER` | `RetailAlert` | Default alphanumeric Sender ID / Originator |
| `SMPP_HOST` | `127.0.0.1` | Aggregator SMPP server hostname or IP |
| `SMPP_PORT` | `2775` | Aggregator SMPP port |
| `SMPP_SYSTEM_ID` | `test_client` | Aggregator username / system ID |
| `SMPP_PASSWORD` | `test_password`| Aggregator password |
| `SMPP_SYSTEM_TYPE` | `""` | Optional system type |
| `SMPP_BIND_MODE` | `transceiver` | `transceiver` (recommended), `transmitter`, or `receiver` |
| `SMPP_TPS_LIMIT` | `10` | Max messages dispatched per second |
| `SMPP_KEEPALIVE_INTERVAL` | `30` | Seconds between `enquire_link` keep-alive pings |
| `SMPP_SOURCE_TON` | `5` | `5` = Alphanumeric (Brand name), `1` = International |
| `SMPP_SOURCE_NPI` | `0` | `0` = Unknown, `1` = ISDN / E.164 |
| `SMPP_DEST_TON` | `1` | `1` = International |
| `SMPP_DEST_NPI` | `1` | `1` = ISDN / E.164 |
| `SMPP_AUTO_CONNECT` | `true` | Connect automatically to SMPP on startup |
| `SIMULATOR_ENABLED` | `true` | Run built-in mock SMPP server for local testing |
| `SIMULATOR_PORT` | `2775` | Port for the built-in mock SMPP server |

---

## 📡 REST API Reference

All requests require an API key passed in the `X-API-Key` or `Authorization: Bearer <key>` header. You can view, copy, or create API keys in the **API & Sandbox** tab in the web portal.

### 1. Send SMS

`POST /api/v1/sms/send`

#### Request Headers:
```http
Content-Type: application/json
X-API-Key: rsk_your_api_key_here
```

#### Request Body (Single Recipient):
```json
{
  "to": "+12025550143",
  "from": "RetailSMS",
  "text": "Your order #10842 is ready for pickup!"
}
```

#### Request Body (Bulk Recipients):
```json
{
  "to": ["+12025550143", "+447911123456", "+966500000000"],
  "from": "RetailSMS",
  "text": "Weekend Special: Get 20% off all items!"
}
```

#### Response (`202 Accepted`):
```json
{
  "success": true,
  "totalQueued": 1,
  "messages": [
    {
      "id": "c76a9c72-c07a-4ec6-89bf-9eb84eb120b3",
      "messageId": "c76a9c72-c07a-4ec6-89bf-9eb84eb120b3",
      "recipient": "+12025550143",
      "sender": "RetailSMS",
      "parts": 1,
      "encoding": "GSM7",
      "characters": 39,
      "status": "QUEUED"
    }
  ]
}
```

---

### 2. Check Message Status & Delivery Receipt

`GET /api/v1/sms/:id`

#### Response (`200 OK`):
```json
{
  "success": true,
  "message": {
    "id": "c76a9c72-c07a-4ec6-89bf-9eb84eb120b3",
    "aggregator_msg_id": "SIM-MUO0H7K2-1001",
    "source": "api",
    "sender": "RetailSMS",
    "recipient": "+12025550143",
    "text": "Your order #10842 is ready for pickup!",
    "encoding": "GSM7",
    "parts_count": 1,
    "status": "DELIVERED",
    "dlr_status": "DELIVRD",
    "dlr_received_at": "2026-09-30T11:18:05.120Z",
    "submitted_at": "2026-09-30T11:18:03.450Z",
    "created_at": "2026-09-30T11:18:03.400Z"
  }
}
```

---

### 3. Check Gateway & SMPP Status

`GET /api/v1/status`

#### Response (`200 OK`):
```json
{
  "success": true,
  "smpp": {
    "state": "BOUND",
    "queueLength": 0,
    "config": {
      "host": "127.0.0.1",
      "port": 2775,
      "systemId": "test_client",
      "bindMode": "transceiver",
      "tps": 10
    }
  },
  "messageStats": {
    "total": 45,
    "queued": 0,
    "submitted": 2,
    "delivered": 41,
    "failed": 2
  }
}
```

---

## 💻 Code Integration Examples

### cURL
```bash
curl -X POST "http://localhost:3000/api/v1/sms/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "to": "+12025550143",
    "from": "RetailSMS",
    "text": "Hello from RetailSMS SMPP Gateway!"
  }'
```

### Python
```python
import requests

url = "http://localhost:3000/api/v1/sms/send"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "YOUR_API_KEY"
}
payload = {
    "to": "+12025550143",
    "from": "RetailSMS",
    "text": "Your verification code is 492019."
}

res = requests.post(url, json=payload, headers=headers)
print(res.json())
```

### Node.js
```javascript
const response = await fetch('http://localhost:3000/api/v1/sms/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    to: '+12025550143',
    from: 'RetailSMS',
    text: 'Hello from Node.js!'
  })
});

const data = await response.json();
console.log(data);
```

---

## 🧪 Testing

Run the automated integration test suite:
```bash
npm test
```
The test suite starts an isolated test server, binds to the mock SMPP server, tests single and bulk SMS, verifies UCS-2 Arabic character handling, checks multipart message segmentation with UDH, and validates asynchronous DLR processing.

---

## 📄 License
ISC
