/**
 * Quick test to validate if custom config is being applied
 * Checks: blocked requests, protections status
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');
const { By } = selenium;

const serverUrl = 'http://localhost:4444';
const configUrl = process.argv[2] || null;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest() {
    const capabilities = { browserName: 'duckduckgo' };
    if (configUrl) {
        capabilities['ddg:privacyConfigURL'] = configUrl;
        console.log(`\n🔧 Using custom config: ${configUrl}`);
    } else {
        console.log(`\n🔧 Using DEFAULT config (no override)`);
    }

    const driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities(capabilities)
        .build();

    try {
        // Navigate to Nintendo
        console.log('\n📍 Navigating to nintendo.com...');
        await driver.get('https://www.nintendo.com/us/');
        await sleep(5000);

        // Check if we can get protection status via privacy dashboard
        // First, let's check console for blocked requests
        const logs = await driver.executeScript(`
            return new Promise((resolve) => {
                const results = {
                    url: window.location.href,
                    blockedCount: 0,
                    allowedCount: 0,
                    trackers: [],
                    errors: []
                };

                // Check for DDG-specific objects
                if (window.__DDG_TRACKER_INFO__) {
                    results.trackerInfo = window.__DDG_TRACKER_INFO__;
                }

                // Check content scope scripts
                if (typeof ddg !== 'undefined') {
                    results.ddgDefined = true;
                }

                // Look for any DDG-injected content
                const ddgElements = document.querySelectorAll('[data-ddg-tracker], [data-ddg-tracking]');
                results.ddgElementCount = ddgElements.length;

                resolve(results);
            });
        `);

        console.log('\n📊 Page state:');
        console.log(`   URL: ${logs.url}`);
        console.log(`   DDG elements found: ${logs.ddgElementCount}`);
        if (logs.ddgDefined) console.log('   DDG object defined: yes');
        if (logs.trackerInfo) console.log(`   Tracker info: ${JSON.stringify(logs.trackerInfo)}`);

        // Try to access the privacy dashboard info via the native interface
        const privacyInfo = await driver.executeScript(`
            return new Promise((resolve) => {
                // Try to get protection status from various sources
                const info = {
                    documentDomain: document.domain,
                    cookies: document.cookie ? document.cookie.split(';').length : 0,
                    localStorage: Object.keys(localStorage).length,
                    scripts: document.querySelectorAll('script[src]').length,
                    iframes: document.querySelectorAll('iframe').length,
                    thirdPartyScripts: [],
                    possiblyBlocked: []
                };

                // List all external scripts
                document.querySelectorAll('script[src]').forEach(s => {
                    const src = s.src;
                    if (src && !src.includes('nintendo.com')) {
                        info.thirdPartyScripts.push(new URL(src).hostname);
                    }
                });

                // List all iframes
                document.querySelectorAll('iframe[src]').forEach(f => {
                    const src = f.src;
                    if (src && !src.includes('nintendo.com')) {
                        try {
                            info.possiblyBlocked.push(new URL(src).hostname);
                        } catch(e) {}
                    }
                });

                resolve(info);
            });
        `);

        console.log('\n📋 Resource analysis:');
        console.log(`   Total scripts: ${privacyInfo.scripts}`);
        console.log(`   Iframes: ${privacyInfo.iframes}`);
        console.log(`   Cookies: ${privacyInfo.cookies}`);
        console.log(`   localStorage keys: ${privacyInfo.localStorage}`);
        
        if (privacyInfo.thirdPartyScripts.length > 0) {
            const unique = [...new Set(privacyInfo.thirdPartyScripts)];
            console.log(`   Third-party script domains (${unique.length}):`);
            unique.forEach(d => console.log(`      - ${d}`));
        }

        // Check for specific trackers that would normally be blocked
        const trackerCheck = await driver.executeScript(`
            return new Promise(async (resolve) => {
                const trackers = {
                    googleAnalytics: false,
                    googleTagManager: false,
                    facebook: false,
                    doubleclick: false,
                    criteo: false
                };

                // Check if Google Analytics loaded
                if (typeof ga !== 'undefined' || typeof gtag !== 'undefined') {
                    trackers.googleAnalytics = true;
                }
                if (typeof google_tag_manager !== 'undefined' || window.dataLayer) {
                    trackers.googleTagManager = true;
                }
                if (typeof fbq !== 'undefined') {
                    trackers.facebook = true;
                }

                // Check for script elements
                const scripts = Array.from(document.querySelectorAll('script[src]'));
                scripts.forEach(s => {
                    const src = s.src.toLowerCase();
                    if (src.includes('google-analytics') || src.includes('googletagmanager')) {
                        trackers.googleAnalytics = true;
                    }
                    if (src.includes('facebook') || src.includes('fbcdn')) {
                        trackers.facebook = true;
                    }
                    if (src.includes('doubleclick')) {
                        trackers.doubleclick = true;
                    }
                    if (src.includes('criteo')) {
                        trackers.criteo = true;
                    }
                });

                resolve(trackers);
            });
        `);

        console.log('\n🔍 Tracker detection (loaded = not blocked):');
        console.log(`   Google Analytics/GTM: ${trackerCheck.googleAnalytics ? '✓ LOADED' : '✗ blocked/not present'}`);
        console.log(`   Facebook Pixel: ${trackerCheck.facebook ? '✓ LOADED' : '✗ blocked/not present'}`);
        console.log(`   DoubleClick: ${trackerCheck.doubleclick ? '✓ LOADED' : '✗ blocked/not present'}`);
        console.log(`   Criteo: ${trackerCheck.criteo ? '✓ LOADED' : '✗ blocked/not present'}`);

        // Check for network errors that might indicate blocking
        const performanceData = await driver.executeScript(`
            const entries = performance.getEntriesByType('resource');
            const failed = [];
            const loaded = [];
            
            entries.forEach(e => {
                if (e.transferSize === 0 && e.decodedBodySize === 0 && !e.name.includes('nintendo')) {
                    failed.push(e.name);
                } else if (!e.name.includes('nintendo')) {
                    loaded.push(e.name);
                }
            });
            
            return { failed: failed.slice(0, 10), loaded: loaded.length, total: entries.length };
        `);

        console.log('\n📡 Network resources:');
        console.log(`   Total loaded: ${performanceData.total}`);
        console.log(`   Third-party loaded: ${performanceData.loaded}`);
        if (performanceData.failed.length > 0) {
            console.log(`   Possibly blocked (0 bytes):`);
            performanceData.failed.forEach(f => {
                try {
                    console.log(`      - ${new URL(f).hostname}`);
                } catch(e) {
                    console.log(`      - ${f.substring(0, 60)}...`);
                }
            });
        }

        console.log('\n✅ Config validation complete');
        
    } finally {
        await driver.quit();
    }
}

runTest().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
