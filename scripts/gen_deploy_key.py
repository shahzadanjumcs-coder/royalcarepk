#!/usr/bin/env python3
"""Generate a fresh ed25519 deploy keypair for royalcarepk pushes.

Private key: /home/z/.ssh/royalcarepk_deploy  (0600, OUTSIDE the repo)
Public key:  /home/z/.ssh/royalcarepk_deploy.pub + printed to stdout
"""
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import paramiko

PRIV = "/home/z/.ssh/royalcarepk_deploy"
PUB = PRIV + ".pub"

key = Ed25519PrivateKey.generate()
pem = key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.OpenSSH,
    serialization.NoEncryption(),
)
with open(PRIV, "wb") as f:
    f.write(pem)
os.chmod(PRIV, 0o600)

# Load back through paramiko to produce the canonical one-line public key.
pk = paramiko.Ed25519Key.from_private_key_file(PRIV)
pub_line = f"{pk.get_name()} {pk.get_base64()} royalcarepk-deploy"
with open(PUB, "w") as f:
    f.write(pub_line + "\n")
os.chmod(PUB, 0o644)

print(pub_line)
