// Unit tests for the pure markdown layer. Run: npm run build && node test-md.mjs
import { deltaInvariants, editSection, parseDoc, render, scanHeadings, sectionSpan, strReplace } from "./dist/md.js";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}${extra ? "\n      " + extra : ""}`);
};
const L = (s) => s.split("\n");
const texts = (src) => scanHeadings(L(src)).headings.map((h) => h.text).join(",");
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

/* ---------- scanner: the 22 prototype cases ---------- */

ok("front matter close is not a setext H2", (() => {
  const r = scanHeadings(L("---\ntitle: x\n---\n\n## Real\nbody\n"));
  return r.headings.length === 1 && r.headings[0].text === "Real" && r.frontMatterEnd === 2;
})());
ok("--- with no closer is a thematic break", (() => {
  const r = scanHeadings(L("---\n\n# Real\n"));
  return r.frontMatterEnd === null && r.headings.length === 1;
})());
ok("heading inside backtick fence ignored", texts("# A\n\n```\n## Fake\n```\n\n## B\n") === "A,B");
ok("tilde fence containing backtick fence", texts("# A\n~~~\n```\n## Fake\n```\n~~~\n## B\n") === "A,B");
ok("shorter fence does not close a longer one", texts("# A\n````\n## Fake\n```\n## Fake2\n````\n## B\n") === "A,B");
ok("indented code heading ignored", texts("# A\n\n    ## Fake\n\n## B\n") === "A,B");
ok("tab-indented heading ignored (tab = 4 cols)", texts("# A\n\n\t## Fake\n\n## B\n") === "A,B");
ok("3-space indent is still a heading", texts("# A\n\n   ### C\n") === "A,C");
ok("setext H1 and H2", (() => {
  const h = scanHeadings(L("Title\n=====\n\nSub\n---\n\ntext\n")).headings;
  return h.map((x) => x.level + ":" + x.text).join(",") === "1:Title,2:Sub";
})());
ok("trailing hashes stripped", scanHeadings(L("## Foo ##\n")).headings[0].text === "Foo");
ok("empty ATX heading", (() => {
  const h = scanHeadings(L("##\n")).headings;
  return h.length === 1 && h[0].text === "";
})());
ok("no space after # is not a heading", texts("#Foo\n\n## Bar\n") === "Bar");
ok("7 hashes is not a heading", texts("####### Foo\n\n## Bar\n") === "Bar");
ok("heading inside HTML block ignored", texts("# A\n\n<div>\n## Fake\n</div>\n\n## B\n") === "A,B");
ok("heading inside HTML comment ignored", texts("# A\n<!--\n## Fake\n-->\n## B\n") === "A,B");
ok("blockquote heading not addressable", texts("# A\n\n> ## Quoted\n\n## B\n") === "A,B");
ok("unclosed fence detected", (() => {
  const r = scanHeadings(L("# A\n```\n## Fake\n"));
  return r.unclosedFenceLine === 1 && r.headings.map((h) => h.text).join(",") === "A";
})());
ok("thematic break after blank is not setext", texts("para\n\n---\n\n## B\n") === "B");
ok("duplicate headings both found", scanHeadings(L("## Notes\na\n\n## Notes\nb\n")).headings.length === 2);
ok("span stops at same-or-shallower level", (() => {
  const lines = L("# T\n\n## A\na\n\n### A1\nx\n\n## B\nb\n");
  const s = sectionSpan(scanHeadings(lines).headings, 1, lines.length);
  return s.start === 2 && s.bodyStart === 3 && s.end === 8;
})());
ok("last section runs to EOF", (() => {
  const lines = L("## A\na\n\n## B\nb\n");
  return sectionSpan(scanHeadings(lines).headings, 1, lines.length).end === lines.length;
})());
ok("setext span starts at the paragraph line", (() => {
  const lines = L("Intro\n=====\ntext\n\nSub\n---\nmore\n");
  const h = scanHeadings(lines).headings;
  const a = sectionSpan(h, 0, lines.length);
  const b = sectionSpan(h, 1, lines.length);
  return a.start === 0 && a.bodyStart === 2 && b.start === 4 && b.bodyStart === 6;
})());

