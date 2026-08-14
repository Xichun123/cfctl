import assert from "node:assert/strict";
import test from "node:test";

import { formatZones, parseToolJson } from "./cfctl.mjs";

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
