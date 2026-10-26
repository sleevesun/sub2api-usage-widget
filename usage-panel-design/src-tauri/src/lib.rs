use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::{
    env, fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

const DEFAULT_REFRESH_MINUTES: u64 = 10;
const USAGE_HISTORY_DAYS: u8 = 28;
const KEYRING_SERVICE: &str = "com.sub2api.usage-widget";
const API_KEYRING_USER: &str = "api-key";
const CUSTOM_BASE_URL_FILE: &str = "sub2api-base-url.txt";
const SHOW_ORB_MENU_ID: &str = "show-orb";
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn tray_menu_item_ids() -> [&'static str; 4] {
    ["show", SHOW_ORB_MENU_ID, "refresh", "quit"]
}

#[derive(Clone)]
struct ProviderConfig {
    base_url: String,
    provider_name: String,
}

#[derive(Clone)]
struct Credentials {
    api_key: String,
    base_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageEnvelope {
    usage: JsonValue,
    fetched_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceInfo {
    auth_found: bool,
    config_found: bool,
    key_configured: bool,
    codex_key_configured: bool,
    custom_key_configured: bool,
    custom_base_url_configured: bool,
    key_source: String,
    base_url: Option<String>,
    provider_name: Option<String>,
    refresh_minutes: u64,
    notifications_enabled: bool,
}

struct UsageState {
    snapshot: RwLock<Option<UsageEnvelope>>,
    last_error: RwLock<Option<String>>,
    refresh_minutes: AtomicU64,
    notifications_enabled: AtomicBool,
    low_balance_notified: AtomicBool,
}

impl Default for UsageState {
    fn default() -> Self {
        Self {
            snapshot: RwLock::new(None),
            last_error: RwLock::new(None),
            refresh_minutes: AtomicU64::new(DEFAULT_REFRESH_MINUTES),
            notifications_enabled: AtomicBool::new(false),
            low_balance_notified: AtomicBool::new(false),
        }
    }
}

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("CODEX_HOME") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }

    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "无法确定用户主目录".to_string())
}

fn validate_base_url(value: String) -> Result<String, String> {
    let base_url = value.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Sub2API 地址不能为空".to_string());
    }
    if base_url.len() > 2048 {
        return Err("Sub2API 地址长度超过限制".to_string());
    }

    let parsed = reqwest::Url::parse(&base_url)
        .map_err(|_| "Sub2API 地址必须是完整的 http:// 或 https:// 地址".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Sub2API 地址必须是完整的 http:// 或 https:// 地址".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Sub2API 地址不能包含查询参数或片段".to_string());
    }

    Ok(base_url)
}

fn normalize_optional_base_url(value: Option<String>) -> Result<Option<String>, String> {
    match value {
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => validate_base_url(value).map(Some),
        None => Ok(None),
    }
}

fn effective_base_url(
    custom_base_url: Option<String>,
    provider_base_url: Option<String>,
) -> Option<String> {
    custom_base_url.or(provider_base_url)
}

fn usage_url(base_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| "Sub2API 地址必须是完整的 http:// 或 https:// 地址".to_string())?;
    let path = url.path().trim_end_matches('/');
    let usage_path = if path == "/v1" || path.ends_with("/v1") {
        format!("{path}/usage")
    } else {
        format!("{path}/v1/usage")
    };
    url.set_path(&usage_path);
    let query = format!("days={USAGE_HISTORY_DAYS}&timezone=Asia%2FShanghai");
    url.set_query(Some(&query));
    Ok(url.to_string())
}

fn valid_usage_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(index, value)| index == 4 || index == 7 || value.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: usize = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) { return false; }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day >= 1 && day <= lengths[month - 1]
}

fn validate_model_usage_period(start_date: &str, end_date: &str) -> Result<(), String> {
    if !valid_usage_date(start_date) || !valid_usage_date(end_date) || start_date > end_date {
        return Err("模型消费的日期范围无效".to_string());
    }
    Ok(())
}

fn model_usage_url(base_url: &str, start_date: &str, end_date: &str) -> Result<reqwest::Url, String> {
    validate_model_usage_period(start_date, end_date)?;
    let mut url = reqwest::Url::parse(&usage_url(base_url)?).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("start_date", start_date).append_pair("end_date", end_date);
    Ok(url)
}

