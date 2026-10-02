"""Generate distinctive test branding assets for the logo upload UI test."""
import struct, zlib, os

def make_png(path, size, rgb, text_label):
    # Simple solid-color PNG with a border pattern, generated without PIL
    w = h = size
    r, g, b = rgb
    rows = []
    for y in range(h):
        row = bytearray()
        row.append(0)  # filter none
        for x in range(w):
            # border ring in dark slate, inner fill in brand color, white square center
            if x < 6 or y < 6 or x >= w - 6 or y >= h - 6:
                row += bytes([40, 40, 60])
            elif (w // 2 - 20) <= x < (w // 2 + 20) and (h // 2 - 20) <= y < (h // 2 + 20):
                row += bytes([255, 255, 255])
            else:
                row += bytes([r, g, b])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")

os.makedirs("/home/z/my-project/scripts/assets", exist_ok=True)
# Distinctive purple/violet logo so we can visually confirm it replaced the default emerald logo
make_png("/home/z/my-project/scripts/assets/test-logo.png", 160, (124, 58, 237), "RCPK")
# Distinctive orange favicon
make_png("/home/z/my-project/scripts/assets/test-favicon.png", 64, (234, 88, 12), "F")
# Second logo for the replace test (teal)
make_png("/home/z/my-project/scripts/assets/test-logo-2.png", 160, (13, 148, 136), "R2")
