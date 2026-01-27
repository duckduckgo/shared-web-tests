/**
 * Diagnostic script to check content blocking behavior
 * Compares what's blocked with and without custom privacy config
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

console.log('\n🔍 Content Blocker Diagnostic');
console.log('='.repeat(50));
console.log(`Config: ${privacyConfigURL || 'DEFAULT (protections ON)'}`);
console.log('');

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

    // Navigate to Nintendo
    console.log('Navigating to nintendo.com...');
    await driver.get('https://www.nintendo.com/us/');
    await sleep(5000);

    // Check loaded scripts and resources
    const diagnostics = await driver.executeScript(`
        const results = {
            url: window.location.href,
            scripts: [],
            blockedResources: [],
            thirdPartyDomains: new Set(),
            trackerDomains: [],
            totalResources: 0
        };

        // Check performance entries for loaded resources
        const entries = performance.getEntriesByType('resource');
        results.totalResources = entries.length;
        
        for (const entry of entries) {
            try {
                const url = new URL(entry.name);
                if (url.hostname !== window.location.hostname) {
                    results.thirdPartyDomains.add(url.hostname);
                }
            } catch {}
        }

        // Check script tags
        document.querySelectorAll('script[src]').forEach(script => {
            try {
                const url = new URL(script.src, window.location.href);
                results.scripts.push({
                    domain: url.hostname,
                    path: url.pathname.slice(0, 50)
                });
            } catch {}
        });

        // Known tracker domains to check
        const trackers = [
            'google-analytics.com',
            'googletagmanager.com',
            'facebook.net',
            'facebook.com',
            'doubleclick.net',
            'googlesyndication.com',
            'criteo.com',
            'criteo.net',
            'amazon-adsystem.com',
            'twitter.com',
            'ads-twitter.com'
        ];

        results.thirdPartyDomains = Array.from(results.thirdPartyDomains);
        
        // Check which trackers loaded
        for (const tracker of trackers) {
            const found = results.thirdPartyDomains.some(d => d.includes(tracker)) ||
                         results.scripts.some(s => s.domain.includes(tracker));
            if (found) {
                results.trackerDomains.push(tracker);
            }
        }

        return results;
    `);

    console.log('\\n📊 Resource Analysis:');
    console.log(`   URL: ${diagnostics.url}`);
    console.log(`   Total resources loaded: ${diagnostics.totalResources}`);
    console.log(`   Third-party domains: ${diagnostics.thirdPartyDomains.length}`);
    console.log(`   Scripts loaded: ${diagnostics.scripts.length}`);
    
    console.log('\\n🔎 Third-party domains:');
    for (const domain of diagnostics.thirdPartyDomains.sort()) {
        console.log(`   - ${domain}`);
    }

    console.log('\\n🎯 Known trackers detected:');
    if (diagnostics.trackerDomains.length === 0) {
        console.log('   ✅ None (blocked or not present)');
    } else {
        for (const tracker of diagnostics.trackerDomains) {
            console.log(`   ⚠️  ${tracker} - LOADED`);
        }
    }

    // Check for specific Facebook/Google/Criteo scripts
    console.log('\\n🔬 Specific tracker check:');
    const trackerCheck = await driver.executeScript(`
        const checks = {};
        
        // Check GTM
        checks.gtm = typeof window.google_tag_manager !== 'undefined' || 
                     document.querySelector('script[src*="googletagmanager.com"]') !== null;
        
        // Check Facebook Pixel
        checks.fbPixel = typeof window.fbq !== 'undefined' ||
                        document.querySelector('script[src*="facebook"]') !== null;
        
        // Check Criteo
        checks.criteo = typeof window.criteo_q !== 'undefined' ||
                       document.querySelector('script[src*="criteo"]') !== null;
        
        // Check Google Analytics
        checks.ga = typeof window.ga !== 'undefined' || 
                   typeof window.gtag !== 'undefined' ||
                   document.querySelector('script[src*="google-analytics"]') !== null;

        return checks;
    `);

    console.log(`   Google Tag Manager: ${trackerCheck.gtm ? '⚠️ LOADED' : '✅ BLOCKED/ABSENT'}`);
    console.log(`   Facebook Pixel: ${trackerCheck.fbPixel ? '⚠️ LOADED' : '✅ BLOCKED/ABSENT'}`);
    console.log(`   Criteo: ${trackerCheck.criteo ? '⚠️ LOADED' : '✅ BLOCKED/ABSENT'}`);
    console.log(`   Google Analytics: ${trackerCheck.ga ? '⚠️ LOADED' : '✅ BLOCKED/ABSENT'}`);

    console.log('\\n' + '='.repeat(50));

} catch (error) {
    console.error('Error:', error.message);
} finally {
    if (driver) {
        await driver.quit();
    }
}
