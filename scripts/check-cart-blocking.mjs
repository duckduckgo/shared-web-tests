/**
 * Check content blocking on Nintendo cart page
 * Captures what's actually blocked vs allowed
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const args = process.argv.slice(2);
const configArg = args.find(a => a.startsWith('--config='));
const privacyConfigURL = configArg ? configArg.split('=').slice(1).join('=') : null;

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

async function cleanupSessions() {
    try {
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            for (const session of data.value || []) {
                await fetch(`${serverUrl}/session/${session.id}`, { method: 'DELETE' });
            }
        }
    } catch {}
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

await cleanupSessions();

console.log('\n🛒 Cart Page Content Blocker Check');
console.log('='.repeat(50));
console.log(`Config: ${privacyConfigURL || 'DEFAULT (protections ON)'}`);

const capabilities = { browserName: 'duckduckgo' };
if (privacyConfigURL) {
    capabilities['ddg:privacyConfigURL'] = privacyConfigURL;
}

let driver;
try {
    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities(capabilities)
        .build();

    // Go directly to cart page
    console.log('\nNavigating to cart page...');
    await driver.get('https://www.nintendo.com/us/cart/');
    await sleep(8000);

    // Capture all network activity including failed requests
    const diagnostics = await driver.executeScript(`
        const results = {
            url: window.location.href,
            totalResources: 0,
            thirdPartyDomains: [],
            failedRequests: [],
            scripts: [],
            trackerCheck: {}
        };

        // Get all resource timing entries
        const entries = performance.getEntriesByType('resource');
        results.totalResources = entries.length;
        
        const domains = new Set();
        for (const entry of entries) {
            try {
                const url = new URL(entry.name);
                if (url.hostname !== 'www.nintendo.com') {
                    domains.add(url.hostname);
                }
                // Check for failed/blocked (zero transfer size often means blocked)
                if (entry.transferSize === 0 && entry.decodedBodySize === 0) {
                    results.failedRequests.push({
                        domain: url.hostname,
                        path: url.pathname.slice(0, 60),
                        duration: entry.duration
                    });
                }
            } catch {}
        }
        results.thirdPartyDomains = Array.from(domains).sort();

        // Check scripts
        document.querySelectorAll('script[src]').forEach(script => {
            try {
                const url = new URL(script.src, window.location.href);
                results.scripts.push(url.hostname);
            } catch {}
        });

        // Check specific trackers
        const trackerDomains = [
            'google-analytics.com',
            'googletagmanager.com', 
            'facebook.net',
            'connect.facebook.net',
            'facebook.com',
            'doubleclick.net',
            'criteo.com',
            'criteo.net',
            'quantummetric.com',
            'optimizely.com',
            'sentry.io'
        ];

        for (const tracker of trackerDomains) {
            const loaded = results.thirdPartyDomains.some(d => d.includes(tracker)) ||
                          results.scripts.some(s => s.includes(tracker));
            results.trackerCheck[tracker] = loaded ? 'LOADED' : 'BLOCKED/ABSENT';
        }

        return results;
    `);

    console.log(`\nURL: ${diagnostics.url}`);
    console.log(`Total resources: ${diagnostics.totalResources}`);
    console.log(`Third-party domains loaded: ${diagnostics.thirdPartyDomains.length}`);
    
    console.log('\n📊 Third-party domains:');
    for (const d of diagnostics.thirdPartyDomains) {
        console.log(`   ${d}`);
    }

    console.log('\n🎯 Tracker status:');
    for (const [tracker, status] of Object.entries(diagnostics.trackerCheck)) {
        const icon = status === 'LOADED' ? '⚠️' : '✅';
        console.log(`   ${icon} ${tracker}: ${status}`);
    }

    if (diagnostics.failedRequests.length > 0) {
        console.log('\n❌ Potentially blocked requests (0 transfer size):');
        for (const req of diagnostics.failedRequests.slice(0, 10)) {
            console.log(`   ${req.domain}${req.path}`);
        }
    }

    console.log('\n' + '='.repeat(50));

} catch (error) {
    console.error('Error:', error.message);
} finally {
    if (driver) {
        await driver.quit();
    }
}
