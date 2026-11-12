//! Anonymous, whole-round Codex Radar reads. This state never accesses usage credentials.
use chrono::{SecondsFormat, Utc};
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use scraper::{Html, Selector};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const SOURCE: &str = "https://codexradar.com/";
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_ROWS: usize = 4096;

#[tauri::command]
pub fn open_codex_radar_homepage() -> Result<(), String> {
    // Keep the destination fixed; the webview cannot request arbitrary commands or URLs.
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot").ok_or("无法定位系统浏览器入口")?;
        let mut command = std::process::Command::new(
            std::path::PathBuf::from(system_root).join("System32/rundll32.exe"),
        );
        command.args(["url.dll,FileProtocolHandler", SOURCE]);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg(SOURCE);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(SOURCE);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "暂时无法打开官网，请稍后重试".into())
}

type Reader = Arc<dyn Fn() -> BoxFuture<'static, Result<String, String>> + Send + Sync>;
type PendingRead = Shared<BoxFuture<'static, Result<Value, String>>>;

#[derive(Default)]
struct Cache {
    snapshot: Option<(Value, Instant)>,
    last_error: Option<String>,
    pending: Option<(u64, PendingRead)>,
    generation: u64,
}

pub struct RadarState {
    cache: Mutex<Cache>,
    reader: Reader,
}

impl Default for RadarState {
    fn default() -> Self {
        Self::with_reader(Arc::new(|| fetch_homepage().boxed()))
    }
}

impl RadarState {
    fn with_reader(reader: Reader) -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            reader,
        }
    }
}

async fn fetch_homepage() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|_| "无法初始化 Codex Radar 官网读取".to_string())?;
    let mut response = client
        .get(SOURCE)
        .header(reqwest::header::ACCEPT, "text/html")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "Codex Radar 官网返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTML_BYTES as u64)
    {
        return Err("Codex Radar 官网响应超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
            return Err("Codex Radar 官网响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Codex Radar 官网返回了无效文本".into())
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Codex Radar 官网读取超时，请稍后刷新".into()
    } else if error.is_connect() {
        "无法连接 Codex Radar 官网，请稍后刷新".into()
    } else {
        "Codex Radar 官网读取失败，请稍后刷新".into()
    }
}

fn target_model(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    let Some(suffix) = lower.strip_prefix("gpt-6") else {
        return false;
    };
    suffix.is_empty() || suffix.starts_with('-') || suffix == ".1" || suffix.starts_with(".1-")
}

