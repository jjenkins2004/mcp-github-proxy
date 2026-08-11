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
const sr = (raw, ...a) => { const d = parseDoc(raw); const r = strReplace(d, "a.md", ...a); return { out: render(r.doc), lf: r.doc.text, note: r.note }; };
const es = (raw, ...a) => { const d = parseDoc(raw); const r = editSection(d, "a.md", ...a); return { out: render(r.doc), lf: r.doc.text, note: r.note }; };

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
ok("empty ATX heading", scanHeadings(L("##\n")).headings.length === 1);
ok("no space after # is not a heading", texts("#Foo\n\n## Bar\n") === "Bar");
ok("7 hashes is not a heading", texts("####### Foo\n\n## Bar\n") === "Bar");
ok("heading inside multi-line HTML block ignored", texts("# A\n\n<div>\n## Fake\n</div>\n\n## B\n") === "A,B");
ok("heading inside multi-line HTML comment ignored", texts("# A\n<!--\n## Fake\n-->\n## B\n") === "A,B");
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
  return sectionSpan(h, 0, lines.length).bodyStart === 2 && sectionSpan(h, 1, lines.length).start === 4;
})());

/* ---------- REGRESSION: one-line HTML blocks (silent whole-file deletion) ---------- */

// An opener whose end condition is satisfied on its own line closes immediately. Missing this,
// `<!-- toc -->` wedged the scanner open to EOF: every later heading vanished and editing an
// earlier section deleted the rest of the file, with no warning of any kind.
ok("REGRESSION one-line HTML comment does not swallow the file",
  texts("# Project\n\n<!-- markdownlint-disable MD013 -->\n\n## Install\n\nx\n\n## Usage\n\ny\n") === "Project,Install,Usage");
// Sections after a one-line comment must be addressable at all — previously the scanner could
// not see them, so they could neither be edited nor protected from an edit above them.
// (Replacing the H1 body legitimately takes its nested H2s; that is documented behavior.)
ok("REGRESSION a section after a one-line comment is addressable", (() => {
  const r = es("# Project\n\n<!-- toc -->\n\n## Install\n\nx\n\n## Usage\n\ny\n", "Install", "replace", "npm i");
  return r.out.includes("npm i") && r.out.includes("## Usage") && r.out.includes("<!-- toc -->");
})());
ok("REGRESSION one-line <pre> closes on itself", texts("# A\n\n<pre>x</pre>\n\n## B\n") === "A,B");
ok("REGRESSION one-line <script> closes on itself", texts("# A\n\n<script>var x=1</script>\n\n## B\n") === "A,B");
ok("REGRESSION one-line CDATA closes on itself", texts("# A\n\n<![CDATA[x]]>\n\n## B\n") === "A,B");
ok("REGRESSION one-line processing instruction closes on itself", texts("# A\n\n<?php echo 1; ?>\n\n## B\n") === "A,B");
ok("REGRESSION one-line declaration closes on itself", texts("# A\n\n<!DOCTYPE html>\n\n## B\n") === "A,B");
ok("multi-line HTML comment still spans", texts("# A\n<!--\n## Fake\n-->\n## B\n") === "A,B");

/* ---------- REGRESSION: front matter heuristic ---------- */

// A `---` thematic break followed later by another `---` was read as front matter, hiding
// every heading between them.
ok("REGRESSION --- break plus a later --- is not front matter",
  texts("---\n\n# A\n\nbody\n\n---\n\n# B\n\nb\n") === "A,B");
ok("real front matter is still detected", scanHeadings(L("---\ntitle: x\ntags: [a]\n---\n\n# T\n")).frontMatterEnd === 3);
ok("--- followed by prose is not front matter", scanHeadings(L("---\njust prose here\n---\n\n# T\n")).frontMatterEnd === null);

/* ---------- byte fidelity ---------- */

