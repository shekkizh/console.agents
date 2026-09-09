import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fxRunnerSource } from "../lib/fx-runner.ts";

for (const scenario of ["success", "crash", "callback-failure", "unsafe-artifact", "empty-final"] as const) {
  test(`launcher handles ${scenario} after waiting for FX`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "console-runner-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const job = join(root, ".console/jobs/test");
    mkdirSync(job, { recursive: true });
    mkdirSync(join(root, ".console/bin"), { recursive: true });
    writeFileSync(join(job, "prompt.txt"), "Test the parent task");
    writeFileSync(join(job, "runner.py"), fxRunnerSource());
    writeFileSync(join(root, ".console/bin/fx"), `#!/usr/bin/env python3
import json, os, pathlib, sys, urllib.request
assert 'CONSOLE_LIFECYCLE_TOKEN' not in os.environ
assert os.environ['AI_GATEWAY_API_KEY'] == 'console-task-proxy'
assert os.environ['FX_GATEWAY_CHAT_URL'].startswith('http://127.0.0.1:')
assert os.environ['CONSOLE_A2A_TOKEN'] == 'messaging-token'
assert sys.argv[1:4] == ['ask', '--yolo', '--json']
assert sys.argv[-1] == 'Test the parent task'
request = urllib.request.Request(os.environ['FX_GATEWAY_CHAT_URL'], data=b'{}', headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(request) as response:
    assert response.read() == b'data: token\\n\\n'
if os.environ['SCENARIO'] == 'crash':
    print('diagnostic: simulated startup failure', file=sys.stderr)
    sys.exit(42)
pathlib.Path('.console/outbox').mkdir()
pathlib.Path('.console/outbox/report.md').write_text('Parent report')
artifact = '../outside.md' if os.environ['SCENARIO'] == 'unsafe-artifact' else '.console/outbox/report.md'
pathlib.Path('.console/artifacts.json').write_text(json.dumps([artifact]))
print(json.dumps({'output': 'truncated preview', 'final_output': '' if os.environ['SCENARIO'] == 'empty-final' else 'Parent is done', 'session_id': 'parent-session', 'exit_code': 0}))
`, { mode: 0o755 });
    const result = spawnSync("python3", ["-c", `
import io, json, os, pathlib, runpy, sys, time, urllib.request
time.sleep = lambda _: None
def request(req, **kwargs):
    payload = json.loads(req.data)
    if '/api/model-gateway/' in req.full_url:
        assert req.get_header('Authorization') == 'Bearer messaging-token'
        response = io.BytesIO(b'data: token\\n\\n')
        response.status = 200
        response.headers = {'Content-Type': 'text/event-stream'}
        return response
    assert req.get_header('Authorization') == 'Bearer lifecycle-token'
    status = json.loads((pathlib.Path(sys.argv[1]).parent / 'status.json').read_text())
    assert status['state'] == 'exited'
    if os.environ['SCENARIO'] == 'callback-failure':
        raise OSError('simulated network failure')
    pathlib.Path(os.environ['CONSOLE_WORKSPACE'], 'callback.json').write_text(json.dumps(payload))
    return io.BytesIO(b'{}')
urllib.request.urlopen = request
runpy.run_path(sys.argv[1], run_name='__main__')
`, join(job, "runner.py")], {
      encoding: "utf8",
      env: { ...process.env, SCENARIO: scenario, CONSOLE_WORKSPACE: root,
        CONSOLE_A2A_URL: "https://console.example/api/a2a", CONSOLE_A2A_TOKEN: "messaging-token",
        CONSOLE_LIFECYCLE_TOKEN: "lifecycle-token", CONSOLE_MODEL_GATEWAY_URL: "https://console.example/api/model-gateway", AI_GATEWAY_API_KEY: "must-not-leak", FX_RESUME_ID: "" },
    });
    assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
    const gatewayLog = readFileSync(join(job, "gateway-events.jsonl"), "utf8");
    assert.match(gatewayLog, /"status": 200/);
    assert.doesNotMatch(gatewayLog, /messaging-token|must-not-leak|lifecycle-token/);
    const payload = JSON.parse(readFileSync(join(job, "delivery.json"), "utf8"));
    if (scenario === "success" || scenario === "callback-failure") {
      assert.equal(payload.operation, "complete");
      assert.equal(payload.arguments.session_id, "parent-session");
      assert.equal(payload.arguments.content, "Parent is done");
      assert.equal(Buffer.from(payload.arguments.artifacts[0].content_base64, "base64").toString(), "Parent report");
    } else {
      assert.equal(payload.operation, "fail");
      assert.doesNotMatch(payload.arguments.content, /simulated startup failure/);
    }
    if (scenario === "crash") {
      assert.equal(JSON.parse(readFileSync(join(job, "status.json"), "utf8")).exitCode, 42);
      assert.match(readFileSync(join(job, "stderr.log"), "utf8"), /simulated startup failure/);
    }
  });
}
