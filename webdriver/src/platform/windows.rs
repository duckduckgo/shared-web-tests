use super::Platform;
use std::env;
use std::process::{Child, Command};

pub struct WindowsPlatform {
    browser_process: Option<Child>,
    browser_path: Option<String>,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        WindowsPlatform {
            browser_process: None,
            browser_path: None,
        }
    }

    fn resolve_browser_path(&self) -> Result<String, String> {
        if let Ok(path) = env::var("BROWSER_PATH") {
            return Ok(path);
        }

        let candidates = [
            "windows-browser/WindowsBrowser/bin/x64/Debug/DuckDuckGo.exe",
            "windows-browser/WindowsBrowser/bin/Debug/net8.0-windows/DuckDuckGo.exe",
            "../windows-browser/WindowsBrowser/bin/x64/Debug/DuckDuckGo.exe",
        ];

        let cwd = env::current_dir().unwrap_or_default();
        for candidate in &candidates {
            let full = cwd.join(candidate);
            if full.exists() {
                return Ok(full.to_string_lossy().to_string());
            }
        }

        Err(
            "Could not find Windows browser executable. Set BROWSER_PATH or build with `dotnet build`."
                .to_string(),
        )
    }
}

impl Platform for WindowsPlatform {
    fn new_session(&mut self) -> Result<String, String> {
        let browser_path = self.resolve_browser_path()?;
        info!("Launching Windows browser: {}", browser_path);

        let child = Command::new(&browser_path)
            .spawn()
            .map_err(|e| format!("Failed to launch Windows browser: {}", e))?;

        let session_id = format!("windows-{}", child.id());
        info!("Windows browser launched with PID {}", child.id());

        self.browser_path = Some(browser_path);
        self.browser_process = Some(child);

        Ok(session_id)
    }

    fn delete_session(&mut self, session_id: &str) -> Result<(), String> {
        info!("Deleting Windows session {:?}", session_id);
        if let Some(mut child) = self.browser_process.take() {
            let _ = child.kill();
            let _ = child.wait();
            info!("Windows browser process terminated");
        }
        Ok(())
    }

    fn navigate(&self, session_id: &str, url: &str) -> Result<(), String> {
        info!(
            "Windows navigate not yet supported (session={}, url={})",
            session_id, url
        );
        Err("Navigation requires an automation server which is not yet available on Windows".into())
    }

    fn execute_script(
        &self,
        session_id: &str,
        _script: &str,
        _args: &str,
    ) -> Result<String, String> {
        info!(
            "Windows execute_script not yet supported (session={})",
            session_id
        );
        Err("Script execution requires an automation server which is not yet available on Windows"
            .into())
    }

    fn execute_async_script(
        &self,
        session_id: &str,
        _script: &str,
        _args: &str,
    ) -> Result<String, String> {
        info!(
            "Windows execute_async_script not yet supported (session={})",
            session_id
        );
        Err("Async script execution requires an automation server which is not yet available on Windows".into())
    }

    fn find_element(
        &self,
        session_id: &str,
        _script: &str,
        _args: &str,
    ) -> Result<String, String> {
        info!(
            "Windows find_element not yet supported (session={})",
            session_id
        );
        Err(
            "FindElement requires an automation server which is not yet available on Windows".into(),
        )
    }

    fn click_element(&self, session_id: &str, _element_id: &str) -> Result<(), String> {
        info!(
            "Windows click_element not yet supported (session={})",
            session_id
        );
        Err("ElementClick requires an automation server which is not yet available on Windows"
            .into())
    }

    fn new_window(&self, session_id: &str) -> Result<(String, String), String> {
        info!(
            "Windows new_window not yet supported (session={})",
            session_id
        );
        Err("NewWindow requires an automation server which is not yet available on Windows".into())
    }

    fn close_window(&self, session_id: &str) -> Result<Vec<String>, String> {
        info!(
            "Windows close_window not yet supported (session={})",
            session_id
        );
        Err(
            "CloseWindow requires an automation server which is not yet available on Windows"
                .into(),
        )
    }

    fn switch_to_window(&self, session_id: &str, _handle: &str) -> Result<(), String> {
        info!(
            "Windows switch_to_window not yet supported (session={})",
            session_id
        );
        Err("SwitchToWindow requires an automation server which is not yet available on Windows"
            .into())
    }

    fn get_window_handle(&self, session_id: &str) -> Result<String, String> {
        info!(
            "Windows get_window_handle not yet supported (session={})",
            session_id
        );
        Err("GetWindowHandle requires an automation server which is not yet available on Windows"
            .into())
    }

    fn get_window_handles(&self, session_id: &str) -> Result<Vec<String>, String> {
        info!(
            "Windows get_window_handles not yet supported (session={})",
            session_id
        );
        Err(
            "GetWindowHandles requires an automation server which is not yet available on Windows"
                .into(),
        )
    }

    fn get_current_url(&self, session_id: &str) -> Result<String, String> {
        info!(
            "Windows get_current_url not yet supported (session={})",
            session_id
        );
        Err(
            "GetCurrentUrl requires an automation server which is not yet available on Windows"
                .into(),
        )
    }
}