fn read_provider_config() -> Result<ProviderConfig, String> {
    let home = codex_home()?;
    let config_path = home.join("config.toml");
    let config_text = fs::read_to_string(&config_path)
        .map_err(|_| format!("未找到 {}", config_path.display()))?;
    let config: toml::Value =
        toml::from_str(&config_text).map_err(|_| "config.toml 不是有效的 TOML".to_string())?;
    let provider_name = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .unwrap_or("OpenAI")
        .to_string();
    let provider = config
        .get("model_providers")
        .and_then(|providers| providers.get(&provider_name))
        .ok_or_else(|| format!("config.toml 中没有模型供应商 {provider_name}"))?;
    let base_url = provider
        .get("base_url")
        .and_then(toml::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("模型供应商 {provider_name} 没有 base_url"))?;

    let base_url = validate_base_url(base_url)?;

    Ok(ProviderConfig {
        base_url,
        provider_name,
    })
}

fn custom_base_url_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CUSTOM_BASE_URL_FILE))
        .map_err(|error| format!("无法确定应用配置目录: {error}"))
}

fn read_custom_base_url(app: &AppHandle) -> Result<Option<String>, String> {
    let path = custom_base_url_path(app)?;
    match fs::read_to_string(&path) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => validate_base_url(value).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 Sub2API 地址配置: {error}")),
    }
}

fn save_custom_base_url(app: &AppHandle, base_url: &str) -> Result<(), String> {
    let path = custom_base_url_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建应用配置目录: {error}"))?;
    }
    fs::write(path, base_url).map_err(|error| format!("无法保存 Sub2API 地址: {error}"))
}

fn clear_custom_base_url(app: &AppHandle) -> Result<(), String> {
    let path = custom_base_url_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法移除自定义 Sub2API 地址: {error}")),
    }
}

fn read_codex_api_key() -> Result<String, String> {
    let auth_path = codex_home()?.join("auth.json");
    let auth_text =
        fs::read_to_string(&auth_path).map_err(|_| format!("未找到 {}", auth_path.display()))?;
    let auth: JsonValue =
        serde_json::from_str(&auth_text).map_err(|_| "auth.json 不是有效的 JSON".to_string())?;
    auth.get("OPENAI_API_KEY")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "auth.json 中没有 OPENAI_API_KEY".to_string())
}

fn keyring_entry(user: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, user).map_err(|error| format!("无法访问系统凭据库: {error}"))
}

fn read_custom_api_key() -> Result<Option<String>, String> {
    let _guard = KEYRING_LOCK
        .lock()
        .map_err(|_| "系统凭据库当前不可用".to_string())?;
    match keyring_entry(API_KEYRING_USER)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据库: {error}")),
    }
}

fn save_custom_api_key(api_key: &str) -> Result<(), String> {
    let _guard = KEYRING_LOCK
        .lock()
        .map_err(|_| "系统凭据库当前不可用".to_string())?;
    keyring_entry(API_KEYRING_USER)?
        .set_password(api_key)
        .map_err(|error| format!("无法保存到系统凭据库: {error}"))
}

fn delete_custom_api_key() -> Result<(), String> {
    let _guard = KEYRING_LOCK
        .lock()
        .map_err(|_| "系统凭据库当前不可用".to_string())?;
    match keyring_entry(API_KEYRING_USER)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统凭据库移除 API Key: {error}")),
    }
}

fn resolve_base_url(app: &AppHandle) -> Result<String, String> {
    let custom_base_url = read_custom_base_url(app)?;
    if custom_base_url.is_some() {
        return effective_base_url(custom_base_url, None)
            .ok_or_else(|| "未配置 Sub2API 地址".to_string());
    }
    let provider_base_url = read_provider_config()?.base_url;
    effective_base_url(None, Some(provider_base_url))
        .ok_or_else(|| "未配置 Sub2API 地址".to_string())
}

fn read_credentials(app: &AppHandle) -> Result<Credentials, String> {
    let base_url = resolve_base_url(app)?;
    let api_key = match read_custom_api_key()? {
        Some(value) => value,
        None => read_codex_api_key()?,
    };

    Ok(Credentials { api_key, base_url })
}

