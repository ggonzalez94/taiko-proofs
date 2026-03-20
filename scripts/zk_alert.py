#!/usr/bin/env python3

import argparse
import json
import os
import signal
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib import error, parse, request


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def parse_iso_z(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize_threshold(value: float) -> float:
    return value / 100 if value > 1 else value


def build_window(now: datetime) -> tuple[str, str]:
    end = now.astimezone(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=24)
    return to_iso_z(start), to_iso_z(end)


@dataclass
class CheckResult:
    status: str
    ratio: Optional[float]
    threshold: float
    proven_total: int
    zk_proven_total: int


@dataclass
class AlertState:
    last_status: str
    last_alert_kind: Optional[str] = None
    last_alert_at: Optional[str] = None


@dataclass
class Config:
    api_base_url: str
    threshold: float
    min_samples: int
    cooldown: timedelta
    interval_seconds: int
    state_file: Path
    slack_webhook_url: Optional[str]
    telegram_bot_token: Optional[str]
    telegram_chat_id: Optional[str]
    timeout_seconds: float
    daemon: bool
    dry_run: bool


def default_alert_states() -> dict[str, AlertState]:
    return {
        "ratio": AlertState(last_status="unknown"),
        "api": AlertState(last_status="unknown")
    }


def evaluate_summary(summary: dict[str, Any], threshold: float, min_samples: int) -> CheckResult:
    proven_total = int(summary.get("provenTotal", 0) or 0)
    zk_proven_total = int(summary.get("zkProvenTotal", 0) or 0)
    ratio = (zk_proven_total / proven_total) if proven_total else None

    if proven_total == 0 or proven_total < min_samples:
        status = "insufficient_data"
    elif ratio is not None and ratio < threshold:
        status = "breach"
    else:
        status = "ok"

    return CheckResult(
        status=status,
        ratio=ratio,
        threshold=threshold,
        proven_total=proven_total,
        zk_proven_total=zk_proven_total
    )


def parse_alert_state(data: dict[str, Any], default_status: str = "unknown") -> AlertState:
    return AlertState(
        last_status=str(data.get("last_status", default_status)),
        last_alert_kind=data.get("last_alert_kind"),
        last_alert_at=data.get("last_alert_at")
    )


def load_states(path: Path) -> dict[str, AlertState]:
    if not path.exists():
        return default_alert_states()

    data = json.loads(path.read_text(encoding="utf-8"))
    states = default_alert_states()

    if "ratio" in data or "api" in data:
        ratio_data = data.get("ratio")
        api_data = data.get("api")
        if isinstance(ratio_data, dict):
            states["ratio"] = parse_alert_state(ratio_data)
        if isinstance(api_data, dict):
            states["api"] = parse_alert_state(api_data)
        return states

    if isinstance(data, dict):
        states["ratio"] = parse_alert_state(data)
    return states


def save_states(path: Path, states: dict[str, AlertState]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {name: asdict(state) for name, state in states.items()}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def decide_status_notification(
    current_status: str,
    previous: Optional[AlertState],
    now: datetime,
    cooldown: timedelta,
    active_status: str,
    active_decision: str,
    recovery_status: str,
    recovery_decision: str
) -> Optional[str]:
    if current_status == active_status:
        if previous is None or previous.last_status != active_status:
            return active_decision

        if not previous.last_alert_at:
            return active_decision

        last_alert_at = parse_iso_z(previous.last_alert_at)
        if now - last_alert_at >= cooldown:
            return active_decision

    if current_status == recovery_status and previous and previous.last_status == active_status:
        return recovery_decision

    return None


def decide_notification(
    result: CheckResult,
    previous: Optional[AlertState],
    now: datetime,
    cooldown: timedelta
) -> Optional[str]:
    return decide_status_notification(
        current_status=result.status,
        previous=previous,
        now=now,
        cooldown=cooldown,
        active_status="breach",
        active_decision="breach",
        recovery_status="ok",
        recovery_decision="recovery"
    )


def decide_api_notification(
    api_ok: bool,
    previous: Optional[AlertState],
    now: datetime,
    cooldown: timedelta
) -> Optional[str]:
    return decide_status_notification(
        current_status="ok" if api_ok else "down",
        previous=previous,
        now=now,
        cooldown=cooldown,
        active_status="down",
        active_decision="api_down",
        recovery_status="ok",
        recovery_decision="api_recovered"
    )


def render_message(
    kind: str,
    result: CheckResult,
    start: str,
    end: str,
    api_url: str
) -> str:
    ratio_percent = f"{(result.ratio or 0) * 100:.2f}%"
    threshold_percent = f"{result.threshold * 100:.2f}%"
    headline = "ZK ratio recovered" if kind == "recovery" else "ZK ratio alert"

    return (
        f"{headline}\n"
        f"Window: {start} -> {end}\n"
        f"ZK ratio: {ratio_percent} (threshold {threshold_percent})\n"
        f"ZK proven: {result.zk_proven_total}/{result.proven_total}\n"
        f"Source: {api_url.rstrip('/')}/stats/zk?start={start}&end={end}"
    )


def render_api_message(
    kind: str,
    start: str,
    end: str,
    api_url: str,
    error_message: Optional[str] = None
) -> str:
    headline = "API recovered" if kind == "api_recovered" else "API down"
    lines = [
        headline,
        f"Window: {start} -> {end}",
        f"Source: {api_url.rstrip('/')}/stats/zk?start={start}&end={end}"
    ]
    if error_message and kind == "api_down":
        lines.append(f"Error: {error_message}")
    return "\n".join(lines)


def fetch_summary(api_base_url: str, start: str, end: str, timeout_seconds: float) -> dict[str, Any]:
    params = parse.urlencode({"start": start, "end": end})
    url = f"{api_base_url.rstrip('/')}/stats/zk?{params}"
    req = request.Request(url, headers={"Accept": "application/json"})

    with request.urlopen(req, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))

    summary = payload.get("summary")
    if not isinstance(summary, dict):
        raise ValueError(f"API response missing summary: {url}")
    return summary


def send_slack(webhook_url: str, message: str, timeout_seconds: float) -> None:
    body = json.dumps({"text": message}).encode("utf-8")
    req = request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with request.urlopen(req, timeout=timeout_seconds):
        return


def send_telegram(
    bot_token: str,
    chat_id: str,
    message: str,
    timeout_seconds: float
) -> None:
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    body = json.dumps({"chat_id": chat_id, "text": message}).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with request.urlopen(req, timeout=timeout_seconds):
        return


def build_arg_parser() -> argparse.ArgumentParser:
    legacy_cooldown_minutes = os.getenv("ZK_ALERT_COOLDOWN_MINUTES")
    default_cooldown_seconds = (
        int(legacy_cooldown_minutes) * 60
        if legacy_cooldown_minutes is not None
        else int(os.getenv("ZK_ALERT_COOLDOWN_SECONDS", "21600"))
    )
    parser = argparse.ArgumentParser(
        description="Poll /stats/zk for the last 24 hours and send alerts when the ratio drops.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument(
        "--api-base-url",
        default=os.getenv("ZK_ALERT_API_BASE_URL"),
        help="API base URL, for example https://api.proofs.taiko.xyz"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.getenv("ZK_ALERT_THRESHOLD", "80")),
        help="Alert threshold. Accepts 0.8 or 80."
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=int(os.getenv("ZK_ALERT_MIN_SAMPLES", "20")),
        help="Minimum proven batch count required before alerting."
    )
    parser.add_argument(
        "--cooldown-seconds",
        type=int,
        default=default_cooldown_seconds,
        help="Seconds to wait before repeating an ongoing breach alert."
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.getenv("ZK_ALERT_INTERVAL_SECONDS", "600")),
        help="Seconds to wait between checks in daemon mode."
    )
    parser.add_argument(
        "--state-file",
        default=os.getenv("ZK_ALERT_STATE_FILE", "/tmp/taikoproofs-zk-alert-state.json"),
        help="Path to the local JSON state file used for dedupe."
    )
    parser.add_argument(
        "--slack-webhook-url",
        default=os.getenv("ZK_ALERT_SLACK_WEBHOOK_URL"),
        help="Slack incoming webhook URL."
    )
    parser.add_argument(
        "--telegram-bot-token",
        default=os.getenv("ZK_ALERT_TELEGRAM_BOT_TOKEN"),
        help="Telegram bot token."
    )
    parser.add_argument(
        "--telegram-chat-id",
        default=os.getenv("ZK_ALERT_TELEGRAM_CHAT_ID"),
        help="Telegram chat ID."
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=float(os.getenv("ZK_ALERT_TIMEOUT_SECONDS", "10")),
        help="HTTP timeout in seconds for API and notification calls."
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Keep running in the foreground and poll repeatedly."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Evaluate and print, but do not send notifications."
    )
    return parser


