pub mod ios;
pub mod windows;

/// Actions a platform must support for WebDriver session lifecycle and browser control.
pub trait Platform: Send {
    /// Create a new browser session, returning a session identifier.
    fn new_session(&mut self) -> Result<String, String>;

    /// Tear down the browser session.
    fn delete_session(&mut self, session_id: &str) -> Result<(), String>;

    /// Navigate the browser to `url`.
    fn navigate(&self, session_id: &str, url: &str) -> Result<(), String>;

    /// Execute a synchronous JavaScript snippet, returning the result as a string.
    fn execute_script(
        &self,
        session_id: &str,
        script: &str,
        args: &str,
    ) -> Result<String, String>;

    /// Execute an asynchronous JavaScript snippet, returning the result as a string.
    fn execute_async_script(
        &self,
        session_id: &str,
        script: &str,
        args: &str,
    ) -> Result<String, String>;

    /// Find an element using the given locator strategy and value, returning an element reference.
    fn find_element(
        &self,
        session_id: &str,
        script: &str,
        args: &str,
    ) -> Result<String, String>;

    /// Click an element identified by `element_id`.
    fn click_element(&self, session_id: &str, element_id: &str) -> Result<(), String>;

    /// Open a new window/tab, returning `(handle, type)`.
    fn new_window(&self, session_id: &str) -> Result<(String, String), String>;

    /// Close the current window, returning remaining window handles.
    fn close_window(&self, session_id: &str) -> Result<Vec<String>, String>;

    /// Switch to the window identified by `handle`.
    fn switch_to_window(&self, session_id: &str, handle: &str) -> Result<(), String>;

    /// Return the current window handle.
    fn get_window_handle(&self, session_id: &str) -> Result<String, String>;

    /// Return all window handles.
    fn get_window_handles(&self, session_id: &str) -> Result<Vec<String>, String>;

    /// Return the URL of the current page.
    fn get_current_url(&self, session_id: &str) -> Result<String, String>;
}

pub fn detect_platform() -> Box<dyn Platform> {
    if let Ok(platform) = std::env::var("PLATFORM") {
        match platform.to_lowercase().as_str() {
            "windows" => {
                info!("Detected platform: Windows");
                return Box::new(windows::WindowsPlatform::new());
            }
            "ios" => {
                info!("Detected platform: iOS");
                return Box::new(ios::IosPlatform::new());
            }
            other => {
                info!("Unknown PLATFORM={}, defaulting to iOS", other);
            }
        }
    } else {
        info!("PLATFORM not set, defaulting to iOS");
    }
    Box::new(ios::IosPlatform::new())
}