fn source_info_value(app: &AppHandle, state: &UsageState) -> Result<SourceInfo, String> {
    let home = codex_home().ok();
    let auth_found = home
        .as_ref()
        .is_some_and(|path| path.join("auth.json").is_file());
    let config_found = home
        .as_ref()
        .is_some_and(|path| path.join("config.toml").is_file());
    let custom_base_url = read_custom_base_url(app)?;
    let provider = read_provider_config().ok();
    let custom_key_configured = read_custom_api_key()?.is_some();
    let codex_key_configured = read_codex_api_key().is_ok();
    let key_source = if custom_key_configured {
        "secureStore"
    } else if codex_key_configured {
        "codexAuth"
    } else {
        "none"
    };

    Ok(SourceInfo {
        auth_found,
        config_found,
        key_configured: custom_key_configured || codex_key_configured,
        codex_key_configured,
        custom_key_configured,
        custom_base_url_configured: custom_base_url.is_some(),
        key_source: key_source.to_string(),
        base_url: effective_base_url(
            custom_base_url,
            provider.as_ref().map(|value| value.base_url.clone()),
        ),
        provider_name: provider.map(|value| value.provider_name),
        refresh_minutes: state.refresh_minutes.load(Ordering::Relaxed),
        notifications_enabled: state.notifications_enabled.load(Ordering::Relaxed),
    })
}

async fn request_usage_with_credentials(credentials: Credentials) -> Result<UsageEnvelope, String> {
    let url = usage_url(&credentials.base_url)?;
    request_usage_at_url(credentials, &url).await
}

async fn request_usage_at_url(credentials: Credentials, url: &str) -> Result<UsageEnvelope, String> {
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(credentials.api_key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("无法连接 Sub2API: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Sub2API 返回 HTTP {}", response.status()));
    }

    let usage = response
        .json::<JsonValue>()
        .await
        .map_err(|_| "Sub2API 返回了无法解析的数据".to_string())?;
    let fetched_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(UsageEnvelope {
        usage,
        fetched_at_ms,
    })
}

async fn request_usage(app: &AppHandle) -> Result<UsageEnvelope, String> {
    request_usage_with_credentials(read_credentials(app)?).await
}

#[tauri::command]
async fn fetch_model_usage(app: AppHandle, start_date: String, end_date: String) -> Result<JsonValue, String> {
    validate_model_usage_period(&start_date, &end_date)?;
    let credentials = read_credentials(&app)?;
    let url = model_usage_url(&credentials.base_url, &start_date, &end_date)?;
    let snapshot = request_usage_at_url(credentials, url.as_str()).await?;
    Ok(serde_json::json!({
        "startDate": start_date,
        "endDate": end_date,
        "modelStats": snapshot.usage.get("model_stats").or_else(|| snapshot.usage.get("modelStats")),
        "dailyUsage": snapshot.usage.get("daily_usage").or_else(|| snapshot.usage.get("dailyUsage")),
        "fetchedAtMs": snapshot.fetched_at_ms,
    }))
}

fn store_snapshot(app: &AppHandle, snapshot: UsageEnvelope) -> UsageEnvelope {
    let state = app.state::<UsageState>();
    if let Ok(mut slot) = state.snapshot.write() {
        *slot = Some(snapshot.clone());
    }
    if let Ok(mut error) = state.last_error.write() {
        *error = None;
    }
    if let Some(remaining) = snapshot
        .usage
        .get("quota")
        .and_then(|quota| quota.get("remaining"))
        .and_then(JsonValue::as_f64)
    {
        if remaining > 20.0 {
            state.low_balance_notified.store(false, Ordering::Relaxed);
        } else if state.notifications_enabled.load(Ordering::Relaxed)
            && !state.low_balance_notified.swap(true, Ordering::Relaxed)
        {
            let _ = app
                .notification()
                .builder()
                .title("Sub2API 额度提醒")
                .body(format!("当前剩余额度为 ${remaining:.2}"))
                .show();
        }
    }
    let _ = app.emit("usage-updated", snapshot.clone());
    snapshot
}

async fn fetch_and_store(app: &AppHandle) -> Result<UsageEnvelope, String> {
    let state = app.state::<UsageState>();
    match request_usage(app).await {
        Ok(snapshot) => Ok(store_snapshot(app, snapshot)),
        Err(message) => {
            if let Ok(mut error) = state.last_error.write() {
                *error = Some(message.clone());
            }
            let _ = app.emit("usage-error", message.clone());
            Err(message)
        }
    }
}

fn validate_api_key(value: String) -> Result<String, String> {
    let api_key = value.trim();
    if api_key.len() < 8 {
        return Err("API Key 长度过短".to_string());
    }
    if api_key.len() > 2048 {
        return Err("API Key 长度超过限制".to_string());
    }
    if api_key.chars().any(char::is_whitespace) {
        return Err("API Key 不能包含空格或换行".to_string());
    }
    Ok(api_key.to_string())
}