def load_config(args: argparse.Namespace) -> Config:
    if not args.api_base_url:
        raise ValueError("Missing API base URL. Set --api-base-url or ZK_ALERT_API_BASE_URL.")

    threshold = normalize_threshold(args.threshold)
    if threshold <= 0 or threshold > 1:
        raise ValueError("Threshold must be between 0 and 1, or between 0 and 100.")

    return Config(
        api_base_url=args.api_base_url,
        threshold=threshold,
        min_samples=max(0, args.min_samples),
        cooldown=timedelta(seconds=max(0, args.cooldown_seconds)),
        interval_seconds=max(1, args.interval_seconds),
        state_file=Path(args.state_file),
        slack_webhook_url=args.slack_webhook_url,
        telegram_bot_token=args.telegram_bot_token,
        telegram_chat_id=args.telegram_chat_id,
        timeout_seconds=max(1, args.timeout_seconds),
        daemon=args.daemon,
        dry_run=args.dry_run
    )


def send_notifications(config: Config, message: str) -> None:
    sent = False

    if config.slack_webhook_url:
        send_slack(config.slack_webhook_url, message, config.timeout_seconds)
        sent = True

    if config.telegram_bot_token and config.telegram_chat_id:
        send_telegram(
            config.telegram_bot_token,
            config.telegram_chat_id,
            message,
            config.timeout_seconds
        )
        sent = True

    if not sent:
        raise ValueError(
            "No notification channel configured. Set Slack or Telegram config, or use --dry-run."
        )


