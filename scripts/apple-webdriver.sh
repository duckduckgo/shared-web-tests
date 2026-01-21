#!/bin/bash
set -e

# Apple WebDriver setup and run script (iOS & macOS)
# Usage:
#   ./scripts/apple-webdriver.sh build [ios|macos] [path]     - Build the app (default: ios, ../apple-browsers)
#   ./scripts/apple-webdriver.sh driver [ios|macos] [path]   - Start ddgdriver (run in separate terminal)
#   ./scripts/apple-webdriver.sh example [--keep] [url]      - Run the example test (--keep keeps browser open)
#   ./scripts/apple-webdriver.sh test [ios|macos]            - Run the full test suite

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_WEB_TESTS_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$SHARED_WEB_TESTS_DIR")"

# Default apple-browsers path, can be overridden via argument or env var
APPLE_BROWSERS_DIR="${APPLE_BROWSERS_DIR:-$REPO_ROOT/apple-browsers}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$APPLE_BROWSERS_DIR/DerivedData}"

export DERIVED_DATA_PATH

# Detect platform from first argument if it's ios/macos, otherwise default to ios
detect_platform() {
    local first_arg="$1"
    if [ "$first_arg" = "ios" ] || [ "$first_arg" = "macos" ]; then
        echo "$first_arg"
        return 0
    fi
    # Always default to ios
    echo "ios"
}

