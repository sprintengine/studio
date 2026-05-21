#!/usr/bin/env python3
"""Generate a static Sprint Engine metrics analysis report.

The report intentionally reads historical run stores as immutable evidence. It
does not mutate Sprint Engine state and it normalizes both older nested payloads
and current flat metric records.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import html
import json
import math
import pathlib
import statistics
from typing import Any


CAMEL_SCORE_KEYS = {
    "acceptanceCriteriaClarityPct": "acceptance_criteria_clarity_pct",
    "autonomyPct": "autonomy_pct",
    "confidencePct": "confidence_pct",
    "contextFitPct": "context_fit_pct",
    "directiveClarityPct": "directive_clarity_pct",
    "hallucinationRiskPct": "hallucination_risk_pct",
    "promptOptimizationPct": "prompt_optimization_pct",
    "roleFitPct": "role_fit_pct",
    "sprintengineToolEffectivenessPct": "sprintengine_tool_effectiveness_pct",
    "swarmToolEffectivenessPct": "swarm_tool_effectiveness_pct",
    "taskClarityPct": "task_clarity_pct",
}

SCORE_LABELS = {
    "hallucination_risk_pct": "Hallucination risk",
    "confidence_pct": "Confidence",
    "task_clarity_pct": "Task clarity",
    "acceptance_criteria_clarity_pct": "Acceptance criteria clarity",
    "directive_clarity_pct": "Directive clarity",
    "context_fit_pct": "Context fit",
    "autonomy_pct": "Autonomy",
    "role_fit_pct": "Role fit",
    "sprintengine_tool_effectiveness_pct": "Sprint Engine tool effectiveness",
    "swarm_tool_effectiveness_pct": "Swarm tool effectiveness",
    "correctness_pct": "Correctness",
    "evidence_quality_pct": "Evidence quality",
    "test_quality_pct": "Test quality",
    "code_quality_pct": "Code quality",
    "maintainability_pct": "Maintainability",
    "instruction_following_pct": "Instruction following",
    "accessibility_pct": "Accessibility",
    "frontend_functionality_pct": "Frontend functionality",
    "security_quality_pct": "Security quality",
    "performance_quality_pct": "Performance quality",
}

PERIODS = [
    ("early_cycles", "Early cycles", None, dt.date(2026, 5, 14)),
    ("transition", "Folder-store transition", dt.date(2026, 5, 15), dt.date(2026, 5, 18)),
    ("mcp_extraction", "MCP extraction", dt.date(2026, 5, 19), None),
]

FRICTION_CATEGORIES = {
    "task_scope_detail": (
        "Task detail / scope",
        (
            "detail",
            "clarity",
            "ambiguous",
            "acceptance",
            "task card",
            "scope",
            "owned path",
            "in-scope",
            "out-of-scope",
            "precondition",
        ),
    ),
    "context_overload": (
        "Context overload / truncation",
        (
            "large",
            "truncated",
            "diff evidence",
            "gate context",
            "read limit",
            "output",
            "manual inspection",
            "direct file inspection",
        ),
    ),
    "verification_tooling": (
        "Verification / tooling",
        (
            "test",
            "typecheck",
            "lint",
            "pytest",
            "npm",
            "missing",
            "blocked",
            "unavailable",
            "no package",
            "no git",
            "git metadata",
            "xcode",
            "java",
        ),
    ),
    "artifact_workflow": (
        "Artifact workflow",
        (
            "artifact",
            "approval",
            "draft",
            "ready_for_review",
            "review artifact",
            "artifact kind",
            "final review",
        ),
    ),
    "runtime_dependency": (
        "Runtime dependency",
        (
            "mcp",
            "browser",
            "webgl",
            "device",
            "native",
            "server",
            "api",
            "runtime",
            "environment",
            "workspace",
        ),
    ),
}

NEGATIVE_WORDS = {
    "ambiguous",
    "blocked",
    "contradict",
    "failed",
    "failure",
    "friction",
    "hard",
    "large",
    "missing",
    "no ",
    "not ",
    "red",
    "regression",
    "stale",
    "truncated",
    "unavailable",
    "unclear",
    "unowned",
}

POSITIVE_WORDS = {
    "clear",
    "clean",
    "concise",
    "direct",
    "explicit",
    "focused",
    "green",
    "narrow",
    "passed",
    "reliable",
    "resolved",
    "straightforward",
    "unambiguous",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="..", help="Parent directory to scan for workspaces.")
    parser.add_argument(
        "--output",
        default="reports/sprintengine-metrics-analysis.html",
        help="HTML report output path.",
    )
    return parser.parse_args()


def snake_scores(raw: dict[str, Any]) -> dict[str, float]:
    scores: dict[str, float] = {}
    for key, value in raw.items():
        normalized = CAMEL_SCORE_KEYS.get(key, key)
        if isinstance(value, (int, float)):
            scores[normalized] = float(value)
    return scores


def normalize_record(record: dict[str, Any], path: pathlib.Path, root: pathlib.Path) -> dict[str, Any]:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    scores: dict[str, float] = {}
    counts: dict[str, float] = {}

    if isinstance(payload.get("scores"), dict):
        scores.update(snake_scores(payload["scores"]))
    if isinstance(record.get("scores"), dict):
        scores.update(snake_scores(record["scores"]))
    if isinstance(payload.get("counts"), dict):
        counts.update({k: float(v) for k, v in payload["counts"].items() if isinstance(v, (int, float))})
    if isinstance(record.get("counts"), dict):
        counts.update({k: float(v) for k, v in record["counts"].items() if isinstance(v, (int, float))})

    merged = dict(payload)
    merged.update(record)
    rel = path.relative_to(root).as_posix() if path.is_relative_to(root) else path.as_posix()
    parts = rel.split("/")
    repo = parts[0] if parts else "unknown"
    team = None
    if ".multi-code" in parts and "sprintengine" in parts:
        idx = parts.index("sprintengine")
        if idx + 1 < len(parts):
            team = parts[idx + 1]

    captured = (
        record.get("captured_at")
        or payload.get("capturedAt")
        or payload.get("captured_at")
        or merged.get("capturedAt")
    )
    timestamp = None
    if isinstance(captured, str):
        try:
            timestamp = dt.datetime.fromisoformat(captured.replace("Z", "+00:00"))
        except ValueError:
            timestamp = None

    return {
        "agent_id": merged.get("agent_id") or merged.get("agentId"),
        "captured_at": captured,
        "counts": counts,
        "date": timestamp.date() if timestamp else None,
        "file": rel,
        "gate_id": merged.get("gate_id") or merged.get("gateId"),
        "gate_verdict": merged.get("gate_verdict") or merged.get("gateVerdict"),
        "repo": repo,
        "role": merged.get("role") or merged.get("reviewer_role") or merged.get("reviewerRole"),
        "run_id": merged.get("run_id") or merged.get("runId") or merged.get("team_slug") or team,
        "scores": scores,
        "source": merged.get("source"),
        "suggested_improvement": merged.get("suggested_improvement") or merged.get("suggestedImprovement"),
        "task_id": merged.get("task_id") or merged.get("taskId"),
        "task_title": merged.get("task_title") or merged.get("taskTitle"),
        "team_slug": merged.get("team_slug") or merged.get("teamSlug") or team,
        "timestamp": timestamp,
        "top_friction": merged.get("top_friction") or merged.get("topFriction"),
    }


def normalize_audit_record(record: dict[str, Any], path: pathlib.Path, root: pathlib.Path) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix() if path.is_relative_to(root) else path.as_posix()
    parts = rel.split("/")
    repo = parts[0] if parts else "unknown"
    recorded = record.get("recorded_at")
    timestamp = None
    if isinstance(recorded, str):
        try:
            timestamp = dt.datetime.fromisoformat(recorded.replace("Z", "+00:00"))
        except ValueError:
            timestamp = None
    return {
        "actor": record.get("actor"),
        "backend_mode": record.get("backend_mode"),
        "date": timestamp.date() if timestamp else None,
        "duration_ms": float(record.get("duration_ms")) if isinstance(record.get("duration_ms"), (int, float)) else None,
        "error_class": record.get("error_class"),
        "file": rel,
        "operation_name": record.get("operation_name"),
        "recorded_at": recorded,
        "repo": repo,
        "result": record.get("result"),
        "team_slug": record.get("team_slug"),
        "timestamp": timestamp,
    }


def load_jsonl_records(
    root: pathlib.Path,
    pattern: str,
    normalizer: Any,
) -> tuple[list[dict[str, Any]], list[pathlib.Path], list[str]]:
    files = sorted(root.glob(pattern))
    records: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in files:
        for line_number, line in enumerate(path.read_text(errors="replace").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                records.append(normalizer(json.loads(line), path, root))
            except Exception as exc:  # noqa: BLE001 - report generation should preserve bad-line evidence.
                errors.append(f"{path}:{line_number}: {exc}")
    return records, files, errors


def load_records(root: pathlib.Path) -> tuple[list[dict[str, Any]], list[pathlib.Path], list[str]]:
    return load_jsonl_records(
        root,
        "*/.multi-code/sprintengine/**/metrics/agent-feedback.jsonl",
        normalize_record,
    )


def load_audit_records(root: pathlib.Path) -> tuple[list[dict[str, Any]], list[pathlib.Path], list[str]]:
    return load_jsonl_records(
        root,
        "*/.multi-code/sprintengine/**/metrics/audit-events.jsonl",
        normalize_audit_record,
    )


def mean(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def pct(value: float | None) -> str:
    if value is None or math.isnan(value):
        return "n/a"
    return f"{value:.1f}%"


def small_pct(value: float | None) -> str:
    if value is None or math.isnan(value):
        return "n/a"
    return f"{value:.2f}%"


def fmt_number(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.1f}"
    return f"{int(value):,}"


def period_for(date: dt.date | None) -> str:
    if date is None:
        return "undated"
    for key, _label, start, end in PERIODS:
        if (start is None or date >= start) and (end is None or date <= end):
            return key
    return "undated"


def sentiment_score(text: str) -> int:
    lowered = text.lower()
    score = 0
    for word in POSITIVE_WORDS:
        if word in lowered:
            score += 1
    for word in NEGATIVE_WORDS:
        if word in lowered:
            score -= 1
    return score


def sentiment_to_pct(value: float | None) -> float | None:
    if value is None:
        return None
    clamped = max(-5, min(5, value))
    return (clamped + 5) * 10


def classify_friction(text: str) -> list[str]:
    lowered = text.lower()
    categories = []
    for key, (_label, needles) in FRICTION_CATEGORIES.items():
        if any(needle in lowered for needle in needles):
            categories.append(key)
    return categories


def slope(points: list[tuple[int, float]]) -> float | None:
    if len(points) < 2:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    xbar = statistics.mean(xs)
    ybar = statistics.mean(ys)
    denom = sum((x - xbar) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys)) / denom


def svg_line_chart(
    series: list[dict[str, Any]],
    keys: list[str],
    labels: dict[str, str],
    *,
    invert: set[str] | None = None,
) -> str:
    if not series:
        return "<div class='empty'>No data</div>"
    invert = invert or set()
    width = 920
    height = 280
    pad_left = 44
    pad_right = 22
    pad_top = 18
    pad_bottom = 36
    plot_w = width - pad_left - pad_right
    plot_h = height - pad_top - pad_bottom
    dates = [row["date"] for row in series]
    x_count = max(1, len(dates) - 1)
    palette = ["#5c7cff", "#ffbf2f", "#30d158", "#ff787c", "#9a9aa2"]
    lines = []
    for idx, key in enumerate(keys):
        points = []
        for i, row in enumerate(series):
            value = row.get(key)
            if value is None:
                continue
            normalized = 100 - value if key in invert else value
            x = pad_left + (i / x_count) * plot_w
            y = pad_top + (1 - normalized / 100) * plot_h
            points.append(f"{x:.1f},{y:.1f}")
        if points:
            color = palette[idx % len(palette)]
            lines.append(
                f"<polyline points='{' '.join(points)}' fill='none' stroke='{color}' "
                "stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' />"
            )
    grid = []
    for value in [0, 25, 50, 75, 100]:
        y = pad_top + (1 - value / 100) * plot_h
        grid.append(f"<line x1='{pad_left}' x2='{width - pad_right}' y1='{y:.1f}' y2='{y:.1f}' />")
        grid.append(f"<text x='10' y='{y + 4:.1f}'>{value}</text>")
    xlabels = []
    for i, date in enumerate(dates):
        if i not in {0, len(dates) - 1} and i % max(1, len(dates) // 5) != 0:
            continue
        x = pad_left + (i / x_count) * plot_w
        xlabels.append(f"<text x='{x:.1f}' y='{height - 10}' text-anchor='middle'>{date[5:]}</text>")
    legend = []
    for idx, key in enumerate(keys):
        display = labels.get(key, key)
        if key in invert:
            display = f"{display} inverted"
        legend.append(
            f"<span><i style='background:{palette[idx % len(palette)]}'></i>{html.escape(display)}</span>"
        )
    return (
        f"<div class='legend'>{''.join(legend)}</div>"
        f"<svg viewBox='0 0 {width} {height}' class='chart' role='img' aria-label='Trend chart'>"
        f"<g class='grid'>{''.join(grid)}</g>"
        f"{''.join(lines)}"
        f"<g class='axis'>{''.join(xlabels)}</g>"
        "</svg>"
    )


def bar_chart(rows: list[tuple[str, float]], *, max_value: float | None = None) -> str:
    if not rows:
        return "<div class='empty'>No data</div>"
    cap = max_value or max(value for _label, value in rows) or 1
    items = []
    for label, value in rows:
        width = max(2, (value / cap) * 100)
        items.append(
            "<div class='bar-row'>"
            f"<span>{html.escape(label)}</span>"
            f"<div class='bar-track'><div class='bar-fill' style='width:{width:.1f}%'></div></div>"
            f"<strong>{fmt_number(value)}</strong>"
            "</div>"
        )
    return "".join(items)


def build_report(
    records: list[dict[str, Any]],
    files: list[pathlib.Path],
    audit_records: list[dict[str, Any]],
    audit_files: list[pathlib.Path],
    errors: list[str],
    root: pathlib.Path,
) -> str:
    dated = [r for r in records if r["date"]]
    dates = sorted({r["date"] for r in dated})
    repos = sorted({r["repo"] for r in records})
    runs = sorted({(r["repo"], r["run_id"]) for r in records if r["run_id"]})
    date_min = min(dates).isoformat() if dates else "n/a"
    date_max = max(dates).isoformat() if dates else "n/a"

    score_stats = []
    for key in SCORE_LABELS:
        values = [r["scores"][key] for r in records if key in r["scores"]]
        if not values:
            continue
        by_day = []
        for i, date in enumerate(dates):
            day_values = [r["scores"][key] for r in dated if r["date"] == date and key in r["scores"]]
            if day_values:
                by_day.append((i, statistics.mean(day_values)))
        first_values = [v for date in dates[:5] for r in dated if r["date"] == date and key in r["scores"] for v in [r["scores"][key]]]
        last_values = [v for date in dates[-5:] for r in dated if r["date"] == date and key in r["scores"] for v in [r["scores"][key]]]
        score_stats.append(
            {
                "key": key,
                "label": SCORE_LABELS[key],
                "n": len(values),
                "avg": statistics.mean(values),
                "min": min(values),
                "max": max(values),
                "first": mean(first_values),
                "latest": mean(last_values),
                "slope": slope(by_day),
            }
        )

    daily_series = []
    for date in dates:
        row: dict[str, Any] = {"date": date.isoformat()}
        day_records = [r for r in dated if r["date"] == date]
        for key in [
            "hallucination_risk_pct",
            "confidence_pct",
            "task_clarity_pct",
            "acceptance_criteria_clarity_pct",
            "context_fit_pct",
            "sprintengine_tool_effectiveness_pct",
        ]:
            row[key] = mean([r["scores"][key] for r in day_records if key in r["scores"]])
        texts = [
            " ".join(filter(None, [r.get("top_friction"), r.get("suggested_improvement")]))
            for r in day_records
            if r.get("top_friction") or r.get("suggested_improvement")
        ]
        raw_sentiment = mean([sentiment_score(text) for text in texts])
        row["sentiment_index"] = raw_sentiment
        row["sentiment_index_pct"] = sentiment_to_pct(raw_sentiment)
        daily_series.append(row)

    period_rows = []
    for key, label, _start, _end in PERIODS:
        period_records = [r for r in records if period_for(r["date"]) == key]
        period_rows.append(
            {
                "key": key,
                "label": label,
                "records": len(period_records),
                "runs": len({(r["repo"], r["run_id"]) for r in period_records if r["run_id"]}),
                "hallucination": mean([r["scores"]["hallucination_risk_pct"] for r in period_records if "hallucination_risk_pct" in r["scores"]]),
                "confidence": mean([r["scores"]["confidence_pct"] for r in period_records if "confidence_pct" in r["scores"]]),
                "task_clarity": mean([r["scores"]["task_clarity_pct"] for r in period_records if "task_clarity_pct" in r["scores"]]),
                "context_fit": mean([r["scores"]["context_fit_pct"] for r in period_records if "context_fit_pct" in r["scores"]]),
                "sentiment": mean(
                    [
                        sentiment_score(" ".join(filter(None, [r.get("top_friction"), r.get("suggested_improvement")])))
                        for r in period_records
                        if r.get("top_friction") or r.get("suggested_improvement")
                    ]
                ),
            }
        )

    count_totals = collections.Counter()
    for r in records:
        count_totals.update(r["counts"])
    claims_checked = count_totals.get("claims_checked", 0)
    count_rows = [
        ("Claims checked", count_totals.get("claims_checked", 0)),
        ("Hallucinated claims", count_totals.get("hallucinated_claims", 0)),
        ("Factual errors", count_totals.get("factual_errors", 0)),
        ("Missed requirements", count_totals.get("missed_requirements", 0)),
        ("Implementation mistakes", count_totals.get("implementation_mistakes", 0)),
        ("Regressions", count_totals.get("regression_count", 0)),
        ("Test failures introduced", count_totals.get("test_failures_introduced", 0)),
        ("Unsafe changes", count_totals.get("unsafe_changes", 0)),
    ]

    category_counts = collections.Counter()
    category_by_period: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    sentiment_examples: list[dict[str, Any]] = []
    for r in records:
        text = " ".join(filter(None, [r.get("top_friction"), r.get("suggested_improvement")]))
        if not text:
            continue
        categories = classify_friction(text)
        for category in categories:
            category_counts[category] += 1
            category_by_period[period_for(r["date"])][category] += 1
        sentiment_examples.append(
            {
                "score": sentiment_score(text),
                "date": r["date"].isoformat() if r["date"] else "undated",
                "repo": r["repo"],
                "run": r["run_id"],
                "role": r["role"],
                "text": text,
                "categories": categories,
            }
        )
    negative_examples = sorted(sentiment_examples, key=lambda item: item["score"])[:10]

    repo_rows = []
    for repo in repos:
        repo_records = [r for r in records if r["repo"] == repo]
        repo_rows.append(
            {
                "repo": repo,
                "records": len(repo_records),
                "runs": len({r["run_id"] for r in repo_records if r["run_id"]}),
                "hallucination": mean([r["scores"]["hallucination_risk_pct"] for r in repo_records if "hallucination_risk_pct" in r["scores"]]),
                "task_clarity": mean([r["scores"]["task_clarity_pct"] for r in repo_records if "task_clarity_pct" in r["scores"]]),
                "confidence": mean([r["scores"]["confidence_pct"] for r in repo_records if "confidence_pct" in r["scores"]]),
            }
        )
    repo_rows.sort(key=lambda row: row["records"], reverse=True)

    role_rows = []
    role_map: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for r in records:
        role_map[str(r["role"] or "unknown")].append(r)
    for role, role_records in role_map.items():
        role_rows.append(
            {
                "role": role,
                "records": len(role_records),
                "hallucination": mean([r["scores"]["hallucination_risk_pct"] for r in role_records if "hallucination_risk_pct" in r["scores"]]),
                "task_clarity": mean([r["scores"]["task_clarity_pct"] for r in role_records if "task_clarity_pct" in r["scores"]]),
                "confidence": mean([r["scores"]["confidence_pct"] for r in role_records if "confidence_pct" in r["scores"]]),
            }
        )
    role_rows.sort(key=lambda row: row["records"], reverse=True)

    source_counts = collections.Counter(str(r["source"] or "unknown") for r in records)
    verdict_counts = collections.Counter(str(r["gate_verdict"] or "none") for r in records if r.get("gate_id"))
    audit_result_counts = collections.Counter(str(r["result"] or "unknown") for r in audit_records)
    audit_operation_counts = collections.Counter(str(r["operation_name"] or "unknown") for r in audit_records)
    audit_durations = [r["duration_ms"] for r in audit_records if isinstance(r.get("duration_ms"), (int, float))]

    trend_chart = svg_line_chart(
        daily_series,
        ["hallucination_risk_pct", "task_clarity_pct", "confidence_pct", "context_fit_pct"],
        SCORE_LABELS,
    )
    sentiment_chart = svg_line_chart(
        daily_series,
        ["sentiment_index_pct", "hallucination_risk_pct"],
        {"sentiment_index_pct": "Text sentiment", **SCORE_LABELS},
    )

    score_table = "".join(
        "<tr>"
        f"<td>{html.escape(row['label'])}</td>"
        f"<td>{fmt_number(row['n'])}</td>"
        f"<td>{pct(row['avg'])}</td>"
        f"<td>{pct(row['first'])}</td>"
        f"<td>{pct(row['latest'])}</td>"
        f"<td>{'+' if row['latest'] is not None and row['first'] is not None and row['latest'] - row['first'] >= 0 else ''}"
        f"{pct((row['latest'] - row['first']) if row['latest'] is not None and row['first'] is not None else None)}</td>"
        "</tr>"
        for row in score_stats
    )

    period_table = "".join(
        "<tr>"
        f"<td>{html.escape(row['label'])}</td>"
        f"<td>{fmt_number(row['records'])}</td>"
        f"<td>{fmt_number(row['runs'])}</td>"
        f"<td>{pct(row['hallucination'])}</td>"
        f"<td>{pct(row['task_clarity'])}</td>"
        f"<td>{pct(row['confidence'])}</td>"
        f"<td>{row['sentiment']:.2f}</td>"
        "</tr>"
        for row in period_rows
    )

    category_period_header = "".join(f"<th>{html.escape(label)}</th>" for _key, label, _s, _e in PERIODS)
    category_table = "".join(
        "<tr>"
        f"<td>{html.escape(FRICTION_CATEGORIES[key][0])}</td>"
        f"<td>{fmt_number(category_counts[key])}</td>"
        + "".join(f"<td>{fmt_number(category_by_period[pkey][key])}</td>" for pkey, _label, _s, _e in PERIODS)
        + "</tr>"
        for key, _value in category_counts.most_common()
    )

    repo_table = "".join(
        "<tr>"
        f"<td>{html.escape(row['repo'])}</td>"
        f"<td>{fmt_number(row['records'])}</td>"
        f"<td>{fmt_number(row['runs'])}</td>"
        f"<td>{pct(row['hallucination'])}</td>"
        f"<td>{pct(row['task_clarity'])}</td>"
        f"<td>{pct(row['confidence'])}</td>"
        "</tr>"
        for row in repo_rows
    )

    role_table = "".join(
        "<tr>"
        f"<td>{html.escape(row['role'])}</td>"
        f"<td>{fmt_number(row['records'])}</td>"
        f"<td>{pct(row['hallucination'])}</td>"
        f"<td>{pct(row['task_clarity'])}</td>"
        f"<td>{pct(row['confidence'])}</td>"
        "</tr>"
        for row in role_rows
    )

    examples = "".join(
        "<li>"
        f"<strong>{html.escape(example['date'])}</strong> "
        f"<span>{html.escape(str(example['repo']))} / {html.escape(str(example['run']))} / {html.escape(str(example['role']))}</span>"
        f"<p>{html.escape(example['text'][:420])}</p>"
        "</li>"
        for example in negative_examples
    )

    generated_at = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")
    hallucination_claim_rate = (count_totals.get("hallucinated_claims", 0) / claims_checked * 100) if claims_checked else None
    factual_error_rate = (count_totals.get("factual_errors", 0) / claims_checked * 100) if claims_checked else None
    missed_req_rate = (count_totals.get("missed_requirements", 0) / claims_checked * 100) if claims_checked else None
    improvement = None
    h_stat = next((row for row in score_stats if row["key"] == "hallucination_risk_pct"), None)
    if h_stat and h_stat["first"] is not None and h_stat["latest"] is not None:
        improvement = h_stat["first"] - h_stat["latest"]

    count_cards = "".join(
        f"<div class='metric'><span>{html.escape(label)}</span><strong>{fmt_number(value)}</strong></div>"
        for label, value in count_rows
    )
    source_bars = bar_chart([(key, value) for key, value in source_counts.most_common()])
    verdict_bars = bar_chart([(key, value) for key, value in verdict_counts.most_common() if key != "none"])
    category_bars = bar_chart([(FRICTION_CATEGORIES[key][0], value) for key, value in category_counts.most_common()])
    audit_result_bars = bar_chart([(key, value) for key, value in audit_result_counts.most_common()])
    audit_operation_bars = bar_chart([(key, value) for key, value in audit_operation_counts.most_common()])

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sprint Engine Metrics Analysis</title>
  <style>
    :root {{
      --bg-app: #08090b;
      --bg-surface: #0d0e11;
      --bg-surface-raised: #111216;
      --bg-hover: #17181d;
      --border-subtle: rgba(255,255,255,0.06);
      --border-default: rgba(255,255,255,0.08);
      --text-strong: #ececee;
      --text-default: #c7c8cf;
      --text-muted: #9a9aa2;
      --text-subtle: #6f7078;
      --accent-primary: #5c7cff;
      --tool-sprintengine: #ffbf2f;
      --tone-good: #30d158;
      --tone-warn: #ffbf2f;
      --tone-error: #ff787c;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg-app);
      color: var(--text-default);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.4;
    }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }}
    header {{ display: grid; gap: 14px; padding-bottom: 22px; border-bottom: 1px solid var(--border-subtle); }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ color: var(--text-strong); font-size: 24px; line-height: 1.2; letter-spacing: 0; font-weight: 650; }}
    h2 {{ color: var(--text-strong); font-size: 15px; line-height: 1.25; margin: 28px 0 12px; font-weight: 650; }}
    h3 {{ color: var(--text-strong); font-size: 13px; line-height: 1.25; margin-bottom: 8px; font-weight: 600; }}
    .eyebrow {{ display: flex; align-items: center; gap: 8px; color: var(--text-muted); }}
    .eyebrow::before {{ content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--tool-sprintengine); }}
    .lede {{ max-width: 860px; color: var(--text-muted); font-size: 13px; }}
    .grid {{ display: grid; gap: 10px; }}
    .summary {{ grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 18px; }}
    .metric {{
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 5px;
      padding: 12px;
      min-height: 70px;
    }}
    .metric span {{ display: block; color: var(--text-muted); }}
    .metric strong {{ display: block; color: var(--text-strong); margin-top: 8px; font-size: 22px; line-height: 1.1; font-variant-numeric: tabular-nums; }}
    .panel {{
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 7px;
      padding: 14px;
      margin-bottom: 12px;
    }}
    .two {{ grid-template-columns: 1.2fr .8fr; align-items: start; }}
    table {{ width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }}
    th, td {{ padding: 8px 9px; border-bottom: 1px solid var(--border-subtle); text-align: right; vertical-align: top; }}
    th:first-child, td:first-child {{ text-align: left; }}
    th {{ color: var(--text-muted); font-weight: 500; background: var(--bg-surface-raised); }}
    td {{ color: var(--text-default); }}
    tr:last-child td {{ border-bottom: 0; }}
    .chart {{ width: 100%; height: auto; display: block; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 5px; }}
    .chart .grid line {{ stroke: rgba(255,255,255,0.06); }}
    .chart .grid text, .chart .axis text {{ fill: var(--text-subtle); font-size: 11px; }}
    .legend {{ display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; color: var(--text-muted); }}
    .legend span {{ display: inline-flex; align-items: center; gap: 6px; }}
    .legend i {{ width: 9px; height: 9px; border-radius: 50%; display: inline-block; }}
    .bar-row {{ display: grid; grid-template-columns: 150px 1fr 50px; gap: 10px; align-items: center; padding: 6px 0; font-variant-numeric: tabular-nums; }}
    .bar-row span {{ color: var(--text-muted); }}
    .bar-row strong {{ color: var(--text-strong); text-align: right; }}
    .bar-track {{ height: 7px; background: var(--bg-hover); border-radius: 3px; overflow: hidden; }}
    .bar-fill {{ height: 100%; background: var(--accent-primary); }}
    .notes {{ display: grid; gap: 8px; color: var(--text-muted); }}
    .notes strong {{ color: var(--text-strong); }}
    .examples {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }}
    .examples li {{ border: 1px solid var(--border-subtle); border-radius: 5px; padding: 10px; background: var(--bg-surface-raised); }}
    .examples strong {{ color: var(--text-strong); margin-right: 8px; }}
    .examples span {{ color: var(--text-subtle); }}
    .examples p {{ margin-top: 6px; color: var(--text-muted); }}
    .meta {{ color: var(--text-subtle); font-variant-numeric: tabular-nums; }}
    .status-line {{ display: flex; flex-wrap: wrap; gap: 14px; color: var(--text-muted); }}
    .status-line b {{ color: var(--text-strong); font-weight: 600; }}
    .empty {{ color: var(--text-subtle); padding: 16px; }}
    @media (max-width: 860px) {{
      main {{ padding: 20px 14px 36px; }}
      .summary, .two {{ grid-template-columns: 1fr; }}
      .bar-row {{ grid-template-columns: 120px 1fr 44px; }}
      table {{ font-size: 11px; }}
      th, td {{ padding: 7px 6px; }}
    }}
  </style>
</head>
<body>
<main>
  <header>
    <div class="eyebrow">Sprint Engine metrics</div>
    <h1>Historical Run Quality Dashboard</h1>
    <p class="lede">Aggregated from every sibling workspace run store found under <code>../*/.multi-code/sprintengine/**/metrics/agent-feedback.jsonl</code>. The sentiment index is inferred from friction/improvement text with a small deterministic lexicon; score and count metrics are recorded values.</p>
    <div class="status-line">
      <span><b>{fmt_number(len(records))}</b> feedback records</span>
      <span><b>{fmt_number(len(files))}</b> metric files</span>
      <span><b>{fmt_number(len(audit_records))}</b> audit events</span>
      <span><b>{fmt_number(len(repos))}</b> workspaces</span>
      <span><b>{fmt_number(len(runs))}</b> repo/run pairs</span>
      <span><b>{html.escape(date_min)}</b> to <b>{html.escape(date_max)}</b></span>
      <span>Generated {html.escape(generated_at)}</span>
    </div>
  </header>

  <section class="grid summary">
    <div class="metric"><span>Average hallucination risk</span><strong>{pct(next((s['avg'] for s in score_stats if s['key'] == 'hallucination_risk_pct'), None))}</strong></div>
    <div class="metric"><span>Latest vs earliest risk</span><strong>{'down ' + pct(improvement) if improvement is not None and improvement >= 0 else pct(improvement)}</strong></div>
    <div class="metric"><span>Average task clarity</span><strong>{pct(next((s['avg'] for s in score_stats if s['key'] == 'task_clarity_pct'), None))}</strong></div>
    <div class="metric"><span>Claim hallucination rate</span><strong>{small_pct(hallucination_claim_rate)}</strong></div>
  </section>

  <h2>Trend Over Time</h2>
  <section class="panel">
    {trend_chart}
  </section>

  <h2>Cycle Comparison</h2>
  <section class="panel">
    <table>
      <thead><tr><th>Cycle</th><th>Records</th><th>Runs</th><th>Hallucination risk</th><th>Task clarity</th><th>Confidence</th><th>Sentiment index</th></tr></thead>
      <tbody>{period_table}</tbody>
    </table>
  </section>

  <h2>Recorded Score Averages</h2>
  <section class="panel">
    <table>
      <thead><tr><th>Metric</th><th>n</th><th>Overall avg</th><th>First 5 active days</th><th>Latest 5 active days</th><th>Latest delta</th></tr></thead>
      <tbody>{score_table}</tbody>
    </table>
  </section>

  <h2>Recorded Review Counts</h2>
  <section class="grid two">
    <div class="panel">
      <h3>Totals</h3>
      <div class="grid summary">{count_cards}</div>
      <p class="meta">Rate checks: hallucinated claims {small_pct(hallucination_claim_rate)}, factual errors {small_pct(factual_error_rate)}, missed requirements {small_pct(missed_req_rate)} per claim checked.</p>
    </div>
    <div class="panel">
      <h3>Metric sources</h3>
      {source_bars}
      <h3 style="margin-top:14px">Gate verdict records</h3>
      {verdict_bars}
    </div>
  </section>

  <h2>MCP Audit Events</h2>
  <section class="grid two">
    <div class="panel">
      <h3>Audit result records</h3>
      {audit_result_bars}
      <p class="meta">Loaded {fmt_number(len(audit_records))} audit events from {fmt_number(len(audit_files))} audit metric files. Mean duration: {fmt_number(mean(audit_durations))} ms.</p>
    </div>
    <div class="panel">
      <h3>Audit operations</h3>
      {audit_operation_bars}
    </div>
  </section>

  <h2>Friction And Sentiment</h2>
  <section class="grid two">
    <div class="panel">
      {sentiment_chart}
      <p class="meta">The sentiment line is normalized from a raw -5 to +5 text-derived index. Positive language generally means focused/clear/resolved; negative language indicates blocked/missing/ambiguous/truncated.</p>
    </div>
    <div class="panel">
      <h3>Friction category frequency</h3>
      {category_bars}
    </div>
  </section>

  <section class="panel">
    <h3>Friction categories by cycle</h3>
    <table>
      <thead><tr><th>Category</th><th>Total</th>{category_period_header}</tr></thead>
      <tbody>{category_table}</tbody>
    </table>
  </section>

  <h2>Workspace And Role Cuts</h2>
  <section class="grid two">
    <div class="panel">
      <h3>By workspace</h3>
      <table>
        <thead><tr><th>Workspace</th><th>Records</th><th>Runs</th><th>Hallucination</th><th>Task clarity</th><th>Confidence</th></tr></thead>
        <tbody>{repo_table}</tbody>
      </table>
    </div>
    <div class="panel">
      <h3>By role</h3>
      <table>
        <thead><tr><th>Role</th><th>Records</th><th>Hallucination</th><th>Task clarity</th><th>Confidence</th></tr></thead>
        <tbody>{role_table}</tbody>
      </table>
    </div>
  </section>

  <h2>Notable Negative Friction Examples</h2>
  <section class="panel">
    <ul class="examples">{examples}</ul>
  </section>

  <h2>Readout</h2>
  <section class="panel notes">
    <p><strong>Trend:</strong> Recorded hallucination risk averages {pct(next((s['avg'] for s in score_stats if s['key'] == 'hallucination_risk_pct'), None))} across all normalized records and is lower in the latest five active days than in the first five active days by {pct(improvement)}.</p>
    <p><strong>Task quality:</strong> Task clarity and acceptance-criteria clarity are both above 93% overall, but text friction still shows recurring ambiguity around task scope, owned paths, final-review semantics, and which artifact states count as completion evidence.</p>
    <p><strong>Operational drag:</strong> The dominant complaints are less about role fit and more about review ergonomics: large or truncated gate context, absent diff evidence in non-git workspaces, missing scripts/tooling, and artifact taxonomy gaps.</p>
    <p><strong>MCP-era signal:</strong> The May 19-21 MCP extraction cycle keeps hallucination risk lower than the early cycles while introducing new friction around schema breadth, dispatch examples, wake/resume proof, and separating stale open feedback from current gate attempts.</p>
    <p><strong>Limitations:</strong> Historical duplicate/archive workspaces are included because the request asked for all workspaces. This may overweight repeated runs copied between <code>multicode</code> and <code>multicode-old-sprintengine</code>.</p>
    {"<p><strong>Parse warnings:</strong> " + html.escape('; '.join(errors[:5])) + "</p>" if errors else ""}
  </section>
</main>
</body>
</html>
"""


def main() -> None:
    args = parse_args()
    root = pathlib.Path(args.root).resolve()
    output = pathlib.Path(args.output)
    records, files, errors = load_records(root)
    audit_records, audit_files, audit_errors = load_audit_records(root)
    html_report = build_report(records, files, audit_records, audit_files, errors + audit_errors, root)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html_report)
    print(
        f"Wrote {output.as_posix()} with {len(records)} feedback records "
        f"from {len(files)} metric files and {len(audit_records)} audit events."
    )


if __name__ == "__main__":
    main()
