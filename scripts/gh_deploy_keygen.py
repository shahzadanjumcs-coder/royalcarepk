#!/usr/bin/env python3
"""Generate an ed25519 deploy keypair inside the sandbox.

- Private key: ~/.ssh/royalcarepk_deploy (mode 0600) — NEVER printed, NEVER leaves sandbox.
- Public key:  printed to stdout in OpenSSH format — safe to share, user adds it
               to GitHub as a Deploy key (write access).
Idempotent: if the private key already exists, reprints the public key instead
of overwriting.
"""
import os
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

SSH_DIR = os.path.expanduser("~/.ssh")
PRIV_PATH = os.path.join(SSH_DIR, "royalcarepk_deploy")
PUB_PATH = PRIV_PATH + ".pub"

if os.path.exists(PRIV_PATH):
    # Idempotent: derive public key from existing private key.
    with open(PRIV_PATH, "rb") as f:
        priv = serialization.load_ssh_private_key(f.read(), password=None)
    pub = priv.public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
    )
    print(pub.decode() + " royalcarepk-sandbox", flush=True)
    sys.exit(0)

key = Ed25519PrivateKey.generate()
priv_pem = key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.OpenSSH,
    serialization.NoEncryption(),
)
pub_openssh = key.public_key().public_bytes(
    serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
)

os.makedirs(SSH_DIR, mode=0o700, exist_ok=True)
fd = os.open(PRIV_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as f:
    f.write(priv_pem)
os.chmod(PRIV_PATH, 0o600)
with open(PUB_PATH, "wb") as f:
    f.write(pub_openssh + b" royalcarepk-sandbox\n")

print(pub_openssh.decode() + " royalcarepk-sandbox", flush=True)
