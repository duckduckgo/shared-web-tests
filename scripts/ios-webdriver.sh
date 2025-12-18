#!/bin/bash
set -e

# iOS WebDriver setup and run script
# Usage:
#   ./scripts/ios-webdriver.sh build [path]     - Build the iOS app (default: ../apple-browsers)
#   ./scripts/ios-webdriver.sh driver [path]    - Start ddgdriver (run in separate terminal)
#   ./scripts/ios-webdriver.sh example [--keep] - Run the example test (--keep keeps browser open)
#   ./scripts/ios-webdriver.sh test             - Run the full test suite

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_WEB_TESTS_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$SHARED_WEB_TESTS_DIR")"

# Default apple-browsers path, can be overridden via argument or env var
APPLE_BROWSERS_DIR="${APPLE_BROWSERS_DIR:-$REPO_ROOT/apple-browsers}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$APPLE_BROWSERS_DIR/DerivedData}"

export DERIVED_DATA_PATH

case "${1:-help}" in
    build)
        # Allow path override as second argument
        if [ -n "$2" ]; then
            APPLE_BROWSERS_DIR="$(cd "$2" && pwd)"
            DERIVED_DATA_PATH="$APPLE_BROWSERS_DIR/DerivedData"
            export DERIVED_DATA_PATH
        fi
        
        if [ ! -d "$APPLE_BROWSERS_DIR/.maestro" ]; then
            echo "❌ Error: Cannot find .maestro in $APPLE_BROWSERS_DIR"
            echo "   Specify path: $0 build /path/to/apple-browsers"
            exit 1
        fi
        
        echo "Building iOS app from: $APPLE_BROWSERS_DIR"
        cd "$APPLE_BROWSERS_DIR"
        # shellcheck source=/dev/null
        source .maestro/common.sh
        build_app 1
        echo "✅ iOS app built at: $DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/DuckDuckGo.app"
        ;;

    driver)
        # Allow derived data path override as second argument
        if [ -n "$2" ]; then
            DERIVED_DATA_PATH="$(cd "$2" && pwd)"
            export DERIVED_DATA_PATH
        fi
        
        APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/DuckDuckGo.app"
        if [ ! -d "$APP_PATH" ]; then
            echo "❌ Error: App not found at $APP_PATH"
            echo "   Run '$0 build' first, or specify path: $0 driver /path/to/DerivedData"
            exit 1
        fi
        
        echo "Starting ddgdriver on port 4444..."
        echo "DERIVED_DATA_PATH=$DERIVED_DATA_PATH"
        cd "$SHARED_WEB_TESTS_DIR/webdriver"
        
        # Build if needed
        if [ ! -f "target/debug/ddgdriver" ]; then
            echo "Building ddgdriver..."
            cargo build
        fi
        
        ./target/debug/ddgdriver --port 4444
        ;;

    example)
        shift
        echo "Running webdriver example..."
        cd "$SHARED_WEB_TESTS_DIR"
        node scripts/selenium-navigate-example.mjs "$@"
        ;;

    test)
        echo "Running full test suite..."
        cd "$SHARED_WEB_TESTS_DIR"
        npm run test
        ;;

    help|*)
        echo "iOS WebDriver Setup Script"
        echo ""
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  build [path]        Build the iOS app (default: ../apple-browsers)"
        echo "  driver              Start ddgdriver server (run in separate terminal)"
        echo "  example [options]   Run the example Selenium test"
        echo "  test                Run the full WPT test suite"
        echo ""
        echo "Example options:"
        echo "  --keep              Keep browser open after test"
        echo "  <url>               Navigate to specific URL (default: https://example.com)"
        echo ""
        echo "Environment variables:"
        echo "  APPLE_BROWSERS_DIR  Path to apple-browsers repo"
        echo "  DERIVED_DATA_PATH   Path to DerivedData containing built app"
        echo ""
        echo "Quick start:"
        echo "  1. $0 build                    # Build iOS app"
        echo "  2. $0 driver                   # Terminal 1: Start driver"
        echo "  3. $0 example                  # Terminal 2: Run test"
        echo "  4. $0 example --keep           # Keep browser open"
        echo "  5. $0 example https://ddg.gg   # Test specific URL"
        ;;
esac

