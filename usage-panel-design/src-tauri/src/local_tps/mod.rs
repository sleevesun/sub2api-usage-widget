mod config;
mod events;

use bytes::Bytes;
use events::{Event, ModelTps, Sample};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    collections::HashSet,
    convert::Infallible,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_STORE: u64 = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 30_000;
const MAX_SAMPLES: usize = 50_000;
const RETENTION_MS: i64 = 35 * 86_400_000;
const EVENT_RETENTION_MS: i64 = 90 * 60_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn read_json<T: serde::de::DeserializeOwned>(file: &Path) -> Result<Option<T>, String> {
    let file = match fs::File::open(file) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本机 TPS 文件，请检查文件权限".into()),
    };
    let mut data = Vec::new();
    file.take(MAX_STORE + 1)
        .read_to_end(&mut data)
        .map_err(|_| "无法读取本机 TPS 文件")?;
    if data.len() as u64 > MAX_STORE {
        return Err("本机 TPS 文件超出读取上限，原文件已保留".into());
    }
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|_| "本机 TPS 文件格式无效，原文件已保留".into())
}

fn atomic_write(file: &Path, bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    let parent = file.parent().ok_or("无法确定本机 TPS 文件目录")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建本机 TPS 目录")?;
    let temporary = parent.join(format!(
        ".sub2api-tps-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建本机 TPS 临时文件")?;
        output
            .write_all(bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "无法写入本机 TPS 文件")?;
        drop(output);
        if let Some(expected) = expected {
            if fs::read_to_string(file).map_err(|_| "无法复核 Codex 配置")? != expected {
                return Err("Codex 配置刚被其他程序修改，请重试".into());
            }
        }
        fs::rename(&temporary, file).map_err(|_| "无法保存本机 TPS 文件，请检查文件权限".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    enabled: bool,
    port: u16,
    config_path: Option<PathBuf>,
    backup: Option<config::Backup>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSamples {
    schema: u8,
    samples: Vec<Sample>,
}

#[derive(Default)]
struct Data {
    events: Vec<Event>,
    samples: Vec<Sample>,
    last_received_at_ms: Option<i64>,
    error: Option<String>,
    writable: bool,
    dirty: bool,
}

impl Data {
    fn ingest(&mut self, payload: &JsonValue, file: &Path) -> Result<(), String> {
        if !self.writable {
            return Err(self
                .error
                .clone()
                .unwrap_or_else(|| "本机 TPS 数据不可写入".into()));
        }
        let now = now_ms();
        let events = events::normalize(payload);
        if !events.is_empty() {
            self.last_received_at_ms = Some(now);
        }
        let mut seen: HashSet<_> = self.events.iter().cloned().collect();
        self.events.extend(events.into_iter().filter(|event| {
            event.at_ms >= now - EVENT_RETENTION_MS
                && event.at_ms <= now + 300_000
                && seen.insert(event.clone())
        }));
        self.events
            .retain(|event| event.at_ms >= now - EVENT_RETENTION_MS);
        self.events.sort_by_key(|event| event.at_ms);
        if self.events.len() > MAX_EVENTS {
            self.events.drain(..self.events.len() - MAX_EVENTS);
        }
        let analysis = events::analyze(&self.events);
        let previous = self.samples.clone();
        self.samples.retain(|sample| {
            !analysis.evaluated_ids.contains(&sample.id)
                && sample.completed_at_ms >= now - RETENTION_MS
        });
        self.samples.extend(analysis.samples);
        self.samples.sort_by_key(|sample| sample.completed_at_ms);
        if self.samples.len() > MAX_SAMPLES {
            self.samples.drain(..self.samples.len() - MAX_SAMPLES);
        }
        self.dirty |= self.samples != previous;
        if self.dirty {
            let bytes = serde_json::to_vec(&StoredSamples {
                schema: 1,
                samples: self.samples.clone(),
            })
            .map_err(|_| "无法编码本机 TPS 数据")?;
            if let Err(error) = atomic_write(file, &bytes, None) {
                self.error = Some(error.clone());
                return Err(error);
            }
            self.error = None;
            self.dirty = false;
        }
        Ok(())
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
struct Control {
    settings: Settings,
    running: Option<Running>,
    error: Option<String>,
    loaded: bool,
}

pub(crate) struct LocalTps {
    directory: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    control: Mutex<Control>,
    data: Arc<Mutex<Data>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    start_date: String,
    end_date: String,
    enabled: bool,
    status: &'static str,
    error: Option<String>,
    models: Vec<ModelTps>,
    last_received_at_ms: Option<i64>,
    recorded_samples: usize,
}

impl LocalTps {
    pub(crate) fn new(directory: Option<PathBuf>, codex_home: Option<PathBuf>) -> Self {
        let service = Self {
            directory,
            codex_home,
            control: Mutex::new(Control::default()),
            data: Arc::new(Mutex::new(Data::default())),
        };
        service.load();
        service
    }

    fn load(&self) {
        let Some(directory) = &self.directory else {
            self.control.lock().unwrap().error = Some("无法确定本机 TPS 保存目录".into());
            return;
        };
        let mut control = self.control.lock().unwrap();
        match read_json::<Settings>(&directory.join("codex-tps-settings.json")) {
            Ok(Some(settings)) => control.settings = settings,
            Ok(None) => {}
            Err(error) => {
                control.error = Some(error);
                return;
            }
        }
        control.loaded = true;
        let mut data = self.data.lock().unwrap();
        data.writable = true;
        match read_json::<StoredSamples>(&directory.join("codex-tps-samples.json")) {
            Ok(Some(store)) if store.schema == 1 => {
                let mut ids = HashSet::new();
                data.samples = store
                    .samples
                    .into_iter()
                    .filter(|sample| {
                        events::model_id(&sample.model)
                            && sample.id.len() == 64
                            && sample.id.bytes().all(|c| c.is_ascii_hexdigit())
                            && sample.duration_ms > 0
                            && sample.duration_ms <= 21_600_000
                            && sample.output_tokens > 0
                            && sample.output_tokens <= 1_000_000_000
                            && sample.completed_at_ms >= now_ms() - RETENTION_MS
                            && sample.completed_at_ms <= now_ms() + 300_000
                            && ids.insert(sample.id.clone())
                    })
                    .take(MAX_SAMPLES)
                    .collect();
            }
            Ok(None) => {}
            _ => {
                data.writable = false;
                data.error = Some("本机 TPS 数据文件无法读取，原文件已保留".into());
            }
        }
        drop(data);
        if control.settings.enabled {
            let result = (|| {
                let path = self.config_path()?;
                if control.settings.config_path.as_ref() != Some(&path)
                    || control.settings.backup.is_none()
                    || control.settings.port == 0
                {
                    return Err("Codex 目录或本机 TPS 配置已改变，请关闭后重新启用".into());
                }
                let text = fs::read_to_string(path)
                    .map_err(|_| "无法读取 Codex 配置，请关闭后重新启用本机 TPS")?;
                if !config::managed(&text, &Self::endpoint(control.settings.port)) {
                    return Err("Codex 遥测目标已改变，本机 TPS 未接管新配置".into());
                }
                let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, control.settings.port))
                    .map_err(|_| "本机 TPS 端口被占用，请关闭重复运行的 App 后重试")?;
                self.receiver(listener)
            })();
            match result {
                Ok(running) => control.running = Some(running),
                Err(error) => control.error = Some(error),
            }
        }
    }

    fn config_path(&self) -> Result<PathBuf, String> {
        self.codex_home
            .as_ref()
            .map(|home| home.join("config.toml"))
            .ok_or_else(|| "无法确定 Codex 配置目录".into())
    }
    fn endpoint(port: u16) -> String {
        format!("http://127.0.0.1:{port}/v1/logs")
    }
    fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        let directory = self.directory.as_ref().ok_or("无法确定本机 TPS 保存目录")?;
        let bytes = serde_json::to_vec(settings).map_err(|_| "无法编码本机 TPS 设置")?;
        atomic_write(&directory.join("codex-tps-settings.json"), &bytes, None)
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut control = self.control.lock().map_err(|_| "本机 TPS 控制器不可用")?;
        if !control.loaded {
            return Err(control
                .error
                .clone()
                .unwrap_or_else(|| "本机 TPS 配置不可读取，原文件已保留".into()));
        }
        if enabled && control.settings.enabled && control.running.is_some() {
            return Ok(());
        }
        let path = self.config_path()?;
        if enabled {
            if !self.data.lock().unwrap().writable {
                return Err("本机 TPS 数据文件不可写入，未修改 Codex 配置".into());
            }
            if control.settings.enabled {
                return Err("请先关闭本机 TPS，再重新启用".into());
            }
            let before = fs::read_to_string(&path)
                .map_err(|_| "未找到可读取的 Codex config.toml，未修改配置")?;
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .map_err(|_| "无法启动本机 TPS 接收器")?;
            let port = listener
                .local_addr()
                .map_err(|_| "无法读取本机 TPS 端口")?
                .port();
            let (updated, backup) = config::enable(&before, &Self::endpoint(port))?;
            let next = Settings {
                enabled: true,
                port,
                config_path: Some(path.clone()),
                backup: Some(backup),
            };
            let running = self.receiver(listener)?;
            self.save_settings(&next)?;
            if let Err(error) = atomic_write(&path, updated.as_bytes(), Some(&before)) {
                let _ = self.save_settings(&control.settings);
                return Err(error);
            }
            control.settings = next;
            control.running = Some(running);
            control.error = None;
        } else {
            // Stop reception before restoring settings. Never restore a different
            // Codex home or overwrite an exporter changed outside this App.
            control.running = None;
            if let Some(backup) = &control.settings.backup {
                if control.settings.config_path.as_ref() != Some(&path) {
                    return Err("Codex 目录已改变，未写入其他目录；原采样已停止".into());
                }
                let before = fs::read_to_string(&path)
                    .map_err(|_| "无法读取 Codex 配置以关闭采样，请检查文件权限")?;
                let (updated, _) =
                    config::restore(&before, &Self::endpoint(control.settings.port), backup)?;
                if updated != before {
                    atomic_write(&path, updated.as_bytes(), Some(&before))?;
                }
            }
            let next = Settings::default();
            self.save_settings(&next)?;
            control.settings = next;
            control.error = None;
        }
        Ok(())
    }

    fn receiver(&self, listener: TcpListener) -> Result<Running, String> {
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法启动本机 TPS 接收器")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "无法启动本机 TPS 运行环境")?;
        let data = self.data.clone();
        let file = self
            .directory
            .as_ref()
            .ok_or("无法确定本机 TPS 保存目录")?
            .join("codex-tps-samples.json");
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("codex-tps".into())
            .spawn(move || {
                runtime.block_on(async move {
                    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                        data.lock().unwrap().error = Some("本机 TPS 接收器启动失败".into());
                        return;
                    };
                    let permits = Arc::new(tokio::sync::Semaphore::new(16));
                    while !worker_stop.load(Ordering::Acquire) {
                        let accepted =
                            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                                .await;
                        let Ok(Ok((stream, _))) = accepted else {
                            continue;
                        };
                        let Ok(permit) = permits.clone().try_acquire_owned() else {
                            continue;
                        };
                        let data = data.clone();
                        let file = file.clone();
                        let stop = worker_stop.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            let service = service_fn(move |request| {
                                receive(request, data.clone(), file.clone(), stop.clone())
                            });
                            let connection = hyper::server::conn::http1::Builder::new()
                                .keep_alive(false)
                                .serve_connection(TokioIo::new(stream), service);
                            let _ = tokio::time::timeout(Duration::from_secs(5), connection).await;
                        });
                    }
                })
            })
            .map_err(|_| "无法启动本机 TPS 接收线程")?;
        Ok(Running {
            stop,
            thread: Some(thread),
        })
    }

    pub(crate) fn snapshot(&self, start: &str, end: &str) -> Snapshot {
        let control = self.control.lock().unwrap();
        let data = self.data.lock().unwrap();
        let error = control
            .error
            .clone()
            .or_else(|| data.error.clone())
            .or_else(|| {
                if control.settings.enabled && control.running.is_none() {
                    Some("本机 TPS 接收器已停止，请关闭后重新启用".into())
                } else {
                    None
                }
            });
        let enabled = control.settings.enabled;
        let status = if error.is_some() {
            "error"
        } else if !enabled {
            "disabled"
        } else if data.last_received_at_ms.is_none() {
            "waiting"
        } else {
            "collecting"
        };
        Snapshot {
            start_date: start.into(),
            end_date: end.into(),
            enabled,
            status,
            error,
            models: events::aggregate(&data.samples, start, end),
            last_received_at_ms: data.last_received_at_ms,
            recorded_samples: data.samples.len(),
        }
    }
}

