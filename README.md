# Shared Web Tests

This repository contains a set of utils to test web applications.
This repo consumes web-platform-tests and exposes it as a simple platform that can be consumed by other projects.
We repackage a few tests and rebuild the manifest.

## Test format

## Running the test server

To start the example test server run the following command:

```bash
npm start
```

We only use the subset of tests that support the web runner: https://wpt-docs.readthedocs.io/en/latest/_running-tests/from-web.html

## Expected integration

```mermaid
graph TD
    SWT[shared-web-tests]
    W[web-platform-tests]
    CSS[content-scope-scripts]
    P[privacy-test-pages]
    I[iOS]
    %% M[MacOS]
    BSK[BrowserServicesKit]
    %% A[Android]


    %% Win[Windows]
    %% Win -- sub module --> CSS
    %% Win -- sub module --> P

    SWT -- depends on via sub module --> W
    CSS -- npm module --> SWT
    BSK -- swift module --> CSS
    %% M -- swift module --> BSK


    %% A -- npm module --> P
    %% A -- npm module --> CSS
    P --  npm module --> SWT
    I -- npm module --> P
    %%M -- npm module --> P
    I -- swift module --> BSK
    %% CSS -- npm module (for manual testing) --> P
    %% P -- sub module --> W
```

## Setting up the host file

https://web-platform-tests.org/running-tests/from-local-system.html#hosts-file-setup

## Setting up the cert

The certificate is generated and used by the test server to serve the tests over https.

See more details: https://web-platform-tests.org/tools/certs/README.html

The client will need to import this root ca to be able to trust the server.

For Apple devices this can be done by running the following command:

```bash
xcrun simctl keychain booted add-root-cert  path/to/shared-web-tests/web-platform-tests/tools/certs/cacert.pem
```

Getting logs from the emulator:

```bash
xcrun simctl spawn booted log show --last 900m --info --debug --predicate 'subsystem == "com.duckduckgo.mobile.ios"' --style compact
```

## iOS WebDriver Testing

### Quick Start

```bash
# Terminal 1: Build the iOS app (first time or after code changes)
npm run ios:build

# Terminal 1: Start the WebDriver server
npm run ios:driver

# Terminal 2: Run the example test
npm run ios:example

# Or run the full test suite
npm run ios:test
```

### Options

```bash
# Build from a different apple-browsers location
./scripts/ios-webdriver.sh build /path/to/apple-browsers

# Keep the browser open after test completes
./scripts/ios-webdriver.sh example --keep

# Navigate to a specific URL
./scripts/ios-webdriver.sh example https://duckduckgo.com

# Combine options
./scripts/ios-webdriver.sh example https://duckduckgo.com --keep
```

### Environment Variables

- `APPLE_BROWSERS_DIR` - Path to apple-browsers repo (default: `../apple-browsers`)
- `DERIVED_DATA_PATH` - Path to DerivedData containing the built app

### Manual Steps (if needed)

Building the iOS app:

```bash
cd ../apple-browsers
source .maestro/common.sh && build_app 1
```

The app will be built to `apple-browsers/DerivedData/Build/Products/Debug-iphonesimulator/DuckDuckGo.app`

Building the WebDriver:

```bash
cd webdriver
cargo build
```

Starting the driver manually:

```bash
cd webdriver
DERIVED_DATA_PATH="../../apple-browsers/DerivedData" ./target/debug/ddgdriver --port 4444
```

Running the example test manually:

```bash
DERIVED_DATA_PATH="../apple-browsers/DerivedData" npm run webdriver:example
```

Running the full suite:

```bash
./wpt run --product duckduckgo --binary webdriver/target/debug/ddgdriver --log-mach - --log-mach-level info duckduckgo
```
