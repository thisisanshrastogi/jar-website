# Storage Engine

This document explains how JAR stores messages on disk. If you've never worked with database internals or file systems, start here — every concept is built from the ground up.

## The Big Idea

JAR stores messages in an **append-only commit log**. This means:

1. New messages are always written at the end of a file (appended)
2. Existing messages are never modified or deleted
3. Every message gets a sequential number called an **offset**
4. To read message #42, you look up where offset 42 lives in the file

This is the same fundamental design that Apache Kafka, PostgreSQL's WAL, and Git's object store all use. It works because sequential disk writes are fast (even on spinning disks), and immutability eliminates a whole class of corruption bugs.

---

## Records: The Smallest Unit

A **record** is one message on disk. It has a fixed-size header followed by variable-length payload.

```
┌───────────────────────────────────────────────────┐
│                     Record                         │
├──────────┬──────────┬─────────────────────────────┤
│ Length   │  CRC32   │         Payload              │
│ (4 bytes)│ (4 bytes)│       (N bytes)              │
└──────────┴──────────┴─────────────────────────────┘
     │           │              │
     │           │              └── The actual message data (arbitrary bytes)
     │           └── Checksum of the payload (corruption detection)
     └── How many bytes the payload is (so we know where it ends)
```

**Total record size** = 8 bytes (header) + N bytes (payload)

### Why this format?

- **Length prefix** — Allows reading records sequentially without knowing their size in advance. Read 4 bytes → now you know how many more bytes to read.
- **CRC32** — If a disk sector goes bad or a write was interrupted mid-record, the checksum won't match. You know the data is corrupt before you use it.
- **No metadata in the record** — The record doesn't store its offset, topic, or timestamp. That context comes from *where* the record lives (which segment, which position). This keeps records small.

### Encoding (writing a record)

```
Input: payload = "hello" (5 bytes)

Step 1: Calculate length = 5
Step 2: Calculate CRC32("hello") = 0x3610A686
Step 3: Build record:
        [0x00000005][0x3610A686][hello]
        └─ 4 bytes ─┘└─ 4 bytes─┘└5 B─┘

Total on disk: 13 bytes
```

### Decoding (reading a record)

```
Step 1: Read 8 bytes (the header)
Step 2: Parse length from first 4 bytes → 5
Step 3: Parse expected CRC from next 4 bytes → 0x3610A686
Step 4: Read 5 bytes (the payload) → "hello"
Step 5: Compute CRC32("hello") → 0x3610A686
Step 6: Compare: expected == actual? ✓ Record is valid.
```

If step 6 fails, the record is corrupt. JAR returns `ErrCorruptRecord`.

---

## Segments: Splitting the Log into Files

If we wrote everything into one giant file, we'd have problems:

- Deleting old messages requires rewriting the entire file
- The file grows unbounded — filesystems handle billions of small files better than one multi-TB file
- Crash during a write to a huge file is harder to recover from

So JAR splits the log into **segments** — fixed-size files that rotate when full.

```
data/sensors/0/                              # Partition 0 of topic "sensors"
├── 00000000000000000000.log    (1 GB max)   # Records at offsets 0, 1, 2, ... 41
├── 00000000000000000042.log    (1 GB max)   # Records at offsets 42, 43, ... 89
└── 00000000000000000090.log    (active)     # Currently being written to
```

### Segment naming

The filename IS the base offset. `00000000000000000042.log` means "this segment's first record has global offset 42." The 20-digit zero-padded format ensures lexicographic sorting matches offset order.

### How a segment works internally

Each segment tracks:

| Field | Type | Purpose |
|-------|------|---------|
| `file` | `*os.File` | The open file handle |
| `size` | `int64` | Current file size in bytes |
| `maxBytes` | `int64` | Maximum file size before rotation |
| `nextOffset` | `uint64` | Next local offset to assign (0, 1, 2, ...) |
| `positions` | `[]int64` | Maps local offset → byte position in file |

### The positions array (the in-memory index)

This is the key data structure. When you want to read offset 3 from a segment:

