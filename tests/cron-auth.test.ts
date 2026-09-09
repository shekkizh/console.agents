import assert from "node:assert/strict";
import test from "node:test";
import { authorizedReconciler } from "../lib/server/cron-auth.ts";

test("reconciliation requires the configured cron secret", () => {
  const request = (token: string) => new Request("http://localhost/api/internal/reconcile", {
    headers: { authorization: token },
  });
  assert.equal(authorizedReconciler(request("Bearer secret"), "secret"), true);
  assert.equal(authorizedReconciler(request("Bearer wrong!"), "secret"), false);
  assert.equal(authorizedReconciler(request("Bearer "), ""), false);
});
