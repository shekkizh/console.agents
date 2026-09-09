import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  a2aCliSource,
  A2A_CLI_PATH,
  A2A_CLI_SOURCE_PATH,
} from "../lib/a2a-cli.ts";

test("ships a direct mailbox CLI without MCP or filesystem polling", () => {
  const source = a2aCliSource();
  assert.equal(A2A_CLI_PATH, ".console/bin/a2a");
  assert.equal(A2A_CLI_SOURCE_PATH, ".console/a2a.py");
  assert.match(source, /urllib\.request/);
  assert.match(source, /call_api\("list"/);
  assert.match(source, /call_api\("send"/);
  assert.match(source, /call_api\("wait"/);
  assert.match(source, /MAX_POLL_SECONDS = 20/);
  assert.match(source, /continue_waiting_for_send/);
  assert.match(source, /commands\.add_parser\("progress"/);
  assert.doesNotMatch(source, /commands\.add_parser\("complete"/);
  assert.doesNotMatch(source, /current_fx_session_id/);
  assert.doesNotMatch(source, /\bmcp\b/i);
  assert.doesNotMatch(source, /time\.sleep|requests\.jsonl|responses\//);

  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.argv[1], 'a2a', 'exec')", source],
    { encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});

test("peer polling stops at sixty seconds and preserves the correlated request", () => {
  const tested = spawnSync("python3", ["-c", String.raw`
import sys
scope = {"__name__": "cli_test"}
exec(compile(sys.argv[1], 'a2a', 'exec'), scope)
clock = [0.0]
class Clock:
    @staticmethod
    def monotonic():
        return clock[0]
scope['time'] = Clock
polls = []
def call(operation, arguments, deadline=None):
    assert operation == 'wait'
    assert arguments['reply_to'] == 'request-123'
    assert deadline == 60
    polls.append(arguments['timeout_s'])
    clock[0] += arguments['timeout_s']
    return {'status': 'timeout', 'messages': []}
scope['call_api'] = call
result = scope['continue_waiting_for_send']({'messageId': 'request-123'}, 'peer', 3600, 0)
assert polls == [20, 20, 20], polls
assert result['status'] == 'timeout'
assert result['requestPreserved'] is True
assert 'request-123' in result['advice']
for invalid in ['61', '-1', 'nan', 'inf']:
    try:
        scope['wait_seconds'](invalid)
    except Exception:
        pass
    else:
        raise AssertionError('Accepted an invalid timeout: ' + invalid)
`, a2aCliSource()], { encoding: "utf8" });
  assert.equal(tested.status, 0, tested.stderr);
});

test("the CLI respects server wait exhaustion and ancestor cycle decisions", () => {
  const tested = spawnSync("python3", ["-c", String.raw`
import sys
scope = {"__name__": "cli_test"}
exec(compile(sys.argv[1], 'a2a', 'exec'), scope)
polls = []
def expired(operation, arguments, deadline=None):
    polls.append(operation)
    return {'status': 'timeout', 'messages': [], 'waitExhausted': True}
scope['call_api'] = expired
scope['continue_waiting_for_send']({'messageId': 'request-123'}, 'peer', 60, scope['time'].monotonic())
assert polls == ['wait']
polls.clear()
def cyclic(operation, arguments, deadline=None):
    polls.append(operation)
    return {'status': 'queued', 'messageId': 'request-456', 'waitSkipped': 'dependency_cycle'}
scope['call_api'] = cyclic
sys.argv = ['a2a', 'send', '--to', 'ancestor', '--message', 'question', '--wait']
scope['main']()
assert polls == ['send'], polls
`, a2aCliSource()], { encoding: "utf8" });
  assert.equal(tested.status, 0, tested.stderr);
});