```
positions = [0, 45, 102, 178, 230]
                          ^
                          │
               positions[3] = 178
               "Offset 3 starts at byte 178 in this file"
```

Then we seek to byte 178 and decode the record.

**Trade-off:** This index lives in memory. For a segment with 1 million records, that's ~8 MB of memory (1M * 8 bytes per int64). This is acceptable. The alternative (mmap'd index files) is planned but not yet implemented.

### Append flow

```
func Append(data []byte):
  1. Encode(data) → record bytes (with CRC)
  2. Check: size + len(record) > maxBytes? → return ErrSegmentFull
  3. file.Write(record)
  4. positions = append(positions, currentSize)   ← "offset N starts at byte `size`"
  5. nextOffset++
  6. size += len(record)
  7. Return local offset (nextOffset - 1)
```

### Read flow

```
func Read(offset uint64):
  1. Check: offset >= nextOffset? → "offset out of range"
  2. pos = positions[offset]                      ← byte position in file
  3. reader = SectionReader(file, pos, size-pos)  ← read from pos to end of file
  4. Decode(reader) → payload (with CRC check)
  5. Return payload
```

---

## Log: Managing Multiple Segments

A **Log** is a sequence of segments that together represent one partition's complete message history.

```
Log
 ├── segments[0]  (base offset 0,  nextOffset = 42)
 ├── segments[1]  (base offset 42, nextOffset = 48)
 └── segments[2]  (base offset 90, nextOffset = 5)   ← activeSegment
                                    global nextOffset = 42 + 48 + 5 = 95
```

### Global offsets vs local offsets

- **Local offset** — Position within a single segment (0, 1, 2, ...)
- **Global offset** — Position within the entire log across all segments

```
Global offset 50 → which segment?

Segment 0: offsets 0-41   (nextOffset=42, base=0)
Segment 1: offsets 42-89  (nextOffset=48, base=42)  ← 50 is here!
Segment 2: offsets 90-94  (nextOffset=5,  base=90)

Local offset = 50 - 42 = 8  → read segment 1, local offset 8
```

### Finding the right segment

```
func findSegment(globalOffset):
  base = 0
  for each segment:
    if globalOffset < base + segment.nextOffset:
      return (segment, globalOffset - base)   ← (segment, localOffset)
    base += segment.nextOffset
  return nil  ← offset out of range
```

This is a linear scan. It's fine because you typically have a handful of segments (not thousands). If you had 1000 segments, you'd binary search — but that's premature optimization here.

### Segment rotation

When you append to a log and the active segment is full:

```
func Append(data):
  offset, err = activeSegment.Append(data)
  if err == ErrSegmentFull:
    nextBase = sum of all segments' nextOffsets   ← e.g., 42 + 48 = 90
    create new segment named "00000000000000000090.log"
    activeSegment = new segment
    offset, err = activeSegment.Append(data)     ← retry on fresh segment
  return baseOffset(activeSegment) + offset       ← global offset
```

### Startup: Loading segments from disk

```
func loadSegments():
  1. ReadDir(log directory) → list all .log files
  2. Sort by filename (lexicographic = offset order)
  3. For each file: open as Segment → Rebuild() if non-empty
  4. Last segment = activeSegment
```

---

## Batcher: Amortizing fsync Cost

**The problem:** `fsync` is expensive. It forces the OS to flush write buffers to physical disk. Calling it on every single append would limit throughput to ~1000-5000 writes/sec (depending on disk).

**The solution:** Buffer multiple writes, then fsync once for the whole batch.

```
┌─────────────────────────────────────────────┐
│                 Batcher                       │
│                                              │
│  Append() ──► Log.Append()                   │
│               pending++                      │
│               if pending >= maxPending:       │
│                 log.Flush() (fsync)           │
│                 pending = 0                   │
│                                              │
│  Background goroutine (flushLoop):           │
│    every `interval` (e.g., 5ms):             │
│      if pending > 0:                         │
│        log.Flush()                           │
│        pending = 0                           │
│                                              │
└─────────────────────────────────────────────┘
```

### Configurable parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `batch_max_pending` | 100 | Flush after this many writes |
| `batch_flush_interval` | 5ms | Flush at least this often, even if batch isn't full |

