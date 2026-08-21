import assert from "node:assert/strict";
import test from "node:test";
import { parseArtifactManifest, validArtifactPath } from "../lib/server/artifact-capture.ts";

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
