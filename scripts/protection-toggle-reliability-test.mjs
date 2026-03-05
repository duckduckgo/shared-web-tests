#!/usr/bin/env node
/**
 * Protection Toggle Reliability Test
 * 
 * Tests Content Blocker consistency across multiple browser loads.
 * Validates there's no race condition in Content Blocker rule compilation.
 * 
 * IMPORTANT ARCHITECTURAL NOTE:
 * - `unprotectedTemporary` only disables INJECTED SCRIPT protections (fingerprinting, GPC, etc.)
 * - Safari Content Blocker operates INDEPENDENTLY and blocks tracker domains regardless
 * - This test verifies Content Blocker consistency, not unprotectedTemporary behavior
 * 
 * Test flow:
 * 1. Spin up browser N times, optionally alternating between:
 *    - Protected mode (default config - trackers SHOULD be blocked by Content Blocker)
 *    - Unprotected mode (custom config with unprotectedTemporary - trackers STILL blocked by Content Blocker)
 * 2. Navigate to https://www.publisher-company.site/product.html?p=12
 * 3. Probe tracker URLs via XHR to verify Content Blocker blocking is active
 * 4. Report consistency across all runs (detect race conditions)
 * 
 * Usage:
 *   node scripts/protection-toggle-reliability-test.mjs [options]
 * 
 * Options:
 *   --iterations=N       Number of test iterations (default: 10)
 *   --verbose            Show detailed output
 *   --protected-only     Only test protected mode (recommended for Content Blocker testing)
 *   --unprotected-only   Only test with unprotectedTemporary config
 *   --parallel=N         Run N sessions in parallel (default: 1)
 * 
 * Environment:
 *   PLATFORM=macos|ios   Target platform (default: macos)
 *   WEBDRIVER_URL        WebDriver server URL (default: http://localhost:4444)
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : defaultValue;
};

const ITERATIONS = parseInt(getArg('iterations', '10'), 10);
const VERBOSE = args.includes('--verbose');
const PROTECTED_ONLY = args.includes('--protected-only');
const UNPROTECTED_ONLY = args.includes('--unprotected-only');
const PARALLEL = parseInt(getArg('parallel', '1'), 10);

const TEST_URL = 'https://www.publisher-company.site/product.html?p=12';
const WEBDRIVER_URL = process.env.WEBDRIVER_URL || 'http://localhost:4444';
const PLATFORM = process.env.PLATFORM || 'macos';

// Unprotected config path (has publisher-company.site in unprotectedTemporary)
const UNPROTECTED_CONFIG_PATH = path.resolve(__dirname, '../test-configs/nintendo-unprotected-full.json');

// Tracker URLs to probe - these are the ones the test page loads
const PAGE_TRACKERS = [
    'https://convert.ad-company.site/convert.js',
    'https://www.ad-company.site/track.js'
];

// Additional common trackers for comprehensive testing
const COMMON_TRACKERS = [
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtm.js'
];

const ALL_TRACKERS = [...PAGE_TRACKERS, ...COMMON_TRACKERS];

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

function verbose(...args) {
    if (VERBOSE) console.log(`  [verbose]`, ...args);
}

/**
 * Probe tracker URLs to determine blocking status
 * @param {selenium.WebDriver} driver 
 * @returns {Promise<{blocked: string[], allowed: string[], errors: string[]}>}
 */
async function probeTrackers(driver) {
    const results = { blocked: [], allowed: [], errors: [] };
    
    for (const url of ALL_TRACKERS) {
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
            if (result && result.status === 'allowed') {
                results.allowed.push(url);
            } else {
                results.blocked.push(url);
            }
        } catch (e) {
            results.errors.push(url);
        }
    }
    
    return results;
}

/**
 * Run a single test iteration
 * @param {number} iteration - Iteration number
 * @param {boolean} useProtected - Whether to use protected mode
 * @returns {Promise<{success: boolean, mode: string, blockedCount: number, allowedCount: number, duration: number, error?: string}>}
 */
