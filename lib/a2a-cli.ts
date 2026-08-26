export const A2A_CLI_PATH = ".console/bin/a2a";
export const A2A_CLI_SOURCE_PATH = ".console/a2a.py";

export function a2aCliSource(): string {
  return String.raw`#!/usr/bin/env python3
import argparse
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("CONSOLE_A2A_URL", "")
API_TOKEN = os.environ.get("CONSOLE_A2A_TOKEN", "")
WORKSPACE = pathlib.Path(os.environ.get("CONSOLE_WORKSPACE", "/workspace"))
MAX_POLL_SECONDS = 20


def call_api(operation, arguments):
    if not API_URL or not API_TOKEN:
        raise RuntimeError("Console messaging is not available in this activation")
    body = json.dumps({"operation": operation, "arguments": arguments}).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": "Bearer " + API_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    timeout = min(60, max(30, int(arguments.get("timeout_s", 0)) + 30))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        raise RuntimeError(str(detail)) from error


def relative_path(value):
    path = pathlib.Path(value)
    absolute = path.resolve() if path.is_absolute() else (pathlib.Path.cwd() / path).resolve()
    try:
        return absolute.relative_to(WORKSPACE).as_posix(), absolute
    except ValueError as error:
        raise RuntimeError("Artifacts must be files inside the Console workspace") from error


def encode_artifact(value):
    relative, absolute = relative_path(value)
    if not relative.startswith(".console/outbox/") or not absolute.is_file():
        raise RuntimeError("Artifacts must be files under .console/outbox/")
    return {
        "path": relative,
        "title": absolute.name,
        "content_base64": base64.b64encode(absolute.read_bytes()).decode("ascii"),
    }


def materialize_artifacts(value):
    if isinstance(value, list):
        return [materialize_artifacts(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: materialize_artifacts(item) for key, item in value.items() if key != "contentBase64"}
    content = value.get("contentBase64")
    destination = value.get("path")
    if isinstance(content, str) and isinstance(destination, str):
        path = (WORKSPACE / destination).resolve()
        try:
            path.relative_to(WORKSPACE)
        except ValueError as error:
            raise RuntimeError("Console returned an unsafe artifact path") from error
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(content, validate=True))
        result["path"] = path.relative_to(WORKSPACE).as_posix()
    return result


def content_from(args):
    if args.message is not None:
        return args.message
    return pathlib.Path(args.message_file).read_text(encoding="utf-8")


def continue_waiting_for_send(result, recipient, timeout_seconds, started_at):
    replies = result.get("replies", []) if isinstance(result, dict) else []
    deadline = started_at + timeout_seconds
    while not replies:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        polled = call_api("wait", {
            "from_agent": recipient,
            "reply_to": result["messageId"],
            "timeout_s": min(MAX_POLL_SECONDS, remaining),
        })
        replies = polled.get("messages", []) if isinstance(polled, dict) else []
    result["status"] = "replied" if replies else "timeout"
    result["replies"] = replies
    return result


def current_fx_session_id():
    try:
        completed = subprocess.run(
            [str(WORKSPACE / ".console/bin/fx"), "sessions", "--json", "--limit", "1"],
            cwd=WORKSPACE,
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
        value = json.loads(completed.stdout)
        sessions = value.get("sessions", []) if isinstance(value, dict) else []
        session_id = sessions[0].get("id") if sessions and isinstance(sessions[0], dict) else None
        if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", session_id):
            return session_id
    except Exception:
        pass
    return None


def add_content_arguments(command):
    content = command.add_mutually_exclusive_group(required=True)
    content.add_argument("--message")
    content.add_argument("--message-file")
    command.add_argument("--summary")
    command.add_argument("--artifact", action="append", default=[])
    return content


def main():
    parser = argparse.ArgumentParser(prog="a2a", description="Console conversation messaging")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("list", help="list reachable participants")

    send = commands.add_parser("send", help="send a durable conversation message")
    send.add_argument("--to", required=True, help="participant id or exact name")
    add_content_arguments(send)
    send.add_argument("--reply-to")
    reply_mode = send.add_mutually_exclusive_group()
    reply_mode.add_argument("--wait", dest="wait_for_reply", action="store_true")
    reply_mode.add_argument("--no-wait", dest="wait_for_reply", action="store_false")
    send.set_defaults(wait_for_reply=None)
    send.add_argument("--timeout", type=float, default=3600)

    wait = commands.add_parser("wait", help="wait for queued agent messages")
    wait.add_argument("--from-agent")
    wait.add_argument("--reply-to")
    wait.add_argument("--timeout", type=float, default=3600)

    progress = commands.add_parser("progress", help="publish a correlated task update")
    add_content_arguments(progress)
    progress.add_argument("--idempotency-key")

    complete = commands.add_parser("complete", help="complete the correlated task")
    add_content_arguments(complete)

    args = parser.parse_args()
    if args.command == "list":
        result = call_api("list", {})
    elif args.command == "send":
        started_at = time.monotonic()
        arguments = {
            "to": args.to,
            "content": content_from(args),
            "artifacts": [encode_artifact(path) for path in args.artifact],
            "timeout_s": args.timeout,
        }
        if args.summary is not None:
            arguments["summary"] = args.summary
        if args.reply_to is not None:
            arguments["reply_to"] = args.reply_to
        if args.wait_for_reply is not None:
            arguments["wait_for_reply"] = args.wait_for_reply
        result = call_api("send", arguments)
        should_continue = result.get("status") == "timeout" or (
            args.wait_for_reply is True and result.get("status") == "queued"
        )
        if should_continue:
            result = continue_waiting_for_send(
                result, args.to, args.timeout, started_at
            )
    elif args.command == "wait":
        arguments = {
            "timeout_s": args.timeout,
        }
        if args.from_agent is not None:
            arguments["from_agent"] = args.from_agent
        if args.reply_to is not None:
            arguments["reply_to"] = args.reply_to
        result = call_api("wait", arguments)
    else:
        arguments = {
            "content": content_from(args),
            "artifacts": [encode_artifact(path) for path in args.artifact],
        }
        if args.summary is not None:
            arguments["summary"] = args.summary
        if args.command == "progress" and args.idempotency_key is not None:
            arguments["idempotency_key"] = args.idempotency_key
        if args.command == "complete":
            session_id = current_fx_session_id()
            if session_id is not None:
                arguments["session_id"] = session_id
        result = call_api(args.command, arguments)
    print(json.dumps(materialize_artifacts(result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("a2a: " + str(error), file=sys.stderr)
        raise SystemExit(1)
`;
}
