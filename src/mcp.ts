/* MCP server: JSON-RPC dispatch and the three exposed tools.
   No GitHub tool is proxied. This server terminates MCP itself. */

import { randomBytes } from "node:crypto";
import { Edit, ToolError, User, commitEdits, listMd, readMd, validatePath } from "./github.js";
import { EditError } from "./md.js";

const KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const FALLBACK_VERSION = "2025-06-18";

/* ---------------- the standing ledger ---------------- */

const PENDING_LINE =
  "PENDING: nothing — this server holds no uncommitted work. A file is unchanged until commit_edits returns a commit SHA.";

/** Failure-only retention. Written ONLY from an isError result; it can never produce a
    success receipt. If this ever grows a "stage for later" entry point, the safety story
    of the whole design is gone. */
type FailedBatch = { ref: string; message: string; edits: Edit[]; failedAt: number; reason: string };
const lastFailure = new Map<string, FailedBatch>();
const commitTimes = new Map<string, number[]>();
const RETENTION_MS = 30 * 60_000;

export function sweep(): void {
  const now = Date.now();
  for (const [k, v] of lastFailure) if (now - v.failedAt > RETENTION_MS) lastFailure.delete(k);
  for (const [k, v] of commitTimes) {
    const keep = v.filter((t) => now - t < 10 * 60_000);
    if (keep.length) commitTimes.set(k, keep);
    else commitTimes.delete(k);
  }
}

export function onShutdown(): void {
  for (const [sub, b] of lastFailure) {
    console.log(`held failed batch ${b.ref} (${sub}, ${b.edits.length} ops) dropped on shutdown`);
  }
}

function ledger(sub: string): string {
  const held = lastFailure.get(sub);
  let out = `\n\n${PENDING_LINE}`;
  if (held) {
    const age = Date.now() - held.failedAt;
    const mins = age < 60_000 ? `${Math.max(1, Math.round(age / 1000))}s` : `${Math.round(age / 60_000)}m`;
    const left = Math.max(1, Math.round((RETENTION_MS - age) / 60_000));
    out +=
      `\nNOTE: a batch you sent ${mins} ago failed and is held as retry_ref ${held.ref} ` +
      `(${held.edits.length} operations, "${held.message}" — ${held.reason}). ` +
      `Resend it with commit_edits({message, retry_ref:"${held.ref}"}). It expires in ${left}m and lives in server memory only; a restart drops it.`;
  }
  return out;
}

/* ---------------- tool definitions ---------------- */