ok("CRLF file keeps CRLF on untouched lines", sr("# T\r\nalpha\r\nbeta\r\n", "alpha", "ALPHA", false).out === "# T\r\nALPHA\r\nbeta\r\n");
ok("BOM is split off so a start-anchored match works", parseDoc("﻿# Title\nbody\n").text.indexOf("# Title") === 0);
ok("BOM is re-attached on write", sr("﻿# Title\nbody\n", "# Title", "# New", false).out === "﻿# New\nbody\n");
ok("hard line break (two trailing spaces) survives", sr("line one  \nline two\n", "line two", "line 2", false).out === "line one  \nline 2\n");
ok("missing trailing newline is not invented", sr("alpha\nbeta", "alpha", "ALPHA", false).out === "ALPHA\nbeta");

// REGRESSION: a mixed-EOL file used to be rewritten wholesale to the majority ending.
ok("REGRESSION mixed EOL: untouched CRLF line keeps its CRLF",
  sr("# T\nalpha\r\nbeta\ngamma\n", "gamma", "GAMMA", false).out === "# T\nalpha\r\nbeta\nGAMMA\n",
  JSON.stringify(sr("# T\nalpha\r\nbeta\ngamma\n", "gamma", "GAMMA", false).out));
ok("REGRESSION mixed EOL: untouched LF line keeps its LF",
  sr("# T\r\nalpha\r\nbeta\ngamma\r\n", "alpha", "ALPHA", false).out === "# T\r\nALPHA\r\nbeta\ngamma\r\n",
  JSON.stringify(sr("# T\r\nalpha\r\nbeta\ngamma\r\n", "alpha", "ALPHA", false).out));

/* ---------- str_replace ---------- */

{
  const d = parseDoc("a\nfoo\nb\nfoo\n");
  const msg = threw(() => strReplace(d, "a.md", "foo", "bar", false));
  ok("2 matches names both line numbers", msg.includes("lines 2, 4"), msg);
  ok("2 matches names both remedies", msg.includes("more surrounding context") && msg.includes("replace_all=true"), msg);
  const r = sr("a\nfoo\nb\nfoo\n", "foo", "bar", true);
  ok("replace_all replaces every occurrence", r.out === "a\nbar\nb\nbar\n", JSON.stringify(r.out));
  ok("replace_all reports the count", r.note.includes("2 occurrence"));
}

// REGRESSION: overlapping matches were counted and spliced as separate replacements.
ok("REGRESSION replace_all does not count overlapping matches",
  sr("a -- b\nsep: -----\n", "--", "X", true).out === "a X b\nsep: XX-\n",
  JSON.stringify(sr("a -- b\nsep: -----\n", "--", "X", true).out));
ok("REGRESSION overlapping count is reported honestly", sr("a -- b\nsep: -----\n", "--", "X", true).note.includes("3 occurrence"));
ok("REGRESSION aaaa/aa yields two replacements", sr("aaaa\n", "aa", "b", true).out === "bb\n");
ok("REGRESSION xaaay/aa yields one replacement", sr("xaaay\n", "aa", "b", true).out === "xbay\n");

{
  const msg = threw(() => strReplace(parseDoc("# Guide\ninstall the thing\n"), "a.md", "instal the thing", "x", false));
  ok("0 matches says did not appear verbatim", msg.includes("did not appear verbatim"), msg);
  ok("0 matches offers near-miss candidates with line numbers", msg.includes("line 2"), msg);
}
ok("0 matches warns the edit may already have landed",
  (threw(() => strReplace(parseDoc("alpha\nbeta\n"), "a.md", "gamma", "beta", false)) || "").includes("may already have landed"));
ok("old_string === new_string is rejected", (threw(() => strReplace(parseDoc("a\n"), "a.md", "a", "a", false)) || "").includes("must be different"));
ok("empty old_string is rejected", (threw(() => strReplace(parseDoc("a\n"), "a.md", "", "b", false)) || "").includes("must not be empty"));

