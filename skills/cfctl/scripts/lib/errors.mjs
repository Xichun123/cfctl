export class AgentError extends Error {
  constructor(code, message, { exitCode = 3, retryable = false, details = null, nextAction = null } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
    this.details = details;
    this.nextAction = nextAction;
  }
}

export function initialResult(operation) {
  return { schema_version: 1, operation, ok: false, data: null, pagination: null, mutation: { state: "none", verification: "not_applicable" }, error: null };
}

export function failure(result, error) {
  const uncertain = ["unknown", "applied"].includes(result.mutation.state);
  result.ok = false;
  result.error = {
    code: error.code || "INTERNAL_ERROR",
    message: error instanceof AgentError ? error.message : "Unexpected local error.",
    retryable: !uncertain && Boolean(error.retryable),
    next_action: uncertain ? "Read the target resource to reconcile the outcome before any retry. Do not replay this write automatically." : error.nextAction || (error.exitCode === 2 ? "Read the operation schema and correct the input or configuration." : "Inspect error details and resolve the cause before retrying."),
    details: error.details ?? null,
  };
  return uncertain ? 5 : error.exitCode || 3;
}

// Redact configured credentials even if an upstream error echoes a header value.
export function redact(value, env = process.env) {
  const secrets = [env.CLOUDFLARE_MCP_TOKEN, env.CLOUDFLARE_MCP_AUTHORIZATION];
  if (env.CLOUDFLARE_MCP_AUTHORIZATION) secrets.push(env.CLOUDFLARE_MCP_AUTHORIZATION.replace(/^\S+\s+/, ""));
  try { secrets.push(...Object.values(JSON.parse(env.CLOUDFLARE_MCP_HEADERS_JSON || "{}"))); } catch { /* configuration error is already structured */ }
  const values = secrets.filter((entry) => typeof entry === "string" && entry.length).sort((a, b) => b.length - a.length);
  const clean = (entry) => {
    if (typeof entry === "string") return values.reduce((text, secret) => text.split(secret).join("[REDACTED]"), entry);
    if (Array.isArray(entry)) return entry.map(clean);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([key, data]) => [clean(key), clean(data)]));
    return entry;
  };
  return clean(value);
}