async fn receive(
    request: Request<Incoming>,
    data: Arc<Mutex<Data>>,
    file: PathBuf,
    stop: Arc<AtomicBool>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let response = |status| {
        Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from_static(b"{}")))
            .unwrap()
    };
    if request.headers().contains_key("origin") {
        return Ok(response(StatusCode::FORBIDDEN));
    }
    if request.method() != hyper::Method::POST || request.uri().path() != "/v1/logs" {
        return Ok(response(StatusCode::NOT_FOUND));
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .is_some_and(|len| len > MAX_BODY as u64)
    {
        return Ok(response(StatusCode::PAYLOAD_TOO_LARGE));
    }
    let encoding = request
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity")
        .to_string();
    if !matches!(encoding.as_str(), "identity" | "gzip") {
        return Ok(response(StatusCode::UNSUPPORTED_MEDIA_TYPE));
    }
    let Ok(body) = Limited::new(request.into_body(), MAX_BODY).collect().await else {
        return Ok(response(StatusCode::PAYLOAD_TOO_LARGE));
    };
    let mut bytes = body.to_bytes().to_vec();
    if encoding == "gzip" {
        let mut decoded = Vec::new();
        if flate2::read::GzDecoder::new(bytes.as_slice())
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut decoded)
            .is_err()
            || decoded.len() > MAX_BODY
        {
            return Ok(response(StatusCode::BAD_REQUEST));
        }
        bytes = decoded;
    }
    let Ok(payload) = serde_json::from_slice::<JsonValue>(&bytes) else {
        return Ok(response(StatusCode::BAD_REQUEST));
    };
    if !payload.get("resourceLogs").is_some_and(JsonValue::is_array) {
        return Ok(response(StatusCode::BAD_REQUEST));
    }
    if stop.load(Ordering::Acquire) {
        return Ok(response(StatusCode::SERVICE_UNAVAILABLE));
    }
    let status = if data.lock().unwrap().ingest(&payload, &file).is_ok() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    Ok(response(status))
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("仅允许主面板管理本机 TPS".into())
    }
}

#[tauri::command]
pub(crate) async fn get_local_codex_tps(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalTps>>,
    start_date: String,
    end_date: String,
) -> Result<Snapshot, String> {
    require_main(window.label())?;
    crate::validate_model_usage_period(&start_date, &end_date)?;
    Ok(state.snapshot(&start_date, &end_date))
}

#[tauri::command]
pub(crate) async fn set_local_codex_tps_enabled(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalTps>>,
    enabled: bool,
) -> Result<(), String> {
    require_main(window.label())?;
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.set_enabled(enabled))
        .await
        .map_err(|_| "本机 TPS 设置任务失败")?
}

#[cfg(test)]
mod service_tests;
