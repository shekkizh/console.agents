// Runs outside the FX process. Native FX children inherit messaging access only.
export function fxRunnerSource(): string {
  return String.raw`import base64
import json
import http.server
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.request

JOB = pathlib.Path(__file__).resolve().parent
WORKSPACE = pathlib.Path(os.environ["CONSOLE_WORKSPACE"]).resolve()
TOKEN = os.environ.pop("CONSOLE_LIFECYCLE_TOKEN")
URL = os.environ["CONSOLE_A2A_URL"]
child = None
relay = None
relay_log_lock = threading.Lock()


def relay_event(**fields):
    # Never log request bodies, prompts, authorization, or provider error text.
    with relay_log_lock:
        path = JOB / "gateway-events.jsonl"
        if path.exists() and path.stat().st_size > 256 * 1024:
            path.replace(JOB / "gateway-events.previous.jsonl")
        with path.open("a", encoding="utf-8") as log:
            log.write(json.dumps({"time": time.time(), **fields}) + "\n")


class ModelRelay(http.server.BaseHTTPRequestHandler):
    # FX permits custom Gateway endpoints only on loopback. The remote endpoint
    # verifies the task token and owns the real account credential.
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        allowed = {("POST", "/v3/ai/language-model"), ("GET", "/coding-agent/v1/models")}
        if (self.command, self.path) not in allowed:
            self.send_error(404)
            return
        started = time.monotonic()
        headers_sent = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 4 * 1024 * 1024 or self.headers.get("Transfer-Encoding"):
                self.send_error(413)
                return
            data = self.rfile.read(length) if self.command == "POST" else None
            request = urllib.request.Request(os.environ["CONSOLE_MODEL_GATEWAY_URL"].rstrip("/") + self.path,
                data=data, method=self.command, headers={
                    "Authorization": "Bearer " + os.environ["CONSOLE_A2A_TOKEN"],
                    "Content-Type": "application/json",
                    "ai-language-model-streaming": self.headers.get("ai-language-model-streaming", "true"),
                })
            try:
                response = urllib.request.urlopen(request, timeout=290)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                headers_sent = True
                size = 0
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    size += len(chunk)
                relay_event(status=response.status, path=self.path, bytes=size, seconds=round(time.monotonic() - started, 3))
        except (BrokenPipeError, ConnectionResetError) as error:
            relay_event(error=type(error).__name__, path=self.path, seconds=round(time.monotonic() - started, 3))
        except Exception as error:
            relay_event(error=type(error).__name__, path=self.path, seconds=round(time.monotonic() - started, 3))
            if not headers_sent:
                self.send_error(502, "Console model relay connection failed")
            self.close_connection = True


def start_relay():
    global relay
    # Remove any inherited account key before starting FX or its native children.
    os.environ.pop("AI_GATEWAY_API_KEY", None)
    if not os.environ.get("CONSOLE_MODEL_GATEWAY_URL"):
        raise RuntimeError("Console model Gateway URL is required")
    relay = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelRelay)
    relay.daemon_threads = True
    threading.Thread(target=relay.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(relay.server_port)
    os.environ["FX_GATEWAY_BASE_URL"] = base
    os.environ["FX_GATEWAY_CHAT_URL"] = base + "/v3/ai/language-model"
    os.environ["AI_GATEWAY_API_KEY"] = "console-task-proxy"


def save(name, value):
    temporary = JOB / (name + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(JOB / name)


def artifact_warning(reason):
    # Attachment mistakes must not replace an otherwise successful answer.
    try:
        with (JOB / "artifact-warnings.log").open("a", encoding="utf-8") as log:
            log.write(reason + "\n")
    except OSError:
        pass


def cancel(signum, frame):
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
    save("status.json", {"state": "cancelled"})
    raise SystemExit(128 + signum)


def artifacts():
    manifest = WORKSPACE / ".console/artifacts.json"
    if not manifest.exists():
        return []
    try:
        paths = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        artifact_warning("ignored unreadable artifact manifest")
        return []
    if not isinstance(paths, list):
        artifact_warning("ignored non-list artifact manifest")
        return []
    if len(paths) > 4:
        artifact_warning("ignored artifact entries after the first four")
        paths = paths[:4]
    result = []
    total = 0
    for index, value in enumerate(paths):
        if not isinstance(value, str):
            artifact_warning("ignored non-string artifact entry " + str(index + 1))
            continue
        try:
            path = (WORKSPACE / value).resolve()
            relative = path.relative_to(WORKSPACE).as_posix()
            if not relative.startswith(".console/outbox/") or not path.is_file():
                raise ValueError
            size = path.stat().st_size
        except (OSError, ValueError):
            artifact_warning("ignored missing or unsafe artifact entry " + str(index + 1))
            continue
        if total + size > 3 * 1024 * 1024:
            artifact_warning("ignored artifact entry exceeding the 3 MB total limit")
            continue
        try:
            content = path.read_bytes()
        except OSError:
            artifact_warning("ignored unreadable artifact entry " + str(index + 1))
            continue
        if total + len(content) > 3 * 1024 * 1024:
            artifact_warning("ignored artifact entry exceeding the 3 MB total limit")
            continue

        total += len(content)
        result.append({"path": relative, "content_base64": base64.b64encode(content).decode("ascii")})
    return result


def deliver(operation, arguments):
    # Persist the exact payload first so HTTP recovery can replay it idempotently.
    save("delivery.json", {"operation": operation, "arguments": arguments})
    for attempt in range(3):
        try:
            request = urllib.request.Request(URL, data=json.dumps({"operation": operation, "arguments": arguments}).encode(),
                headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=30) as response:
                response.read()
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    global child
    os.umask(0o077)
    (JOB / "worker.pid").write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    save("status.json", {"state": "running"})
    start_relay()
    prompt = (JOB / "prompt.txt").read_text(encoding="utf-8")
    (JOB / "prompt.txt").unlink()
    command = [str(WORKSPACE / ".console/bin/fx"), "ask", "--yolo", "--json"]
    if os.environ.get("FX_RESUME_ID"):
        command += ["--resume-id", os.environ["FX_RESUME_ID"]]
    command += ["--", prompt]
    with (JOB / "stdout.json").open("w") as stdout, (JOB / "stderr.log").open("w") as stderr:
        child = subprocess.Popen(command, cwd=WORKSPACE, env=dict(os.environ), stdout=stdout, stderr=stderr, start_new_session=True)
        (JOB / "fx.pid").write_text(str(child.pid))
        code = child.wait()
    save("status.json", {"state": "exited", "exitCode": code})
    if code != 0:
        raise RuntimeError("FX exited with code " + str(code))
    result = json.loads((JOB / "stdout.json").read_text(encoding="utf-8"))
    if result.get("exit_code") != 0 or result.get("error"):
        raise RuntimeError("FX reported an unsuccessful result")
    # v0.0.8 output includes intermediate text; final_output is the completed answer.
    content = result.get("final_output")
    session = result.get("session_id")
    if not isinstance(content, str) or not content.strip() or len(content.strip().encode("utf-16-le")) // 2 > 100000:
        raise RuntimeError("FX returned an empty or oversized final response")
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", session):
        raise RuntimeError("FX returned an invalid session id")
    deliver("complete", {"content": content.strip(), "session_id": session, "artifacts": artifacts()})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Raw diagnostics stay in the private job directory, outside chat messages.
        (JOB / "runner-error.log").write_text(str(error), encoding="utf-8")
        # Never replace a successful result when only its callback failed.
        if not (JOB / "delivery.json").exists():
            deliver("fail", {"content": "The FX worker stopped before completing this request. Inspect its private job logs for details, then retry."})
        raise SystemExit(1)
`;
}
