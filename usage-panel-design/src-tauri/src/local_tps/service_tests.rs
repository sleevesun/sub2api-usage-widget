use super::*;
use serde_json::json;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let base = std::env::temp_dir().join("sub2api-local-tps-tests");
        let path = base.join(format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("codex")).unwrap();
        fs::create_dir_all(path.join("app")).unwrap();
        fs::write(
            path.join("codex/config.toml"),
            "# test config\nmodel='gpt-6.1-sol'\n",
        )
        .unwrap();
        Self(path)
    }
    fn service(&self) -> LocalTps {
        LocalTps::new(Some(self.0.join("app")), Some(self.0.join("codex")))
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let base = std::env::temp_dir()
            .join("sub2api-local-tps-tests")
            .canonicalize()
            .unwrap();
        let path = self.0.canonicalize().unwrap();
        assert!(path.starts_with(base));
        let _ = fs::remove_dir_all(path);
    }
}

fn payload(at: i64) -> JsonValue {
    let records=[
        (200,"codex.api_request",None,Some(200),None),
        (205,"codex.sse_event",Some("response.created"),Some(5),None),
        (1000,"codex.sse_event",Some("response.completed"),Some(10),None),
        (1001,"codex.sse_event",Some("response.completed"),None,Some(100)),
    ].into_iter().map(|(offset,name,kind,duration,output)| {
        let mut attrs=vec![
            json!({"key":"event.name","value":{"stringValue":name}}),
            json!({"key":"event.timestamp","value":{"stringValue":chrono::DateTime::from_timestamp_millis(at+offset).unwrap().to_rfc3339()}}),
            json!({"key":"model","value":{"stringValue":"gpt-6.1-sol"}}),
            json!({"key":"conversation.id","value":{"stringValue":"PRIVATE_CONVERSATION"}}),
            json!({"key":"http.response.status_code","value":{"intValue":"200"}}),
            json!({"key":"prompt","value":{"stringValue":"PRIVATE_PROMPT"}}),
        ];
        if let Some(kind)=kind { attrs.push(json!({"key":"event.kind","value":{"stringValue":kind}})); }
        if let Some(duration)=duration { attrs.push(json!({"key":"duration_ms","value":{"intValue":duration.to_string()}})); }
        if let Some(output)=output { attrs.push(json!({"key":"output_token_count","value":{"intValue":output.to_string()}})); }
        json!({"attributes":attrs})
    }).collect::<Vec<_>>();
    json!({"resourceLogs":[{"scopeLogs":[{"logRecords":records}]}]})
}

#[test]
fn loopback_receives_metadata_persists_samples_and_restores_config() {
    let workspace = Workspace::new();
    let before = fs::read_to_string(workspace.0.join("codex/config.toml")).unwrap();
    let service = workspace.service();
    assert!(!service.snapshot("2026-11-13", "2026-11-13").enabled);
    service.set_enabled(true).unwrap();
    let port = service.control.lock().unwrap().settings.port;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _runtime_context = runtime.enter();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let start = now_ms() - 5000;
    let date = chrono::DateTime::from_timestamp_millis(start)
        .unwrap()
        .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d")
        .to_string();
    for _ in 0..2 {
        let response = runtime
            .block_on(
                client
                    .post(format!("http://127.0.0.1:{port}/v1/logs"))
                    .json(&payload(start))
                    .send(),
            )
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let snapshot = service.snapshot(&date, &date);
    assert!(snapshot.enabled);
    assert_eq!(snapshot.models.len(), 1);
    assert_eq!(snapshot.models[0].samples, 1);
    assert_eq!(snapshot.models[0].tps, 100.0);
    let persisted = fs::read_to_string(workspace.0.join("app/codex-tps-samples.json")).unwrap();
    assert!(!persisted.contains("PRIVATE_"));
    let denied = runtime
        .block_on(
            client
                .post(format!("http://127.0.0.1:{port}/v1/logs"))
                .header("Origin", "https://example.test")
                .json(&payload(start))
                .send(),
        )
        .unwrap();
    assert_eq!(denied.status(), 403);
    service.set_enabled(false).unwrap();
    assert_eq!(
        fs::read_to_string(workspace.0.join("codex/config.toml")).unwrap(),
        before
    );
    drop(service);
    let restored = workspace.service();
    assert!(!restored.snapshot(&date, &date).enabled);
    assert_eq!(restored.snapshot(&date, &date).models[0].samples, 1);
}

#[test]
fn existing_exporter_fails_without_modifying_codex() {
    let workspace = Workspace::new();
    let file = workspace.0.join("codex/config.toml");
    let config = "[otel]\nexporter={otlp-http={endpoint='https://example.test/logs'}}\n";
    fs::write(&file, config).unwrap();
    let service = workspace.service();
    assert!(service.set_enabled(true).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), config);
    assert!(!service.snapshot("2026-11-13", "2026-11-13").enabled);
}