#[tauri::command]
async fn set_api_key(
    app: AppHandle,
    api_key: String,
    base_url: Option<String>,
) -> Result<UsageEnvelope, String> {
    let api_key = validate_api_key(api_key)?;
    let requested_base_url = normalize_optional_base_url(base_url)?;
    let credentials = Credentials {
        api_key: api_key.clone(),
        base_url: match requested_base_url.clone() {
            Some(base_url) => base_url,
            None => resolve_base_url(&app)?,
        },
    };
    let snapshot = request_usage_with_credentials(credentials).await?;
    if let Some(base_url) = requested_base_url {
        save_custom_base_url(&app, &base_url)?;
    }
    save_custom_api_key(&api_key)?;
    Ok(store_snapshot(&app, snapshot))
}

#[tauri::command]
async fn clear_api_key_override(app: AppHandle) -> Result<UsageEnvelope, String> {
    read_codex_api_key()?;
    delete_custom_api_key()?;
    fetch_and_store(&app).await
}

#[tauri::command]
async fn refresh_usage(app: AppHandle) -> Result<UsageEnvelope, String> {
    fetch_and_store(&app).await
}

#[tauri::command]
fn set_base_url(app: AppHandle, base_url: String) -> Result<(), String> {
    match normalize_optional_base_url(Some(base_url))? {
        Some(normalized) => save_custom_base_url(&app, &normalized),
        None => clear_custom_base_url(&app),
    }
}

#[tauri::command]
fn get_cached_usage(state: tauri::State<'_, UsageState>) -> Result<Option<UsageEnvelope>, String> {
    state
        .snapshot
        .read()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "无法读取用量缓存".to_string())
}

#[tauri::command]
fn get_source_info(
    app: AppHandle,
    state: tauri::State<'_, UsageState>,
) -> Result<SourceInfo, String> {
    source_info_value(&app, &state)
}

#[tauri::command]
fn set_refresh_interval(minutes: u64, state: tauri::State<'_, UsageState>) -> Result<(), String> {
    if !(1..=1440).contains(&minutes) {
        return Err("刷新间隔必须在 1-1440 分钟之间".to_string());
    }
    state.refresh_minutes.store(minutes, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn set_notification_enabled(enabled: bool, state: tauri::State<'_, UsageState>) {
    state
        .notifications_enabled
        .store(enabled, Ordering::Relaxed);
    if !enabled {
        state.low_balance_notified.store(false, Ordering::Relaxed);
    }
}

const RADAR_API_URL: &str = "https://api.codexradar.com/api/v1/radar-bench-score";
static RADAR_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn radar_score_url(model: &str, effort: &str) -> Result<reqwest::Url, String> {
    const MODELS: [&str; 6] = [
        "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol",
        "gpt-5.6-sol", "gpt-6-luna", "gpt-5.6-luna",
    ];
    const EFFORTS: [&str; 6] = ["ultra", "max", "xhigh", "high", "medium", "low"];
    if !MODELS.contains(&model) || !EFFORTS.contains(&effort)
        || (model.ends_with("-luna") && effort == "ultra")
    {
        return Err("不支持的雷达Bench模型或思考档位".to_string());
    }
    let mut url = reqwest::Url::parse(RADAR_API_URL).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("model", model).append_pair("effort", effort);
    Ok(url)
}

#[tauri::command]
async fn fetch_radar_bench_score(model: String, effort: String) -> Result<JsonValue, String> {
    let url = radar_score_url(&model, &effort)?;
    let response = RADAR_CLIENT.get_or_init(reqwest::Client::new)
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("请求雷达Bench接口失败: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "雷达Bench接口返回 HTTP {}",
            response.status()
        ));
    }

    response
        .json::<JsonValue>()
        .await
        .map_err(|error| format!("解析雷达Bench数据失败: {error}"))
}

#[tauri::command]
fn start_window_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

fn validate_main_resize(label: &str, direction: &str) -> Result<(), String> {
    if label != "main" {
        return Err("仅允许调整主面板大小".to_string());
    }
    if ![
        "North", "South", "East", "West",
        "NorthEast", "NorthWest", "SouthEast", "SouthWest",
    ].contains(&direction) {
        return Err("无效的窗口调整方向".to_string());
    }
    Ok(())
}

