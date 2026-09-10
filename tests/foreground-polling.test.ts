import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FOREGROUND_POLLING_WINDOW_MS, startForegroundPolling } from "../lib/foreground-polling.ts";

class Visibility extends EventTarget {
  hidden = false;
  setHidden(value: boolean) {
    this.hidden = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

test("polling cannot overlap requests, run in hidden tabs, or exceed its time budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const visibility = new Visibility();
  let calls = 0;
  let expired = 0;
  let release = () => {};
  const stop = startForegroundPolling(5000, () => {
    calls++;
    return new Promise<void>((resolve) => { release = resolve; });
  }, visibility, () => expired++, 30_000);
  t.after(stop);
  t.mock.timers.tick(5000);
  assert.equal(calls, 1);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1, "a slow request cannot overlap another tick");
  release();
  await Promise.resolve();
  visibility.setHidden(true);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  visibility.setHidden(false);
  assert.equal(calls, 2, "returning to the tab refreshes once");
  release();
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal(expired, 1);
  visibility.setHidden(true);
  visibility.setHidden(false);
  t.mock.timers.tick(60_000);
  assert.equal(calls, 2, "visibility changes cannot reset an expired budget");
});

test("production has no recurring recovery job and browser monitoring is bounded", () => {
  const configuration = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(configuration.crons, []);
  assert.equal(FOREGROUND_POLLING_WINDOW_MS, 15 * 60_000);
});