#[test]
fn restart_reuses_port_and_samples_and_does_not_take_an_occupied_port() {
    let workspace = Workspace::new();
    let service = workspace.service();
    service.set_enabled(true).unwrap();
    let port = service.control.lock().unwrap().settings.port;
    drop(service);
    let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
    let blocked = workspace.service();
    assert_eq!(blocked.snapshot("2026-11-13", "2026-11-13").status, "error");
    assert!(blocked.snapshot("2026-11-13", "2026-11-13").enabled);
    drop(blocked);
    drop(occupied);
    let restarted = workspace.service();
    assert_eq!(
        restarted.snapshot("2026-11-13", "2026-11-13").status,
        "waiting"
    );
    restarted.set_enabled(false).unwrap();
    assert!(require_main("orb").is_err());
    assert!(require_main("main").is_ok());
}

#[test]
fn partial_replay_after_restart_keeps_saved_samples_until_known_invalid() {
    let workspace = Workspace::new();
    let file = workspace.0.join("app/codex-tps-samples.json");
    let start = now_ms() - 5000;
    let complete = payload(start);
    let service = workspace.service();
    service
        .data
        .lock()
        .unwrap()
        .ingest(&complete, &file)
        .unwrap();
    drop(service);

    let restarted = workspace.service();
    let mut data = restarted.data.lock().unwrap();
    assert_eq!(data.samples.len(), 1);
    assert!(data.events.is_empty());
    let mut partial = complete.clone();
    partial["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    data.ingest(&partial, &file).unwrap();
    assert_eq!(
        data.samples.len(),
        1,
        "API-only replay must not retract a saved sample"
    );
    data.ingest(&complete, &file).unwrap();
    assert_eq!(
        data.samples.len(),
        1,
        "full replay must not duplicate a saved sample"
    );
    assert_eq!(
        read_json::<StoredSamples>(&file)
            .unwrap()
            .unwrap()
            .samples
            .len(),
        1
    );
}

#[test]
fn late_invalidating_metadata_retracts_persisted_samples() {
    for (name, kind) in [
        ("codex.sse_event", Some("response.failed")),
        ("codex.api_request", None),
        ("codex.websocket_request", None),
    ] {
        let workspace = Workspace::new();
        let service = workspace.service();
        let file = workspace.0.join("app/codex-tps-samples.json");
        let start = now_ms() - 5000;
        let mut data = service.data.lock().unwrap();
        data.ingest(&payload(start), &file).unwrap();
        assert_eq!(data.samples.len(), 1);
        let mut attrs = vec![
            json!({"key":"event.name","value":{"stringValue":name}}),
            json!({"key":"event.timestamp","value":{"stringValue":chrono::DateTime::from_timestamp_millis(start+500).unwrap().to_rfc3339()}}),
            json!({"key":"model","value":{"stringValue":"gpt-6.1-sol"}}),
            json!({"key":"conversation.id","value":{"stringValue":"PRIVATE_CONVERSATION"}}),
            json!({"key":"http.response.status_code","value":{"intValue":"200"}}),
            json!({"key":"duration_ms","value":{"intValue":"100"}}),
        ];
        if let Some(kind) = kind {
            attrs.push(json!({"key":"event.kind","value":{"stringValue":kind}}));
        }
        let late = json!({"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":attrs}]}]}]});
        data.ingest(&late, &file).unwrap();
        assert!(
            data.samples.is_empty(),
            "late {name} {kind:?} must retract the sample"
        );
        let stored: StoredSamples = read_json(&file).unwrap().unwrap();
        assert!(
            stored.samples.is_empty(),
            "retraction must also be persisted"
        );
    }
}

