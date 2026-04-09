# Windows Network Diagnostic Agent

This is a lightweight Windows CLI tool that will run network diagnostics on a client's machine (Ping, Jitter, Traceroute, and Bandwidth) and submit it to your backend.

## 1. How to Build the EXE

We will use `pkg` (installed conceptually via `npm` dependencies, or you can install it globally) to bundle the Node.js script into a standalone executable.

**Steps:**
1. Open up a terminal in this `client-agent` directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the build script defined in `package.json`:
   ```bash
   npm run build
   ```
   *(Or run it manually: `npx pkg index.js --targets node18-win-x64 --output network-checker.exe`)*
4. You will get a `network-checker.exe` file that can be distributed to users. Users do not need admin privileges to run it.

---

## 2. Setting Your Server IP

In `index.js`, find this line:
```javascript
const BACKEND_SERVER_URL = 'http://YOUR_SERVER_IP:3000'; // REPLACE WITH ACTUAL IP
```
Change `http://YOUR_SERVER_IP:3000` to the actual hosted server endpoint before building your exe.

---

## 3. Sample Backend API Implementation

For the diagnostic tool to run bandwidth tests and submit reports, your actual backend (e.g., `server.js` from your main application dashboard) must support these three endpoints:

### Express.js Example code snippet to add to your backend:

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

// Middleware to handle large uploads (at least 5MB)
app.use(express.json({ limit: '10mb' }));
// Using raw body parser for the binary upload test stream
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

/**
 * 1. BANDWIDTH TEST - DOWNLOAD
 * Sends a 10MB chunk of data to the client to measure download speed.
 */
app.get('/speedtest/download', (req, res) => {
    const dataSize = 10 * 1024 * 1024; // 10MB
    const buffer = Buffer.alloc(dataSize, '1');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Length', dataSize);
    res.send(buffer);
});

/**
 * 2. BANDWIDTH TEST - UPLOAD
 * Accepts a large body to measure upload speed, but doesn't store it.
 */
app.post('/speedtest/upload', (req, res) => {
    res.status(200).send('OK');
});

/**
 * 3. SAVE DIAGNOSTIC RESULT
 * Receives the aggregated result from the CLI agent.
 */
app.post('/save-result', (req, res) => {
    const data = req.body;
    
    // Generate a simple Check ID
    const checkId = 'CHK-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    
    // Log OR Store in Database (SQLite)
    console.log(`Received Diagnostic for ID: ${checkId} from IP: ${data.ip}`);
    /* 
    Example Payload received:
    {
      "ip": "user_ip",
      "latency_avg": 291,
      "latency_min": 290,
      "latency_max": 293,
      "jitter": 1,
      "packet_loss": 0,
      "download_speed": 500,
      "upload_speed": 90,
      "traceroute": "full output"
    }
    */
    
    res.json({ check_id: checkId });
});

app.listen(3000, () => {
    console.log('Backend listening on port 3000');
});
```