const EDIT_ITEM_SCHEMA = {
  type: "object",
  description:
    "One edit operation. Required fields depend on op: " +
    'write needs content (and expect_sha when mode="overwrite"); ' +
    "str_replace needs old_string and new_string; " +
    "edit_section needs heading and mode; " +
    "delete needs expect_sha.",
  properties: {
    op: {
      type: "string",
      enum: ["write", "str_replace", "edit_section", "delete"],
      description:
        'write = create a new file, replace a whole file, or append to one. ' +
        "str_replace = exact-text surgical replacement. " +
        "edit_section = replace/append/prepend/delete a markdown section addressed by its heading. " +
        "delete = remove a file.",
    },
    path: { type: "string", description: "Repo-relative path ending in .md, no leading slash." },
    content: {
      type: "string",
      description: "write: the whole file text (create/overwrite) or the text to add (append). edit_section: the new section text. Omit for delete.",
    },
    mode: {
      type: "string",
      enum: ["create", "overwrite", "append", "replace", "prepend", "delete"],
      description:
        'For op=write: "create" (default, fails if the path exists), "overwrite" (requires expect_sha), or "append". ' +
        'For op=edit_section: "replace" (swap the body, keep the heading), "append", "prepend", or "delete" (remove heading and body).',
    },
    old_string: { type: "string", description: "str_replace: text to find, matched byte for byte including whitespace and indentation." },
    new_string: { type: "string", description: "str_replace: replacement text. Must differ from old_string." },
    replace_all: { type: "boolean", description: "str_replace: replace every occurrence instead of requiring a unique match. Default false." },
    heading: {
      type: "string",
      description:
        'edit_section: the heading text as shown in read_md\'s outline. Accepts a breadcrumb such as "Guide > Install" ' +
        'or an occurrence index such as "Notes#2" when the text is not unique.',
    },
    expect_sha: {
      type: "string",
      description:
        "The file's current 40-character git blob SHA, from read_md or list_md. REQUIRED for delete and for " +
        'write mode="overwrite" — the two operations that destroy a whole file. Optional elsewhere as a staleness guard.',
    },
  },
  required: ["op", "path"],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "list_md",
    title: "List markdown files",
    description:
      "List every .md file in the connected repository, with byte size and git blob SHA. Read-only. " +
      "The blob SHA shown is exactly what that file's expect_sha takes in commit_edits, so a file can be deleted straight from this listing with no content read.",
    inputSchema: {
      type: "object",
      properties: {
        path_prefix: { type: "string", description: 'Repo-relative directory prefix to filter by, e.g. "docs/". Empty lists the whole repository.' },
        max_results: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum files to list. Default 500." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List markdown files", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "read_md",
    title: "Read markdown file",
    description:
      "Return the exact text of one .md file, its git blob SHA, and an outline of its headings with line ranges. Read-only. " +
      "Content comes back without line-number gutters, so any span copied out of it matches the file byte for byte and can be pasted straight into old_string.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Repo-relative path to a .md file, e.g. "docs/guide.md". No leading slash.' },
        offset_lines: { type: "integer", minimum: 1, description: "1-based line to start the returned window at. Default 1." },
        max_bytes: { type: "integer", minimum: 1000, maximum: 120000, description: "Byte cap on the returned window. Default 100000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Read markdown file", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "commit_edits",
    title: "Commit markdown edits",
    description:
      "Apply an ordered list of markdown edits and push them as EXACTLY ONE commit. This is the only tool that writes. " +
      "Either every operation succeeds and one commit is created, or nothing is sent to GitHub at all — this server holds no staging area, " +
      "and a file is unchanged until this call returns a commit SHA. Batch as much as you can into a single call: several files and " +
      "several operations per file land in one commit. Operations apply in array order against one working copy per path, so a later " +
      "operation sees the result of an earlier one. Every path must end in .md.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000, description: "The commit message." },
        edits: { type: "array", minItems: 1, maxItems: 100, items: EDIT_ITEM_SCHEMA, description: "Operations applied in array order." },
        retry_ref: {
          type: "string",
          description: "Resend a batch this server retained after a failed commit_edits. Supply INSTEAD of edits, never alongside it.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { title: "Commit markdown edits", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const INSTRUCTIONS =
  "Markdown editing for one GitHub repository. Read with list_md and read_md; change anything with commit_edits, which is the only " +
  "tool that writes and always produces exactly one commit. There is no staging area and nothing is ever queued: an edit exists only " +
  "once commit_edits returns a commit SHA. Prefer one commit_edits call carrying every change you intend, rather than one call per file. " +
  "For surgical changes use str_replace (exact text) or edit_section (addressed by heading) rather than rewriting a whole file. " +
  "expect_sha is required wherever an operation destroys a whole file — delete, and write with mode=overwrite.";

/* ---------------- helpers ---------------- */

const text = (s: string) => ({ content: [{ type: "text", text: s }] });
const toolError = (s: string) => ({ content: [{ type: "text", text: s }], isError: true });

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ToolError(`${field} must be a string.`);
  return v;
}

/** Normalize the flat wire shape into the discriminated Edit union, enforcing the
    per-op requirements the flat schema cannot express. */
const EDIT_KEYS = new Set(["op", "path", "content", "mode", "old_string", "new_string", "replace_all", "heading", "expect_sha"]);

function coerceEdit(raw: unknown, i: number): Edit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`edits[${i}] must be an object.`);
  const e = raw as Record<string, unknown>;
  // additionalProperties:false is advertised in the schema, and nothing validates it for us:
  // claude.ai does not enforce server-side schemas, so a stray key would be silently dropped.
  const unknown = Object.keys(e).filter((k) => !EDIT_KEYS.has(k));
  if (unknown.length) throw new ToolError(`edits[${i}] has unknown field(s): ${unknown.join(", ")}. Allowed: ${[...EDIT_KEYS].join(", ")}.`);
  const op = e.op;
  const path = str(e.path, `edits[${i}].path`);
  const sha = e.expect_sha === undefined ? undefined : str(e.expect_sha, `edits[${i}].expect_sha`);
  if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ToolError(`edits[${i}].expect_sha must be a 40-character git blob SHA (got "${sha}").`);
  }

  if (op === "write") {
    // `?? "create"` would let an explicit null mean create, unlike every neighbouring check.
    const mode = (e.mode === undefined ? "create" : e.mode) as string;
    if (!["create", "overwrite", "append"].includes(mode)) {
      throw new ToolError(`edits[${i}]: op=write takes mode "create", "overwrite" or "append" (got ${JSON.stringify(e.mode)}).`);
    }
    // expect_sha is required wherever an op destroys a whole file. Enforced here AND in
    // shaGuard: a single layer means deleting one guard silently permits a blind overwrite.
    if (mode === "overwrite" && !sha) {
      throw new ToolError(
        `edits[${i}]: write mode="overwrite" requires expect_sha (the file's current blob SHA, from read_md or list_md). ` +
          `Refusing to replace a whole file that was not observed.`
      );
    }
    return { op: "write", path, content: str(e.content, `edits[${i}].content`), mode: mode as any, expect_sha: sha };
  }
  if (op === "str_replace") {
    return {
      op: "str_replace",
      path,
      old_string: str(e.old_string, `edits[${i}].old_string`),
      new_string: str(e.new_string, `edits[${i}].new_string`),
      replace_all: e.replace_all === true,
      expect_sha: sha,
    };
  }
  if (op === "edit_section") {
    const mode = e.mode as string;
    if (!["replace", "append", "prepend", "delete"].includes(mode)) {
      throw new ToolError(`edits[${i}]: op=edit_section takes mode "replace", "append", "prepend" or "delete" (got ${JSON.stringify(e.mode)}).`);
    }
    return {
      op: "edit_section",
      path,
      heading: str(e.heading, `edits[${i}].heading`),
      mode: mode as any,
      content: e.content === undefined ? undefined : str(e.content, `edits[${i}].content`),
      expect_sha: sha,
    };
  }
  if (op === "delete") {
    if (!sha) {
      throw new ToolError(
        `edits[${i}]: delete requires expect_sha (the file's current blob SHA, returned by read_md and list_md). ` +
          `Refusing to delete a file that was not observed.`
      );
    }
    return { op: "delete", path, expect_sha: sha };
  }
  throw new ToolError(`edits[${i}].op must be one of write, str_replace, edit_section, delete (got ${JSON.stringify(op)}).`);
}

/* ---------------- tool execution ---------------- */

async function callTool(user: User, name: string, args: Record<string, unknown>) {
  if (name === "list_md") {
    const prefix = args.path_prefix === undefined ? "" : str(args.path_prefix, "path_prefix");
    const max = typeof args.max_results === "number" ? Math.min(2000, Math.max(1, args.max_results)) : 500;
    const r = await listMd(user, prefix, max);
    if (!r.files.length) {
      return text(`No .md files${prefix ? ` under "${prefix}"` : ""} in ${user.repo} on ${r.branch}.${ledger(user.id)}`);
    }
    const rows = r.files.map((f) => `${f.sha}  ${String(f.size ?? 0).padStart(7)}  ${f.path}`).join("\n");
    let head = `${user.repo} on ${r.branch} — ${r.total} markdown file(s)`;
    if (r.files.length < r.total) head += `, showing ${r.files.length}`;
    if (r.truncated) head += ` (GitHub truncated the tree; narrow with path_prefix for a complete list)`;
    return text(`${head}\n\nblob sha                                    bytes  path\n${rows}${ledger(user.id)}`);
  }

  if (name === "read_md") {
    const path = validatePath(user, args.path);
    const offset = typeof args.offset_lines === "number" ? Math.max(1, args.offset_lines) : 1;
    const maxBytes = typeof args.max_bytes === "number" ? Math.min(120000, Math.max(1000, args.max_bytes)) : 100000;
    const r = await readMd(user, path, offset, maxBytes);
    let out = `${path} on ${r.branch}\nblob sha: ${r.sha}\nlines: ${r.totalLines}`;
    if (r.unclosedFence !== null) out += `\nwarning: an unclosed code fence opens at line ${r.unclosedFence + 1}; headings after it are not addressable by edit_section`;
    if (r.outline.length) out += `\n\noutline:\n${r.outline.join("\n")}`;
    out += `\n\n--- content (from line ${r.startLine}) ---\n${r.content}`;
    if (r.clipped) out += `\n--- truncated at max_bytes; continue with offset_lines ---`;
    return text(out + ledger(user.id));
  }

  if (name === "commit_edits") {
    const message = str(args.message, "message");
    // The schema advertises these bounds; nothing else enforces them.
    if (!message.trim()) throw new ToolError("message must not be empty — GitHub rejects a commit with no message.");
    if (message.length > 2000) throw new ToolError(`message is ${message.length} characters; the maximum is 2000.`);
    const hasRef = typeof args.retry_ref === "string" && args.retry_ref;
    const hasEdits = Array.isArray(args.edits);
    if (hasRef && hasEdits) throw new ToolError("Supply either edits or retry_ref, not both.");

    let edits: Edit[];
    if (hasRef) {
      const held = lastFailure.get(user.id);
      if (!held || held.ref !== args.retry_ref) {
        throw new ToolError(`No retained batch matches retry_ref "${String(args.retry_ref)}" — it may have expired, already succeeded, or been dropped by a restart.`);
      }
      edits = held.edits;
    } else {
      if (!hasEdits || !(args.edits as unknown[]).length) throw new ToolError("edits must be a non-empty array (or supply retry_ref).");
      if ((args.edits as unknown[]).length > 100) {
        throw new ToolError(`edits has ${(args.edits as unknown[]).length} operations; the maximum is 100. Split this into several commits.`);
      }
      edits = (args.edits as unknown[]).map(coerceEdit);
    }

    for (const e of edits) validatePath(user, e.path);

    let result;
    try {
      result = await commitEdits(user, message, edits);
    } catch (err) {
      if (!(err instanceof ToolError || err instanceof EditError)) throw err;
      const reason = err.message;
      // Retention exists so a large batch need not be retyped. A batch that can never succeed
      // as-sent gets no ref: offering to resend it would only produce the same failure.
      if (/No effective changes/i.test(reason)) return toolError(`${reason}${ledger(user.id)}`);
      const ref = `r_${randomBytes(3).toString("hex")}`;
      lastFailure.set(user.id, { ref, message, edits, failedAt: Date.now(), reason: reason.split("\n")[0]!.slice(0, 160) });
      return toolError(`${reason}\n\nThis batch is held as retry_ref ${ref} — resend it unchanged with commit_edits({message, retry_ref:"${ref}"}) once the cause is fixed.${ledger(user.id)}`);
    }

    lastFailure.delete(user.id);
    const times = (commitTimes.get(user.id) || []).filter((t) => Date.now() - t < 10 * 60_000);
    times.push(Date.now());
    commitTimes.set(user.id, times);

    let out = `Committed ${result.sha.slice(0, 7)} to ${user.repo}@${result.branch}\n${result.url}`;
    if (result.changed.length) out += `\n\nchanged (${result.changed.length}): ${result.changed.join(", ")}`;
    if (result.deleted.length) out += `\ndeleted (${result.deleted.length}): ${result.deleted.join(", ")}`;
    if (result.notes.length) out += `\n\n${result.notes.map((n) => `• ${n}`).join("\n")}`;
    if (result.warnings.length) out += `\n\nwarn: ${result.warnings.join("; ")}`;

    const touched = result.changed.length + result.deleted.length;
    if (times.length >= 3 && touched === 1) {
      const span = Math.max(1, Math.round((Date.now() - times[0]!) / 60_000));
      out +=
        `\n\nNOTE: ${times.length} commits in ${span}m, this one touching a single file. ` +
        `commit_edits takes an edits array — several files and several operations per file land in one commit.`;
    }
    return text(out + ledger(user.id));
  }

  return null; // unknown tool -> caller emits a protocol error
}

/* ---------------- JSON-RPC ---------------- */

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

/** Returns null for notifications (caller answers 202 with an empty body). */
export async function handleMessage(user: User, msg: any): Promise<object | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid Request");
  const { id, method } = msg;
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request: method must be a string");
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, -32600, "Invalid Request: id must be a string or number");
  }

  // A notification is fire-and-forget and MAY be retried by the client, so it must never
  // perform a write and must never get a response. Decided by the absence of `id` alone —
  // keying off the method name both executed id-less tools/call and hung real requests whose
  // method merely started with "notifications/".
  const isNotification = !("id" in msg) || msg.id === undefined;
  if (isNotification) return null;

  if (method === "initialize") {
    const asked = msg.params?.protocolVersion;
    // Never error on an unknown version: a future claude.ai bump must not brick the connector.
    const version = KNOWN_VERSIONS.includes(asked) ? asked : FALLBACK_VERSION;
    return rpcOk(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "md-github", version: "2.0.0" },
      instructions: INSTRUCTIONS,
    });
  }

  if (method === "ping") return rpcOk(id, {});

  if (method === "tools/list") return rpcOk(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === name)) {
      return rpcError(id, -32602, `Unknown tool "${String(name)}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
    }
    try {
      const r = await callTool(user, name, args);
      return rpcOk(id, r);
    } catch (err) {
      // SEP-1303: everything the model could fix is a TOOL error, not a protocol error.
      if (err instanceof ToolError || err instanceof EditError) return rpcOk(id, toolError(err.message + ledger(user.id)));
      console.error("tools/call failed:", err);
      return rpcOk(id, toolError(`The server hit an unexpected error: ${err instanceof Error ? err.message : String(err)}${ledger(user.id)}`));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
