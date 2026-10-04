"""Split the Task 32 patch into chat-sized parts for plain-text delivery.

Computes part boundaries snapped to 'diff --git' lines so each part is a
whole number of patch files. Prints a boundary table for delivery.
"""
import hashlib

P = "/home/z/my-project/download/task32-approval-workflow.patch"
N_PARTS = 5

data = open(P, "rb").read()
total = len(data)
lines = data.split(b"\n")          # last element is b"" (file ends with \n)
n_content = len(lines) - 1         # number of real lines

# byte offset of each line
offs = []
o = 0
for ln in lines:
    offs.append(o)
    o += len(ln) + 1

non_ascii = sum(1 for b in data if b > 0x7F)

# boundaries snapped to next 'diff --git' line at/after each byte target
starts = [0]
for i in range(1, N_PARTS):
    t = total * i / N_PARTS
    idx = n_content - 1
    for j in range(1, n_content):
        if offs[j] >= t and lines[j].startswith(b"diff --git "):
            idx = j
            break
    starts.append(idx)
starts.append(n_content)

print(f"total_bytes={total} lines={n_content} non_ascii_bytes={non_ascii}")
sum_bytes = 0
for k in range(N_PARTS):
    a, b = starts[k], starts[k + 1]
    seg = data[offs[a]:offs[b]]
    sum_bytes += len(seg)
    first = lines[a].decode("utf-8", "replace")[:60]
    last = lines[b - 1].decode("utf-8", "replace")[:60]
    print(f"PART {k+1}: sed {a+1},{b}p  lines={b-a}  bytes={len(seg)}  "
          f"sha={hashlib.sha256(seg).hexdigest()[:12]}")
    print(f"   first: {first}")
    print(f"   last : {last}")
print(f"sum_of_parts={sum_bytes} (must equal {total})")
