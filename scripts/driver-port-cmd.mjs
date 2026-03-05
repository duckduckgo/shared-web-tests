#!/usr/bin/env node
/**
 * Port-aware WebDriver commands
 * 
 * Usage:
 *   node scripts/driver-port-cmd.mjs status
 *   node scripts/driver-port-cmd.mjs sessions
 *   node scripts/driver-port-cmd.mjs wait
 *   node scripts/driver-port-cmd.mjs cleanup
 * 
 * Environment:
 *   WEBDRIVER_PORT - Port number (default: 4444)
 */

const port = process.env.WEBDRIVER_PORT || '4444';
const baseUrl = `http://localhost:${port}`;
const command = process.argv[2];

async function status() {
    try {
        const r = await fetch(`${baseUrl}/status`);
        if (r.ok) {
            const data = await r.json();
            console.log(`Driver running on port ${port}`);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log(`Driver not responding on port ${port}`);
            process.exit(1);
        }
    } catch {
        console.log(`Driver not running on port ${port}`);
        process.exit(1);
    }
}

async function sessions() {
    try {
        const r = await fetch(`${baseUrl}/sessions`);
        const d = await r.json();
        const count = d.value?.length || 0;
        console.log(`${count} session(s) on port ${port}`);
        if (count > 0) {
            d.value.forEach(s => console.log(`  - ${s.id}`));
        }
    } catch {
        console.log(`0 session(s) - driver not running on port ${port}`);
    }
}

async function wait() {
    const maxWait = 60;
    for (let i = 0; i < maxWait; i++) {
        try {
            const r = await fetch(`${baseUrl}/status`);
            if (r.ok) {
                console.log(`Driver ready on port ${port}`);
                process.exit(0);
            }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
    }
    console.error(`Driver timeout on port ${port} after ${maxWait}s`);
    process.exit(1);
}

async function cleanup() {
    // Delete sessions
    try {
        const r = await fetch(`${baseUrl}/sessions`);
        const d = await r.json();
        for (const s of d.value || []) {
            console.log(`Deleting session: ${s.id}`);
            await fetch(`${baseUrl}/session/${s.id}`, { method: 'DELETE' });
        }
    } catch {}
    console.log(`Sessions cleaned on port ${port}`);
}

switch (command) {
    case 'status':
        await status();
        break;
    case 'sessions':
        await sessions();
        break;
    case 'wait':
        await wait();
        break;
    case 'cleanup':
        await cleanup();
        break;
    default:
        console.log('Usage: driver-port-cmd.mjs <status|sessions|wait|cleanup>');
        process.exit(1);
}
