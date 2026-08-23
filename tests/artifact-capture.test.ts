import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArtifactManifest,
  capturePeerArtifact,
  validArtifactPath,
  validPeerArtifactPath,
} from "../lib/server/artifact-capture.ts";

test("accepts bounded workspace-relative artifact paths", () => {
  assert.equal(
    validArtifactPath(".console/previews/final chart.png"),
    ".console/previews/final chart.png",
  );
  assert.equal(validArtifactPath("reports/final.pdf"), undefined);
  assert.equal(validArtifactPath("/etc/passwd"), undefined);
  assert.equal(validArtifactPath("../outside.txt"), undefined);
  assert.equal(validArtifactPath("folder\\file.txt"), undefined);
});

test("accepts only peer outbox artifact paths", () => {
  assert.equal(
    validPeerArtifactPath(".console/outbox/review notes.md"),
    ".console/outbox/review notes.md",
  );
  assert.equal(validPeerArtifactPath(".console/previews/leak.txt"), undefined);
  assert.equal(validPeerArtifactPath("../outside.txt"), undefined);
  assert.equal(validPeerArtifactPath("/workspace/.console/outbox/file.txt"), undefined);
});

test("validates peer artifact bytes received by the mailbox API", () => {
  const content = new TextEncoder().encode("# Review\nLooks good.");
  assert.deepEqual(
    capturePeerArtifact({
      path: ".console/outbox/review.md",
      title: "Review",
      content,
    }),
    {
      path: ".console/outbox/review.md",
      name: "review.md",
      title: "Review",
      mediaType: "text/plain; charset=utf-8",
      kind: "text",
      content,
    },
  );
  assert.throws(() => capturePeerArtifact({
    path: ".console/outbox/fake.png",
    content,
  }), /does not match/);
});

test("parses preview manifests while dropping unsafe paths", () => {
  assert.deepEqual(
    parseArtifactManifest(JSON.stringify({
      files: [
        { path: ".console/previews/chart.png", title: "Chart" },
        { path: "../../secret.txt" },
      ],
    })),
    [{ path: ".console/previews/chart.png", title: "Chart" }],
  );
});

test("rejects oversized preview manifests", () => {
  assert.deepEqual(
    parseArtifactManifest(JSON.stringify({
      files: Array.from(
        { length: 5 },
        (_, index) => ({ path: `.console/previews/${index}.txt` }),
      ),
    })),
    [],
  );
});
