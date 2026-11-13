use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

// This internal type is never serialized or logged. Conversation IDs are used
// only to associate transport events in memory; only Sample is persisted.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Event {
    pub at_ms: i64,
    pub name: String,
    pub kind: Option<String>,
    pub conversation: String,
    pub model: String,
    pub duration_ms: Option<u64>,
    pub output_tokens: Option<u64>,
    pub status: Option<u64>,
    pub failed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Sample {
    pub id: String,
    pub model: String,
    pub completed_at_ms: i64,
    pub output_tokens: u64,
    pub duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelTps {
    pub model: String,
    pub samples: usize,
    pub output_tokens: u64,
    pub duration_ms: u64,
    pub first_sample_at_ms: i64,
    pub last_sample_at_ms: i64,
    pub tps: f64,
}

#[derive(Default)]
pub(super) struct Analysis {
    pub samples: Vec<Sample>,
    pub evaluated_ids: HashSet<String>,
}

pub(super) fn model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}

fn integer(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse::<u64>().ok())
        .filter(|n| *n <= 9_007_199_254_740_991)
}

pub(super) fn normalize(payload: &Value) -> Vec<Event> {
    let mut events = Vec::new();
    let Some(resources) = payload.get("resourceLogs").and_then(Value::as_array) else {
        return events;
    };
    for resource in resources {
        let Some(scopes) = resource.get("scopeLogs").and_then(Value::as_array) else {
            continue;
        };
        for scope in scopes {
            let Some(records) = scope.get("logRecords").and_then(Value::as_array) else {
                continue;
            };
            for record in records {
                let Some(attrs) = record.get("attributes").and_then(Value::as_array) else {
                    continue;
                };
                let attrs: HashMap<&str, &Value> = attrs
                    .iter()
                    .filter_map(|attr| {
                        let value = attr.get("value")?;
                        Some((
                            attr.get("key")?.as_str()?,
                            value
                                .get("stringValue")
                                .or_else(|| value.get("intValue"))
                                .or_else(|| value.get("doubleValue"))
                                .or_else(|| value.get("boolValue"))?,
                        ))
                    })
                    .collect();
                let text = |name: &str| attrs.get(name).and_then(|v| v.as_str());
                let Some(name) = text("event.name").filter(|name| {
                    matches!(
                        *name,
                        "codex.api_request"
                            | "codex.sse_event"
                            | "codex.websocket_request"
                            | "codex.websocket_event"
                            | "codex.tool_decision"
                            | "codex.tool_result"
                    )
                }) else {
                    continue;
                };
                let Some(model) = text("model").filter(|v| model_id(v)) else {
                    continue;
                };
                let Some(conversation) =
                    text("conversation.id").filter(|v| !v.is_empty() && v.len() <= 256)
                else {
                    continue;
                };
                let Some(at_ms) = text("event.timestamp")
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|time| time.timestamp_millis())
                else {
                    continue;
                };
                events.push(Event {
                    at_ms,
                    name: name.into(),
                    model: model.to_ascii_lowercase(),
                    conversation: conversation.into(),
                    kind: text("event.kind")
                        .filter(|v| model_id(v))
                        .map(str::to_string),
                    duration_ms: integer(attrs.get("duration_ms").copied()),
                    output_tokens: integer(attrs.get("output_token_count").copied()),
                    status: integer(attrs.get("http.response.status_code").copied()),
                    failed: attrs.get("success").and_then(|v| v.as_bool()) == Some(false),
                });
            }
        }
    }
    events
}

struct Request {
    id: String,
    model: String,
    start: i64,
    api_at: i64,
    created: Option<i64>,
    end: Option<i64>,
    ambiguous: bool,
    tool: bool,
}

fn rank(event: &Event) -> u8 {
    if event.name == "codex.api_request" {
        0
    } else if event.kind.as_deref() == Some("response.created") {
        1
    } else if event.kind.as_deref() == Some("response.completed") {
        if event.output_tokens.is_some() {
            4
        } else {
            3
        }
    } else {
        2
    }
}

