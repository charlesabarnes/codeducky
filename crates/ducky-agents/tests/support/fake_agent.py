"""A stand-in coding agent for the scratch-core tests.

It reports status with OSC 7501 the way real agents do (idle when ready, working during a turn,
done after it), reads each message `hc send` pastes (bracketed paste, then Enter), and acts on
Code Ducky tasks by editing the notes file the task names: a fix task resolves the listed notes,
a review task adds one. `block` makes it ask for permission; `exit` ends it with code 3.
`FAKE_AGENT_DELAY` (seconds, default 0.3) is how long each turn works.
"""

import datetime
import json
import os
import re
import sys
import time
import tty

PASTE_START = b"\x1b[200~"
PASTE_END = b"\x1b[201~"
AUTHOR = {"kind": "agent", "name": "fake-agent"}


def out(text):
    sys.stdout.write(text.replace("\n", "\r\n"))
    sys.stdout.flush()


def report(state, **fields):
    parts = [f"state={state}", "app=fake-agent"] + [f"{k}={v}" for k, v in fields.items()]
    out("\x1b]7501;" + ":".join(parts) + "\x1b\\")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_message(fd):
    text, pending, in_paste = b"", b"", False
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            sys.exit(0)
        pending += chunk
        while pending:
            if pending.startswith(PASTE_START):
                in_paste, pending = True, pending[len(PASTE_START):]
            elif pending.startswith(PASTE_END):
                in_paste, pending = False, pending[len(PASTE_END):]
            elif PASTE_START.startswith(pending) or PASTE_END.startswith(pending):
                break
            else:
                byte, pending = pending[:1], pending[1:]
                if byte == b"\r" and not in_paste:
                    return text.decode(errors="replace").replace("\r", "\n")
                text += byte


def load(path):
    if not os.path.exists(path):
        return {"version": 1, "notes": []}
    with open(path) as f:
        return json.load(f)


def save(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(doc, f, indent=2)
    os.replace(path + ".tmp", path)


def notes_path(message):
    found = re.search(r"^Notes file: (.+)$", message, re.M)
    return found.group(1).strip() if found else None


def fix(message):
    path = notes_path(message)
    ids = set(re.findall(r"^([a-z0-9]+)  \S+:\S+  \[", message, re.M))
    doc = load(path)
    for note in doc["notes"]:
        if note["id"] in ids and note.get("status", "open") == "open":
            stamp = now()
            note["status"] = "resolved"
            note["updated_at"] = stamp
            note["resolution"] = {"by": AUTHOR, "text": "fake agent fixed it", "at": stamp}
    save(path, doc)
    out(f"resolved {' '.join(sorted(ids))}\n")


def review(message):
    path = notes_path(message)
    doc = load(path)
    stamp = now()
    doc["notes"].append({
        "id": "fake01", "status": "open", "severity": "issue", "path": "README.md",
        "anchor": {"side": "new", "line": 1}, "body": "Found by the fake agent.",
        "author": AUTHOR, "created_at": stamp, "updated_at": stamp,
    })
    save(path, doc)
    out("added fake01\n")


def main():
    fd = sys.stdin.fileno()
    tty.setraw(fd)
    out("\x1b[?2004h")
    out(f"fake agent ready [{os.environ.get('CLAUDECODE', '-')}][{os.environ.get('CLAUDE_CONFIG_DIR', '-')}]\n")
    report("idle")
    while True:
        message = read_message(fd)
        command = message.strip()
        out("got: " + (command.splitlines() or [""])[0][:100] + "\n")
        if command == "block":
            report("blocked", kind="permission")
            continue
        if command == "exit":
            sys.exit(3)
        report("working")
        time.sleep(float(os.environ.get("FAKE_AGENT_DELAY", "0.3")))
        if "Code Ducky fix task" in message:
            fix(message)
        elif "Code Ducky review task" in message:
            review(message)
        report("done")
        out("done\n")


main()