async function runIteration(iteration, useProtected) {
    const mode = useProtected ? 'protected' : 'unprotected';
    const startTime = Date.now();
    
    verbose(`Iteration ${iteration}: Starting ${mode} mode test`);
    
    // Ensure no stale sessions exist
    await ensureCleanSession();
    
    const capabilities = { browserName: 'duckduckgo' };
    
    // Add custom config path for unprotected mode
    if (!useProtected) {
        capabilities['ddg:privacyConfigPath'] = UNPROTECTED_CONFIG_PATH;
    }
    
    let driver;
    let result;
    
    try {
        driver = await new selenium.Builder()
            .usingServer(WEBDRIVER_URL)
            .withCapabilities(capabilities)
            .build();
        
        verbose(`  Session created in ${Date.now() - startTime}ms`);
        
        // Navigate to test page
        await driver.get(TEST_URL);
        await driver.sleep(2000); // Allow page to fully load
        
        verbose(`  Page loaded: ${await driver.getCurrentUrl()}`);
        
        // Probe trackers
        const probeResults = await probeTrackers(driver);
        
        const duration = Date.now() - startTime;
        
        // Determine if the result matches expectations
        const blockedCount = probeResults.blocked.length;
        const allowedCount = probeResults.allowed.length;
        
        // Expected behavior:
        // - Protected mode: ALL trackers should be blocked (blockedCount == total, allowedCount == 0)
        // - Unprotected mode: ALL trackers should be allowed (blockedCount == 0, allowedCount == total)
        
        let success;
        let expectation;
        
        // Content Blocker should ALWAYS block trackers regardless of unprotectedTemporary
        // (unprotectedTemporary only affects injected script protections, not Content Blocker)
        success = blockedCount === ALL_TRACKERS.length && allowedCount === 0;
        expectation = `Expected ALL blocked (${ALL_TRACKERS.length}), got blocked=${blockedCount}, allowed=${allowedCount}`;
        
        if (!useProtected && !success) {
            // This is actually expected - unprotectedTemporary doesn't disable Content Blocker
            verbose(`  Note: unprotectedTemporary doesn't disable Content Blocker (expected behavior)`);
        }
        
        verbose(`  Result: ${success ? 'PASS' : 'FAIL'} - ${expectation}`);
        
        result = {
            iteration,
            success,
            mode,
            blockedCount,
            allowedCount,
            duration,
            error: success ? undefined : expectation,
            details: probeResults
        };
        
    } catch (e) {
        result = {
            iteration,
            success: false,
            mode,
            blockedCount: 0,
            allowedCount: 0,
            duration: Date.now() - startTime,
            error: e.message
        };
    }
    
    // Cleanup: always run this after try/catch
    if (driver) {
        try {
            await driver.quit();
        } catch {}
    }
    
    // Force kill the DuckDuckGo app to ensure clean state for next iteration
    try {
        execSync('pkill -9 -f "DuckDuckGo.app" 2>/dev/null || true', { timeout: 5000 });
    } catch {}
    
    // The DDG WebDriver only supports one session - must restart the server
    verbose(`  Restarting WebDriver for next iteration...`);
    await restartWebDriver();
    
    return result;
}

/**
 * Restart the WebDriver server to allow a new session
 */
