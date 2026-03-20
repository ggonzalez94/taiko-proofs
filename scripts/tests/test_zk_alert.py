import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.zk_alert import (
    AlertState,
    CheckResult,
    build_arg_parser,
    build_window,
    decide_api_notification,
    decide_notification,
    evaluate_summary,
    load_config,
    load_states,
    run_check,
    run_daemon_loop,
    render_message
)


class BuildWindowTests(unittest.TestCase):
    def test_build_window_uses_rolling_24_hours(self):
        now = datetime(2026, 3, 19, 8, 30, 0, tzinfo=timezone.utc)

        start, end = build_window(now)

        self.assertEqual(start, "2026-03-18T08:30:00Z")
        self.assertEqual(end, "2026-03-19T08:30:00Z")


class EvaluateSummaryTests(unittest.TestCase):
    def test_breach_when_ratio_is_below_threshold(self):
        result = evaluate_summary(
            {"provenTotal": 100, "zkProvenTotal": 79},
            threshold=0.8,
            min_samples=20
        )

        self.assertEqual(result.status, "breach")
        self.assertAlmostEqual(result.ratio or 0, 0.79)

    def test_ok_when_ratio_meets_threshold(self):
        result = evaluate_summary(
            {"provenTotal": 100, "zkProvenTotal": 80},
            threshold=0.8,
            min_samples=20
        )

        self.assertEqual(result.status, "ok")
        self.assertAlmostEqual(result.ratio or 0, 0.8)

    def test_insufficient_data_when_sample_count_is_too_low(self):
        result = evaluate_summary(
            {"provenTotal": 10, "zkProvenTotal": 5},
            threshold=0.8,
            min_samples=20
        )

        self.assertEqual(result.status, "insufficient_data")
        self.assertAlmostEqual(result.ratio or 0, 0.5)


class NotificationDecisionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 3, 19, 8, 30, 0, tzinfo=timezone.utc)
        self.breach = CheckResult(
            status="breach",
            ratio=0.79,
            threshold=0.8,
            proven_total=100,
            zk_proven_total=79
        )
        self.ok = CheckResult(
            status="ok",
            ratio=0.85,
            threshold=0.8,
            proven_total=100,
            zk_proven_total=85
        )

    def test_first_breach_sends_notification(self):
        decision = decide_notification(
            self.breach,
            previous=None,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertEqual(decision, "breach")

    def test_repeated_breach_inside_cooldown_is_suppressed(self):
        previous = AlertState(
            last_status="breach",
            last_alert_kind="breach",
            last_alert_at="2026-03-19T05:00:00Z"
        )

        decision = decide_notification(
            self.breach,
            previous=previous,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertIsNone(decision)

    def test_repeated_breach_after_cooldown_sends_notification(self):
        previous = AlertState(
            last_status="breach",
            last_alert_kind="breach",
            last_alert_at="2026-03-19T01:00:00Z"
        )

        decision = decide_notification(
            self.breach,
            previous=previous,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertEqual(decision, "breach")

    def test_recovery_after_breach_sends_notification(self):
        previous = AlertState(
            last_status="breach",
            last_alert_kind="breach",
            last_alert_at="2026-03-19T01:00:00Z"
        )

        decision = decide_notification(
            self.ok,
            previous=previous,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertEqual(decision, "recovery")

    def test_first_api_failure_sends_notification(self):
        decision = decide_api_notification(
            api_ok=False,
            previous=None,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertEqual(decision, "api_down")

    def test_repeated_api_failure_inside_cooldown_is_suppressed(self):
        previous = AlertState(
            last_status="down",
            last_alert_kind="api_down",
            last_alert_at="2026-03-19T05:00:00Z"
        )

        decision = decide_api_notification(
            api_ok=False,
            previous=previous,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertIsNone(decision)

    def test_api_recovery_after_failure_sends_notification(self):
        previous = AlertState(
            last_status="down",
            last_alert_kind="api_down",
            last_alert_at="2026-03-19T01:00:00Z"
        )

        decision = decide_api_notification(
            api_ok=True,
            previous=previous,
            now=self.now,
            cooldown=timedelta(hours=6)
        )

        self.assertEqual(decision, "api_recovered")


class RenderMessageTests(unittest.TestCase):
    def test_render_message_contains_key_metrics(self):
        message = render_message(
            kind="breach",
            result=CheckResult(
                status="breach",
                ratio=0.72,
                threshold=0.8,
                proven_total=50,
                zk_proven_total=36
            ),
            start="2026-03-18T08:30:00Z",
            end="2026-03-19T08:30:00Z",
            api_url="https://api.proofs.taiko.xyz"
        )

        self.assertIn("ZK ratio alert", message)
        self.assertIn("72.00%", message)
        self.assertIn("80.00%", message)
        self.assertIn("36/50", message)
        self.assertIn("/stats/zk", message)


class HelpOutputTests(unittest.TestCase):
    def test_help_mentions_default_state_file(self):
        help_text = build_arg_parser().format_help()

        self.assertIn("/tmp/taikoproofs-zk-alert-state.json", help_text)
        self.assertIn("--cooldown-seconds", help_text)
        self.assertIn("--interval-seconds", help_text)
        self.assertIn("--daemon", help_text)
        self.assertNotIn("--cooldown-minutes", help_text)


class ConfigTests(unittest.TestCase):
    def test_load_config_parses_second_based_values(self):
        parser = build_arg_parser()
        args = parser.parse_args(
            [
                "--api-base-url",
                "https://api.proofs.taiko.xyz",
                "--cooldown-seconds",
                "900",
                "--interval-seconds",
                "120"
            ]
        )

        config = load_config(args)

        self.assertEqual(config.cooldown, timedelta(seconds=900))
        self.assertEqual(config.interval_seconds, 120)


class DaemonLoopTests(unittest.TestCase):
    def test_run_daemon_loop_repeats_until_stop(self):
        calls = []
        stop_flags = [False, False, True]
        sleep_calls = []

        def run_once():
            calls.append("run")

        def should_stop():
            return stop_flags.pop(0)

        def sleep(seconds):
            sleep_calls.append(seconds)

        run_daemon_loop(
            run_once=run_once,
            interval_seconds=42,
            should_stop=should_stop,
            sleep_fn=sleep
        )

        self.assertEqual(calls, ["run", "run"])
        self.assertEqual(sleep_calls, [42, 42])

    def test_run_daemon_loop_keeps_running_after_handled_error(self):
        calls = []
        stop_flags = [False, False, True]

        def run_once():
            calls.append("run")
            return 1

        run_daemon_loop(
            run_once=run_once,
            interval_seconds=5,
            should_stop=lambda: stop_flags.pop(0),
            sleep_fn=lambda _seconds: None
        )

        self.assertEqual(calls, ["run", "run"])


class RunCheckTests(unittest.TestCase):
    def test_api_failure_sends_api_down_and_persists_independent_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            sent_messages = []

            def fetch_summary(*_args, **_kwargs):
                raise OSError("api timeout")

            def send_notifications(_config, message):
                sent_messages.append(message)

            config = load_config(
                build_arg_parser().parse_args(
                    [
                        "--api-base-url",
                        "https://api.proofs.taiko.xyz",
                        "--state-file",
                        str(Path(tmpdir) / "state.json"),
                        "--cooldown-seconds",
                        "0"
                    ]
                )
            )

            exit_code = run_check(
                config,
                now=datetime(2026, 3, 19, 8, 30, 0, tzinfo=timezone.utc),
                fetch_summary_fn=fetch_summary,
                send_notifications_fn=send_notifications
            )

            states = load_states(config.state_file)
            self.assertEqual(exit_code, 1)
            self.assertEqual(states["api"].last_status, "down")
            self.assertEqual(states["ratio"].last_status, "unknown")
            self.assertEqual(len(sent_messages), 1)
            self.assertIn("API down", sent_messages[0])

    def test_api_recovery_after_failure_sends_recovery(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "state.json"
            state_file.write_text(
                '{\n'
                '  "ratio": {"last_status": "ok", "last_alert_kind": null, "last_alert_at": null},\n'
                '  "api": {"last_status": "down", "last_alert_kind": "api_down", "last_alert_at": "2026-03-19T01:00:00Z"}\n'
                '}\n',
                encoding="utf-8"
            )
            sent_messages = []

            def fetch_summary(*_args, **_kwargs):
                return {"provenTotal": 100, "zkProvenTotal": 100}

            def send_notifications(_config, message):
                sent_messages.append(message)

            config = load_config(
                build_arg_parser().parse_args(
                    [
                        "--api-base-url",
                        "https://api.proofs.taiko.xyz",
                        "--state-file",
                        str(state_file),
                        "--cooldown-seconds",
                        "0"
                    ]
                )
            )

            exit_code = run_check(
                config,
                now=datetime(2026, 3, 19, 8, 30, 0, tzinfo=timezone.utc),
                fetch_summary_fn=fetch_summary,
                send_notifications_fn=send_notifications
            )

            states = load_states(config.state_file)
            self.assertEqual(exit_code, 0)
            self.assertEqual(states["api"].last_status, "ok")
            self.assertEqual(len(sent_messages), 1)
            self.assertIn("API recovered", sent_messages[0])


if __name__ == "__main__":
    unittest.main()
