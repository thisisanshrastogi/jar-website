# Design Decisions

Each section follows: Context → Options → Choice → Trade-off. These are the interesting engineering choices in JAR — the kind of thing an interviewer asks about.

---

## Decision 1: Append-Only Commit Log over an Embedded Database

**Context:** JAR needs durable message storage. Every published message must survive restarts and be retrievable by offset. The obvious approaches are: use an existing embedded database (SQLite, BoltDB, LevelDB) or manage raw files yourself.

**Options considered:**
- **SQLite** — Relational, ACID, well-tested. Would store messages as rows.
- **BoltDB (bbolt)** — Key-value store, B+ tree, single-writer. Used by etcd.
- **Append-only log files** — What Kafka does. Sequential writes to flat files.

**Choice:** Append-only log files.

**Why:**
- Sequential writes only → disk throughput is maximized. No random seeks, no page splits, no compaction. The OS write buffer does its job perfectly.
- Offset is just a position — O(1) reads. No query planner, no index traversal.
- Deletion of old data is trivial: delete the entire segment file. No garbage collection, no tombstones.
- No write amplification. Data is written once and never rewritten (unlike LSM trees or B-trees).
- The storage format is the same as the API: "give me offset N" translates directly to "read at position P in file F."

**Trade-off:**
- No ad-hoc queries. Can't "SELECT WHERE payload LIKE ..." — you must read sequentially or know the exact offset.
- Had to build segment management, rotation, CRC validation, and crash recovery from scratch.
- Point lookups by anything other than offset (e.g., by timestamp or by key) would require building external indexes.

---

## Decision 2: Hand-Parse MQTT Instead of Using a Library

**Context:** JAR needs MQTT v3.1.1 protocol support. Real clients (mosquitto_pub/sub, Paho) must be able to connect. Go has existing MQTT server libraries (mochi-mqtt, rumqttd bindings).

**Options considered:**
- **Use mochi-mqtt** — Drop-in MQTT server library for Go. Hook into its event system.
- **Parse MQTT packets from scratch** — Read the OASIS spec, implement byte-by-byte.

**Choice:** Hand-parse packets from the spec.

**Why:**
- The bridge between MQTT semantics and the commit log IS the core of this project. A library draws that boundary in the wrong place — you lose control over exactly when to ack, how to map sessions to offsets, and where durability guarantees kick in.
- MQTT's wire format is straightforward: fixed header (2-5 bytes) + variable header + payload. The remaining-length encoding is the trickiest part (4 lines of code).
- Learning goal: understanding protocol parsing at the byte level is the skill being developed.
- Only a subset is needed (CONNECT, PUBLISH, SUBSCRIBE, PING, DISCONNECT) — implementing 6 packet types is ~300 lines, not thousands.

**Trade-off:**
- No QoS 2 (exactly-once). The four-step PUBREC/PUBREL/PUBCOMP handshake is complex and skipped.
- No retained messages, no will messages (parsed but not acted on), no keepalive disconnect timer.
- Spec compliance is partial. Works with mosquitto_pub/sub and Paho but wouldn't pass a conformance test suite.
- Any encoding mistake = silent disconnects that are difficult to debug (client just drops the connection with no error).

---

## Decision 3: Topic Trie for Wildcard Matching Instead of Flat Map

**Context:** MQTT supports wildcard subscriptions (`+` matches one level, `#` matches all remaining levels). When a message arrives on `sensors/room1/temp`, we need to find all matching subscribers — including those subscribed to `sensors/+/temp` or `sensors/#`. This happens on every publish, so it must be fast.

**Options considered:**
- **Flat map** — Store every subscription as a string, iterate all subscriptions on each publish, regex-match each one.
- **Trie (prefix tree)** — Split topics by `/`, build a tree structure, walk it on publish.

**Choice:** Trie.

