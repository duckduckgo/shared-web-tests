import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const configPath = process.argv[2];
console.log(`Using config: ${configPath || 'default (no test config)'}`);

const capabilities = { browserName: 'duckduckgo' };
if (configPath) {
    capabilities['ddg:privacyConfigPath'] = configPath;
}

const driver = await new selenium.Builder()
    .usingServer('http://localhost:4444')
    .withCapabilities(capabilities)
    .build();

console.log('Session started');
await driver.get('https://www.nintendo.com/us/');
await driver.sleep(3000);
console.log('Navigated to Nintendo');

// Test each URL individually using synchronous XHR (since async doesn't work well with our driver)
const urlsToTest = [
    'https://logx.optimizely.com/v1/events',
    'https://cdn.optimizely.com/js/test.js', 
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtm.js',
    'https://connect.facebook.net/en_US/fbevents.js'
];

const results = { blocked: [], allowed: [], errors: [], url: '' };

// Get current page URL
results.url = await driver.executeScript('return location.href');

// Test each URL
for (const url of urlsToTest) {
    const testScript = `
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('HEAD', '${url}', false); // synchronous
            xhr.timeout = 3000;
            xhr.send();
            return { status: 'allowed', code: xhr.status };
        } catch (e) {
            return { status: 'blocked', error: e.message };
        }
    `;
    
    try {
        const result = await driver.executeScript(testScript);
        if (result.status === 'allowed') {
            results.allowed.push({ url, httpStatus: result.code });
        } else {
            results.blocked.push({ url, error: result.error });
        }
    } catch (e) {
        results.errors.push({ url, error: e.message });
    }
}

console.log('\n🛡️ Content Blocker Probe Results:');
console.log(`   Page: ${results.url}`);

if (results.blocked.length > 0) {
    console.log(`\n   ❌ BLOCKED (${results.blocked.length}):`);
    results.blocked.forEach(r => console.log(`      - ${r.url}`));
}

if (results.allowed.length > 0) {
    console.log(`\n   ✅ ALLOWED (${results.allowed.length}):`);
    results.allowed.forEach(r => console.log(`      - ${r.url}`));
}

if (results.errors.length > 0) {
    console.log(`\n   ⚠️ ERRORS (${results.errors.length}):`);
    results.errors.forEach(r => console.log(`      - ${r.url}: ${r.error}`));
}

await driver.quit();
console.log('\nDone');