/* ---------- byte fidelity ---------- */

{
  const raw = "# T\r\nalpha\r\nbeta\r\n";
  const doc = parseDoc(raw);
  const r = strReplace(doc, "a.md", "alpha", "ALPHA", false);
  const out = render(doc, r.text);
  ok("CRLF file keeps CRLF on untouched lines", out === "# T\r\nALPHA\r\nbeta\r\n", JSON.stringify(out));
}
{
  const raw = "﻿# Title\nbody\n";
  const doc = parseDoc(raw);
  ok("BOM is split off so a start-anchored match works", doc.text.indexOf("# Title") === 0);
  const r = strReplace(doc, "a.md", "# Title", "# New", false);
  ok("BOM is re-attached on write", render(doc, r.text) === "﻿# New\nbody\n");
}
{
  const raw = "line one  \nline two\n";
  const doc = parseDoc(raw);
  const r = strReplace(doc, "a.md", "line two", "line 2", false);
  ok("hard line break (two trailing spaces) survives", render(doc, r.text) === "line one  \nline 2\n");
}
{
  const raw = "alpha\nbeta";
  const doc = parseDoc(raw);
  const r = strReplace(doc, "a.md", "alpha", "ALPHA", false);
  ok("missing trailing newline is not invented", render(doc, r.text) === "ALPHA\nbeta");
}

/* ---------- str_replace ---------- */

{
  const doc = parseDoc("a\nfoo\nb\nfoo\n");
  const msg = threw(() => strReplace(doc, "a.md", "foo", "bar", false));
  ok("2 matches names both line numbers", msg.includes("lines 2, 4"), msg);
  ok("2 matches names both remedies", msg.includes("more surrounding context") && msg.includes("replace_all=true"), msg);
  const r = strReplace(doc, "a.md", "foo", "bar", true);
  ok("replace_all replaces every occurrence", r.text === "a\nbar\nb\nbar\n");
  ok("replace_all reports the count", r.note.includes("2 occurrence"));
}
{
  const doc = parseDoc("# Guide\ninstall the thing\n");
  const msg = threw(() => strReplace(doc, "a.md", "instal the thing", "x", false));
  ok("0 matches says did not appear verbatim", msg.includes("did not appear verbatim"), msg);
  ok("0 matches offers near-miss candidates with line numbers", msg.includes("line 2"), msg);
}
{
  const doc = parseDoc("alpha\nbeta\n");
  const msg = threw(() => strReplace(doc, "a.md", "gamma", "beta", false));
  ok("0 matches warns the edit may already have landed", msg.includes("may already have landed"), msg);
}
ok("old_string === new_string is rejected", (threw(() => strReplace(parseDoc("a\n"), "a.md", "a", "a", false)) || "").includes("must be different"));
ok("empty old_string is rejected", (threw(() => strReplace(parseDoc("a\n"), "a.md", "", "b", false)) || "").includes("must not be empty"));

/* ---------- edit_section ---------- */

const DOC = "# Guide\n\nintro\n\n## Install\n\nstep one\n\n### Notes\n\ndeep\n\n## Usage\n\nrun it\n";

