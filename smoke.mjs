// End-to-end: OAuth walk, then the MCP tool layer against a stateful fake GitHub.
// Run the server first with GITHUB_API_URL pointed at 127.0.0.1:8899 (see README).
import { createHash, randomBytes } from "node:crypto";
import { startFakeGitHub } from "./fake-github.mjs";

const B = "http://127.0.0.1:8787";
const b64 = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const RD = "https://claude.ai/api/mcp/auth_callback";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log(`PASS  ${n}`); return; }
  fail++;
  console.log(`FAIL  ${n}${extra ? "\n      " + String(extra).slice(0, 400) : ""}`);
  process.exitCode = 1;
};

/* ---------------- fake GitHub ---------------- */

const gh = startFakeGitHub({ port: 8899 });
await gh.ready;

const ALICE_MD = "# Guide\n\nintro\n\n## Install\n\nstep one\n\n## Usage\n\nrun it\n";
gh.seed("alice/notes", { files: { "guide.md": ALICE_MD, "docs/old.md": "# Old\n\nbye\n", "README.txt": "not markdown\n" } });
gh.seed("bob/wiki", { files: { "index.md": "# Bob\n\nhi\n" } });

/* ---------------- OAuth walk ---------------- */

async function tokenFor(secret) {
  const client = await (await fetch(`${B}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "smoke", redirect_uris: [RD] }),
  })).json();
  const verifier = b64(randomBytes(32));
  const q = new URLSearchParams({
    client_id: client.client_id, redirect_uri: RD, response_type: "code",
    code_challenge: b64(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256", state: "s", scope: "mcp",
  });
  const html = await (await fetch(`${B}/authorize?${q}`)).text();
  const fields = new URLSearchParams(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]])
  );
  const r = await fetch(`${B}/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([...fields, ["secret", secret]]), redirect: "manual",
  });
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(`${B}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RD, code_verifier: verifier }),
  })).json();
  return { tok, fields, verifier };
}

const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json();
ok("protected-resource metadata", prm.resource === `${B}/mcp` && prm.authorization_servers[0] === B);
const as = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
ok("AS metadata advertises PKCE S256 + public client",
  as.code_challenge_methods_supported[0] === "S256" && as.token_endpoint_auth_methods_supported[0] === "none");

const alice = await tokenFor("secret-alice");
ok("form round-trips every param /authorize requires",
  ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"].every((k) => alice.fields.has(k)));
ok("alice gets a token", !!alice.tok.access_token && alice.tok.expires_in === 3600);
const bob = await tokenFor("secret-bob");
const sub = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).sub;
ok("two users get distinct identities", sub(alice.tok.access_token) === "alice" && sub(bob.tok.access_token) === "bob");

const bad = await fetch(`${B}/authorize?` + new URLSearchParams({ ...Object.fromEntries(alice.fields), redirect_uri: "https://evil.example/cb" }));
ok("rejects non-allowlisted redirect_uri", bad.status === 400);

const noAuth = await fetch(`${B}/mcp`, { method: "POST", body: "{}" });
ok("401 + WWW-Authenticate on /mcp",
  noAuth.status === 401 && (noAuth.headers.get("www-authenticate") || "").includes(`resource_metadata="${B}/.well-known/oauth-protected-resource"`));

/* ---------------- MCP plumbing ---------------- */

let rpcId = 0;
async function rpc(token, method, params) {
  const res = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json(), headers: res.headers };
}
// Every tool result must carry the standing ledger line — asserted centrally so none can skip it.
let ledgerMisses = 0;
async function call(token, name, args) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const t = r.body?.result?.content?.[0]?.text ?? "";
  if (!t.includes("PENDING:")) ledgerMisses++;
  return { text: t, isError: !!r.body?.result?.isError, raw: r.body };
}
const A = alice.tok.access_token, BK = bob.tok.access_token;

const init = await rpc(A, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
ok("initialize echoes a known protocol version", init.body.result.protocolVersion === "2025-06-18");
const oldInit = await rpc(A, "initialize", { protocolVersion: "1.0.0", capabilities: {}, clientInfo: { name: "s", version: "0" } });
ok("unknown protocol version negotiates rather than erroring", !oldInit.body.error && !!oldInit.body.result.protocolVersion);
ok("declares only the tools capability",
  init.body.result.capabilities.tools && init.body.result.capabilities.tools.listChanged !== true &&
  !init.body.result.capabilities.resources && !init.body.result.capabilities.prompts);
ok("instructions present and under 2000 bytes",
  init.body.result.instructions?.length > 0 && Buffer.byteLength(init.body.result.instructions) < 2000);
ok("no Mcp-Session-Id is ever minted", !init.headers.get("mcp-session-id"));

const notif = await fetch(`${B}/mcp`, {
  method: "POST", headers: { authorization: `Bearer ${A}`, "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
ok("notification answers 202 with an empty body", notif.status === 202 && (await notif.text()) === "");

ok("ping returns an empty result", (await rpc(A, "ping", {})).body.result && Object.keys((await rpc(A, "ping", {})).body.result).length === 0);
ok("unknown method is -32601", (await rpc(A, "nope/nope", {})).body.error?.code === -32601);
ok("unknown tool is a protocol error -32602", (await rpc(A, "tools/call", { name: "delete_repo", arguments: {} })).body.error?.code === -32602);
ok("tools/call with no arguments does not crash", !(await rpc(A, "tools/call", { name: "list_md" })).body.error);
ok("GET /mcp is 405", (await fetch(`${B}/mcp`, { headers: { authorization: `Bearer ${A}` } })).status === 405);
ok("DELETE /mcp is 405", (await fetch(`${B}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${A}` } })).status === 405);

const list = (await rpc(A, "tools/list", {})).body.result.tools;
const names = list.map((t) => t.name).sort();
ok("EXACTLY three tools are exposed, no GitHub passthrough",
  JSON.stringify(names) === JSON.stringify(["commit_edits", "list_md", "read_md"]), JSON.stringify(names));
ok("every tool has a title, object schema and annotations",
  list.every((t) => t.title && t.inputSchema?.type === "object" && t.inputSchema.additionalProperties === false && t.annotations));
ok("reads are readOnlyHint, commit_edits is destructiveHint",
  list.find((t) => t.name === "list_md").annotations.readOnlyHint === true &&
  list.find((t) => t.name === "read_md").annotations.readOnlyHint === true &&
  list.find((t) => t.name === "commit_edits").annotations.destructiveHint === true);

/* ---------------- reads ---------------- */

const listed = await call(A, "list_md", {});
ok("list_md returns 40-hex blob shas", /\b[0-9a-f]{40}\b/.test(listed.text));
ok("list_md filters to .md only", listed.text.includes("guide.md") && listed.text.includes("docs/old.md") && !listed.text.includes("README.txt"));

const read = await call(A, "read_md", { path: "guide.md" });
const guideSha = /blob sha: ([0-9a-f]{40})/.exec(read.text)[1];
ok("read_md returns the blob sha and an outline", !!guideSha && read.text.includes("outline:") && read.text.includes("L2 Install"));
ok("read_md content has no line-number gutters", read.text.includes("\n# Guide\n") && !/^\s*\d+\t/m.test(read.text.split("--- content")[1]));

/* ---------------- path validation: never touches the network ---------------- */

for (const [label, path] of [
  ["non-.md path", "notes.txt"], ["leading slash", "/guide.md"], [".. segment", "../secrets.md"],
  ["empty segment", "docs//x.md"], ["backslash", "docs\\x.md"],
]) {
  gh.reset();
  const r = await call(A, "commit_edits", { message: "m", edits: [{ op: "write", path, content: "x" }] });
  ok(`rejects ${label} with zero network calls`, r.isError && gh.log.length === 0, `${r.text} | log=${gh.log.length}`);
}

/* ---------------- the feature premise: N edits, ONE commit ---------------- */

gh.reset();
const batch = await call(A, "commit_edits", {
  message: "docs: restructure",
  edits: [
    { op: "str_replace", path: "guide.md", old_string: "step one", new_string: "step 1" },
    { op: "edit_section", path: "guide.md", heading: "Usage", mode: "replace", content: "run it fast" },
    { op: "write", path: "new.md", content: "# New\n\nfresh\n" },
    { op: "delete", path: "docs/old.md", expect_sha: /([0-9a-f]{40})\s+\d+\s+docs\/old\.md/.exec(listed.text)[1] },
  ],
});
ok("a 4-op batch across 3 files succeeds", !batch.isError, batch.text);
const count = (m, p) => gh.log.filter((r) => r.method === m && p.test(r.path)).length;
ok("EXACTLY one POST /git/trees", count("POST", /\/git\/trees$/) === 1, String(count("POST", /\/git\/trees$/)));
ok("EXACTLY one POST /git/commits", count("POST", /\/git\/commits$/) === 1);
ok("EXACTLY one PATCH /git/refs", count("PATCH", /\/git\/refs\//) === 1);
ok("ZERO PUT /contents (the one-commit-per-file API)", count("PUT", /\/contents\//) === 0);

const treeReq = gh.log.find((r) => r.method === "POST" && /\/git\/trees$/.test(r.path));
ok("base_tree is a 40-hex tree sha", /^[0-9a-f]{40}$/.test(treeReq.body.base_tree));
ok('deletion survives serialization as literal "sha":null', treeReq.rawBody.includes('"sha":null'), treeReq.rawBody.slice(0, 200));
ok("every tree entry is a blob with a full path", treeReq.body.tree.every((e) => e.type === "blob" && !e.path.startsWith("/")));
ok("no entry carries both sha and content", treeReq.body.tree.every((e) => !(e.sha != null && e.content != null)));
ok("force:false on every ref update", gh.log.filter((r) => r.method === "PATCH").every((r) => r.body.force === false));

const after = await call(A, "read_md", { path: "guide.md" });
ok("read-back shows the str_replace landed", after.text.includes("step 1"));
ok("read-back shows the section replace landed", after.text.includes("run it fast"));
ok("read-back shows the created file", !(await call(A, "read_md", { path: "new.md" })).isError);
ok("read-back shows the deletion", (await call(A, "read_md", { path: "docs/old.md" })).isError);

/* ---------------- per-user isolation ---------------- */

gh.reset();
await call(A, "list_md", {});
await call(BK, "list_md", {});
const aliceReqs = gh.log.filter((r) => r.authorization === "Bearer pat-alice");
const bobReqs = gh.log.filter((r) => r.authorization === "Bearer pat-bob");
// startsWith, not includes-with-trailing-slash: the repo-metadata call is /repos/o/r exactly.
ok("alice's calls carry only alice's PAT and repo",
  aliceReqs.length > 0 && aliceReqs.every((r) => r.path.startsWith("/repos/alice/notes")));
ok("bob's calls carry only bob's PAT and repo",
  bobReqs.length > 0 && bobReqs.every((r) => r.path.startsWith("/repos/bob/wiki")),
  bobReqs.map((r) => r.path).join(","));
ok("no request mixes the two identities", gh.log.every((r) => ["Bearer pat-alice", "Bearer pat-bob"].includes(r.authorization)));

/* ---------------- all-or-nothing + failure families ---------------- */

gh.reset();
const multi = await call(A, "commit_edits", {
  message: "bad batch",
  edits: [
    { op: "str_replace", path: "guide.md", old_string: "definitely not present", new_string: "x" },
    { op: "write", path: "guide.md", content: "clobber" },
    { op: "delete", path: "docs/gone.md", expect_sha: "0".repeat(40) },
  ],
});
ok("a batch with 3 bad ops fails", multi.isError);
ok("all three failures are reported at once",
  multi.text.includes("edits[0]") && multi.text.includes("edits[1]") && multi.text.includes("edits[2]"), multi.text);
ok("a failed batch issues ZERO mutative requests",
  gh.log.every((r) => r.method === "GET"), gh.log.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.path).join(","));

const retryRef = /retry_ref (r_[0-9a-f]{6})/.exec(multi.text)?.[1];
ok("a failed batch is retained as a retry_ref", !!retryRef, multi.text.slice(-200));
const nagged = await call(A, "list_md", {});
ok("the retained failure is announced on later results", nagged.text.includes(retryRef));
ok("bob never sees alice's retained failure", !(await call(BK, "list_md", {})).text.includes(retryRef));
ok("supplying both edits and retry_ref is an error",
  (await call(A, "commit_edits", { message: "m", retry_ref: retryRef, edits: [{ op: "write", path: "x.md", content: "y" }] })).isError);
ok("an unknown retry_ref is an error", (await call(A, "commit_edits", { message: "m", retry_ref: "r_000000" })).isError);

const amb = await call(A, "commit_edits", {
  message: "m", edits: [{ op: "str_replace", path: "guide.md", old_string: "\n", new_string: "\n\n" }],
});
ok("an ambiguous anchor names both remedies",
  amb.isError && amb.text.includes("more surrounding context") && amb.text.includes("replace_all=true"), amb.text);

/* ---------------- the expect_sha invariant ---------------- */

const gsha = /blob sha: ([0-9a-f]{40})/.exec((await call(A, "read_md", { path: "guide.md" })).text)[1];
gh.reset();
ok("write mode=overwrite without expect_sha is rejected",
  (await call(A, "commit_edits", { message: "m", edits: [{ op: "write", path: "guide.md", content: "x", mode: "overwrite" }] })).isError);
ok("delete without expect_sha is rejected",
  (await call(A, "commit_edits", { message: "m", edits: [{ op: "delete", path: "guide.md" }] })).isError);
ok("a stale expect_sha is rejected before any POST",
  (await call(A, "commit_edits", { message: "m", edits: [{ op: "delete", path: "guide.md", expect_sha: "a".repeat(40) }] })).isError &&
  gh.log.every((r) => r.method === "GET"));

// The judge's constructed attack: delete-then-create as a blind overwrite.
gh.reset();
const attack = await call(A, "commit_edits", {
  message: "attack",
  edits: [{ op: "delete", path: "guide.md", expect_sha: "b".repeat(40) }, { op: "write", path: "guide.md", content: "OWNED" }],
});
ok("delete-then-create is refused when the delete's expect_sha is stale", attack.isError && gh.log.every((r) => r.method === "GET"));
const legit = await call(A, "commit_edits", {
  message: "legit replace",
  edits: [{ op: "delete", path: "guide.md", expect_sha: gsha }, { op: "write", path: "guide.md", content: "# Replaced\n" }],
});
ok("delete-then-create succeeds with a correct expect_sha", !legit.isError, legit.text);
ok("delete-then-create leaves the file present with new content",
  (await call(A, "read_md", { path: "guide.md" })).text.includes("# Replaced"));

/* ---------------- the silent-clobber attack ---------------- */

gh.seed("alice/notes", { files: { "race.md": "# Race\n\nalpha\n" } });
const stale = await call(A, "read_md", { path: "race.md" });
ok("baseline read of the race file", stale.text.includes("alpha"));
gh.state.externalEdit("alice/notes", "race.md", "# Race\n\nBETA\n"); // a colleague pushes
const clobber = await call(A, "commit_edits", {
  message: "m", edits: [{ op: "str_replace", path: "race.md", old_string: "alpha", new_string: "gamma" }],
});
ok("an anchor that vanished upstream fails instead of clobbering", clobber.isError, clobber.text);
ok("the colleague's content survives", gh.state.readFile("alice/notes", "race.md").toString().includes("BETA"));
const rebased = await call(A, "commit_edits", {
  message: "m", edits: [{ op: "str_replace", path: "race.md", old_string: "BETA", new_string: "GAMMA" }],
});
ok("an anchor present in the NEW bytes commits against them", !rebased.isError, rebased.text);

/* ---------------- no-op detection ---------------- */

gh.reset();
const noop = await call(A, "commit_edits", {
  message: "m", edits: [{ op: "str_replace", path: "race.md", old_string: "GAMMA", new_string: "GAMMA " }],
});
const noop2 = await call(A, "commit_edits", {
  message: "m", edits: [{ op: "write", path: "tmp.md", content: "x\n" }, { op: "delete", path: "tmp.md", expect_sha: "c".repeat(40) }],
});
ok("create-then-delete in one batch does not commit", noop2.isError || !/Committed/.test(noop2.text));

/* ---------------- conflict handling ---------------- */

gh.reset();
gh.fault("422-once", { thenAdvanceHeadWith: { repo: "alice/notes", path: "unrelated.md", content: "# Unrelated\n" } });
const raced = await call(A, "commit_edits", { message: "after race", edits: [{ op: "write", path: "afterrace.md", content: "# After\n" }] });
ok("a collision on an untouched file re-plans and succeeds", !raced.isError, raced.text);
ok("the retry re-reads the ref rather than reusing a cached tree",
  gh.log.filter((r) => r.method === "GET" && /\/git\/ref\//.test(r.path)).length >= 2);
const treePosts = gh.log.filter((r) => r.method === "POST" && /\/git\/trees$/.test(r.path));
ok("the retry rebuilds against the NEW base tree",
  treePosts.length === 2 && treePosts[0].body.base_tree !== treePosts[1].body.base_tree);
ok("the colleague's file survives the retry", !!gh.state.readFile("alice/notes", "unrelated.md"));

gh.reset();
gh.fault("403-protected");
const prot = await call(A, "commit_edits", { message: "m", edits: [{ op: "write", path: "prot.md", content: "# P\n" }] });
ok("branch protection is not treated as a collision", prot.isError && /pull request/i.test(prot.text), prot.text);
ok("branch protection does not retry", gh.log.filter((r) => r.method === "PATCH").length === 1);

/* ---------------- empty repo bootstrap ---------------- */

gh.seed("alice/notes", { files: {} });
gh.reset();
const boot = await call(A, "commit_edits", { message: "init", edits: [{ op: "write", path: "first.md", content: "# First\n" }] });
ok("an empty repo bootstraps", !boot.isError, boot.text);
const bootTree = gh.log.find((r) => r.method === "POST" && /\/git\/trees$/.test(r.path));
ok("bootstrap omits base_tree", bootTree && bootTree.body.base_tree === undefined);
const bootCommit = gh.log.find((r) => r.method === "POST" && /\/git\/commits$/.test(r.path));
ok("bootstrap commit has no parents", bootCommit && !bootCommit.body.parents);
const bootRef = gh.log.find((r) => r.method === "POST" && /\/git\/refs$/.test(r.path));
ok("bootstrap creates the ref with the refs/ prefix", bootRef && bootRef.body.ref.startsWith("refs/heads/"));

/* ---------------- byte fidelity through the tool surface ---------------- */

gh.seed("alice/notes", { files: { "crlf.md": "# T\r\nalpha\r\nbeta\r\n", "hard.md": "line one  \nline two\n" } });
gh.reset();
await call(A, "commit_edits", { message: "m", edits: [{ op: "str_replace", path: "crlf.md", old_string: "alpha", new_string: "ALPHA" }] });
ok("a CRLF file keeps CRLF on untouched lines",
  gh.state.readFile("alice/notes", "crlf.md").toString() === "# T\r\nALPHA\r\nbeta\r\n",
  JSON.stringify(gh.state.readFile("alice/notes", "crlf.md").toString()));
await call(A, "commit_edits", { message: "m", edits: [{ op: "str_replace", path: "hard.md", old_string: "line two", new_string: "line 2" }] });
ok("markdown hard line breaks (two trailing spaces) survive",
  gh.state.readFile("alice/notes", "hard.md").toString() === "line one  \nline 2\n");

/* ---------------- delta invariants ---------------- */

gh.seed("alice/notes", { files: { "fence.md": "# T\n\nbody\n", "fm.md": "---\ntitle: x\n---\n\n# T\n\nbody\n" } });
ok("an edit that leaves an unclosed fence is rejected",
  (await call(A, "commit_edits", { message: "m", edits: [{ op: "write", path: "fence.md", mode: "append", content: "```js\nlet x = 1\n" }] })).isError);
ok("an edit that destroys front matter is rejected",
  (await call(A, "commit_edits", { message: "m", edits: [{ op: "str_replace", path: "fm.md", old_string: "---\ntitle: x\n---\n\n", new_string: "" }] })).isError);

/* ---------------- markdown addressing through the tool surface ---------------- */

gh.seed("alice/notes", { files: {
  "dup.md": "# Guide\n\n## Install\n\n### Notes\na\n\n## Appendix\n\n### Notes\nb\n",
  "fenced.md": "# A\n\n```\n## Fake\n```\n\n## Real\nx\n",
} });
const dupErr = await call(A, "commit_edits", { message: "m", edits: [{ op: "edit_section", path: "dup.md", heading: "Notes", mode: "replace", content: "x" }] });
ok("a duplicate heading is an error listing both candidates",
  dupErr.isError && dupErr.text.includes("Guide > Install > Notes") && dupErr.text.includes("Guide > Appendix > Notes"), dupErr.text);
ok("a breadcrumb resolves to one section",
  !(await call(A, "commit_edits", { message: "m", edits: [{ op: "edit_section", path: "dup.md", heading: "Guide > Appendix > Notes", mode: "replace", content: "PICKED" }] })).isError);
const fakeErr = await call(A, "commit_edits", { message: "m", edits: [{ op: "edit_section", path: "fenced.md", heading: "Fake", mode: "replace", content: "x" }] });
ok("a heading inside a code fence is not addressable", fakeErr.isError && fakeErr.text.includes("No heading matched"), fakeErr.text);

/* ---------------- cadence telemetry ---------------- */

gh.seed("alice/notes", { files: { "c1.md": "# 1\na\n", "c2.md": "# 2\nb\n", "c3.md": "# 3\nc\n" } });
await call(A, "commit_edits", { message: "one", edits: [{ op: "str_replace", path: "c1.md", old_string: "a", new_string: "A" }] });
await call(A, "commit_edits", { message: "two", edits: [{ op: "str_replace", path: "c2.md", old_string: "b", new_string: "B" }] });
const third = await call(A, "commit_edits", { message: "three", edits: [{ op: "str_replace", path: "c3.md", old_string: "c", new_string: "C" }] });
ok("three single-file commits in a row nudge toward batching", third.text.includes("edits array"), third.text.slice(-300));

/* ---------------- the ledger ---------------- */

ok("EVERY tool result carried the standing PENDING line", ledgerMisses === 0, `${ledgerMisses} result(s) missing it`);

await gh.close();
console.log(`\n${pass}/${pass + fail} passed`);
