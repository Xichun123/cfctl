#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentError, initialResult, failure, redact } from "./lib/errors.mjs";
import { describe, normalizeInput } from "./lib/schema.mjs";
import { configuration, McpClient } from "./lib/mcp.mjs";
import { execute } from "./lib/operations.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

async function readInput(argv, stdin) {
  if (!argv.length) return {};
  const [source, value] = argv;
  if (!(source === "--stdin" && argv.length === 1) && !(["--input", "--file"].includes(source) && argv.length === 2)) throw new AgentError("INVALID_INPUT", "Use exactly one of --input <JSON>, --file <path>, or --stdin.", { exitCode: 2 });
  let text;
  if (source === "--input") text = value;
  if (source === "--file") {
    try { text = await readFile(value, "utf8"); } catch { throw new AgentError("INPUT_IO_ERROR", "Could not read the JSON input file.", { exitCode: 2 }); }
  }
  if (source === "--stdin") {
    if (stdin.isTTY) throw new AgentError("INVALID_INPUT", "--stdin requires piped JSON; interactive input is unsupported.", { exitCode: 2 });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of stdin) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_INPUT_BYTES) throw new AgentError("INVALID_INPUT", "Input exceeds 8 MiB.", { exitCode: 2 });
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("INPUT_IO_ERROR", "Could not read JSON from stdin.", { exitCode: 2 });
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new AgentError("INVALID_INPUT", "Input exceeds 8 MiB.", { exitCode: 2 });
  try { return JSON.parse(text); } catch { throw new AgentError("INVALID_JSON", "Input must be one valid JSON object.", { exitCode: 2 }); }
}

export async function run(argv, { env = process.env, stdin = process.stdin, clientFactory = (config) => new McpClient(config) } = {}) {
  const operation = argv[0] || "schema";
  const result = initialResult(operation);
  let exitCode = 0;
  try {
    if (operation === "schema") {
      if (argv.length > 2) throw new AgentError("INVALID_INPUT", "Usage: cfctl schema [operation]", { exitCode: 2 });
      result.data = describe(argv[1]);
    } else {
      const input = normalizeInput(operation, await readInput(argv.slice(1), stdin));
      const client = clientFactory(configuration(env));
      const initialized = await client.initialize();
      await execute(client, operation, input, result, initialized);
    }
    result.ok = true;
  } catch (error) {
    exitCode = failure(result, error);
  }
  return { result: redact(result, env), exitCode };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { result, exitCode } = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
