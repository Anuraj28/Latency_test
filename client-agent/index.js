const { exec } = require('child_process');
const axios = require('axios');
const http = require('http');
const os = require('os');
const isWin = os.platform() === 'win32';

// Configuration
const TARGET_HOST = 'ping1.chinetworks.com';
let BACKEND_SERVER_URL = 'http://49.43.154.14:3000'; // Default WAN IP for external users
const serverArg = process.argv.find(arg => arg.startsWith('--server='));
if (serverArg) {
    BACKEND_SERVER_URL = serverArg.split('=')[1];
    console.log(`[Config] Overriding backend with: ${BACKEND_SERVER_URL}`);
}

const DOWNLOAD_ENDPOINT = `${BACKEND_SERVER_URL}/download-test`;
const UPLOAD_ENDPOINT = `${BACKEND_SERVER_URL}/upload-test`;
const REPORT_ENDPOINT = `${BACKEND_SERVER_URL}/save-result`;

// Helper: Calculate Standard Deviation for Jitter
function calculateJitter(latencies) {
    if (latencies.length === 0) return 0;
    const n = latencies.length;
    const mean = latencies.reduce((a, b) => a + b) / n;
    const variance = latencies.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
    return Math.sqrt(variance);
}

// 1. Run Ping Test
function runPing() {
    console.log(`Running ping to ${TARGET_HOST}...`);
    return new Promise((resolve, reject) => {
        const pingCmd = isWin ? `ping -n 10 ${TARGET_HOST}` : `ping -c 10 ${TARGET_HOST}`;
        exec(pingCmd, (error, stdout, stderr) => {
            const result = {
                latency_avg: 0,
                latency_min: 0,
                latency_max: 0,
                jitter: 0,
                packet_loss: 0,
                latencies: []
            };

            const lines = stdout.split('\n');
            const latencyRegex = /time[=<]([\d.]+)\s*ms/i; // Matches: time=15.1ms, time<1ms, time=15.1 ms
            const lossRegexWin = /\((\d+)% loss\)/i;
            const lossRegexLin = /(\d+)% packet loss/i;

            for (const line of lines) {
                // Check individual latencies
                const timeMatch = line.match(latencyRegex);
                if (timeMatch && timeMatch[1]) {
                    result.latencies.push(parseFloat(timeMatch[1]));
                }
                
                // Check Packet Loss
                const lossMatchWin = line.match(lossRegexWin);
                if (lossMatchWin && lossMatchWin[1]) {
                    result.packet_loss = parseInt(lossMatchWin[1], 10);
                }
                const lossMatchLin = line.match(lossRegexLin);
                if (lossMatchLin && lossMatchLin[1]) {
                    result.packet_loss = parseInt(lossMatchLin[1], 10);
                }
            }

            // Calculation
            if (result.latencies.length > 0) {
                result.latency_min = Math.round(Math.min(...result.latencies));
                result.latency_max = Math.round(Math.max(...result.latencies));
                result.latency_avg = Math.round(result.latencies.reduce((a, b) => a + b) / result.latencies.length);
                result.jitter = Math.round(calculateJitter(result.latencies));
            } else {
                result.packet_loss = 100; // All timed out or failed to parse
            }

            resolve(result);
        });
    });
}

// 2. Run Traceroute
function runTraceroute() {
    console.log(`Running traceroute to ${TARGET_HOST}...`);
    return new Promise((resolve) => {
        const traceCmd = isWin ? `tracert -d ${TARGET_HOST}` : `traceroute -n ${TARGET_HOST}`;
        exec(traceCmd, (error, stdout, stderr) => {
            resolve(stdout || stderr || "Traceroute failed");
        });
    });
}