// REGRESSION: the indent-insensitive recovery ladder stripped real indentation, turning an
// indented code block into a live heading.
{
  const src = "# Doc\n\nExample:\n\n    ## fake heading\n    more code\n\ndone\n";
  const r = sr(src, "## fake heading\nmore code", "## fake heading\nmore code 2", false);
  ok("REGRESSION relaxed match preserves the original indentation",
    r.out === "# Doc\n\nExample:\n\n    ## fake heading\n    more code 2\n\ndone\n", JSON.stringify(r.out));
  ok("REGRESSION relaxed match does not create a heading", scanHeadings(L(r.out)).headings.length === 1);
}
ok("REGRESSION ragged indentation refuses the relaxed match rather than guessing",
  (threw(() => strReplace(parseDoc("# D\n\n    a\n      b\n"), "a.md", "a\nb", "a\nB", false)) || "").includes("did not appear verbatim"));

/* ---------- edit_section ---------- */

const DOC = "# Guide\n\nintro\n\n## Install\n\nstep one\n\n### Notes\n\ndeep\n\n## Usage\n\nrun it\n";

ok("replace keeps the heading line", es(DOC, "Install", "replace", "NEW BODY").lf.includes("## Install\nNEW BODY"));
ok("replace removes the nested sub-heading", !es(DOC, "Install", "replace", "NEW BODY").lf.includes("### Notes"));
ok("replace leaves the following section intact", es(DOC, "Install", "replace", "NEW BODY").lf.includes("## Usage\n\nrun it"));
ok("replace leaves one blank line before the next heading", /NEW BODY\n\n## Usage/.test(es(DOC, "Install", "replace", "NEW BODY").lf));
ok("delete removes heading and body", !es(DOC, "Install", "delete", undefined).lf.includes("step one"));
ok("delete takes nested sub-headings with it", !es(DOC, "Install", "delete", undefined).lf.includes("### Notes"));
ok("delete keeps sibling sections", es(DOC, "Install", "delete", undefined).lf.includes("## Usage"));
ok("append inserts inside the section", /deep\nappended line/.test(es(DOC, "Notes", "append", "appended line").lf));
ok("append does not cross the next heading", (() => {
  const t = es(DOC, "Notes", "append", "appended line").lf;
  return t.indexOf("appended line") < t.indexOf("## Usage");
})());
ok("prepend inserts right after the heading", /## Usage\nfirst!/.test(es(DOC, "Usage", "prepend", "first!").lf));
ok("delete with content is rejected", (threw(() => editSection(parseDoc(DOC), "a.md", "Usage", "delete", "x")) || "").includes("does not take content"));
ok("replace without content is rejected", (threw(() => editSection(parseDoc(DOC), "a.md", "Usage", "replace", undefined)) || "").includes("requires content"));

ok("repeated appends do not drift", (() => {
  let d = parseDoc(DOC);
  for (let i = 0; i < 4; i++) d = editSection(d, "a.md", "Notes", "append", "line").doc;
  return !/\n\n\n/.test(render(d)) && (render(d).match(/line/g) || []).length === 4;
})());

{
  const dup = "# Guide\n\n## Install\n\n### Notes\na\n\n## Appendix\n\n### Notes\nb\n";
  const msg = threw(() => editSection(parseDoc(dup), "a.md", "Notes", "replace", "x"));
  ok("ambiguous heading is an error, not first-match-wins", msg.includes("matches 2 headings"), msg);
  ok("ambiguity lists breadcrumbs", msg.includes("Guide > Install > Notes"), msg);
  ok("breadcrumb resolves to one section", es(dup, "Guide > Appendix > Notes", "replace", "PICKED").lf.includes("PICKED"));
  ok("occurrence index resolves to one section", es(dup, "Notes#1", "replace", "IDX").lf.includes("IDX"));
  // REGRESSION: breadcrumb ancestors must match in order, not as an unordered set.
  ok("REGRESSION reversed breadcrumb does not resolve",
    (threw(() => editSection(parseDoc(dup), "a.md", "Notes > Appendix", "replace", "x")) || "").includes("No heading matched"));
}

// REGRESSION: `#N` and `>` were parsed before checking for a heading with that literal text,
// so `## Issue #42` was unaddressable and `Notes #2` silently edited a different section.
{
  const iss = "# Doc\n\n## Issue #42\n\nbody\n\n## Other\n\nx\n";
  ok("REGRESSION a heading literally containing #42 is addressable", es(iss, "Issue #42", "replace", "FIXED").lf.includes("FIXED"));
  ok("REGRESSION editing it does not touch the sibling", es(iss, "Issue #42", "replace", "FIXED").lf.includes("## Other\n\nx"));
  const gt = "# A > B\nfirst\n\n# A\n\n## B\nsecond\n";
  const r = es(gt, "A > B", "replace", "PICKED");
  ok("REGRESSION a heading literally containing > is addressable", /# A > B\nPICKED/.test(r.lf), JSON.stringify(r.lf));
  const amb = "## Notes\nfirst\n\n## Notes #2\nliteral\n\n## Notes\nthird\n";
  ok("REGRESSION literal 'Notes #2' targets the literal heading", /## Notes #2\nPICKED/.test(es(amb, "Notes #2", "replace", "PICKED").lf));
}

// REGRESSION: JS trim() treats NBSP/U+3000 as blank; markdown does not.
ok("REGRESSION an NBSP-only line is not deleted by append",
  es("## A\n\npara\n \n\n## B\n\nb\n", "A", "append", "added").lf.includes(" "),
  JSON.stringify(es("## A\n\npara\n \n\n## B\n\nb\n", "A", "append", "added").lf));
ok("REGRESSION a U+3000-only line is not deleted",
  es("## A\n\npara\n　\n\n## B\n\nb\n", "A", "append", "added").lf.includes("　"));

{
  const fenced = "# A\n\n```\n## Fake\n```\n\n## Real\nx\n";
  const msg = threw(() => editSection(parseDoc(fenced), "a.md", "Fake", "replace", "x"));
  ok("heading inside a fence is not addressable", msg.includes("No heading matched"), msg);
  ok("not-found lists the real headings", msg.includes("Real"), msg);
}
ok("unclosed fence gets its own diagnostic",
  (threw(() => editSection(parseDoc("# A\n\n```\n## Fake\n"), "a.md", "Fake", "replace", "x")) || "").includes("unclosed"));
{
  const fm = "---\ntitle: x\n---\n\n## Real\nbody\n";
  ok("front matter is left byte-identical", es(fm, "Real", "replace", "NEW").out.startsWith("---\ntitle: x\n---\n"));
  ok("front matter is not addressable as a section",
    (threw(() => editSection(parseDoc(fm), "a.md", "title: x", "replace", "x")) || "").includes("No heading matched"));
}

/* ---------- delta invariants ---------- */

ok("an edit that opens a fence and leaves it open is rejected",
  (threw(() => deltaInvariants("# A\nbody\n", "# A\n```\nbody\n", "a.md", false)) || "").includes("unclosed code fence"));
ok("a pre-existing unclosed fence is not blamed on this edit",
  threw(() => deltaInvariants("# A\n```\nx\n", "# A\n```\nx\ny\n", "a.md", false)) === null);
ok("destroying front matter is rejected",
  (threw(() => deltaInvariants("---\na: 1\n---\n# T\n", "# T\n", "a.md", false)) || "").includes("front matter"));
ok("removing a heading warns rather than blocking", deltaInvariants("# A\n\n## B\nx\n", "# A\n", "a.md", false).length === 1);

// REGRESSION: a file being created has no delta, so it must not be blamed for "gaining"
// front matter — that made every Jekyll/Hugo/Obsidian note impossible to create.
ok("REGRESSION creating a file with front matter is allowed",
  threw(() => deltaInvariants("", "---\ntitle: hello\n---\n\n# Hello\n", "a.md", true)) === null);
ok("REGRESSION creating a file that ends inside a fence is allowed",
  threw(() => deltaInvariants("", "# F\n\n```js\nconst x = 1;\n", "a.md", true)) === null);
ok("REGRESSION creating a file emits no spurious heading warning", deltaInvariants("", "# A\n\n## B\n", "a.md", true).length === 0);

console.log(`${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