{
  const r = editSection(parseDoc(DOC), "a.md", "Install", "replace", "NEW BODY");
  ok("replace keeps the heading line", r.text.includes("## Install\nNEW BODY"), r.text);
  ok("replace removes the nested sub-heading", !r.text.includes("### Notes"));
  ok("replace leaves the following section intact", r.text.includes("## Usage\n\nrun it"));
  ok("replace leaves one blank line before the next heading", /NEW BODY\n\n## Usage/.test(r.text), JSON.stringify(r.text));
}
{
  const r = editSection(parseDoc(DOC), "a.md", "Install", "delete", undefined);
  ok("delete removes heading and body", !r.text.includes("## Install") && !r.text.includes("step one"));
  ok("delete takes nested sub-headings with it", !r.text.includes("### Notes"));
  ok("delete keeps sibling sections", r.text.includes("## Usage"));
}
{
  const r = editSection(parseDoc(DOC), "a.md", "Notes", "append", "appended line");
  // Appends directly after the section's last non-blank line, not after its trailing blank.
  ok("append inserts inside the section", /deep\nappended line/.test(r.text), JSON.stringify(r.text));
  ok("append does not cross the next heading", r.text.indexOf("appended line") < r.text.indexOf("## Usage"));
}
{
  const r = editSection(parseDoc(DOC), "a.md", "Usage", "prepend", "first!");
  ok("prepend inserts right after the heading", /## Usage\nfirst!/.test(r.text), JSON.stringify(r.text));
}
ok("delete with content is rejected", (threw(() => editSection(parseDoc(DOC), "a.md", "Usage", "delete", "x")) || "").includes("does not take content"));
ok("replace without content is rejected", (threw(() => editSection(parseDoc(DOC), "a.md", "Usage", "replace", undefined)) || "").includes("requires content"));

{
  const dup = "# Guide\n\n## Install\n\n### Notes\na\n\n## Appendix\n\n### Notes\nb\n";
  const msg = threw(() => editSection(parseDoc(dup), "a.md", "Notes", "replace", "x"));
  ok("ambiguous heading is an error, not first-match-wins", msg.includes("matches 2 headings"), msg);
  ok("ambiguity lists breadcrumbs", msg.includes("Guide > Install > Notes"), msg);
  const byCrumb = editSection(parseDoc(dup), "a.md", "Guide > Appendix > Notes", "replace", "PICKED");
  ok("breadcrumb resolves to one section", byCrumb.text.includes("PICKED") && byCrumb.text.includes("a\n"));
  const byIdx = editSection(parseDoc(dup), "a.md", "Notes#1", "replace", "IDX");
  ok("occurrence index resolves to one section", byIdx.text.includes("IDX") && byIdx.text.includes("b\n"));
}
{
  const fenced = "# A\n\n```\n## Fake\n```\n\n## Real\nx\n";
  const msg = threw(() => editSection(parseDoc(fenced), "a.md", "Fake", "replace", "x"));
  ok("heading inside a fence is not addressable", msg.includes("No heading matched"), msg);
  ok("not-found lists the real headings", msg.includes("Real"), msg);
}
{
  const unclosed = "# A\n\n```\n## Fake\n";
  const msg = threw(() => editSection(parseDoc(unclosed), "a.md", "Fake", "replace", "x"));
  ok("unclosed fence gets its own diagnostic", msg.includes("unclosed") && msg.includes("line 3"), msg);
}
{
  const fm = "---\ntitle: x\n---\n\n## Real\nbody\n";
  const r = editSection(parseDoc(fm), "a.md", "Real", "replace", "NEW");
  ok("front matter is left byte-identical", r.text.startsWith("---\ntitle: x\n---\n"), JSON.stringify(r.text));
  const msg = threw(() => editSection(parseDoc(fm), "a.md", "title: x", "replace", "x"));
  ok("front matter is not addressable as a section", msg.includes("No heading matched"), msg);
}

/* ---------- delta invariants ---------- */

ok("an edit that opens a fence and leaves it open is rejected",
  (threw(() => deltaInvariants("# A\nbody\n", "# A\n```\nbody\n", "a.md")) || "").includes("unclosed code fence"));
ok("a pre-existing unclosed fence is not blamed on this edit",
  threw(() => deltaInvariants("# A\n```\nx\n", "# A\n```\nx\ny\n", "a.md")) === null);
ok("destroying front matter is rejected",
  (threw(() => deltaInvariants("---\na: 1\n---\n# T\n", "# T\n", "a.md")) || "").includes("front matter"));
ok("removing a heading warns rather than blocking", (() => {
  const w = deltaInvariants("# A\n\n## B\nx\n", "# A\n", "a.md");
  return w.length === 1 && w[0].includes("-1");
})());

console.log(`${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
