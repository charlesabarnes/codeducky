# Code Ducky review notes

This folder holds the review notes Code Ducky keeps for this repository. It lives in the git
common dir, so it is never committed, every worktree of the repository shares it, and every
machine that reviews this checkout sees the same notes.

If you are a coding agent working in this repository: read the open notes, fix what they ask,
and mark each one resolved by editing the JSON file directly. Code Ducky picks up your edits
when your turn ends.

## Where the notes are

    branches/<branch>/notes.json    notes on a local branch, e.g. branches/feature/login/notes.json
    pulls/<number>/notes.json       notes on GitHub pull request <number>

For the branch you have checked out:

    NOTES="$(git rev-parse --path-format=absolute --git-common-dir)/codeducky/branches/$(git branch --show-current)/notes.json"

`state.json` beside each `notes.json`, and `checklists.json` here, are Code Ducky's own
bookkeeping. Leave them alone.

## What a note holds

    id          short id, e.g. "k3x9qa"; how you refer to the note
    status      "open", "resolved" or "dismissed"
    severity    "nit", "suggestion", "issue" or "blocker"
    path        file path relative to the repository root
    anchor      side: "new" (the branch's version of the file) or "old" (the base)
                line, end_line: the line, or the first and last line of a range
                code: the lines as they read when the note was made; before/after: context
    body        the note, in Markdown
    author      {"kind": "human"} or {"kind": "agent", "name": "..."}
    created_at, updated_at   UTC times like "2026-11-10T14:05:00Z"
    resolution  {"by": <author>, "text": "...", "at": <time>}, set when a note is closed
    anchor_lost true when the anchored code is gone from the latest version (maybe already fixed)

Line numbers on the "new" side are those of the file in the working tree. Code Ducky moves
them as the file changes.

## List the open notes

    jq -r '.notes[] | select(.status == "open")
      | "\(.id)  \(.path):\(.anchor.line)  [\(.severity)]  \(.body)"' "$NOTES"

## Resolve a note

Set `status` to "resolved", add a `resolution` saying what you did, and set `updated_at` to now.
Change nothing else and keep every other field as it is, including fields you do not recognise.

    {
      "id": "k3x9qa",
      "status": "resolved",
      ...
      "updated_at": "2026-11-10T15:00:00Z",
      "resolution": {
        "by": {"kind": "agent", "name": "claude-code"},
        "text": "Renamed x to total and added a test.",
        "at": "2026-11-10T15:00:00Z"
      }
    }

With jq:

    NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    jq --arg id k3x9qa --arg now "$NOW" --arg text "Renamed x to total and added a test." \
      '(.notes[] | select(.id == $id)) |= (.status = "resolved" | .updated_at = $now
        | .resolution = {by: {kind: "agent", name: "claude-code"}, text: $text, at: $now})' \
      "$NOTES" > "$NOTES.tmp" && mv "$NOTES.tmp" "$NOTES"

Use "dismissed" instead of "resolved" for a note you decided not to act on, and say why.

## Add a note

Append an object to `notes`. Only `path`, `anchor.line` and `body` are required; Code Ducky
fills in the anchored code and context from the file.

    {
      "id": "a7pq2m",
      "status": "open",
      "severity": "issue",
      "path": "src/cart.ts",
      "anchor": {"side": "new", "line": 42},
      "body": "`total` ignores the discount.",
      "author": {"kind": "agent", "name": "claude-code"},
      "created_at": "2026-11-10T15:00:00Z",
      "updated_at": "2026-11-10T15:00:00Z"
    }

Pick an id of a few lowercase letters and digits that no other note in the file uses. For a
range, add `"end_line"`. If `notes.json` does not exist yet, create it as
`{"version": 1, "notes": [ ... ]}`.

## Rules

- Keep the file valid JSON. If Code Ducky cannot read it, it shows the problem and does not
  write the file until it is fixed.
- Do not delete notes or change `version`; resolve or dismiss notes instead.