// 3. Bandwidth Test
async function runBandwidthTest() {
    console.log('Testing bandwidth...');
    let downloadSpeed = 0;
    let uploadSpeed = 0;

    try {
        // --- Download Test ---
        const dlStartTime = Date.now();
        // Request arraybuffer to avoid parsing overhead mapping to string
        const dlResponse = await axios.get(DOWNLOAD_ENDPOINT, {
            responseType: 'arraybuffer',
            timeout: 15000 // 15 sec timeout
        });
        const dlEndTime = Date.now();

        const dlDurationSec = (dlEndTime - dlStartTime) / 1000;
        const dlBytes = dlResponse.data.byteLength;
        // bps = bytes * 8, then divide by 1,000,000 for Mbps
        downloadSpeed = Math.round(((dlBytes * 8) / 1000000) / dlDurationSec);

    } catch (err) {
        console.error("Warning: Download test failed. Is the backend correctly serving /speedtest/download?", err.message);
    }

    try {
        // --- Upload Test ---
        // Generate a 5MB dummy buffer
        const payloadSize = 5 * 1024 * 1024;
        const dummyData = Buffer.alloc(payloadSize, '0');

        const ulStartTime = Date.now();
        await axios.post(UPLOAD_ENDPOINT, dummyData, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': payloadSize
            },
            timeout: 15000 // 15 sec timeout
        });
        const ulEndTime = Date.now();

        const ulDurationSec = (ulEndTime - ulStartTime) / 1000;
        uploadSpeed = Math.round(((payloadSize * 8) / 1000000) / ulDurationSec);

    } catch (err) {
        console.error("Warning: Upload test failed. Is the backend correctly accepting POST on /speedtest/upload?", err.message);
    }

    return { downloadSpeed, uploadSpeed };
}

// 4. Get User Public IP
async function getPublicIP() {
    try {
        const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
        return response.data.ip;
    } catch (err) {
        console.error("Warning: Failed to fetch public IP.");
        return "Unknown";
    }
}

// 5. Send results to backend
async function reportResults(results) {
    try {
        const payload = {
            ip: results.ip,
            latency_avg: results.ping.latency_avg,
            latency_min: results.ping.latency_min,
            latency_max: results.ping.latency_max,
            jitter: results.ping.jitter,
            packet_loss: results.ping.packet_loss,
            download_speed: results.bandwidth.downloadSpeed,
            upload_speed: results.bandwidth.uploadSpeed,
            traceroute: results.traceroute
        };

        const response = await axios.post(REPORT_ENDPOINT, payload, { timeout: 10000 });
        return response.data.check_id || "UNKNOWN-ID";
    } catch (error) {
        console.error("Error: Failed to report results to backend server. Make sure BACKEND_SERVER_URL is correct.", error.message);
        return null;
    }
}

// Main Flow
async function main() {
    console.log("==========================================");
    console.log("   Network Diagnostic Tool");
    console.log("==========================================\n");

    try {
        // Basic internet check implicitly done via ping or IP lookup
        const expectedIP = await getPublicIP();

        // 1. Gather Data
        const pingResult = await runPing();
        const tracerouteOutput = await runTraceroute();
        const bwResult = await runBandwidthTest();

        const combinedData = {
            ip: expectedIP,
            ping: pingResult,
            traceroute: tracerouteOutput,
            bandwidth: bwResult
        };

        console.log("Submitting results to server...");
        // 2. Submit Data
        const checkId = await reportResults(combinedData);

        // 3. Display Output
        console.log("\n==========================================");
        console.log("               RESULTS");
        console.log("==========================================");
        console.log(`Latency: ${pingResult.latency_avg} ms`);
        console.log(`Jitter: ${pingResult.jitter} ms`);
        console.log(`Packet Loss: ${pingResult.packet_loss}%`);
        console.log(`Download: ${bwResult.downloadSpeed} Mbps`);
        console.log(`Upload: ${bwResult.uploadSpeed} Mbps`);
        console.log("\n------------------------------------------");

        if (checkId) {
            console.log(`Check ID: ${checkId}`);
        } else {
            console.log("Check ID: API Error (Data not saved)");
        }

        console.log("==========================================\n");

    } catch (err) {
        console.error("Critical Error execution failed:", err);
    }
}

// Kick off Execution
main();