#[tauri::command]
fn start_window_resize(window: tauri::Window, direction: String) -> Result<(), String> {
    validate_main_resize(window.label(), &direction)?;
    let direction = serde_json::from_value(JsonValue::String(direction))
        .map_err(|_| "无效的窗口调整方向".to_string())?;
    window.start_resize_dragging(direction).map_err(|error| error.to_string())
}

#[tauri::command]
fn move_orb_window(window: WebviewWindow, delta_x: f64, delta_y: f64) -> Result<(), String> {
    if window.label() != "orb" {
        return Err("仅允许移动 orb 窗口".to_string());
    }
    let Ok(current_pos) = window.outer_position() else {
        return Err("获取窗口位置失败".to_string());
    };
    let new_x = (current_pos.x as f64 + delta_x).round() as i32;
    let new_y = (current_pos.y as f64 + delta_y).round() as i32;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: new_x, y: new_y }))
        .map_err(|e| e.to_string())
}

fn position_near_tray(window: &WebviewWindow, cursor: PhysicalPosition<f64>) {
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };

    let monitor = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        cursor.x >= position.x as f64
            && cursor.x <= (position.x + size.width as i32) as f64
            && cursor.y >= position.y as f64
            && cursor.y <= (position.y + size.height as i32) as f64
    });

    let Some(monitor) = monitor else {
        return;
    };
    let position = tray_panel_position(cursor, window_size, *monitor.position(), *monitor.size());
    let _ = window.set_position(position);
}

fn tray_panel_position(
    cursor: PhysicalPosition<f64>,
    window_size: PhysicalSize<u32>,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let left = monitor_position.x as f64;
    let top = monitor_position.y as f64;
    let right = left + monitor_size.width as f64;
    let bottom = top + monitor_size.height as f64;
    let width = window_size.width as f64;
    let height = window_size.height as f64;
    let margin = 10.0;

    let min_x = left + margin;
    let min_y = top + margin;
    let max_x = (right - width - margin).max(min_x);
    let max_y = (bottom - height - margin).max(min_y);
    let x = (cursor.x - width + 28.0).clamp(min_x, max_x);
    let preferred_y = if cursor.y < top + monitor_size.height as f64 / 2.0 {
        cursor.y + 14.0
    } else {
        cursor.y - height - 14.0
    };
    let y = preferred_y.clamp(min_y, max_y);
    PhysicalPosition::new(x.round() as i32, y.round() as i32)
}

fn position_orb_window(window: &WebviewWindow) {
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Some(monitor) = monitors.first() else {
        return;
    };

    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let margin = 24i32;
    let x = monitor_position.x
        + (monitor_size.width as i32 - window_size.width as i32 - margin).max(margin);
    let y = monitor_position.y
        + (monitor_size.height as i32 - window_size.height as i32 - margin).max(margin);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_main_window(app: &AppHandle, cursor: Option<PhysicalPosition<f64>>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(position) = cursor {
            position_near_tray(&window, position);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_main_window_command(app: AppHandle) {
    println!("[rust][cmd] show_main_window_command");
    show_main_window(&app, None);
}

#[tauri::command]
fn orb_open_settings(app: AppHandle) {
    println!("[rust][cmd] orb_open_settings");
    show_main_window(&app, None);
    // 给主窗口发事件，让 React 端打开设置面板
    let _ = app.emit("open-settings", ());
}

#[tauri::command]
fn orb_hide(app: AppHandle) {
    println!("[rust][cmd] orb_hide");
    if let Some(window) = app.get_webview_window("orb") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn minimize_main_window_command(app: AppHandle) {
    println!("[rust][cmd] minimize_main_window_command");
    // 前端 window.minimize() 有时 handle 会拿错（orb 先加载后主窗口复用模块）
    // 后端兜底：直接按 label="main" 定位窗口
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            // macOS：真正最小化到 Dock（Dock 图标保留，点击可恢复）
            let _ = window.minimize();
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Windows：与原行为一致，直接隐藏（关闭按钮 = 最小化需求）
            let _ = window.hide();
        }
    }
}

fn show_orb_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("orb") {
        // orb 窗口是 280x280 的透明容器（容纳球 + 右键菜单）
        let _ = window.set_size(LogicalSize::<f64>::new(280.0, 280.0));
        let _ = window.set_min_size(Some(LogicalSize::<f64>::new(280.0, 280.0)));
        let _ = window.set_max_size(Some(LogicalSize::<f64>::new(280.0, 280.0)));
        position_orb_window(&window);
        let _ = window.show();
        let _ = window.set_size(LogicalSize::<f64>::new(280.0, 280.0));
    }
}

fn hide_orb_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("orb") {
        let _ = window.hide();
    }
}