pub(super) fn analyze(events: &[Event]) -> Analysis {
    let mut analysis = Analysis::default();
    let mut seen = HashSet::new();
    let mut ordered: Vec<_> = events.iter().filter(|event| seen.insert(*event)).collect();
    ordered.sort_by_key(|e| (e.at_ms, rank(e)));
    let mut tools: HashMap<&str, Vec<(i64, i64)>> = HashMap::new();
    for event in &ordered {
        if matches!(
            event.name.as_str(),
            "codex.tool_decision" | "codex.tool_result"
        ) {
            let duration = event.duration_ms.unwrap_or(0).min(86_400_000) as i64;
            tools
                .entry(&event.conversation)
                .or_default()
                .push((event.at_ms - duration, event.at_ms));
        }
    }
    let mut active: HashMap<&str, Request> = HashMap::new();
    for event in ordered {
        let key = event.conversation.as_str();
        if event.name.starts_with("codex.websocket_") {
            if let Some(request) = active.remove(key) {
                analysis.evaluated_ids.insert(request.id);
            }
            continue;
        }
        if event.name == "codex.api_request" {
            let identity = event
                .duration_ms
                .filter(|duration| *duration <= 21_600_000)
                .map(|duration| {
                    let start = event.at_ms - duration as i64;
                    let id = format!(
                        "{:x}",
                        Sha256::digest(format!("{key}|{}|{start}|{}", event.model, event.at_ms))
                    );
                    (start, id)
                });
            if event.failed || !matches!(event.status, Some(200..=299)) || identity.is_none() {
                if let Some(request) = active.remove(key) {
                    analysis.evaluated_ids.insert(request.id);
                }
                if let Some((_, id)) = identity {
                    analysis.evaluated_ids.insert(id);
                }
                continue;
            }
            let (start, id) = identity.unwrap();
            // API-only replay after a restart is still pending. Reconcile a
            // saved sample only on a full completion or explicit invalidation.
            let ambiguous = if let Some(previous) = active.remove(key) {
                analysis.evaluated_ids.insert(previous.id);
                analysis.evaluated_ids.insert(id.clone());
                true
            } else {
                false
            };
            active.insert(
                key,
                Request {
                    id,
                    model: event.model.clone(),
                    start,
                    api_at: event.at_ms,
                    created: None,
                    end: None,
                    ambiguous,
                    tool: false,
                },
            );
            continue;
        }
        if event.name != "codex.sse_event" {
            continue;
        }
        if event.failed
            || matches!(
                event.kind.as_deref(),
                Some("response.failed" | "response.incomplete" | "error")
            )
        {
            if let Some(request) = active.remove(key) {
                analysis.evaluated_ids.insert(request.id);
            }
            continue;
        }
        let Some(request) = active.get_mut(key) else {
            continue;
        };
        if event.model != request.model {
            request.ambiguous = true;
        }
        if event.kind.as_deref() == Some("response.created") {
            if request.created.replace(event.at_ms).is_some() {
                request.ambiguous = true;
            }
        }
        if event.kind.as_deref() == Some("response.function_call_arguments.delta") {
            request.tool = true;
        }
        if request.ambiguous || request.tool {
            analysis.evaluated_ids.insert(request.id.clone());
        }
        if event.kind.as_deref() != Some("response.completed") {
            continue;
        }
        if event.duration_ms.is_some() {
            request.end.get_or_insert(event.at_ms);
        }
        let Some(output_tokens) = event.output_tokens else {
            continue;
        };
        let request = active.remove(key).unwrap();
        let Some(end) = request.end else { continue };
        analysis.evaluated_ids.insert(request.id.clone());
        let has_tools = tools.get(key).is_some_and(|tools| {
            tools
                .iter()
                .any(|(start, finish)| *start <= event.at_ms && *finish >= request.start)
        });
        if request.ambiguous
            || request.tool
            || has_tools
            || request.model != event.model
            || request
                .created
                .is_none_or(|created| created < request.api_at || created > end)
            || end < request.api_at
            || end > event.at_ms
            || end <= request.start
            || end - request.start > 21_600_000
            || output_tokens == 0
            || output_tokens > 1_000_000_000
        {
            continue;
        }
        analysis.samples.push(Sample {
            id: request.id,
            model: event.model.clone(),
            completed_at_ms: end,
            output_tokens,
            duration_ms: (end - request.start) as u64,
        });
    }
    analysis
}

