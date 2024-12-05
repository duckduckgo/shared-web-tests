xcode-select --install
sudo xcodebuild -license accept
# Check if Homebrew is installed
if test ! $(which brew); then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Check node is installed
if test ! $(which node); then
    echo "Installing Node..."
    brew install node
fi
npm install -g appium
appium -v
# Carthage is required to build dependencies for WebDriverAgent, which Appium uses for iOS automation.
brew install carthage
# https://github.com/appium/WebDriverAgent
# cd $(npm root -g)/appium/node_modules/appium-webdriveragent
# mkdir -p Resources/WebDriverAgent.bundle
# ./Scripts/bootstrap.sh -d

 open $(npm root -g)/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj
# . Set Up Signing for Targets
# In Xcode:
#
#    Select the WebDriverAgentRunner target.
#    Go to the Signing & Capabilities tab.
#    Choose your Team from the dropdown (your Apple Developer account).
#    Ensure Automatically manage signing is checked.
#    Repeat these steps for the WebDriverAgentLib and WebDriverAgent targets.

let target_device="iPhone-16";
let target_os="iOS-18-1";

xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'platform=iOS Simulator,name=<simulator_name>' test

export IPHONEOS_DEPLOYMENT_TARGET=12.0

xcodebuild -project $(npm root -g)/appium/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'platform=iOS Simulator,name=iPhone-16 iOS-18-1 (maestro),id=C8BFF642-7B00-4E86-A57A-9139DA74E276' test