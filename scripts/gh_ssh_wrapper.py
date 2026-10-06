#!/usr/bin/env python3
"""GIT_SSH transport shim backed by paramiko (no ssh binary / no root needed).

Invoked by git as:  <script> [-p port] [-o opt] [-i path] [-4|-6] host [command]
- Auth: ed25519 deploy key at ~/.ssh/royalcarepk_deploy (generated sandbox-side).
- Host key: PINNED to GitHub's published ssh-ed25519 host key (no TOFU, no
  AutoAdd) — MITM on the transport is rejected.
- Streams git protocol bidirectionally; exits with the remote command's status.
"""
import base64
import os
import sys
import threading
import time

import paramiko
from paramiko.ed25519key import Ed25519Key

# GitHub's official ssh-ed25519 host key (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
GITHUB_ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
PRIV_PATH = os.path.expanduser("~/.ssh/royalcarepk_deploy")


def parse_args(argv):
    port = 22
    host = None
    command = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-p" and i + 1 < len(argv):
            port = int(argv[i + 1]); i += 2
        elif a.startswith("-p") and len(a) > 2 and a[2:].isdigit():
            port = int(a[2:]); i += 1
        elif a == "-o" and i + 1 < len(argv):
            i += 2  # ignore ssh options
        elif a == "-i" and i + 1 < len(argv):
            i += 2  # ignore identity hints; we use our deploy key
        elif a in ("-4", "-6", "-A", "-C", "-q", "-T", "-x", "-n", "-a", "-t", "-v"):
            i += 1
        elif a == "--":
            i += 1
        elif host is None:
            host = a
            command = argv[i + 1:]
            break
        else:
            i += 1
    # Real ssh accepts 'user@host' as the destination; git passes it that way.
    username = "git"
    if host and "@" in host:
        username, host = host.rsplit("@", 1)
    return port, host, username, command


def main():
    port, host, username, command = parse_args(sys.argv[1:])
    if host is None:
        sys.stderr.write("gh_ssh_wrapper: no host given\n")
        return 2
    if not os.path.exists(PRIV_PATH):
        sys.stderr.write("gh_ssh_wrapper: deploy key missing — run gh_deploy_keygen.py first\n")
        return 2

    client = paramiko.SSHClient()
    # Pin GitHub host key under both hostnames we may connect to.
    gh_key = Ed25519Key(data=base64.b64decode(GITHUB_ED25519))
    hk = client.get_host_keys()
    hk.add("github.com", "ssh-ed25519", gh_key)
    hk.add("[ssh.github.com]:443", "ssh-ed25519", gh_key)
    pkey = Ed25519Key.from_private_key_file(PRIV_PATH)

    target_host = "ssh.github.com" if port == 443 else host
    try:
        client.connect(
            target_host,
            port=port,
            username=username,
            pkey=pkey,
            timeout=20,
            banner_timeout=20,
            auth_timeout=20,
            allow_agent=False,
            look_for_keys=False,
        )
    except paramiko.AuthenticationException:
        sys.stderr.write(
            "gh_ssh_wrapper: GitHub rejected the deploy key (publickey). "
            "Has the deploy key been added with 'Allow write access'?\n"
        )
        return 255
    except Exception as e:  # network / hostkey errors — keep message non-secret
        sys.stderr.write(
            f"gh_ssh_wrapper: connect failed: {type(e).__name__}: {e} "
            f"(host={host!r}, port={port}, target={target_host!r})\n"
        )
        return 255

    try:
        chan = client.get_transport().open_session()
        chan.settimeout(600)
        chan.exec_command(" ".join(command) if command else "")

        def feed_stdin():
            try:
                while True:
                    data = sys.stdin.buffer.read(32768)
                    if not data:
                        break
                    chan.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    chan.shutdown_write()
                except Exception:
                    pass

        t = threading.Thread(target=feed_stdin, daemon=True)
        t.start()

        while True:
            got = False
            if chan.recv_ready():
                sys.stdout.buffer.write(chan.recv(32768))
                sys.stdout.buffer.flush()
                got = True
            if chan.recv_stderr_ready():
                sys.stderr.buffer.write(chan.recv_stderr(32768))
                sys.stderr.buffer.flush()
                got = True
            if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
                break
            if not got:
                time.sleep(0.01)

        while chan.recv_ready():
            sys.stdout.buffer.write(chan.recv(32768))
        while chan.recv_stderr_ready():
            sys.stderr.buffer.write(chan.recv_stderr(32768))
        sys.stdout.buffer.flush()
        sys.stderr.buffer.flush()
        return chan.recv_exit_status()
    finally:
        try:
            client.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