#[test]
fn late_tool_metadata_retracts_samples_and_invalid_store_is_preserved() {
    let workspace = Workspace::new();
    let service = workspace.service();
    let file = workspace.0.join("app/codex-tps-samples.json");
    let start = now_ms() - 5000;
    service
        .data
        .lock()
        .unwrap()
        .ingest(&payload(start), &file)
        .unwrap();
    assert_eq!(service.data.lock().unwrap().samples.len(), 1);
    let tool = json!({"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[
        {"key":"event.name","value":{"stringValue":"codex.tool_result"}},
        {"key":"event.timestamp","value":{"stringValue":chrono::DateTime::from_timestamp_millis(start+2000).unwrap().to_rfc3339()}},
        {"key":"model","value":{"stringValue":"gpt-6.1-sol"}},
        {"key":"conversation.id","value":{"stringValue":"PRIVATE_CONVERSATION"}},
        {"key":"duration_ms","value":{"intValue":"1800"}}
    ]}]}]}]});
    service.data.lock().unwrap().ingest(&tool, &file).unwrap();
    assert!(service.data.lock().unwrap().samples.is_empty());
    drop(service);
    fs::write(&file, "invalid, preserve me").unwrap();
    let broken = workspace.service();
    assert!(broken.set_enabled(true).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "invalid, preserve me");
}

#[test]
#[ignore = "requires explicit local Codex executable; makes one short real model request"]
fn live_codex_metadata_reaches_production_receiver_without_changing_user_config() {
    use sha2::{Digest, Sha256};
    use std::process::{Command, Stdio};
    let executable =
        std::env::var("SUB2API_TPS_CODEX_EXE").expect("Set SUB2API_TPS_CODEX_EXE explicitly");
    let config_file = crate::codex_home().unwrap().join("config.toml");
    let config_hash = Sha256::digest(fs::read(&config_file).unwrap());
    let workspace = Workspace::new();
    let service = workspace.service();
    service.set_enabled(true).unwrap();
    let port = service.control.lock().unwrap().settings.port;
    let mut command = Command::new(executable);
    command
        .args([
            "exec",
            "--ephemeral",
            "--json",
            "--color",
            "never",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
        ])
        .arg(&workspace.0);
    for config in [
        format!(
            "otel.exporter={{otlp-http={{endpoint=\"{}\",protocol=\"json\"}}}}",
            LocalTps::endpoint(port)
        ),
        "otel.trace_exporter=\"none\"".into(),
        "otel.metrics_exporter=\"none\"".into(),
        "otel.log_user_prompt=false".into(),
        "otel.log_agent_responses=false".into(),
        "otel.log_guardian_assessments=false".into(),
        "otel.tool_result.max_bytes=0".into(),
        "model_reasoning_effort=\"low\"".into(),
        "mcp_servers={}".into(),
    ] {
        command.arg("-c").arg(config);
    }
    command.arg("Print the integers 1 through 80, separated by a single space. Do not use tools. Do not inspect files. Do not include any other text.")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .expect("Could not launch the configured Codex executable");
    let started = std::time::Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(90) {
            let _ = child.kill();
            panic!("Codex sampling timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "The real Codex request did not complete; private process output is not logged"
    );
    let usage = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<JsonValue>(line).ok())
        .filter_map(|event| event.get("usage")?.get("output_tokens")?.as_u64())
        .sum::<u64>();
    for _ in 0..20 {
        if !service.data.lock().unwrap().samples.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let data = service.data.lock().unwrap();
    assert!(
        !data.samples.is_empty(),
        "No complete supported request was received"
    );
    assert_eq!(
        data.samples.iter().map(|s| s.output_tokens).sum::<u64>(),
        usage,
        "Local sample output must match Codex's own usage"
    );
    let duration = data.samples.iter().map(|s| s.duration_ms).sum::<u64>();
    println!("Real production receiver: {} samples, {} output tokens, {} request ms; no user config changes",data.samples.len(),usage,duration);
    drop(data);
    assert_eq!(Sha256::digest(fs::read(config_file).unwrap()), config_hash);
    service.set_enabled(false).unwrap();
}