### The durability-latency trade-off

- **maxPending = 1, interval = 0** → fsync every write. Maximum durability, minimum throughput.
- **maxPending = 1000, interval = 100ms** → fsync every 1000 writes or every 100ms. High throughput, but up to 100ms of data can be lost on crash.
- **Default (100 writes, 5ms)** → At most 5ms of messages could be lost on a hard crash. Good balance.

---

## Crash Recovery: Rebuilding State from Disk

When JAR restarts after a crash (or a normal shutdown), it needs to reconstruct all in-memory state. Here's what happens for each segment:

```
func Rebuild():
  positions = empty
  nextOffset = 0
  pos = 0  (byte position in file)

  while pos < file size:
    1. Read 8 bytes at position `pos` (the header)
    2. Parse length from first 4 bytes
    3. positions = append(positions, pos)      ← "this offset starts here"
    4. pos += 8 + length                       ← skip to next record
    5. nextOffset++
```

This walks the file record-by-record, rebuilding the `positions` array without reading the actual payloads. It only reads headers (8 bytes per record), so it's fast even for large segments.

### What about partial writes?

If JAR crashed mid-write, the last record might be truncated:

```
[good record][good record][partial: length=100 but only 50 bytes written]
                                     ^
                                     │
                            Rebuild stops here (ReadAt fails)
```

The rebuild loop will stop when it can't read a full header or when the remaining bytes don't match the declared length. The partial record is effectively ignored — it was never acknowledged (no PUBACK sent), so the client will retry.

### CRC as a safety net

Even if a record appears complete (correct length), the CRC check during Read() catches bit-rot or disk corruption. A record that passes the length check but fails CRC is flagged as `ErrCorruptRecord`.

---

## How Offsets Work: The Full Picture

Offsets are JAR's addressing system. Here's how they flow through the layers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer          │ What it sees                                            │
├────────────────┼────────────────────────────────────────────────────────┤
│ MQTT Client    │ Doesn't see offsets directly.                          │
│                │ Internally mapped: clientID → offset per partition.     │
├────────────────┼────────────────────────────────────────────────────────┤
│ Custom Protocol│ Explicit: "give me topic X, partition Y, offset Z"     │
│ (jarctl)       │ Returns the message at that exact position.            │
├────────────────┼────────────────────────────────────────────────────────┤
│ Broker         │ Global offset per partition. Publish returns            │
│                │ (partition, globalOffset). Consume takes globalOffset.  │
├────────────────┼────────────────────────────────────────────────────────┤
│ Batcher        │ Passes through to Log. Same global offset.             │
├────────────────┼────────────────────────────────────────────────────────┤
│ Log            │ Translates global → (segment, localOffset).            │
│                │ Append returns: baseOffset(activeSeg) + localOffset     │
├────────────────┼────────────────────────────────────────────────────────┤
│ Segment        │ Local offset only (0, 1, 2, ...).                      │
│                │ positions[localOffset] → byte position in file.         │
└────────────────┴────────────────────────────────────────────────────────┘
```

### Example: Reading global offset 50

```
1. Broker.Consume("sensors", partition=0, offset=50)
2. Topic.Read(0, 50) → batcher[0].Read(50)
3. Batcher.Read(50) → Log.Read(50)
4. Log.findSegment(50):
   - Segment 0: base=0, has 42 records → 50 >= 42, skip
   - Segment 1: base=42, has 48 records → 50 < 42+48 → found!
   - localOffset = 50 - 42 = 8
5. Segment 1.Read(8):
   - pos = positions[8] → byte 1024 (for example)
   - SectionReader at byte 1024
   - Decode → CRC check → return payload
```

---

## Summary Table

| Component | File | Responsibility |
|-----------|------|----------------|
| Record | `record.go` | Encode/decode with CRC32 |
| Segment | `segment.go` | Single file I/O, position tracking, rebuild |
| Log | `log.go` | Multi-segment management, global offsets, rotation |
| Batcher | `batcher.go` | Deferred fsync, flush loop, throughput optimization |
