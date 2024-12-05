from appium import webdriver

# Set up desired capabilities
desired_caps = {
    'platformName': 'iOS',
    'deviceName': 'YourDeviceName',
    'appPackage': 'com.example.app',  # Replace with your app's package name
    'appActivity': 'com.example.app.MainActivity',  # Replace with your app's main activity
    # Other capabilities...
}

# Initialize the driver
driver = webdriver.Remote('http://localhost:4723/wd/hub', desired_caps)

try:
    # Locate the UI element containing the app state
    state_element = driver.find_element_by_id('com.example.app:id/stateTextView')  # Replace with the actual ID

    # Retrieve the text
    app_state = state_element.text

    # Output the state to the CLI
    print(f"App State: {app_state}")

finally:
    # Quit the driver
    driver.quit()
