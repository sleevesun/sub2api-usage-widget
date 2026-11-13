use serde::{Deserialize, Serialize};
use toml_edit::{value, Document, InlineTable, Item, Value};

const FLAGS: [&str; 3] = [
    "log_user_prompt",
    "log_agent_responses",
    "log_guardian_assessments",
];

// Only these non-secret values are backed up. An existing custom exporter,
// including any authentication headers, is never copied or replaced.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Backup {
    otel_existed: bool,
    exporter_was_none: bool,
    flags: [Option<bool>; 3],
    tool_result_existed: bool,
    max_bytes: Option<i64>,
}

fn parse(text: &str) -> Result<Document, String> {
    text.parse::<Document>()
        .map_err(|_| "Codex config.toml 格式无效，未修改配置".into())
}

fn path<'a>(document: &'a Document, keys: &[&str]) -> Option<&'a Item> {
    let mut item = document.get(keys[0])?;
    for key in &keys[1..] {
        item = item.as_table_like()?.get(key)?;
    }
    Some(item)
}

#[cfg(test)]
fn get<const N: usize>(text: &str, keys: [&str; N]) -> Option<toml::Value> {
    let mut value: toml::Value = toml::from_str(text).ok()?;
    for key in keys {
        value = value.get(key)?.clone();
    }
    Some(value)
}

fn exporter(endpoint: &str) -> Item {
    let mut http = InlineTable::new();
    http.insert("endpoint", Value::from(endpoint));
    http.insert("protocol", Value::from("json"));
    let mut exporter = InlineTable::new();
    exporter.insert("otlp-http", Value::InlineTable(http));
    value(exporter)
}

pub(super) fn managed(text: &str, endpoint: &str) -> bool {
    let Ok(actual) = toml::from_str::<toml::Value>(text) else {
        return false;
    };
    let Ok(expected) = toml::from_str::<toml::Value>(&format!("exporter = {}", exporter(endpoint)))
    else {
        return false;
    };
    actual.get("otel").and_then(|v| v.get("exporter")) == expected.get("exporter")
}

pub(super) fn enable(text: &str, endpoint: &str) -> Result<(String, Backup), String> {
    let mut document = parse(text)?;
    if document
        .get("otel")
        .is_some_and(|item| item.as_table_like().is_none())
    {
        return Err("Codex 的 otel 配置不是表格，未修改配置".into());
    }
    let previous_exporter = path(&document, &["otel", "exporter"]);
    if previous_exporter.is_some_and(|item| item.as_str() != Some("none")) {
        return Err(
            "Codex 已配置其他遥测目标，未替换。请保留现有配置，或自行停用后再开启本机 TPS".into(),
        );
    }
    let mut flags = [None; 3];
    for (index, key) in FLAGS.iter().enumerate() {
        if let Some(item) = path(&document, &["otel", key]) {
            flags[index] = Some(
                item.as_bool()
                    .ok_or("Codex 的遥测内容开关格式无效，未修改配置")?,
            );
        }
    }
    let tool_result = path(&document, &["otel", "tool_result"]);
    if tool_result.is_some_and(|item| item.as_table_like().is_none()) {
        return Err("Codex 的 tool_result 配置格式无效，未修改配置".into());
    }
    let max_bytes = path(&document, &["otel", "tool_result", "max_bytes"])
        .map(|item| {
            item.as_integer()
                .ok_or("Codex 的工具输出长度配置无效，未修改配置")
        })
        .transpose()?;
    let backup = Backup {
        otel_existed: document.contains_key("otel"),
        exporter_was_none: previous_exporter.is_some(),
        flags,
        tool_result_existed: tool_result.is_some(),
        max_bytes,
    };
    document["otel"]["exporter"] = exporter(endpoint);
    for key in FLAGS {
        document["otel"][key] = value(false);
    }
    document["otel"]["tool_result"]["max_bytes"] = value(0);
    Ok((document.to_string(), backup))
}