async function restartWebDriver() {
    try {
        // Kill existing WebDriver
        execSync('pkill -9 -f ddgdriver 2>/dev/null || true', { timeout: 5000 });
    } catch {}
    
    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Start new WebDriver in background
    const { spawn } = await import('node:child_process');
    const scriptPath = path.resolve(__dirname, '../scripts/apple-webdriver.sh');
    
    const child = spawn('bash', [scriptPath, 'driver', 'macos'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            DERIVED_DATA_PATH: path.resolve(__dirname, '../../apple-browsers/DerivedData'),
            MACOS_APP_PATH: path.resolve(__dirname, '../../apple-browsers/DerivedData/Build/Products/Debug/DuckDuckGo.app'),
            TARGET_PLATFORM: 'macos'
        }
    });
    child.unref();
    
    // Wait for WebDriver to be ready
    for (let i = 0; i < 30; i++) {
        try {
            const response = await fetch(`${WEBDRIVER_URL}/status`);
            if (response.ok) {
                verbose(`  WebDriver ready after ${i + 1} attempts`);
                return;
            }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('WebDriver failed to start');
}

/**
 * Ensure WebDriver has no active sessions and app is closed
 */
async function ensureCleanSession() {
    try {
        // First, try to delete any existing sessions via WebDriver API
        const response = await fetch(`${WEBDRIVER_URL}/sessions`);
        const data = await response.json();
        const sessions = data.value || [];
        
        for (const session of sessions) {
            verbose(`  Cleaning up stale session: ${session.id}`);
            try {
                await fetch(`${WEBDRIVER_URL}/session/${session.id}`, { method: 'DELETE' });
            } catch {}
        }
        
        // Kill the DuckDuckGo app to ensure clean state
        try {
            execSync('osascript -e \'tell application "DuckDuckGo" to quit\' 2>/dev/null', { timeout: 5000 });
        } catch {}
        
        // Wait for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {}
}

/**
 * Run all test iterations
 */
async function runTests() {
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🧪 Protection Toggle Reliability Test');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('');
    log(`Configuration:`);
    log(`  Platform:            ${PLATFORM}`);
    log(`  WebDriver URL:       ${WEBDRIVER_URL}`);
    log(`  Test URL:            ${TEST_URL}`);
    log(`  Iterations:          ${ITERATIONS}`);
    log(`  Mode:                ${PROTECTED_ONLY ? 'protected only' : UNPROTECTED_ONLY ? 'unprotected only' : 'alternating'}`);
    log(`  Parallel sessions:   ${PARALLEL}`);
    log(`  Unprotected config:  ${UNPROTECTED_CONFIG_PATH}`);
    log('');
    log(`Tracker URLs to probe: ${ALL_TRACKERS.length}`);
    ALL_TRACKERS.forEach(url => log(`  - ${url}`));
    log('');
    
    // Verify config file exists
    if (!PROTECTED_ONLY && !fs.existsSync(UNPROTECTED_CONFIG_PATH)) {
        log(`❌ ERROR: Unprotected config file not found: ${UNPROTECTED_CONFIG_PATH}`);
        process.exit(1);
    }
    
    const results = [];
    const startTime = Date.now();
    
    // Generate test plan
    const testPlan = [];
    for (let i = 0; i < ITERATIONS; i++) {
        if (PROTECTED_ONLY) {
            testPlan.push({ iteration: i + 1, protected: true });
        } else if (UNPROTECTED_ONLY) {
            testPlan.push({ iteration: i + 1, protected: false });
        } else {
            // Alternate between protected and unprotected
            testPlan.push({ iteration: i + 1, protected: i % 2 === 0 });
        }
    }
    
    log(`Running ${testPlan.length} iterations...`);
    log('');
    
    // Run tests (sequentially or in parallel)
    if (PARALLEL > 1) {
        // Parallel execution
        for (let i = 0; i < testPlan.length; i += PARALLEL) {
            const batch = testPlan.slice(i, i + PARALLEL);
            const batchPromises = batch.map(t => runIteration(t.iteration, t.protected));
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            // Log batch progress
            batchResults.forEach(r => {
                const icon = r.success ? '✓' : '✗';
                const modeIcon = r.mode === 'protected' ? '🛡️' : '🔓';
                log(`  ${icon} Iteration ${r.iteration} ${modeIcon} ${r.mode}: blocked=${r.blockedCount}, allowed=${r.allowedCount}, ${r.duration}ms`);
            });
        }
    } else {
        // Sequential execution
        for (const test of testPlan) {
            const result = await runIteration(test.iteration, test.protected);
            results.push(result);
            
            const icon = result.success ? '✓' : '✗';
            const modeIcon = result.mode === 'protected' ? '🛡️' : '🔓';
            log(`  ${icon} Iteration ${result.iteration} ${modeIcon} ${result.mode}: blocked=${result.blockedCount}, allowed=${result.allowedCount}, ${result.duration}ms`);
            
            if (!result.success && result.error) {
                log(`    ⚠️ ${result.error}`);
            }
        }
    }
    
    const totalDuration = Date.now() - startTime;
    
    // Analyze results
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📊 RESULTS SUMMARY');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('');
    
    const protectedResults = results.filter(r => r.mode === 'protected');
    const unprotectedResults = results.filter(r => r.mode === 'unprotected');
    
    const protectedPass = protectedResults.filter(r => r.success).length;
    const protectedFail = protectedResults.filter(r => !r.success).length;
    const unprotectedPass = unprotectedResults.filter(r => r.success).length;
    const unprotectedFail = unprotectedResults.filter(r => !r.success).length;
    
    const totalPass = results.filter(r => r.success).length;
    const totalFail = results.filter(r => !r.success).length;
    
    if (protectedResults.length > 0) {
        const protectedRate = ((protectedPass / protectedResults.length) * 100).toFixed(1);
        log(`🛡️ Protected Mode:`);
        log(`   Pass: ${protectedPass}/${protectedResults.length} (${protectedRate}%)`);
        log(`   Fail: ${protectedFail}/${protectedResults.length}`);
        log(`   Avg duration: ${Math.round(protectedResults.reduce((sum, r) => sum + r.duration, 0) / protectedResults.length)}ms`);
        log('');
    }
    
    if (unprotectedResults.length > 0) {
        const unprotectedRate = ((unprotectedPass / unprotectedResults.length) * 100).toFixed(1);
        log(`🔓 Unprotected Mode:`);
        log(`   Pass: ${unprotectedPass}/${unprotectedResults.length} (${unprotectedRate}%)`);
        log(`   Fail: ${unprotectedFail}/${unprotectedResults.length}`);
        log(`   Avg duration: ${Math.round(unprotectedResults.reduce((sum, r) => sum + r.duration, 0) / unprotectedResults.length)}ms`);
        log('');
    }
    
    const overallRate = ((totalPass / results.length) * 100).toFixed(1);
    log(`📈 Overall:`);
    log(`   Pass: ${totalPass}/${results.length} (${overallRate}%)`);
    log(`   Fail: ${totalFail}/${results.length}`);
    log(`   Total duration: ${Math.round(totalDuration / 1000)}s`);
    log('');
    
    // Race condition analysis
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔍 RACE CONDITION ANALYSIS');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('');
    
    // Check for inconsistencies within same mode
    const protectedConsistent = protectedResults.every(r => 
        r.blockedCount === protectedResults[0]?.blockedCount && 
        r.allowedCount === protectedResults[0]?.allowedCount
    );
    const unprotectedConsistent = unprotectedResults.every(r => 
        r.blockedCount === unprotectedResults[0]?.blockedCount && 
        r.allowedCount === unprotectedResults[0]?.allowedCount
    );
    
    if (protectedResults.length > 0) {
        if (protectedConsistent && protectedFail === 0) {
            log(`✅ Protected mode: CONSISTENT - All ${protectedResults.length} iterations identical`);
        } else if (protectedConsistent) {
            log(`⚠️ Protected mode: CONSISTENT but FAILING - All identical but wrong behavior`);
        } else {
            log(`❌ Protected mode: INCONSISTENT - Race condition detected!`);
            const blockedCounts = [...new Set(protectedResults.map(r => r.blockedCount))];
            const allowedCounts = [...new Set(protectedResults.map(r => r.allowedCount))];
            log(`   Blocked counts seen: ${blockedCounts.join(', ')}`);
            log(`   Allowed counts seen: ${allowedCounts.join(', ')}`);
        }
    }
    
    if (unprotectedResults.length > 0) {
        if (unprotectedConsistent && unprotectedFail === 0) {
            log(`✅ Unprotected mode: CONSISTENT - All ${unprotectedResults.length} iterations identical`);
        } else if (unprotectedConsistent) {
            log(`⚠️ Unprotected mode: CONSISTENT but FAILING - All identical but wrong behavior`);
        } else {
            log(`❌ Unprotected mode: INCONSISTENT - Race condition detected!`);
            const blockedCounts = [...new Set(unprotectedResults.map(r => r.blockedCount))];
            const allowedCounts = [...new Set(unprotectedResults.map(r => r.allowedCount))];
            log(`   Blocked counts seen: ${blockedCounts.join(', ')}`);
            log(`   Allowed counts seen: ${allowedCounts.join(', ')}`);
        }
    }
    
    log('');
    
    // Final verdict
    const noRaceCondition = (protectedConsistent || protectedResults.length === 0) && 
                           (unprotectedConsistent || unprotectedResults.length === 0);
    const allPassing = totalFail === 0;
    
    if (allPassing && noRaceCondition) {
        log('✅ VERDICT: No race condition detected - Configuration switching is reliable');
    } else if (noRaceCondition && !allPassing) {
        log('⚠️ VERDICT: Consistent but incorrect behavior - Check config or Content Blocker readiness');
    } else {
        log('❌ VERDICT: Race condition detected - Results vary between identical configurations');
    }
    
    log('');
    
    // Save detailed results
    const resultsDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    const resultsFile = path.join(resultsDir, `protection-toggle-test-${Date.now()}.json`);
    const reportData = {
        timestamp: new Date().toISOString(),
        platform: PLATFORM,
        testUrl: TEST_URL,
        iterations: ITERATIONS,
        mode: PROTECTED_ONLY ? 'protected-only' : UNPROTECTED_ONLY ? 'unprotected-only' : 'alternating',
        totalDuration,
        summary: {
            protected: { pass: protectedPass, fail: protectedFail, total: protectedResults.length, consistent: protectedConsistent },
            unprotected: { pass: unprotectedPass, fail: unprotectedFail, total: unprotectedResults.length, consistent: unprotectedConsistent },
            overall: { pass: totalPass, fail: totalFail, total: results.length }
        },
        raceConditionDetected: !noRaceCondition,
        allPassing,
        results
    };
    
    fs.writeFileSync(resultsFile, JSON.stringify(reportData, null, 2));
    log(`Results saved to: ${resultsFile}`);
    
    // Exit with appropriate code
    return allPassing && noRaceCondition ? 0 : 1;
}

// Run the tests
runTests()
    .then(exitCode => process.exit(exitCode))
    .catch(e => {
        console.error('Test failed with error:', e);
        process.exit(1);
    });