**Why:**
- Flat map is O(n) per publish where n = total subscriptions. With 10,000 subscriptions, that's 10,000 string comparisons per message.
- Trie is O(d) where d = topic depth (typically 3-5 levels). Walk down the tree, branching on `+` (all children) and terminating on `#`.
- `#` wildcard terminates the walk immediately — the trie handles this as "collect all subscribers at this node" without further recursion.
- `+` means "take all children at this level" — one branch per child, no string comparison needed.
- Adding/removing subscriptions is also O(d) — insert or delete a path.

**Trade-off:**
- More complex code: flat map is ~5 lines, the trie is ~110 lines.
- Higher memory overhead: each topic level is a separate node with a `map[string]*trieNode`.
- For small subscriber counts (<50), flat scan may actually be faster due to cache locality. The trie pays off at scale.
- Debugging is harder — can't just print the subscription list; need to walk the tree.

---

## Decision 4: Per-Client Buffered Channels for Fan-Out

**Context:** When a message is published, it must reach all matching subscribers. Subscribers read at different speeds — a sensor on a slow 2G connection shouldn't block a desktop dashboard on gigabit ethernet. This is the "fan-out" problem.

**Options considered:**
- **Direct write** — Publisher's goroutine writes to each subscriber's TCP connection directly (blocking on each).
- **Shared channel** — All subscribers read from one channel (first-come-first-served, only one gets it).
- **Per-client buffered channel** — Each subscriber has its own channel; publisher drops message in each.

**Choice:** Per-client buffered channels.

**Why:**
- Publisher drops the message into each channel and moves on — never blocks on a slow consumer. The publish latency is O(number of subscribers) for the channel sends, but each send is non-blocking if the buffer isn't full.
- Each subscriber's goroutine drains its own channel independently. They're completely decoupled.
- Bounded buffer = natural backpressure point. When it's full, you make a policy decision (currently: drop). The publisher is never held hostage.
- Failure isolation: one subscriber's broken TCP connection doesn't ripple to others.
- Go channels are the idiomatic primitive for this pattern.