fn normalized_heading(heading: &str) -> String {
    heading
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_whitespace() || matches!(ch, '‐' | '‑' | '‒' | '–' | '—' | '−') {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn selector(text: &str) -> Result<Selector, String> {
    Selector::parse(text).map_err(|_| "Codex Radar 解析规则无效".into())
}

fn nonnegative_number(value: Option<&Value>) -> Value {
    value
        .filter(|value| {
            value
                .as_f64()
                .is_some_and(|number| number.is_finite() && number >= 0.0)
        })
        .cloned()
        .unwrap_or(Value::Null)
}

fn parse_snapshot(html: &str, fetched_at: &str) -> Result<Value, String> {
    if html.len() > MAX_HTML_BYTES {
        return Err("Codex Radar 官网响应超过大小限制".into());
    }
    let document = Html::parse_document(html);
    let scripts = selector("script[id='home-overview-data']")?;
    let mut matches = document.select(&scripts);
    let script = matches
        .next()
        .ok_or("官网未返回 home-overview-data，数据结构可能已更新")?;
    if matches.next().is_some() {
        return Err("官网返回重复的 home-overview-data".into());
    }
    let data: Value = serde_json::from_str(&script.text().collect::<String>())
        .map_err(|_| "官网 home-overview-data 不是有效 JSON".to_string())?;
    let scores = data
        .get("scores")
        .and_then(Value::as_object)
        .ok_or("官网 scores 格式已变化")?;
    let source_rows = scores
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("官网 scores.rows 格式已变化")?;
    if source_rows.len() > MAX_ROWS {
        return Err("官网 scores.rows 超过数量限制".into());
    }
    let mut rows = Vec::new();
    let mut combinations = HashSet::new();
    for row in source_rows {
        let object = row.as_object().ok_or("官网 scores.rows 包含无效记录")?;
        let model = object
            .get("model")
            .and_then(Value::as_str)
            .ok_or("官网模型标识缺失")?
            .trim()
            .to_ascii_lowercase();
        if !target_model(&model) {
            continue;
        }
        let effort = object
            .get("effort")
            .and_then(Value::as_str)
            .ok_or("官网模型档位缺失")?
            .trim()
            .to_ascii_lowercase();
        if model.len() > 128 || effort.is_empty() || effort.len() > 64 {
            return Err("官网模型或档位标识无效".into());
        }
        if !combinations.insert((model.clone(), effort.clone())) {
            return Err("官网 scores.rows 包含重复的模型档位".into());
        }
        let cost_kind = match object.get("cost_kind") {
            None | Some(Value::Null) => "unknown",
            Some(Value::String(value)) if value.len() <= 128 => value,
            _ => return Err("官网费用类型格式无效".into()),
        };
        rows.push(json!({
            "model": model, "effort": effort,
            "score150": nonnegative_number(object.get("score150")),
            "cost_usd": nonnegative_number(object.get("cost_usd")),
            "model_elapsed_seconds": nonnegative_number(object.get("model_elapsed_seconds")),
            "cost_kind": cost_kind,
        }));
    }
    let models: HashMap<String, String> = rows
        .iter()
        .filter_map(|row| row["model"].as_str())
        .map(|model| (normalized_heading(model), model.to_string()))
        .collect();
    let row_selector = selector("tr")?;
    let heading_selector = selector("th[scope]")?;
    let cell_selector = selector("td[data-cir-column]")?;
    let heat_selector = selector("[data-heat-state]")?;
    let mut unsupported = Vec::new();
    let mut seen = HashSet::new();
    for row in document.select(&row_selector) {
        let Some(heading) = row.select(&heading_selector).find(|heading| {
            heading
                .value()
                .attr("scope")
                .is_some_and(|scope| scope.eq_ignore_ascii_case("row"))
        }) else {
            continue;
        };
        let heading_text = heading.text().collect::<Vec<_>>().join(" ");
        let Some(model) = models.get(&normalized_heading(&heading_text)) else {
            continue;
        };
        for cell in row.select(&cell_selector) {
            let explicit = cell
                .value()
                .attr("data-heat-state")
                .is_some_and(|value| value.eq_ignore_ascii_case("unsupported"))
                || cell.select(&heat_selector).any(|marker| {
                    marker
                        .value()
                        .attr("data-heat-state")
                        .is_some_and(|value| value.eq_ignore_ascii_case("unsupported"))
                });
            if !explicit {
                continue;
            }
            let effort = cell
                .value()
                .attr("data-cir-column")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if effort.is_empty() || effort.len() > 64 {
                continue;
            }
            if seen.insert((model.clone(), effort.clone())) {
                unsupported.push(json!({"model": model, "effort": effort}));
            }
        }
    }
    let metadata: Map<String, Value> = scores
        .iter()
        .filter(|(key, _)| key.as_str() != "rows")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let snapshot = json!({"source": SOURCE, "fetched_at": fetched_at, "score_max": 150,
        "rows": rows, "unsupported": unsupported, "metadata": metadata});
    if serde_json::to_vec(&snapshot)
        .map_err(|_| "Codex Radar 数据序列化失败")?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err("Codex Radar 数据超过大小限制".into());
    }
    Ok(snapshot)
}

fn with_status(mut snapshot: Value, status: &str, error: Option<&str>) -> Value {
    snapshot["status"] = json!(status);
    if let Some(error) = error {
        snapshot["error"] = json!(error);
    }
    snapshot
}

async fn read_at(force: bool, state: &RadarState, now: Instant) -> Result<Value, String> {
    let (generation, pending) = {
        let mut cache = state
            .cache
            .lock()
            .map_err(|_| "Codex Radar 缓存不可用".to_string())?;
        // All callers join an existing refresh, including forced calls. Holding a
        // mutex through the request would queue duplicate forced network reads.
        if let Some((generation, pending)) = &cache.pending {
            (*generation, pending.clone())
        } else {
            if !force {
                if let Some((snapshot, fetched)) = &cache.snapshot {
                    if now.saturating_duration_since(*fetched) < CACHE_TTL {
                        return Ok(with_status(
                            snapshot.clone(),
                            if cache.last_error.is_some() {
                                "stale"
                            } else {
                                "cached"
                            },
                            cache.last_error.as_deref(),
                        ));
                    }
                }
            }
            let reader = state.reader.clone();
            let pending = async move {
                let html = reader().await?;
                parse_snapshot(
                    &html,
                    &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                )
            }
            .boxed()
            .shared();
            cache.generation = cache.generation.wrapping_add(1);
            let generation = cache.generation;
            cache.pending = Some((generation, pending.clone()));
            (generation, pending)
        }
    };
    let result = pending.await;
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| "Codex Radar 缓存不可用".to_string())?;
    if cache
        .pending
        .as_ref()
        .is_some_and(|(current, _)| *current == generation)
    {
        cache.pending = None;
        match &result {
            Ok(snapshot) => {
                cache.snapshot = Some((snapshot.clone(), now));
                cache.last_error = None;
            }
            Err(error) => {
                cache.last_error = Some(error.clone());
            }
        }
    }
    match result {
        Ok(snapshot) => Ok(with_status(snapshot, "latest", None)),
        Err(error) => match &cache.snapshot {
            Some((snapshot, _)) => Ok(with_status(snapshot.clone(), "stale", Some(&error))),
            None => Err(error),
        },
    }
}

