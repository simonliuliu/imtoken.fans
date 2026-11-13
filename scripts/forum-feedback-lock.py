#!/usr/bin/env python3
"""Run the local queue operator with a crash-safe, process-held POSIX lock."""

import fcntl
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent


def acquire_lock(filename):
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(filename, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("Queue lock must be a regular file")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.set_inheritable(descriptor, True)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def main():
    args = sys.argv[1:]
    command = args[0] if args and not args[0].startswith("--") else "list"
    local_node = ROOT / "node_modules" / "node" / "bin" / "node"
    node = str(local_node) if os.access(local_node, os.X_OK) else shutil.which("node")
    if not node:
        raise OSError("Node is unavailable")
    env = os.environ.copy()
    env.pop("FORUM_FEEDBACK_LOCK_FD", None)
    if command != "list" and "--help" not in args:
        result = subprocess.run(
            ["git", "rev-parse", "--git-path", "forum-feedback-queue-state.json"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        state = Path(result.stdout.strip())
        if not state.is_absolute():
            state = ROOT / state
        descriptor = acquire_lock(str(state) + ".lock")
        env["FORUM_FEEDBACK_LOCK_FD"] = str(descriptor)
    os.execve(node, [node, str(ROOT / "scripts" / "forum-feedback-queue.mjs"), *args], env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.SubprocessError):
        print("Forum queue lock unavailable; another operator may be active. No credentials were printed.", file=sys.stderr)
        sys.exit(1)