pub(super) fn aggregate(samples: &[Sample], start: &str, end: &str) -> Vec<ModelTps> {
    let offset = FixedOffset::east_opt(8 * 3600).unwrap();
    let mut models = BTreeMap::new();
    for sample in samples {
        let Some(completed) = DateTime::from_timestamp_millis(sample.completed_at_ms) else {
            continue;
        };
        let date = completed
            .with_timezone(&offset)
            .format("%Y-%m-%d")
            .to_string();
        if date.as_str() < start || date.as_str() > end || sample.duration_ms == 0 {
            continue;
        }
        let model_key = sample.model.to_ascii_lowercase();
        let model = models.entry(model_key.clone()).or_insert(ModelTps {
            model: model_key,
            samples: 0,
            output_tokens: 0,
            duration_ms: 0,
            first_sample_at_ms: sample.completed_at_ms,
            last_sample_at_ms: sample.completed_at_ms,
            tps: 0.0,
        });
        model.samples += 1;
        model.output_tokens += sample.output_tokens;
        model.duration_ms += sample.duration_ms;
        model.first_sample_at_ms = model.first_sample_at_ms.min(sample.completed_at_ms);
        model.last_sample_at_ms = model.last_sample_at_ms.max(sample.completed_at_ms);
        model.tps = model.output_tokens as f64 * 1000.0 / model.duration_ms as f64;
    }
    models.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn wire(rows: Vec<Value>) -> Value {
        json!({"resourceLogs":[{"scopeLogs":[{"logRecords":rows.into_iter().map(|attrs| {
            json!({"body":{"stringValue":"PRIVATE_BODY"},"attributes":attrs.as_object().unwrap().iter().map(|(key,value)| {
                json!({"key":key,"value":if value.is_number(){json!({"intValue":value.to_string()})}else{json!({"stringValue":value})}})
            }).collect::<Vec<_>>()})
        }).collect::<Vec<_>>()}]}]})
    }

    fn request(start: i64, tokens: u64) -> Vec<Event> {
        [
            (start + 200, "codex.api_request", None, Some(200), None),
            (
                start + 205,
                "codex.sse_event",
                Some("response.created"),
                Some(5),
                None,
            ),
            (
                start + 300,
                "codex.sse_event",
                Some("response.output_text.delta"),
                Some(95),
                None,
            ),
            (
                start + 1000,
                "codex.sse_event",
                Some("response.completed"),
                Some(10),
                None,
            ),
            (
                start + 1001,
                "codex.sse_event",
                Some("response.completed"),
                None,
                Some(tokens),
            ),
        ]
        .into_iter()
        .map(|(at_ms, name, kind, duration_ms, output_tokens)| Event {
            at_ms,
            name: name.into(),
            kind: kind.map(str::to_string),
            duration_ms,
            output_tokens,
            conversation: "private-thread".into(),
            model: "gpt-6.1-sol".into(),
            status: Some(200),
            failed: false,
        })
        .collect()
    }

    #[test]
    fn whitelist_discards_personal_content_and_preserves_completion_metadata() {
        let payload = wire(vec![
            json!({"event.name":"codex.sse_event","event.timestamp":"2026-11-13T00:00:00Z",
            "event.kind":"response.completed","model":"gpt-6.1-sol","conversation.id":"private-thread",
            "output_token_count":100,"reasoning_token_count":20,"user.email":"PRIVATE_EMAIL",
            "prompt":"PRIVATE_PROMPT","authorization":"PRIVATE_AUTH"}),
        ]);
        let events = normalize(&payload);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].output_tokens, Some(100));
        assert_eq!(events[0].at_ms, 1794528000000);
        assert!(!format!("{events:?}").contains("PRIVATE_"));
        assert!(normalize(&json!(null)).is_empty());
    }

    #[test]
    fn pairs_transport_and_usage_once_without_double_counting_reasoning() {
        let rows = request(10000, 100);
        let analysis = analyze(&rows);
        assert_eq!(analysis.samples.len(), 1);
        assert_eq!(analysis.samples[0].duration_ms, 1000);
        assert_eq!(analysis.samples[0].output_tokens, 100);
        assert!(!serde_json::to_string(&analysis.samples)
            .unwrap()
            .contains("private-thread"));
        let mut repeated = rows.clone();
        repeated.extend(rows);
        repeated.reverse();
        assert_eq!(analyze(&repeated).samples, analysis.samples);
    }

    #[test]
    fn rejects_tools_failures_ambiguity_and_incomplete_responses() {
        let mut tool = request(10000, 100);
        tool[2].kind = Some("response.function_call_arguments.delta".into());
        assert!(analyze(&tool).samples.is_empty());
        let mut overlapping_tool = request(10000, 100);
        let mut result = overlapping_tool[0].clone();
        result.name = "codex.tool_result".into();
        result.at_ms = 12000;
        result.duration_ms = Some(1800);
        result.output_tokens = None;
        overlapping_tool.push(result);
        let dropped = analyze(&overlapping_tool);
        assert!(dropped.samples.is_empty());
        assert_eq!(
            dropped.evaluated_ids.len(),
            1,
            "Late tool metadata must retract a previously accepted sample"
        );
        let mut failed = request(10000, 100);
        failed[3].failed = true;
        assert!(analyze(&failed).samples.is_empty());
        let mut ambiguous = request(10000, 100);
        let mut extra = ambiguous[0].clone();
        extra.at_ms += 50;
        ambiguous.push(extra);
        assert!(analyze(&ambiguous).samples.is_empty());
        assert!(analyze(&request(10000, 100)[..3]).samples.is_empty());
        let mut mismatch = request(10000, 100);
        mismatch[4].model = "gpt-6-astra".into();
        assert!(analyze(&mismatch).samples.is_empty());
        let mut websocket = request(10000, 100);
        websocket[0].name = "codex.websocket_request".into();
        assert!(analyze(&websocket).samples.is_empty());
    }

    #[test]
    fn normalizes_mixed_case_model_identifiers_before_pairing() {
        let payload = wire(request(10000, 100).into_iter().map(|event| {
            json!({
                "event.name": event.name,
                "event.timestamp": DateTime::from_timestamp_millis(event.at_ms).unwrap().to_rfc3339(),
                "event.kind": event.kind,
                "model": if event.name == "codex.api_request" { "GPT-6.1-SOL" } else { "gpt-6.1-sol" },
                "conversation.id": event.conversation,
                "duration_ms": event.duration_ms,
                "output_token_count": event.output_tokens,
                "http.response.status_code": event.status,
            })
        }).collect());
        let rows = normalize(&payload);
        assert_eq!(analyze(&rows).samples.len(), 1);
        assert!(rows.iter().all(|event| event.model == "gpt-6.1-sol"));
    }

    #[test]
    fn aggregates_mixed_case_saved_models_into_one_weighted_row() {
        let midnight = DateTime::parse_from_rfc3339("2026-11-12T16:00:00Z")
            .unwrap()
            .timestamp_millis();
        let mut samples = analyze(&request(midnight + 1000, 100)).samples;
        let mut second = analyze(&request(midnight + 5000, 50)).samples.remove(0);
        second.model = "GPT-6.1-SOL".into();
        second.duration_ms = 2000;
        samples.push(second);
        let models = aggregate(&samples, "2026-11-13", "2026-11-13");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model, "gpt-6.1-sol");
        assert_eq!(models[0].samples, 2);
        assert_eq!(models[0].tps, 50.0);
    }

    #[test]
    fn aggregates_by_exact_model_completion_date_and_total_duration() {
        let midnight = chrono::DateTime::parse_from_rfc3339("2026-11-12T16:00:00Z")
            .unwrap()
            .timestamp_millis();
        let mut samples = analyze(&request(midnight - 1500, 100)).samples;
        samples.extend(analyze(&request(midnight + 1000, 100)).samples);
        let mut slow = analyze(&request(midnight + 5000, 50)).samples.remove(0);
        slow.duration_ms = 2000;
        samples.push(slow);
        let today = aggregate(&samples, "2026-11-13", "2026-11-13");
        assert_eq!(today.len(), 1);
        assert_eq!(today[0].samples, 2);
        assert_eq!(today[0].output_tokens, 150);
        assert_eq!(today[0].duration_ms, 3000);
        assert_eq!(today[0].tps, 50.0);
        assert_eq!(
            aggregate(&samples, "2026-11-12", "2026-11-12")[0].samples,
            1
        );
        assert!(aggregate(&samples, "2026-11-14", "2026-11-14").is_empty());
    }
}