pub(super) fn restore(
    text: &str,
    endpoint: &str,
    backup: &Backup,
) -> Result<(String, bool), String> {
    if !managed(text, endpoint) {
        return Ok((text.to_string(), false));
    }
    let mut document = parse(text)?;
    let otel = document["otel"]
        .as_table_like_mut()
        .ok_or("Codex 遥测配置已改变，未恢复")?;
    if backup.exporter_was_none {
        otel.insert("exporter", value("none"));
    } else {
        otel.remove("exporter");
    }
    for (index, key) in FLAGS.iter().enumerate() {
        if otel.get(key).and_then(Item::as_bool) == Some(false) {
            if let Some(previous) = backup.flags[index] {
                otel.insert(key, value(previous));
            } else {
                otel.remove(key);
            }
        }
    }
    if let Some(tool) = otel
        .get_mut("tool_result")
        .and_then(Item::as_table_like_mut)
    {
        if tool.get("max_bytes").and_then(Item::as_integer) == Some(0) {
            if let Some(previous) = backup.max_bytes {
                tool.insert("max_bytes", value(previous));
            } else {
                tool.remove("max_bytes");
            }
        }
        if !backup.tool_result_existed && tool.is_empty() {
            otel.remove("tool_result");
        }
    }
    if !backup.otel_existed && otel.is_empty() {
        document.remove("otel");
    }
    Ok((document.to_string(), true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_and_disable_preserve_comments_unrelated_settings_and_user_changes() {
        let before="# keep this comment\nmodel = 'gpt-6.1-sol'\n[otel]\nlog_user_prompt = true\n[otel.tool_result]\nmax_bytes = 512\n[features]\napps = true\n";
        let endpoint = "http://127.0.0.1:43817/v1/logs";
        let (enabled, backup) = enable(before, endpoint).unwrap();
        assert!(enabled.contains("# keep this comment"));
        assert!(managed(&enabled, endpoint));
        assert_eq!(
            get(&enabled, ["otel", "log_user_prompt"])
                .unwrap()
                .as_bool(),
            Some(false)
        );
        let changed = enabled.replace("apps = true", "apps = false");
        let (restored, owned) = restore(&changed, endpoint, &backup).unwrap();
        assert!(owned);
        assert!(restored.contains("apps = false"));
        assert_eq!(
            get(&restored, ["otel", "log_user_prompt"])
                .unwrap()
                .as_bool(),
            Some(true)
        );
        assert_eq!(
            get(&restored, ["otel", "tool_result", "max_bytes"])
                .unwrap()
                .as_integer(),
            Some(512)
        );
        assert!(get(&restored, ["otel", "exporter"]).is_none());
    }

    #[test]
    fn third_party_exporters_and_invalid_configs_are_never_replaced() {
        assert!(enable("[otel]\nexporter={otlp-http={endpoint='https://example.test/logs',headers={authorization='PRIVATE_SENTINEL'}}}","http://127.0.0.1:43817/v1/logs").is_err());
        assert!(enable(
            "[otel]\nlog_user_prompt = 'invalid'",
            "http://127.0.0.1:43817/v1/logs"
        )
        .is_err());
        assert!(enable("broken = [", "http://127.0.0.1:43817/v1/logs").is_err());
        let (enabled, backup) =
            enable("model='gpt-6'\n", "http://127.0.0.1:43817/v1/logs").unwrap();
        assert!(!serde_json::to_string(&backup).unwrap().contains("PRIVATE_"));
        let changed = enabled.replace("43817", "43818");
        let (restored, owned) =
            restore(&changed, "http://127.0.0.1:43817/v1/logs", &backup).unwrap();
        assert!(!owned);
        assert_eq!(restored, changed);
        let (restored, owned) =
            restore(&enabled, "http://127.0.0.1:43817/v1/logs", &backup).unwrap();
        assert!(owned);
        assert!(!restored.contains("[otel"));
    }
}
