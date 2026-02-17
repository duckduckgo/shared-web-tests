use serde_json::Value;

use crate::ios;
use crate::macos;

// Platform configuration
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    IOS,
    MacOS,
}

impl Platform {
    pub(crate) fn from_env() -> Self {
        let env_value = std::env::var("TARGET_PLATFORM");
        info!("TARGET_PLATFORM env var: {:?}", env_value);
        match env_value.as_deref() {
            Ok("macos") | Ok("macOS") | Ok("mac") => {
                info!("Detected macOS platform");
                Platform::MacOS
            },
            Ok(val) => {
                info!("TARGET_PLATFORM={} not recognized, defaulting to iOS", val);
                Platform::IOS
            },
            Err(_) => {
                info!("TARGET_PLATFORM not set, defaulting to iOS");
                Platform::IOS // Default to iOS for backward compatibility
            }
        }
    }

    pub(crate) fn bundle_id(&self) -> &'static str {
        match self {
            Platform::IOS => ios::BUNDLE_ID,
            Platform::MacOS => macos::BUNDLE_ID,
        }
    }
}

/// DuckDuckGo-specific session capabilities
#[derive(Clone, Debug, Default)]
pub(crate) struct DdgCapabilities {
    /// Custom URL for privacy configuration (overrides bundled config via cache write)
    pub privacy_config_url: Option<String>,
    /// Local file path for privacy configuration (uses TEST_PRIVACY_CONFIG_PATH env var)
    pub privacy_config_path: Option<String>,
}

impl DdgCapabilities {
    /// Parse DuckDuckGo capabilities from WebDriver NewSession parameters
    pub(crate) fn from_new_session_params(params: &webdriver::command::NewSessionParameters) -> Self {
        let mut caps = DdgCapabilities::default();

        // NewSessionParameters is an enum, try multiple serialization approaches
        if let Ok(value) = serde_json::to_value(params) {
            info!("Serialized NewSessionParameters: {}", value);

            // Approach 1: Direct capabilities.alwaysMatch (Spec variant)
            if let Some(capabilities) = value.get("capabilities") {
                if let Some(always_match) = capabilities.get("alwaysMatch") {
                    caps.extract_from_value(always_match);
                }
                if let Some(first_match) = capabilities.get("firstMatch").and_then(|v| v.as_array()) {
                    for match_caps in first_match {
                        caps.extract_from_value(match_caps);
                    }
                }
            }

            // Approach 2: Spec enum variant wrapper { "Spec": { "alwaysMatch": ... } }
            if caps.privacy_config_url.is_none() {
                if let Some(spec) = value.get("Spec") {
                    if let Some(always_match) = spec.get("alwaysMatch") {
                        caps.extract_from_value(always_match);
                    }
                    if let Some(first_match) = spec.get("firstMatch").and_then(|v| v.as_array()) {
                        for match_caps in first_match {
                            caps.extract_from_value(match_caps);
                        }
                    }
                }
            }

            // Approach 3: Direct alwaysMatch at root level
            if caps.privacy_config_url.is_none() {
                if let Some(always_match) = value.get("alwaysMatch") {
                    caps.extract_from_value(always_match);
                }
            }
        } else {
            info!("Failed to serialize NewSessionParameters to JSON");
        }

        info!("Parsed DuckDuckGo capabilities: {:?}", caps);
        caps
    }

    fn extract_from_value(&mut self, caps: &Value) {
        // Look for ddg:privacyConfigURL (writes to cache)
        if let Some(url) = caps.get("ddg:privacyConfigURL").and_then(|v| v.as_str()) {
            info!("Found ddg:privacyConfigURL: {}", url);
            self.privacy_config_url = Some(url.to_string());
        }
        // Look for ddg:privacyConfigPath (uses TEST_PRIVACY_CONFIG_PATH env var)
        if let Some(path) = caps.get("ddg:privacyConfigPath").and_then(|v| v.as_str()) {
            info!("Found ddg:privacyConfigPath: {}", path);
            self.privacy_config_path = Some(path.to_string());
        }
    }
}

/// Fetch privacy configuration from URL (supports http://, https://, and file://)
/// Used by both macOS and iOS privacy config setup.
pub(crate) fn fetch_privacy_config(config_url: &str) -> Result<Vec<u8>, String> {
    info!("Fetching privacy config from: {}", config_url);

    if config_url.starts_with("file://") {
        // Handle local file paths
        let file_path = config_url.strip_prefix("file://").unwrap();
        match std::fs::read(file_path) {
            Ok(data) => {
                info!("Read {} bytes from local file", data.len());
                Ok(data)
            },
            Err(e) => Err(format!("Failed to read file {}: {}", file_path, e))
        }
    } else {
        // Handle HTTP/HTTPS URLs
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let response = client.get(config_url)
            .send()
            .map_err(|e| format!("Failed to fetch config: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }

        let data = response.bytes()
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        info!("Fetched {} bytes from URL", data.len());
        Ok(data.to_vec())
    }
}