**Trade-off:**
- Memory: each subscriber holds a buffer of N messages (default 256). With 1000 subscribers, that's 256K message pointers in memory.
- No zero-copy fan-out. Each channel gets its own reference to the payload (though the payload itself isn't copied — it's a slice pointing to the same backing array).
- Drop policy must be decided: drop oldest? Drop newest? Disconnect the slow client? Currently drops (doesn't send to full channels). No perfect answer.
- Delivery timing is non-deterministic across subscribers. Subscriber A might receive a message before Subscriber B — no cross-subscriber ordering guarantee.

---

## Decision 5: Batched fsync over Per-Write fsync

**Context:** Durability requires `fsync` — it forces the OS to flush write buffers to physical disk. Without it, data in the OS page cache is lost on power failure. But fsync is slow: ~0.5-5ms per call depending on the disk. Calling it on every single message limits throughput to a few thousand writes per second.

**Options considered:**
- **fsync every write** — Maximum durability. Every message is on disk before returning success.
- **fsync never** — Let the OS decide when to flush. Maximum throughput but data loss on crash.
- **Batched fsync** — Accumulate writes, periodically flush the batch.

**Choice:** Batched fsync with configurable triggers.

**Why:**
- A single fsync covers all writes since the last flush. 100 messages × 1 fsync = 100x better throughput than 100 messages × 100 fsyncs.
- Two flush triggers (whichever fires first):
  - **Count-based** (`batch_max_pending = 100`): flush after 100 writes
  - **Time-based** (`batch_flush_interval = 5ms`): flush every 5ms regardless of count
- This gives bounded data loss: at most 5ms of messages can be lost on a hard crash. For IoT telemetry, this is an acceptable trade-off.
- The flush is a background goroutine with a ticker — no coordination needed from the writer path beyond incrementing a counter.

**Trade-off:**
- Up to `batch_flush_interval` worth of messages can be lost on a hard crash (kernel panic, power loss). A clean shutdown always flushes.
- QoS 1 PUBACK is sent before fsync completes. This means "at-least-once" isn't perfectly durable — it's "at-least-once assuming no crash within 5ms of the ack." Strict durability would require sync-before-ack.
- Adds complexity: a background goroutine, a pending counter, shutdown coordination (must flush on close).

---

## Decision 6: Consumer Offsets Stored in a Commit Log

**Context:** Consumer offsets (`group:topic:partition → offset`) must survive restarts. Where to store them?

**Options considered:**
- **Flat file** — Write all offsets to a JSON/TOML file periodically.
- **Embedded KV store** — Use BoltDB or similar for offset storage.
- **Another commit log** — Store offsets in the same append-only log format as messages.

**Choice:** Dedicated commit log at `data/__consumer_offsets/`.

**Why:**
- Reuses the exact same code (Log, Segment, Record). No new dependencies, no new serialization format.
- Append-only means offset commits are fast writes (no seek, no rewrite).
- Recovery works identically: replay the log from start, apply each commit in order, last write wins.
- This is exactly what Kafka does (`__consumer_offsets` topic) — proven pattern.

**Trade-off:**
- The log grows forever (every commit is a new record, even for the same group/topic/partition). Requires log compaction to reclaim space (not yet implemented).
- Rebuild time grows linearly with the number of commits. For millions of commits, startup gets slow. In practice, with a few hundred consumers committing periodically, this is fine.
- More complex than a simple file rewrite. But simpler than adding a KV store dependency.

---

## Decision 7: Single Binary with Multiple Protocol Servers

**Context:** JAR needs to serve three different interfaces: MQTT (for IoT devices), custom binary protocol (for programmatic replay), and HTTP (for the admin panel). These could be separate processes or one process.

**Options considered:**
- **Separate binaries** — `jar-mqtt`, `jar-custom`, `jar-admin`. Communicate via IPC or shared storage.
- **Single binary, multiple goroutines** — One process runs all three servers.

**Choice:** Single binary.

**Why:**
- Shared state: all three servers need access to the same Broker, the same topics, the same commit logs. In-process access is a function call. Cross-process access requires serialization, sockets, and coordination.
- Deployment simplicity: one binary to build, one process to monitor, one config file.
- No distributed coordination: no need for service discovery, no split-brain, no eventual consistency between components.
- Resource efficiency: one process, shared memory, no IPC overhead.

**Trade-off:**
- No independent scaling. Can't run 5 MQTT servers and 1 admin panel. (Fine for single-node; would matter for multi-node.)
- One crash takes down everything. A bug in the admin panel's HTTP handler crashes the MQTT server too.
- More complex graceful shutdown: must drain all three servers in order.
- Testing requires spinning up the whole broker for integration tests.

---

## Decision 8: FNV32a Hash for Partition Routing

**Context:** When a message has a partition key, we need to deterministically route it to one of N partitions. The same key must always go to the same partition (for ordering guarantees). 

**Options considered:**
- **CRC32** — Already used for record integrity. Reuse it for routing.
- **FNV32a** — Fast, well-distributed, non-cryptographic hash.
- **SHA256 truncated** — Cryptographic hash, maximum distribution quality.

**Choice:** FNV32a.

**Why:**
- Non-cryptographic = fast. FNV32a is one of the fastest hash functions with good distribution.
- 32-bit output is ideal for `hash % numPartitions` (usually 1-64 partitions). No need for 256 bits of entropy.
- Part of Go's standard library (`hash/fnv`) — no external dependency.
- Well-studied distribution properties. Won't create hot partitions for typical string keys.

**Trade-off:**
- Not cryptographically secure (irrelevant here — we're routing messages, not protecting secrets).
- Fixed partition count: if you add partitions later, existing keys may route differently. This is a fundamental limitation of `hash % N`. (Kafka has the same limitation — you shouldn't change partition count on existing topics.)
- Round-robin for nil keys means no ordering guarantee for keyless messages. This is intentional — if you don't provide a key, you're saying "I don't care about order."
