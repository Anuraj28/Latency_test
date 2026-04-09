# NetDiag v2 — Enterprise Network Diagnostics Dashboard

Smokeping + Speedtest + Traceroute combined, in a single-page Node.js app.

---

## Features

| Feature | Detail |
|---------|--------|
| Latency Monitor | HEAD ping every 1s via performance.now() |
| Jitter | StdDev of last 60 samples, updated every second |
| Smokeping Chart | 5-min scrolling canvas — min/max band, jitter highlights, loss markers |
| Bandwidth Test | Auto every 1 hour + "Run Now" button |
| Traceroute | Runs after bandwidth test via backend `traceroute` command |
| Data Storage | SQLite — every test saves latency, jitter, DL/UL, traceroute, IP |
| Check ID | Auto-increment per test, shown top-left |

---

## Quick Start

```bash
cd netdiag2
npm install
npm start
# Open http://localhost:3000
```

### Linux: install traceroute if missing
```bash
sudo apt install traceroute   # Debian/Ubuntu
sudo yum install traceroute   # RHEL/CentOS
```

---

## Database Schema

```sql
CREATE TABLE results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      TEXT NOT NULL,
  ip             TEXT NOT NULL,
  latency_avg    REAL,
  jitter         REAL,
  download_speed REAL,
  upload_speed   REAL,
  traceroute     TEXT
);
```

File: `netdiag2/netdiag.db` (auto-created on first run)

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| HEAD/GET | `/ping` | Proxy latency check |
| GET | `/my-ip` | Return caller IP |
| GET | `/download-test` | Serve 10 MB file |
| POST | `/upload-test` | Accept upload |
| GET | `/traceroute` | Run system traceroute |
| POST | `/save-result` | Save test result |
| GET | `/results` | List results |
| GET | `/results/:id` | Fetch by Check ID |

---

## Nginx Reverse Proxy (Production)

```nginx
server {
    listen 443 ssl;
    server_name netdiag.example.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_set_header   Host $host;
        proxy_read_timeout 120s;
    }
}
```

---

## Architecture Notes

- **Ping strategy**: `fetch()` with `mode: no-cors` to target → fallback to `/ping` proxy
- **Jitter**: Standard deviation of sliding 60-sample window
- **Smokeping canvas**: Min/Max band + median line + loss markers + jitter highlight columns
- **Traceroute**: `child_process.exec()` — Linux (`traceroute -n`) or Windows (`tracert -d`)
- **No heavy dependencies**: Vanilla JS + Canvas 2D — runs fine in Citrix/VDI

---

## File Structure

```
netdiag2/
├── server.js
├── package.json
├── netdiag.db          (auto-created)
└── public/
    ├── index.html
    ├── style.css
    └── script.js
```
