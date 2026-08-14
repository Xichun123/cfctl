import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDnsRecords,
  formatZones,
  normalizeDnsName,
  parseOptions,
  parseToolJson,
} from "./cfctl.mjs";

test("parses MCP JSON and formats zones", () => {
  const response = parseToolJson({
    content: [{ type: "text", text: '{"success":true,"status":200}' }],
  });
  assert.equal(response.status, 200);
  assert.match(
    formatZones([{ name: "example.com", status: "active", paused: false, type: "full", plan: "Free" }]),
    /example\.com\s+active\s+false\s+full\s+Free/
  );
});

test("parses and formats DNS commands", () => {
  assert.equal(normalizeDnsName("example.com", "www"), "www.example.com");
  assert.equal(normalizeDnsName("example.com", "@"), "example.com");
  assert.deepEqual(parseOptions(["example.com", "--type", "A", "--json"], ["--type"], ["--json"]), {
    positionals: ["example.com"],
    options: { "--type": "A", "--json": true },
  });
  assert.match(
    formatDnsRecords([{ id: "a".repeat(32), type: "A", name: "www.example.com", content: "192.0.2.1", proxied: true, ttl: 1 }]),
    /A\s+www\.example\.com\s+192\.0\.2\.1\s+true\s+1/
  );
});
