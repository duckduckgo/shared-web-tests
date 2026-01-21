#!/usr/bin/env node
/**
 * Unified WebDriver Test Runner
 * 
 * Composes npm scripts: cleanup → driver:macos → driver:wait → test → cleanup
 * 
 * Usage:
 *   node scripts/test-runner.mjs                    # Run search-company test
 *   node scripts/test-runner.mjs --check            # Check environment only (no test)
 *   node scripts/test-runner.mjs --script my-test   # Run custom test script
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const verbose = args.includes('--verbose') || args.includes('-v');
const noKeep = args.includes('--no-keep');
const keep = args.includes('--keep');
const scriptArg = args.find((_, i, arr) => arr[i - 1] === '--script');
const testScript = scriptArg || 'search-company-flow.mjs';

const DRIVER_PORT = 4444;

// ============ Utility Functions ============

function log(msg, ...rest) {
    console.log(`[runner] ${msg}`, ...rest);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function npmRun(script, options = {}) {
    const { silent = false, background = false } = options;
    const stdio = silent ? 'ignore' : (verbose ? 'inherit' : 'pipe');
    
    if (background) {
        const child = spawn('npm', ['run', script], {
            cwd: rootDir,
            stdio: 'ignore',
            detached: true,
            env: { ...process.env, TARGET_PLATFORM: 'macos' }
        });
        child.unref();
        return { status: 0 };
    }
    
    const result = spawnSync('npm', ['run', script], {
        cwd: rootDir,
        stdio,
        env: { ...process.env, TARGET_PLATFORM: 'macos' }
    });
    return result;
}

async function isDriverReady() {
    try {
        const response = await fetch(`http://localhost:${DRIVER_PORT}/status`, { 
            signal: AbortSignal.timeout(1000) 
        });
        return response.ok;
    } catch {
        return false;
    }
}

function isProcessRunning(pattern) {
    try {
        const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
        return result.status === 0;
    } catch {
        return false;
    }
}

// ============ Environment Checks ============

async function checkEnvironment() {
    const status = {
        driverRunning: false,
        driverPort: DRIVER_PORT,
        appRunning: false,
        driverBinaryExists: false,
        macosAppExists: false,
    };

    // Check driver binary
    const driverBinary = join(rootDir, 'webdriver/target/debug/ddgdriver');
    status.driverBinaryExists = existsSync(driverBinary);

    // Check macOS app (DerivedData is the default build output location)
    const appleBrowsersDir = join(rootDir, '../apple-browsers');
    const derivedDataPath = process.env.DERIVED_DATA_PATH || join(appleBrowsersDir, 'DerivedData');
    const macosAppPath = join(derivedDataPath, 'Build/Products/Debug/DuckDuckGo.app');
    status.macosAppExists = existsSync(macosAppPath);

    // Check driver port
    status.driverRunning = await isDriverReady();

    // Check app process
    status.appRunning = isProcessRunning('DuckDuckGo.app');

    return status;
}

function printStatus(status) {
    console.log('\n📋 Environment Status:');
    console.log(`   Driver binary: ${status.driverBinaryExists ? '✅ exists' : '❌ missing (run: npm run build-rust)'}`);
    console.log(`   macOS app:     ${status.macosAppExists ? '✅ exists' : '❌ missing (run: npm run build:macos)'}`);
    console.log(`   Driver (4444): ${status.driverRunning ? '✅ running' : '⚪ not running'}`);
    console.log(`   DuckDuckGo:    ${status.appRunning ? '✅ running' : '⚪ not running'}`);
    console.log('');
}

// ============ Main ============

async function main() {
    console.log('\n🔧 WebDriver Test Runner\n');

    // Always check environment first
    const status = await checkEnvironment();
    
    if (checkOnly) {
        printStatus(status);
        
        if (!status.driverBinaryExists || !status.macosAppExists) {
            console.log('⚠️  Missing prerequisites. Build with:');
            if (!status.driverBinaryExists) console.log('   npm run build-rust');
            if (!status.macosAppExists) console.log('   npm run build:macos');
            process.exit(1);
        }
        
        process.exit(0);
    }

    // Check prerequisites
    if (!status.driverBinaryExists) {
        log('❌ Driver binary not found. Run: npm run build-rust');
        process.exit(1);
    }
    if (!status.macosAppExists) {
        log('❌ macOS app not found. Run: npm run build:macos');
        process.exit(1);
    }

    // Step 1: Cleanup any existing state
    log('Running driver:cleanup...');
    npmRun('driver:cleanup', { silent: !verbose });

    await sleep(500);

    // Step 2: Start driver in background
    log('Starting driver:macos...');
    npmRun('driver:macos', { background: true });

    // Step 3: Wait for driver to be ready
    log('Running driver:wait...');
    const waitResult = npmRun('driver:wait', { silent: !verbose });
    if (waitResult.status !== 0) {
        log('❌ Driver failed to start');
        npmRun('driver:kill', { silent: true });
        process.exit(1);
    }
    log('Driver ready!');

    // Step 4: Run test
    const testScriptPath = join(rootDir, 'scripts', testScript);
    if (!existsSync(testScriptPath)) {
        log(`❌ Test script not found: ${testScriptPath}`);
        npmRun('driver:cleanup', { silent: true });
        process.exit(1);
    }

    log(`Running test: ${testScript}`);
    const testArgs = [];
    if (noKeep) testArgs.push('--no-keep');
    else if (!keep) testArgs.push('--no-keep'); // Default to --no-keep for automation
    
    const testResult = spawnSync('node', [testScriptPath, ...testArgs], {
        cwd: rootDir,
        stdio: 'inherit',
        env: { ...process.env, PLATFORM: 'macos' }
    });

    // Step 5: Cleanup after test
    await sleep(500);
    npmRun('driver:cleanup', { silent: true });

    if (testResult.status === 0) {
        console.log('\n✅ Test completed successfully\n');
        process.exit(0);
    } else {
        console.log('\n❌ Test failed\n');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