def next_state(
    current_status: str,
    previous: Optional[AlertState],
    decision: Optional[str],
    now: datetime
) -> AlertState:
    state = AlertState(
        last_status=current_status,
        last_alert_kind=previous.last_alert_kind if previous else None,
        last_alert_at=previous.last_alert_at if previous else None
    )
    if decision:
        state.last_alert_kind = decision
        state.last_alert_at = to_iso_z(now)
    return state


def run_check(
    config: Config,
    now: Optional[datetime] = None,
    fetch_summary_fn: Callable[[str, str, str, float], dict[str, Any]] = fetch_summary,
    send_notifications_fn: Callable[[Config, str], None] = send_notifications
) -> int:
    now = now or utc_now()
    start, end = build_window(now)
    states = load_states(config.state_file)

    try:
        summary = fetch_summary_fn(config.api_base_url, start, end, config.timeout_seconds)
    except (ValueError, OSError, error.URLError, json.JSONDecodeError) as exc:
        api_decision = decide_api_notification(False, states.get("api"), now, config.cooldown)
        if api_decision:
            message = render_api_message(
                api_decision,
                start,
                end,
                config.api_base_url,
                error_message=str(exc)
            )
            if config.dry_run:
                print(message)
            else:
                send_notifications_fn(config, message)

        states["api"] = next_state("down", states.get("api"), api_decision, now)
        save_states(config.state_file, states)
        print(f"status=api_down decision={api_decision or 'none'} error={exc}", file=sys.stderr)
        return 1

    api_decision = decide_api_notification(True, states.get("api"), now, config.cooldown)
    if api_decision:
        message = render_api_message(api_decision, start, end, config.api_base_url)
        if config.dry_run:
            print(message)
        else:
            send_notifications_fn(config, message)

    states["api"] = next_state("ok", states.get("api"), api_decision, now)

    result = evaluate_summary(summary, config.threshold, config.min_samples)
    decision = decide_notification(result, states.get("ratio"), now, config.cooldown)

    if decision:
        message = render_message(decision, result, start, end, config.api_base_url)
        if config.dry_run:
            print(message)
        else:
            send_notifications_fn(config, message)

    states["ratio"] = next_state(result.status, states.get("ratio"), decision, now)
    save_states(config.state_file, states)

    ratio_percent = (result.ratio or 0) * 100
    print(
        f"status={result.status} ratio={ratio_percent:.2f}% "
        f"proven={result.proven_total} zk={result.zk_proven_total} decision={decision or 'none'}"
    )
    return 0


def run_daemon_loop(
    run_once: Callable[[], None],
    interval_seconds: int,
    should_stop: Callable[[], bool],
    sleep_fn: Callable[[float], None] = time.sleep
) -> None:
    while not should_stop():
        run_once()
        sleep_fn(interval_seconds)


class StopSignal:
    def __init__(self) -> None:
        self.stopped = False

    def request_stop(self, _signum: int, _frame: Any) -> None:
        self.stopped = True

    def should_stop(self) -> bool:
        return self.stopped


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        config = load_config(args)
        if not config.daemon:
            return run_check(config)

        stop_signal = StopSignal()
        signal.signal(signal.SIGINT, stop_signal.request_stop)
        signal.signal(signal.SIGTERM, stop_signal.request_stop)
        run_daemon_loop(
            run_once=lambda: run_check(config),
            interval_seconds=config.interval_seconds,
            should_stop=stop_signal.should_stop
        )
        return 0
    except (ValueError, OSError, error.URLError, json.JSONDecodeError) as exc:
        print(f"zk_alert error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
