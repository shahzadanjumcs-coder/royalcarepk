#!/usr/bin/env python3
"""
Generate a NEW ed25519 GitHub deploy keypair for the royalcarepk repository.

- Writes keys OUTSIDE the repo: ~/.ssh/royalcarepk_deploy_v2(.pub)
- Does NOT touch the old royalcarepk_deploy(.pub) or any application code
- Private key: OpenSSH format, no passphrase (deploy-key usage)
- Prints the SHA256 fingerprint and the exact public key line for GitHub
"""
import os
import base64
import hashlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

PRIV_PATH = os.path.expanduser("~/.ssh/royalcarepk_deploy_v2")
PUB_PATH = PRIV_PATH + ".pub"
COMMENT = "royalcarepk-deploy-v2"

def main() -> None:
    # Refuse to silently overwrite anything
    for p in (PRIV_PATH, PUB_PATH):
        if os.path.exists(p):
            raise SystemExit(f"REFUSING: {p} already exists — choose another name")

    key = Ed25519PrivateKey.generate()

    priv_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,   # openssh-key-v1 container
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_line = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.OpenSSH,
            format=serialization.PublicFormat.OpenSSH,
        )
        .decode("ascii")
        + f" {COMMENT}"
    )

    with open(PRIV_PATH, "wb") as f:
        f.write(priv_pem)
    os.chmod(PRIV_PATH, 0o600)
    with open(PUB_PATH, "w") as f:
        f.write(pub_line + "\n")
    os.chmod(PUB_PATH, 0o644)

    # SHA256 fingerprint exactly as GitHub displays it
    raw = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    # fingerprint is over the wire-format blob, not the raw point — build it:
    blob = b"\x00\x00\x00\x0bssh-ed25519" + b"\x00\x00\x00\x20" + raw
    fp = base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")

    print("PRIVATE:", PRIV_PATH, "(600, outside repo, never committed)")
    print("PUBLIC :", PUB_PATH)
    print("FINGER : SHA256:" + fp)
    print("PUBKEY :")
    print(pub_line)

if __name__ == "__main__":
    main()
