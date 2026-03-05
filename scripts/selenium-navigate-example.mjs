import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep') || !args.includes('--no-keep'); // Default to keeping open unless --no-keep is specified
const url = args.find((arg) => !arg.startsWith('--')) ?? 'https://example.com';

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const expectedPlatform = process.env.PLATFORM || process.env.TARGET_PLATFORM;

// Helper to clean up any existing sessions
async function cleanupExistingSessions() {
    try {
        // Try to get list of sessions (WebDriver standard endpoint)
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            // Handle both standard WebDriver format and custom format
            const sessions = data.value || (Array.isArray(data) ? data : []);
            if (Array.isArray(sessions) && sessions.length > 0) {
                console.log(`Found ${sessions.length} existing session(s), cleaning up...`);
                for (const session of sessions) {
                    try {
                        const sessionId = session.id || session.sessionId || session;
                        await fetch(`${serverUrl}/session/${sessionId}`, { method: 'DELETE' });
                        console.log(`  Deleted session: ${sessionId}`);
                    } catch (e) {
                        // Ignore errors during cleanup
                    }
                }
                // Give the server a moment to clean up
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
    } catch (e) {
        // Server might not be running or might not support /sessions endpoint
        // That's okay, we'll try to create a session anyway
    }
}

// Clean up any existing sessions before creating a new one
await cleanupExistingSessions();

let driver;
try {
    driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

    // Try to detect platform by checking if we can access automation server directly
    // (macOS automation server runs on port 8788, iOS uses simulator logs)
    if (expectedPlatform === 'macos') {
        try {
            const automationCheck = await fetch('http://localhost:8788/getUrl');
            if (!automationCheck.ok) {
                console.warn('⚠️  Warning: Expected macOS but automation server (port 8788) is not responding.');
                console.warn('   Make sure you ran: npm run driver:macos');
            }
        } catch (e) {
            console.warn('⚠️  Warning: Expected macOS but automation server (port 8788) is not accessible.');
            console.warn('   Make sure you ran: npm run driver:macos (not driver:ios)');
        }
    }

    await driver.get(url);
    const title = await driver.getTitle();
    console.log(JSON.stringify({ ok: true, url, title }));

    if (keepOpen) {
        console.log('\n✅ Browser will stay open. Press Ctrl+C to quit.');
        // Keep the process alive
        await new Promise(() => {});
    } else {
        console.log('\n⚠️  Browser will close automatically. Use --keep to keep it open.');
    }
} catch (error) {
    console.error('Error:', error.message);
    if (error.message.includes('Session is already started') || error.message.includes('SessionNotCreatedError')) {
        console.error('\n💡 Tip: There may be an existing session. Try one of these:');
        console.error('   Option 1 - Restart the driver:');
        console.error('     1. Stop the WebDriver server (Ctrl+C in the driver terminal)');
        console.error('     2. Restart it with: npm run driver:macos (or driver:ios)');
        console.error('     3. Run this command again');
        console.error('');
        console.error('   Option 2 - Use the existing session:');
        console.error('     If a browser is already open from a previous test,');
        console.error('     you can interact with it directly via the automation server:');
        console.error('     curl "http://localhost:8788/getUrl"');
        console.error('     curl "http://localhost:8788/navigate?url=https://example.com"');
    }
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch (e) {
            // Ignore errors during quit
        }
    }
}
