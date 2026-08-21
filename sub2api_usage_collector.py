#!/usr/bin/env python3
"""Collect Sub2API key usage snapshots.

Configuration is read from a JSON file. The script writes:
- usage_snapshots.jsonl: full raw snapshots, one line per key per run
- usage_summary.csv: flattened summary rows for spreadsheets or alerts
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as f:
        config = json.load(f)
    if not config.get("base_url"):
        raise ValueError("config.base_url is required")
    if not isinstance(config.get("keys"), list) or not config["keys"]:
        raise ValueError("config.keys must be a non-empty list")
    return config


def get_json(url: str, api_key: str, timeout: int) -> dict[str, Any]:
    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "sub2api-usage-collector/1.0",
        },
        method="GET",
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"request failed: {exc.reason}") from exc
    return json.loads(body)


def nested(data: dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def summary_row(collected_at: str, key_name: str, usage: dict[str, Any]) -> dict[str, Any]:
    quota = usage.get("quota") if isinstance(usage.get("quota"), dict) else {}
    subscription = usage.get("subscription") if isinstance(usage.get("subscription"), dict) else {}
    total = nested(usage, "usage.total", {}) or {}
    today = nested(usage, "usage.today", {}) or {}
    return {
        "collected_at": collected_at,
        "key_name": key_name,
        "is_valid": usage.get("isValid", usage.get("is_active")),
        "mode": usage.get("mode"),
        "status": usage.get("status"),
        "unit": usage.get("unit") or quota.get("unit"),
        "quota_limit": quota.get("limit"),
        "quota_used": quota.get("used"),
        "quota_remaining": quota.get("remaining", usage.get("remaining")),
        "balance": usage.get("balance"),
        "daily_limit_usd": subscription.get("daily_limit_usd"),
        "daily_usage_usd": subscription.get("daily_usage_usd"),
        "weekly_limit_usd": subscription.get("weekly_limit_usd"),
        "weekly_usage_usd": subscription.get("weekly_usage_usd"),
        "monthly_limit_usd": subscription.get("monthly_limit_usd"),
        "monthly_usage_usd": subscription.get("monthly_usage_usd"),
        "total_requests": total.get("requests"),
        "total_tokens": total.get("total_tokens"),
        "total_actual_cost": total.get("actual_cost"),
        "today_requests": today.get("requests"),
        "today_tokens": today.get("total_tokens"),
        "today_actual_cost": today.get("actual_cost"),
        "rpm": nested(usage, "usage.rpm"),
        "tpm": nested(usage, "usage.tpm"),
    }


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def append_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    exists = path.exists()
    encoding = "utf-8-sig" if not exists else "utf-8"
    with path.open("a", encoding=encoding, newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        if not exists:
            writer.writeheader()
        writer.writerows(rows)


def mask_key(api_key: str) -> str:
    if len(api_key) <= 12:
        return "***"
    return f"{api_key[:7]}...{api_key[-6:]}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect usage snapshots from Sub2API /v1/usage.")
    parser.add_argument("--config", default="sub2api_usage_config.json", help="JSON config file path")
    parser.add_argument("--output-dir", default=None, help="Override output directory")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds")
    args = parser.parse_args()

    config_path = Path(args.config)
    config = load_config(config_path)
    base_url = str(config["base_url"]).rstrip("/") + "/"
    output_dir = Path(args.output_dir or config.get("output_dir") or ".")
    output_dir.mkdir(parents=True, exist_ok=True)

    collected_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict[str, Any]] = []
    failures = 0
    usage_url = urljoin(base_url, "v1/usage")

    for item in config["keys"]:
        name = str(item.get("name") or mask_key(str(item.get("key", ""))))
        api_key = str(item.get("key") or "")
        if not api_key:
            print(f"[WARN] skip {name}: missing key", file=sys.stderr)
            failures += 1
            continue
        try:
            usage = get_json(usage_url, api_key, args.timeout)
            append_jsonl(
                output_dir / "usage_snapshots.jsonl",
                {"collected_at": collected_at, "key_name": name, "usage": usage},
            )
            rows.append(summary_row(collected_at, name, usage))
            remaining = rows[-1].get("quota_remaining") or rows[-1].get("balance")
            print(f"[OK] {name}: status={usage.get('status')} remaining={remaining}")
        except Exception as exc:
            failures += 1
            append_jsonl(
                output_dir / "usage_snapshots.jsonl",
                {"collected_at": collected_at, "key_name": name, "error": str(exc)},
            )
            print(f"[ERROR] {name}: {exc}", file=sys.stderr)

    append_csv(output_dir / "usage_summary.csv", rows)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
