import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const screenshotPath = process.argv[2] || '/Users/jonathankingston/cursor-artifacts/act-test-page-macOS.png';

// Clean up any existing sessions
try {
    const resp = await fetch(`${serverUrl}/sessions`);
    if (resp.ok) {
        const data = await resp.json();
        const sessions = data.value || (Array.isArray(data) ? data : []);
        for (const session of sessions) {
            const id = session.id || session.sessionId || session;
            await fetch(`${serverUrl}/session/${id}`, { method: 'DELETE' }).catch(() => {});
        }
        if (sessions.length > 0) await new Promise(r => setTimeout(r, 500));
    }
} catch (e) { /* ignore */ }

let driver;
try {
    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities({ browserName: 'duckduckgo' })
        .build();

    // Navigate to the ACT test server page
    await driver.get('http://127.0.0.1:8443/');
    await new Promise(r => setTimeout(r, 3000)); // Wait for page to load

    const title = await driver.getTitle();
    console.log('Page title:', title);

    // Take screenshot
    const screenshot = await driver.takeScreenshot();
    writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
    console.log('Screenshot saved to:', screenshotPath);

    // Now navigate to /protected to trigger the 401 challenge
    await driver.get('http://127.0.0.1:8443/protected');
    await new Promise(r => setTimeout(r, 3000));

    const protectedTitle = await driver.getTitle();
    console.log('Protected page title:', protectedTitle);

    // Take screenshot of the protected page result
    const screenshot2 = await driver.takeScreenshot();
    const protectedPath = screenshotPath.replace('.png', '-protected.png');
    writeFileSync(protectedPath, Buffer.from(screenshot2, 'base64'));
    console.log('Protected page screenshot saved to:', protectedPath);

    // Navigate to the test page from test-pages
    // This page tests whether the browser handled the challenge transparently
    // Try the local test-pages server if running, otherwise use the ACT server page
    await driver.get('http://127.0.0.1:8443/');
    await new Promise(r => setTimeout(r, 2000));

    // Get final server status
    const statusResp = await fetch('http://127.0.0.1:8443/status');
    const status = await statusResp.json();
    console.log('Server status:', JSON.stringify(status));

} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
} finally {
    if (driver) {
        // Keep the browser open for visual verification
        console.log('Browser open. Taking final screenshot...');
    }
}
