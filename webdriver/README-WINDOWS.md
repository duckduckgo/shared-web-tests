# Windows WebDriver Support for DuckDuckGo Browser

This document describes the Windows platform support added to `ddgdriver`.

## Overview

The `ddgdriver` now supports both macOS (iOS Simulator) and Windows platforms:

| Platform | Browser Control | Communication |
|----------|-----------------|---------------|
| macOS/iOS | `xcrun simctl` | HTTP server in app |
| Windows | Process spawn | Chrome DevTools Protocol (CDP) |

## Prerequisites

### Windows

1. **Rust toolchain**: Install via [rustup](https://rustup.rs/)
   ```powershell
   winget install Rustlang.Rustup
   ```

2. **DuckDuckGo Windows Browser**: DEBUG build with `DDG_WEBVIEW_DEBUG_PORT` support

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DDG_BROWSER_PATH` | Path to DuckDuckGo.exe | `DuckDuckGo.exe` (in PATH) |

## Building

```bash
cd webdriver
cargo build --release
```

The binary will be at `target/release/ddgdriver.exe` (Windows) or `target/release/ddgdriver` (macOS).

## Usage

### Running WPT Tests

```bash
# Start the WPT server (from shared-web-tests root)
npm start

# Run tests with ddgdriver
./wpt run --product duckduckgo --binary path/to/ddgdriver.exe --log-mach - duckduckgo
```

### Direct WebDriver Usage

```bash
# Start the WebDriver server
ddgdriver.exe --port 4444

# Use any WebDriver client to connect
# Example with curl:
curl -X POST http://localhost:4444/session \
  -H "Content-Type: application/json" \
  -d '{"capabilities": {}}'
```

### Puppeteer (Direct CDP - No WebDriver)

For direct Puppeteer usage without WebDriver:

```javascript
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');

// Launch browser with debug port
const browser = spawn('DuckDuckGo.exe', [], {
    env: { ...process.env, DDG_WEBVIEW_DEBUG_PORT: '9222' }
});

// Wait for browser to start
await new Promise(r => setTimeout(r, 3000));

// Connect Puppeteer
const page = await puppeteer.connect({
    browserURL: 'http://localhost:9222'
});

// Use normally
await page.goto('https://example.com');
const title = await page.title();
console.log(title);
```

## Architecture

### Windows Implementation

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│  WPT/Test   │────▶│  ddgdriver  │────▶│  DuckDuckGo.exe  │
│   Runner    │     │  (WebDriver)│     │  (WebView2)      │
└─────────────┘     └──────┬──────┘     └────────┬─────────┘
                          │                      │
                          │ CDP WebSocket        │ --remote-debugging-port
                          └──────────────────────┘
```

### Key Files

- `src/windows.rs` - Windows session management, process lifecycle
- `src/cdp.rs` - Chrome DevTools Protocol client
- `src/handler.rs` - Platform-specific WebDriver command handlers

### Supported WebDriver Commands

| Command | Status |
|---------|--------|
| New Session | ✅ |
| Delete Session | ✅ |
| Navigate (Get) | ✅ |
| Execute Script | ✅ |
| Execute Async Script | ✅ |
| Find Element | ✅ |
| Element Click | ✅ |
| Get Current URL | ✅ |
| Get Window Handle | ✅ |
| Get Window Handles | ✅ |
| New Window | ✅ |
| Close Window | ✅ |
| Switch to Window | ⚠️ Partial |

## Debugging

Enable verbose logging:

```bash
RUST_LOG=debug ddgdriver.exe --port 4444
```

Logs are written to `output.log` in the current directory.

## Known Limitations

1. **DEBUG builds only**: Windows browser must be built in DEBUG mode to expose `DDG_WEBVIEW_DEBUG_PORT`
2. **Single session**: Currently optimized for single concurrent session
3. **Window switching**: Limited support for multiple windows/tabs

## Contributing

When adding new WebDriver commands, implement them in both:
- `#[cfg(windows)]` block in `handler.rs`
- `#[cfg(target_os = "macos")]` block in `handler.rs`