fn toggle_orb_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("orb") {
        if window.is_visible().unwrap_or(false) {
            hide_orb_window(app);
        } else {
            show_orb_window(app);
        }
    }
}

fn toggle_main_window(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app, Some(cursor));
        }
    }
}

#[tauri::command]
fn get_update_info() -> JsonValue {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "supported": cfg!(all(target_os = "windows", target_arch = "x86_64")),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(UsageState::default())
        .invoke_handler(tauri::generate_handler![
            refresh_usage,
            get_cached_usage,
            get_source_info,
            get_update_info,
            show_main_window_command,
            set_api_key,
            set_base_url,
            clear_api_key_override,
            set_refresh_interval,
            set_notification_enabled,
            fetch_radar_bench_score,
            fetch_model_usage,
            start_window_dragging,
            start_window_resize,
            move_orb_window,
            orb_open_settings,
            orb_hide,
            minimize_main_window_command
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show_item = MenuItem::with_id(app, "show", "显示面板", true, None::<&str>)?;
            let show_orb_item = MenuItem::with_id(app, SHOW_ORB_MENU_ID, "显示悬浮球", true, None::<&str>)?;
            let refresh_item = MenuItem::with_id(app, "refresh", "立即刷新", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &show_orb_item, &refresh_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("sub2api-usage")
                .tooltip("Sub2API 用量")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app, None),
                    SHOW_ORB_MENU_ID => toggle_orb_window(app),
                    "refresh" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = fetch_and_store(&handle).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        position,
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle(), position);
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            if let Some(orb_window) = app.get_webview_window("orb") {
                let _ = orb_window.set_size(LogicalSize::<f64>::new(280.0, 280.0));
                let _ = orb_window.set_min_size(Some(LogicalSize::<f64>::new(280.0, 280.0)));
                let _ = orb_window.set_max_size(Some(LogicalSize::<f64>::new(280.0, 280.0)));
                position_orb_window(&orb_window);
                let _ = orb_window.show();
                let _ = orb_window.set_size(LogicalSize::<f64>::new(280.0, 280.0));
            }

            if env::args().any(|argument| argument == "--show") {
                show_main_window(app.handle(), None);
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let minutes = app_handle
                        .state::<UsageState>()
                        .refresh_minutes
                        .load(Ordering::Relaxed)
                        .max(1);
                    tokio::time::sleep(Duration::from_secs(minutes * 60)).await;
                    let _ = fetch_and_store(&app_handle).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Sub2API usage widget");
}

#[cfg(test)]
mod tests {
    use super::{
        effective_base_url, fetch_radar_bench_score, validate_main_resize, normalize_optional_base_url,
        radar_score_url, tray_menu_item_ids, tray_panel_position, usage_url, validate_api_key,
        validate_base_url, RADAR_API_URL,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn model_usage_query_uses_the_selected_inclusive_dates() {
        let url = super::model_usage_url(
            "https://sub2api.example.com/provider/v1",
            "2026-10-12",
            "2026-10-13",
        ).unwrap();
        assert_eq!(url.path(), "/provider/v1/usage");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("start_date").unwrap(), "2026-10-12");
        assert_eq!(query.get("end_date").unwrap(), "2026-10-13");
        assert_eq!(query.get("timezone").unwrap(), "Asia/Shanghai");
        assert_eq!(query.get("days").unwrap(), "28");
    }

    #[test]
    fn model_usage_query_rejects_invalid_and_reversed_dates() {
        for (start, end) in [
            ("2026-02-30", "2026-10-13"),
            ("2026-10-14", "2026-10-13"),
            ("2026-10-13&days=999", "2026-10-13"),
            ("2026-1-01", "2026-10-13"),
            ("2026-10-13", "2026-13-01"),
            ("2026-10-13", "2026-10-00"),
        ] {
            assert!(super::model_usage_url("https://sub2api.example.com", start, end).is_err());
        }
        assert!(super::model_usage_url("https://sub2api.example.com", "2024-02-29", "2024-02-29").is_ok());
        assert!(super::model_usage_url("https://sub2api.example.com", "2026-10-13", "2026-10-13").is_ok());
    }

    #[test]
    #[ignore = "requires the locally configured Sub2API credentials and live service"]
    fn model_usage_live_selected_day() {
        let day = std::env::var("SUB2API_USAGE_TEST_DATE").expect("Set the current Asia/Shanghai date for this manual live check");
        let custom_url = dirs::config_dir()
            .and_then(|directory| std::fs::read_to_string(directory.join("com.sub2api.usage-widget").join(super::CUSTOM_BASE_URL_FILE)).ok())
            .and_then(|value| super::validate_base_url(value).ok());
        let base_url = custom_url.unwrap_or_else(|| super::read_provider_config().expect("Sub2API provider configuration").base_url);
        let api_key = super::read_custom_api_key().expect("System credential store")
            .unwrap_or_else(|| super::read_codex_api_key().expect("Configured Codex API key"));
        let credentials = super::Credentials { api_key, base_url };
        let url = super::model_usage_url(&credentials.base_url, &day, &day).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let snapshot = runtime.block_on(super::request_usage_at_url(credentials.clone(), url.as_str()))
            .expect("Read selected-day usage");
        let models = snapshot.usage.get("model_stats").and_then(serde_json::Value::as_array).expect("Selected-day model statistics");
        assert!(models.iter().all(|model| ["actual_cost", "requests", "total_tokens"].iter().all(|field| model.get(field).is_some())), "Live model records must provide all three requested metrics");
        let model_cost: f64 = models.iter().filter_map(|model| model.get("actual_cost").and_then(serde_json::Value::as_f64)).sum();
        let today_cost = snapshot.usage.pointer("/usage/today/actual_cost").and_then(serde_json::Value::as_f64).expect("Today's actual cost");
        assert!((model_cost - today_cost).abs() < 0.01, "Selected-day model amounts must agree with today's usage rather than the default cumulative range");
        let empty_url = super::model_usage_url(&credentials.base_url, "2000-01-01", "2000-01-01").unwrap();
        let empty_snapshot = runtime.block_on(super::request_usage_at_url(credentials, empty_url.as_str())).expect("Read empty historical period");
        assert!(empty_snapshot.usage.get("model_stats").map_or(true, |value| value.is_null() || value.as_array().is_some_and(|rows| rows.is_empty())),
            "The server must honor the date filter rather than return the current cumulative models for an empty historical period");
        eprintln!("Live selected-day and empty historical queries passed; {} current models provide amount, requests and tokens", models.len());
    }

    #[test]
    fn tray_position_handles_full_monitor_and_oversized_panels() {
        for size in [PhysicalSize::new(1920, 1080), PhysicalSize::new(2560, 1440)] {
            for cursor in [PhysicalPosition::new(-60.0, 140.0), PhysicalPosition::new(-60.0, 1120.0)] {
                assert_eq!(
                    tray_panel_position(
                        cursor,
                        size,
                        PhysicalPosition::new(-1920, 100),
                        PhysicalSize::new(1920, 1080),
                    ),
                    PhysicalPosition::new(-1910, 110),
                );
            }
        }
    }

    #[test]
    fn tray_position_keeps_tall_panels_reachable_from_top_tray() {
        assert_eq!(
            tray_panel_position(
                PhysicalPosition::new(70.0, 40.0),
                PhysicalSize::new(420, 1440),
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 1080),
            ),
            PhysicalPosition::new(10, 10),
        );
    }

    #[test]
    fn tray_position_preserves_normal_panel_placement() {
        for (cursor, expected) in [
            (PhysicalPosition::new(1860.0, 1060.0), PhysicalPosition::new(1468, 286)),
            (PhysicalPosition::new(70.0, 40.0), PhysicalPosition::new(10, 54)),
        ] {
            assert_eq!(
                tray_panel_position(
                    cursor,
                    PhysicalSize::new(420, 760),
                    PhysicalPosition::new(0, 0),
                    PhysicalSize::new(1920, 1080),
                ),
                expected,
            );
        }
    }

    #[test]
    fn main_panel_supports_all_eight_resize_directions() {
        for direction in [
            "North", "South", "East", "West",
            "NorthEast", "NorthWest", "SouthEast", "SouthWest",
        ] {
            assert!(validate_main_resize("main", direction).is_ok());
        }
        assert_eq!(
            validate_main_resize("main", "SouthEast"),
            Ok(())
        );
    }

    #[test]
    fn resize_command_rejects_other_windows_and_invalid_directions() {
        assert!(validate_main_resize("orb", "SouthEast").is_err());
        assert!(validate_main_resize("main", "invalid").is_err());
    }

    #[test]
    fn radar_bench_uses_public_score_endpoint() {
        assert_eq!(
            RADAR_API_URL,
            "https://api.codexradar.com/api/v1/radar-bench-score"
        );
    }

    #[test]
    fn radar_bench_url_contains_only_the_selected_public_parameters() {
        let url = radar_score_url("gpt-6.1-sol", "xhigh").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.codexradar.com"));
        assert_eq!(url.path(), "/api/v1/radar-bench-score");
        assert_eq!(url.username(), "");
        assert_eq!(url.password(), None);
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![
                ("model".into(), "gpt-6.1-sol".into()),
                ("effort".into(), "xhigh".into()),
            ]
        );
    }

    #[test]
    fn radar_bench_rejects_invalid_and_unsupported_selections() {
        for (model, effort) in [
            ("https://other.example/score", "max"),
            ("gpt-6-astra&token=private", "max"),
            ("gpt-6-astra", "unknown"),
            ("gpt-6-luna", "ultra"),
            ("gpt-5.6-luna", "ultra"),
        ] {
            assert!(radar_score_url(model, effort).is_err());
        }
    }

    #[test]
    #[ignore = "requires the live anonymous RadarBench service"]
    fn radar_bench_live_public_transport() {
        let data = tauri::async_runtime::block_on(fetch_radar_bench_score(
            "gpt-6-astra".to_string(),
            "xhigh".to_string(),
        ))
        .expect("the desktop transport should read the public score");
        assert_eq!(data["model"], "gpt-6-astra");
        assert_eq!(data["effort"], "xhigh");
        assert_eq!(data["score_max"].as_f64(), Some(150.0));
        assert!(data["statistics"]["sample_count"].as_u64().is_some());
    }

    #[test]
    fn tray_menu_exposes_orb_visibility_action() {
        assert!(tray_menu_item_ids().contains(&"show-orb"));
    }

    #[test]
    fn validates_and_trims_api_keys() {
        assert_eq!(
            validate_api_key("  sk-valid-example-key  ".to_string()).unwrap(),
            "sk-valid-example-key"
        );
    }

    #[test]
    fn rejects_short_or_whitespace_api_keys() {
        assert!(validate_api_key("short".to_string()).is_err());
        assert!(validate_api_key("sk-invalid key".to_string()).is_err());
        assert!(validate_api_key("sk-invalid\nkey".to_string()).is_err());
    }

    #[test]
    fn validates_and_normalizes_base_urls() {
        assert_eq!(
            validate_base_url(" https://sub2api.example.com/// ".to_string()).unwrap(),
            "https://sub2api.example.com"
        );
    }

    #[test]
    fn rejects_unsupported_or_empty_base_urls() {
        assert!(validate_base_url("".to_string()).is_err());
        assert!(validate_base_url("sub2api.example.com".to_string()).is_err());
        assert!(validate_base_url("ftp://sub2api.example.com".to_string()).is_err());
    }

    #[test]
    fn normalizes_optional_base_url_input_for_key_setup() {
        assert_eq!(
            normalize_optional_base_url(Some(" https://custom.example.com/// ".to_string()))
                .unwrap(),
            Some("https://custom.example.com".to_string())
        );
        assert_eq!(
            normalize_optional_base_url(Some("  ".to_string())).unwrap(),
            None
        );
        assert_eq!(normalize_optional_base_url(None).unwrap(), None);
    }

    #[test]
    fn appends_usage_path_to_a_host_base_url() {
        assert_eq!(
            usage_url("http://sub2api.example.com").unwrap(),
            "http://sub2api.example.com/v1/usage?days=28&timezone=Asia%2FShanghai"
        );
    }

    #[test]
    fn does_not_duplicate_v1_when_base_url_already_contains_it() {
        assert_eq!(
            usage_url("http://sub2api.example.com/v1").unwrap(),
            "http://sub2api.example.com/v1/usage?days=28&timezone=Asia%2FShanghai"
        );
    }

    #[test]
    fn custom_base_url_overrides_codex_provider_url() {
        assert_eq!(
            effective_base_url(
                Some("https://custom.example.com".to_string()),
                Some("https://codex.example.com".to_string()),
            ),
            Some("https://custom.example.com".to_string())
        );
        assert_eq!(
            effective_base_url(None, Some("https://codex.example.com".to_string())),
            Some("https://codex.example.com".to_string())
        );
    }
}