case "${1:-help}" in
    build)
        PLATFORM=$(detect_platform "$2")
        # Allow path override as third argument (or second if platform not specified)
        if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "macos" ]; then
            if [ -n "$3" ]; then
                APPLE_BROWSERS_DIR="$(cd "$3" && pwd)"
                DERIVED_DATA_PATH="$APPLE_BROWSERS_DIR/DerivedData"
                export DERIVED_DATA_PATH
            fi
        else
            # Platform not specified, second arg is path
            if [ -n "$2" ]; then
                APPLE_BROWSERS_DIR="$(cd "$2" && pwd)"
                DERIVED_DATA_PATH="$APPLE_BROWSERS_DIR/DerivedData"
                export DERIVED_DATA_PATH
                PLATFORM="ios"  # Default
            fi
        fi
        
        if [ ! -d "$APPLE_BROWSERS_DIR/.maestro" ]; then
            echo "❌ Error: Cannot find .maestro in $APPLE_BROWSERS_DIR"
            echo "   Specify path: $0 build $PLATFORM /path/to/apple-browsers"
            exit 1
        fi
        
        # Build the WebDriver binary first (needed for both platforms)
        echo "⏲️ Building WebDriver binary..."
        cd "$SHARED_WEB_TESTS_DIR/webdriver"
        if ! cargo build; then
            echo "❌ Error: Failed to build WebDriver binary"
            exit 1
        fi
        echo "✅ WebDriver binary built"
        
        echo "Building $PLATFORM app from: $APPLE_BROWSERS_DIR"
        cd "$APPLE_BROWSERS_DIR"
        
        if [ "$PLATFORM" = "macos" ]; then
            # Build macOS app
            echo "⏲️ Building macOS app"
            set -o pipefail && xcodebuild -project macOS/DuckDuckGo-macOS.xcodeproj \
                                          -scheme "macOS Browser" \
                                          -derivedDataPath "$DERIVED_DATA_PATH" \
                                          -skipPackagePluginValidation \
                                          -skipMacroValidation \
                                          ONLY_ACTIVE_ARCH=NO | tee xcodebuild.log
            if [ $? -ne 0 ]; then
                echo "‼️ Unable to build macOS app into $DERIVED_DATA_PATH"
                exit 1
            fi
            APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug/DuckDuckGo.app"
            echo "✅ macOS app built at: $APP_PATH"
        else
            # Build iOS app
            # shellcheck source=/dev/null
            source .maestro/common.sh
            build_app 1
            APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/DuckDuckGo.app"
            echo "✅ iOS app built at: $APP_PATH"
        fi
        ;;

    driver)
        PLATFORM=$(detect_platform "$2")
        # Allow derived data path override
        if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "macos" ]; then
            if [ -n "$3" ]; then
                DERIVED_DATA_PATH="$(cd "$3" && pwd)"
                export DERIVED_DATA_PATH
            fi
        else
            # Platform not specified, second arg is path
            if [ -n "$2" ]; then
                DERIVED_DATA_PATH="$(cd "$2" && pwd)"
                export DERIVED_DATA_PATH
            fi
            PLATFORM="ios"  # Default
        fi
        
        if [ "$PLATFORM" = "macos" ]; then
            APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug/DuckDuckGo.app"
            if [ ! -d "$APP_PATH" ]; then
                echo "❌ Error: macOS app not found at $APP_PATH"
                echo "   Run '$0 build macos' first, or specify path: $0 driver macos /path/to/DerivedData"
                exit 1
            fi
            # Set environment variables for macOS
            export MACOS_APP_PATH="$APP_PATH"
            export TARGET_PLATFORM="macos"
        else
            # Clear macOS-specific vars for iOS
            unset MACOS_APP_PATH
            unset TARGET_PLATFORM
            APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/DuckDuckGo.app"
            if [ ! -d "$APP_PATH" ]; then
                echo "❌ Error: iOS app not found at $APP_PATH"
                echo "   Run '$0 build ios' first, or specify path: $0 driver ios /path/to/DerivedData"
                exit 1
            fi
        fi
        
        echo "Starting ddgdriver on port 4444 for $PLATFORM..."
        echo "DERIVED_DATA_PATH=$DERIVED_DATA_PATH"
        if [ "$PLATFORM" = "macos" ]; then
            export MACOS_APP_PATH="$APP_PATH"
            export TARGET_PLATFORM="macos"
            echo "MACOS_APP_PATH=$MACOS_APP_PATH"
            echo "TARGET_PLATFORM=$TARGET_PLATFORM"
        else
            # Explicitly unset for iOS to avoid confusion
            unset TARGET_PLATFORM
            unset MACOS_APP_PATH
        fi
        cd "$SHARED_WEB_TESTS_DIR/webdriver"
        
        # Build if needed
        if [ ! -f "target/debug/ddgdriver" ]; then
            echo "Building ddgdriver..."
            cargo build
        else
            # Check if binary needs rebuild (if source files are newer)
            if [ "webdriver/src/handler.rs" -nt "target/debug/ddgdriver" ] 2>/dev/null; then
                echo "⚠️  ddgdriver source files are newer than binary. Rebuilding..."
                cargo build
            fi
        fi
        
        # Verify environment variables are set before starting
        if [ "$PLATFORM" = "macos" ]; then
            echo "Verifying environment before starting driver..."
            echo "  TARGET_PLATFORM=${TARGET_PLATFORM:-<not set>}"
            echo "  MACOS_APP_PATH=${MACOS_APP_PATH:-<not set>}"
            if [ -z "$TARGET_PLATFORM" ] || [ "$TARGET_PLATFORM" != "macos" ]; then
                echo "❌ Error: TARGET_PLATFORM not set correctly!"
                exit 1
            fi
        fi
        
        # Explicitly pass environment variables to the ddgdriver process
        # Use env to ensure they're passed through, and print them for debugging
        if [ "$PLATFORM" = "macos" ]; then
            echo "Launching ddgdriver with environment:"
            echo "  TARGET_PLATFORM=$TARGET_PLATFORM"
            echo "  MACOS_APP_PATH=$MACOS_APP_PATH"
            echo "  DERIVED_DATA_PATH=$DERIVED_DATA_PATH"
            # Verify the variables are actually set
            if [ -z "$TARGET_PLATFORM" ] || [ "$TARGET_PLATFORM" != "macos" ]; then
                echo "❌ Error: TARGET_PLATFORM is not set to 'macos'!"
                exit 1
            fi
            # Use exec env to replace the shell process and ensure env vars are passed
            exec env TARGET_PLATFORM="$TARGET_PLATFORM" \
                MACOS_APP_PATH="$MACOS_APP_PATH" \
                DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
                ./target/debug/ddgdriver --port 4444
        else
            # For iOS, make sure TARGET_PLATFORM is not set
            exec env -u TARGET_PLATFORM \
                -u MACOS_APP_PATH \
                DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
                ./target/debug/ddgdriver --port 4444
        fi
        ;;

    example)
        shift
        PLATFORM=$(detect_platform "$1")
        # If first arg is a platform, shift it out
        if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "macos" ]; then
            shift
        fi
        echo "Running webdriver example for $PLATFORM..."
        if [ -z "$1" ] || [ "$1" != "ios" ] && [ "$1" != "macos" ]; then
            echo "⚠️  Note: Defaulting to iOS. Make sure you started the driver with: $0 driver $PLATFORM"
        else
            echo "⚠️  Note: Make sure you started the driver with: $0 driver $PLATFORM"
        fi
        echo ""
        cd "$SHARED_WEB_TESTS_DIR"
        PLATFORM="$PLATFORM" TARGET_PLATFORM="$PLATFORM" node scripts/selenium-navigate-example.mjs "$@"
        ;;

    test)
        PLATFORM=$(detect_platform "$2")
        echo "Running full test suite for $PLATFORM..."
        cd "$SHARED_WEB_TESTS_DIR"
        
        if [ "$PLATFORM" = "macos" ]; then
            # Find macOS app if not set
            if [ -z "$MACOS_APP_PATH" ]; then
                MACOS_APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug/DuckDuckGo.app"
                if [ ! -d "$MACOS_APP_PATH" ]; then
                    echo "❌ Error: macOS app not found at $MACOS_APP_PATH"
                    echo "   Run '$0 build macos' first"
                    exit 1
                fi
            fi
            export MACOS_APP_PATH
            export TARGET_PLATFORM="macos"
            source build/_venv3/bin/activate 2>/dev/null || true
            TARGET_PLATFORM=macos ./build/wpt run --product duckduckgo --binary webdriver/target/debug/ddgdriver --log-mach - --log-mach-level info duckduckgo
        else
            npm run test
        fi
        ;;

    help|*)
        echo "Apple WebDriver Setup Script (iOS & macOS)"
        echo ""
        echo "Usage: $0 <command> [platform] [options]"
        echo ""
        echo "Commands:"
        echo "  build [ios|macos] [path]     Build the app (default: ios, ../apple-browsers)"
        echo "  driver [ios|macos] [path]    Start ddgdriver server (run in separate terminal)"
        echo "  example [ios|macos] [options] Run the example Selenium test (default: ios)"
        echo "  test [ios|macos]             Run the full WPT test suite"
        echo ""
        echo "Platform:"
        echo "  ios                          iOS Simulator (default)"
        echo "  macos                        macOS app"
        echo ""
        echo "Example options:"
        echo "  --keep                       Keep browser open after test (default behavior)"
        echo "  --no-keep                    Close browser automatically after test"
        echo "  <url>                        Navigate to specific URL (default: https://example.com)"
        echo ""
        echo "Environment variables:"
        echo "  APPLE_BROWSERS_DIR           Path to apple-browsers repo"
        echo "  DERIVED_DATA_PATH            Path to DerivedData containing built app"
        echo "  MACOS_APP_PATH               Path to macOS app (for macos platform)"
        echo "  TARGET_PLATFORM              Target platform (ios or macos)"
        echo "  PLATFORM                     Platform override (ios or macos)"
        echo ""
        echo "Quick start (iOS):"
        echo "  1. $0 build ios                    # Build iOS app"
        echo "  2. $0 driver ios                   # Terminal 1: Start driver"
        echo "  3. $0 example                      # Terminal 2: Run test"
        echo ""
        echo "Quick start (macOS):"
        echo "  1. $0 build macos                  # Build macOS app"
        echo "  2. $0 driver macos                  # Terminal 1: Start driver"
        echo "  3. $0 example                      # Terminal 2: Run test"
        echo ""
        echo "Examples:"
        echo "  $0 example ios --keep               # iOS: Keep browser open"
        echo "  $0 example macos https://ddg.gg    # macOS: Test specific URL"
        echo "  $0 example macos https://ddg.gg --keep  # macOS: Test URL and keep open"
        ;;
esac