pub async fn read_snapshot(force: bool, state: &RadarState) -> Result<Value, String> {
    read_at(force, state, Instant::now()).await
}

#[tauri::command]
pub async fn fetch_codex_radar_snapshot(
    force: bool,
    state: tauri::State<'_, RadarState>,
) -> Result<Value, String> {
    read_snapshot(force, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{future::join_all, FutureExt};
    use serde_json::json;
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
        time::Duration,
    };

    fn page(rows: Value, matrix: &str) -> String {
        let overview = json!({"scores": {
            "rows": rows,
            "round_id": "fixture-round",
            "author_test_interval": {"completed_at": "2026-11-12T10:41:36+08:00"},
            "model_and_judge_interval": {"completed_at": "2026-11-12T10:50:43+08:00"},
            "future_metadata": {"retained": true}
        }});
        format!("<html><script type='application/json' data-other='x' id='home-overview-data'>{overview}</script><table>{matrix}</table></html>")
    }

    fn valid_page(score: f64) -> String {
        page(
            json!([{"model":"gpt-6.1-sol","effort":"high","score150":score,"cost_usd":0.6,"model_elapsed_seconds":120.5,"cost_kind":"api_equivalent_estimate"}]),
            "",
        )
    }

    fn state_with_replies(replies: Vec<Result<String, String>>) -> (RadarState, Arc<AtomicUsize>) {
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let calls = Arc::new(AtomicUsize::new(0));
        let reader_calls = calls.clone();
        let reader: Reader = Arc::new(move || {
            reader_calls.fetch_add(1, Ordering::SeqCst);
            let reply = replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected network read");
            async move { reply }.boxed()
        });
        (RadarState::with_reader(reader), calls)
    }

    #[test]
    fn parses_rows_metadata_and_missing_scores_without_inventing_counts() {
        let html = page(
            json!([
                {"model":"GPT-6.1-Sol","effort":"HIGH","score150":123.4,"cost_usd":0.5,"model_elapsed_seconds":42,"cost_kind":"api_equivalent_estimate","unwanted":"omit"},
                {"model":"gpt-6-new-suffix","effort":"ultra"},
                {"model":"gpt-6.1-new-suffix","effort":"max","score150":null},
                {"model":"gpt-60-sol","effort":"high","score150":100},
                {"model":"gpt-6.10-sol","effort":"high","score150":100},
                {"model":"gpt-6.2-sol","effort":"high","score150":100},
                {"model":"gpt-5.6-sol","effort":"high","score150":100}
            ]),
            "",
        );
        let value = parse_snapshot(&html, "2026-11-12T03:00:00.000Z").unwrap();
        assert_eq!(value["source"], "https://codexradar.com/");
        assert_eq!(value["fetched_at"], "2026-11-12T03:00:00.000Z");
        assert_eq!(value["score_max"], 150);
        assert_eq!(value["rows"].as_array().unwrap().len(), 3);
        assert_eq!(value["rows"][0]["model"], "gpt-6.1-sol");
        assert_eq!(value["rows"][0]["effort"], "high");
        assert_eq!(value["rows"][0]["score150"], 123.4);
        assert_eq!(value["rows"][0]["cost_usd"], 0.5);
        assert_eq!(value["rows"][0]["model_elapsed_seconds"], 42);
        assert!(value["rows"][0].get("unwanted").is_none());
        assert!(value["rows"][1]["score150"].is_null());
        assert_eq!(value["rows"][1]["cost_kind"], "unknown");
        assert_eq!(
            value["metadata"]["author_test_interval"]["completed_at"],
            "2026-11-12T10:41:36+08:00"
        );
        assert_eq!(value["metadata"]["future_metadata"]["retained"], true);
        assert!(value["metadata"].get("graded").is_none());
        assert!(value["metadata"].get("rows").is_none());
    }

    #[test]
    fn recognizes_only_explicit_unsupported_cells_for_json_models() {
        let html = page(json!([
            {"model":"gpt-6.1-sol","effort":"high","score150":120},
            {"model":"gpt-6-luna","effort":"max","score150":110}
        ]), "<tr><th data-x='1' scope='row'><span>GPT–6.1</span> <b>Sol</b></th><td class='x' data-cir-column='ULTRA'><div><i aria-label='x' data-heat-state='unsupported'></i></div></td><td data-cir-column='LOW'><span data-heat-state='unknown'></span></td></tr><tr><th scope='row'>GPT-6 Luna</th><td data-cir-column='ULTRA'><span data-heat-state='unsupported'></span></td></tr><tr><th scope='row'>GPT-6 Unlisted</th><td data-cir-column='LOW'><span data-heat-state='unsupported'></span></td></tr>");
        let value = parse_snapshot(&html, "stamp").unwrap();
        assert_eq!(
            value["unsupported"],
            json!([
                {"model":"gpt-6.1-sol","effort":"ultra"},
                {"model":"gpt-6-luna","effort":"ultra"}
            ])
        );
        assert!(
            parse_snapshot(&valid_page(120.0), "stamp").unwrap()["unsupported"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_malformed_json_and_missing_identity_schema() {
        for html in [
            "<html></html>".to_string(),
            "<script id='home-overview-data'>{no json}</script>".to_string(),
            "<script id='home-overview-data'>{\"scores\":{\"rows\":{}}}</script>".to_string(),
            "<script id='home-overview-data'>{\"scores\":{}}</script>".to_string(),
            page(json!([{"model":"gpt-6-sol"}]), ""),
            page(json!([{"effort":"high"}]), ""),
        ] {
            assert!(
                parse_snapshot(&html, "stamp").is_err(),
                "must reject malformed page"
            );
        }
    }

    #[test]
    fn invalid_numeric_fields_become_null_without_dropping_combinations() {
        for invalid in [
            json!(-1),
            json!("invalid"),
            json!(true),
            json!([]),
            json!({}),
            Value::Null,
        ] {
            let snapshot = parse_snapshot(&page(json!([
                {"model":"gpt-6-sol","effort":"high","score150":invalid,"cost_usd":invalid,"model_elapsed_seconds":invalid},
                {"model":"gpt-6-sol","effort":"low"},
                {"model":"gpt-6-sol","effort":"ultra","score150":175.25,"cost_usd":0,"model_elapsed_seconds":0}
            ]), ""), "stamp").unwrap();
            let rows = snapshot["rows"].as_array().unwrap();
            assert_eq!(rows.len(), 3);
            for index in [0, 1] {
                for key in ["score150", "cost_usd", "model_elapsed_seconds"] {
                    assert!(
                        rows[index][key].is_null(),
                        "invalid or missing {key} must become null"
                    );
                }
            }
            assert_eq!(rows[2]["score150"], 175.25);
            assert_eq!(rows[2]["cost_usd"], 0);
            assert_eq!(rows[2]["model_elapsed_seconds"], 0);
        }
    }

    #[test]
    fn empty_and_filtered_rounds_are_valid_whole_snapshots() {
        for source_rows in [
            json!([]),
            json!([{"model":"gpt-5.6-sol","effort":"high","score150":110}]),
        ] {
            let snapshot = parse_snapshot(&page(source_rows, "<tr><th scope='row'>GPT-6 Sol</th><td data-cir-column='ULTRA'><i data-heat-state='unsupported'></i></td></tr>"), "stamp").unwrap();
            assert_eq!(snapshot["rows"], json!([]));
            assert_eq!(snapshot["unsupported"], json!([]));
            assert_eq!(snapshot["metadata"]["round_id"], "fixture-round");
            assert_eq!(snapshot["fetched_at"], "stamp");
        }
    }

    #[test]
    fn trims_identifiers_and_rejects_duplicate_normalized_combinations() {
        let trimmed = parse_snapshot(
            &page(
                json!([
                    {"model":" GPT-6.1-SOL ","effort":" HIGH ","score150":120}
                ]),
                "",
            ),
            "stamp",
        )
        .unwrap();
        assert_eq!(trimmed["rows"][0]["model"], "gpt-6.1-sol");
        assert_eq!(trimmed["rows"][0]["effort"], "high");
        for (model, effort) in [("gpt-6.1-sol", "high"), (" GPT-6.1-SOL ", " HIGH ")] {
            let duplicate = page(
                json!([
                    {"model":"gpt-6.1-sol","effort":"high","score150":120},
                    {"model":model,"effort":effort,"score150":121}
                ]),
                "",
            );
            assert!(
                parse_snapshot(&duplicate, "stamp").is_err(),
                "duplicate normalized combination must reject the whole round"
            );
        }
        assert!(parse_snapshot(
            &page(json!([{"model":"gpt-6-sol","effort":"  "}]), ""),
            "stamp"
        )
        .is_err());
    }

    #[test]
    fn empty_round_replaces_cached_rows_and_duplicate_round_retains_it() {
        tauri::async_runtime::block_on(async {
            let duplicate = page(
                json!([
                    {"model":"gpt-6-sol","effort":"high","score150":100},
                    {"model":" GPT-6-SOL ","effort":" HIGH ","score150":101}
                ]),
                "",
            );
            let (state, _) = state_with_replies(vec![
                Ok(valid_page(120.0)),
                Ok(page(json!([]), "")),
                Ok(duplicate),
            ]);
            let now = Instant::now();
            read_at(false, &state, now).await.unwrap();
            let empty = read_at(true, &state, now + Duration::from_secs(1))
                .await
                .unwrap();
            assert_eq!(empty["rows"], json!([]));
            assert_eq!(empty["status"], "latest");
            let stale = read_at(true, &state, now + Duration::from_secs(2))
                .await
                .unwrap();
            assert_eq!(stale["status"], "stale");
            assert_eq!(stale["rows"], empty["rows"]);
            assert_eq!(stale["fetched_at"], empty["fetched_at"]);
        });
    }

    #[test]
    fn cache_reuses_snapshot_and_manual_refresh_replaces_whole_snapshot() {
        tauri::async_runtime::block_on(async {
            let (state, calls) =
                state_with_replies(vec![Ok(valid_page(100.0)), Ok(valid_page(120.0))]);
            let now = Instant::now();
            let initial = read_at(false, &state, now).await.unwrap();
            let cached = read_at(false, &state, now + Duration::from_secs(1))
                .await
                .unwrap();
            assert_eq!(initial["status"], "latest");
            assert_eq!(cached["status"], "cached");
            assert_eq!(initial["rows"], cached["rows"]);
            assert_eq!(initial["fetched_at"], cached["fetched_at"]);
            let refreshed = read_at(true, &state, now + Duration::from_secs(2))
                .await
                .unwrap();
            assert_eq!(refreshed["status"], "latest");
            assert_eq!(refreshed["rows"][0]["score150"], 120.0);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn expired_cache_refreshes_at_ten_minutes() {
        tauri::async_runtime::block_on(async {
            let (state, calls) =
                state_with_replies(vec![Ok(valid_page(100.0)), Ok(valid_page(120.0))]);
            let now = Instant::now();
            read_at(false, &state, now).await.unwrap();
            assert_eq!(
                read_at(false, &state, now + Duration::from_secs(599))
                    .await
                    .unwrap()["status"],
                "cached"
            );
            assert_eq!(
                read_at(false, &state, now + Duration::from_secs(600))
                    .await
                    .unwrap()["status"],
                "latest"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn concurrent_forced_refreshes_share_one_network_read() {
        tauri::async_runtime::block_on(async {
            let calls = Arc::new(AtomicUsize::new(0));
            let reader_calls = calls.clone();
            let (release, gate) = tokio::sync::oneshot::channel::<()>();
            let gate = Arc::new(Mutex::new(Some(gate)));
            let state = RadarState::with_reader(Arc::new(move || {
                reader_calls.fetch_add(1, Ordering::SeqCst);
                let gate = gate.lock().unwrap().take().expect("duplicate network read");
                async move {
                    gate.await.unwrap();
                    Ok(valid_page(120.0))
                }
                .boxed()
            }));
            // Poll every caller while the upstream is held pending, then release
            // one result. A single yield could complete before later callers start.
            let (results, _) = futures_util::join!(
                join_all((0..12).map(|_| read_snapshot(true, &state))),
                async move {
                    release.send(()).unwrap();
                }
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let first = results[0].as_ref().unwrap();
            for result in &results {
                assert_eq!(result.as_ref().unwrap(), first);
            }
        });
    }

    #[test]
    fn failed_or_malformed_refresh_retains_exact_snapshot_and_stale_state() {
        tauri::async_runtime::block_on(async {
            let (state, calls) = state_with_replies(vec![
                Ok(valid_page(100.0)),
                Err("官网读取超时".into()),
                Ok("broken HTML".into()),
                Ok(valid_page(130.0)),
            ]);
            let now = Instant::now();
            let initial = read_at(false, &state, now).await.unwrap();
            for second in 1..=2 {
                let stale = read_at(true, &state, now + Duration::from_secs(second))
                    .await
                    .unwrap();
                assert_eq!(stale["status"], "stale");
                assert!(!stale["error"].as_str().unwrap().is_empty());
                for key in ["rows", "metadata", "fetched_at", "unsupported"] {
                    assert_eq!(stale[key], initial[key]);
                }
                let next = read_at(false, &state, now + Duration::from_secs(second))
                    .await
                    .unwrap();
                assert_eq!(next["status"], "stale");
                assert_eq!(next["error"], stale["error"]);
            }
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            let recovered = read_at(true, &state, now + Duration::from_secs(3))
                .await
                .unwrap();
            assert_eq!(recovered["status"], "latest");
            assert!(recovered.get("error").is_none());
        });
    }

    #[test]
    fn cold_failure_is_an_error_and_can_retry() {
        tauri::async_runtime::block_on(async {
            let (state, calls) =
                state_with_replies(vec![Err("HTTP 503".into()), Ok(valid_page(100.0))]);
            assert_eq!(read_snapshot(false, &state).await.unwrap_err(), "HTTP 503");
            assert_eq!(
                read_snapshot(false, &state).await.unwrap()["status"],
                "latest"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    #[ignore = "anonymous live website read; run explicitly"]
    fn live_snapshot_has_structure_without_fixed_results() {
        tauri::async_runtime::block_on(async {
            let snapshot = read_snapshot(true, &RadarState::default()).await.unwrap();
            let rows = snapshot["rows"].as_array().unwrap();
            assert!(!rows.is_empty());
            assert_eq!(snapshot["score_max"], 150);
            assert_eq!(snapshot["status"], "latest");
            assert!(snapshot["metadata"].is_object());
            assert!(snapshot["unsupported"].is_array());
            assert!(rows
                .iter()
                .all(|row| row["model"].as_str().unwrap().starts_with("gpt-6")));
            let models = rows
                .iter()
                .map(|row| row["model"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>();
            println!(
                "models={} rows={} status={}",
                models.len(),
                rows.len(),
                snapshot["status"].as_str().unwrap()
            );
        });
    }
}
