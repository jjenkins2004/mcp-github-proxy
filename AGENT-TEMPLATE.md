# Agent instruction template

Paste this at the top of a project's instructions, with `{{REPO}}` replaced by the repository
name. `./connector-prompt.sh` does the substitution and copies the result to the clipboard.

---

```
Project context lives in the GitHub repository `{{REPO}}`. Read and write it through the
markdown connector — never the file/document reader, never an uploaded copy, never memory.

START: make overview(repo:"{{REPO}}") part of your first batch of calls, before you fetch
any file. It returns that repository's INDEX.md — the router that says which file answers
which question — plus every file path with its byte size. That is your map; do not go
looking for one.

READING
- Follow the router. Fetch only what INDEX.md marks relevant to the task at hand, and heed
  its per-file reading instructions.
- Fetch in batches: read_md(repo:"{{REPO}}", paths:["a.md","b.md","c.md"]) is one round trip
  for three files. Never call read_md once per file.
- Sizes are in the overview. Before opening anything large, check whether a folder's
  index.md answers the question instead.
- There is no content search. To locate something, work down the indexes: the root router
  names folders, each folder's index.md describes its files and says when each is relevant.
  list_md(repo:"{{REPO}}", path_prefix:"...", outline:true) shows headings without reading
  bodies, which narrows a folder — but it sees headings only, not body text. If the indexes
  do not point at an answer, say so rather than fetching large files hoping to find it.

WRITING
- commit_edits is the only tool that changes markdown, and it always produces exactly one
  commit. Nothing is staged or queued: a change exists only once it returns a commit SHA.
- Put every change you intend into ONE call. Several files and several operations per file
  land in a single commit. Do not commit once per file.
- Prefer surgical edits over rewriting a file:
    str_replace   — exact text, matched byte for byte
    edit_section  — addressed by heading, e.g. heading:"Known gaps", mode:"append"
  Rewrite a whole file only when you actually mean to replace all of it.
- expect_sha is required to delete a file or to overwrite one whole (mode:"overwrite").
  Take it from overview, list_md or read_md. You cannot destroy a file you never observed.
- When you add a file, update the index that lists it — in the SAME commit. That is normally
  the `index.md` of the folder you added to, not the root INDEX.md; check which one actually
  carries a per-file table before editing either. If you added a whole new folder, the root
  index needs a row too. An index going stale is the failure mode this layout exists to avoid.
- There is no move operation. Moving a file is a write of the new path plus a delete of the
  old one, with the old file's expect_sha, in one commit_edits call — one commit.

RULES
- Every tool call needs repo:"{{REPO}}". There is no default repository.
- If the connector cannot reach the repository, say so and stop. Do not answer project
  questions from memory or guesswork, and do not fall back to another source.
- Never claim an edit landed without a commit SHA in the response.
```

---

## Notes for whoever installs this

- `create_repo(name, overview)` starts a new project repository, seeded with its own
  `INDEX.md` carrying the overview. It is deliberately not in the agent template: creating
  repositories is usually a human decision. Add a line about it if you want the agent to.
- `history(repo, path)` and `show_commit(repo, sha)` answer "who changed this and when".
  Add them to the template for an agent that needs to audit rather than edit.
- The template names one repository on purpose. An agent that roams several is an agent
  that can put an edit in the wrong one.
