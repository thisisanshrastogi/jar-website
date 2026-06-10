# Architecture

This document traces how a message moves through JAR — from the moment a client sends it to the moment another client receives it. Every component it touches is explained along the way.

## System Overview

JAR is a single Go binary that runs three network servers simultaneously:

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                      JAR Process                         │
                    │                                                          │
  MQTT Clients ────▶  MQTT Server (:2707)                                     │
                    │       │                                                  │
  jarctl / apps ───▶  Custom Protocol Server (:2708)     Admin Panel (:8080) ◀── Browser
                    │       │                                │                 │
                    │       ▼                                ▼                 │
                    │  ┌──────────┐                  ┌─────────────┐           │
                    │  │  MQTT    │                  │  Admin HTTP  │           │
                    │  │  Handler │                  │  Server      │           │
                    │  └────┬─────┘                  └──────┬──────┘           │
                    │       │                               │                  │
                    │       ▼                               ▼                  │
                    │  ┌────────────────────────────────────────────┐          │
                    │  │                 Broker                      │          │
                    │  │  ┌────────┐  ┌─────────────┐  ┌────────┐  │          │
                    │  │  │ Topics │  │ Consumer Mgr │  │Sessions│  │          │
                    │  │  └───┬────┘  └─────────────┘  └────────┘  │          │
                    │  └──────┼────────────────────────────────────┘           │
                    │         │                                                │
                    │         ▼                                                │
                    │  ┌─────────────────────────────────────┐                 │
                    │  │         Commit Log Engine            │                 │
                    │  │  ┌─────────┐  ┌─────────┐  ┌─────┐ │                 │
                    │  │  │ Batcher │  │ Log     │  │Seg  │  │                 │
                    │  │  └─────────┘  └─────────┘  └─────┘  │                │
                    │  └──────────────────┼──────────────────┘                 │
                    └─────────────────────┼────────────────────────────────────┘
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │     Disk      │
                                  │  .log files   │
                                  └───────────────┘
```

## The Four Layers

JAR is built in four clean layers. Each layer only talks to the one directly below it.

### Layer 1: Transport (Network I/O)

**What it does:** Accepts TCP connections, manages connection lifecycle, handles graceful shutdown.

**Components:**
- `mqtt.Server` — A generic TCP server. Accepts connections, spawns a goroutine per connection, wraps the socket in buffered reader/writer, passes them to a `ConnectionHandler`.
- Connection tracking — Maintains a map of active connections for clean shutdown.
- Context propagation — Uses `context.WithCancel` so all connections drain when the server stops.

**Key insight:** The server doesn't know anything about MQTT or the custom protocol. It just hands off `bufio.Reader` and `bufio.Writer` to whatever handler you give it. This is why both protocols can share the same server code.

### Layer 2: Protocol (Message Parsing)

**What it does:** Reads raw bytes off the wire, decodes them into structured packets, and encodes responses back to bytes.

**Components:**
- `MQTTHandler` — Handles the MQTT protocol (CONNECT, PUBLISH, SUBSCRIBE, PINGREQ, DISCONNECT)
- `BrokerHandler` — Handles the custom binary protocol (PUBLISH, CONSUME, COMMIT, FETCH_OFFSET)
- Packet codec — `DecodeConnect`, `DecodePublish`, `DecodeSubscribe`, `EncodeConnack`, `EncodePuback`, etc.

**MQTT Handler** owns:
- A **topic trie** for wildcard subscription matching
- A **client map** (clientID → connection state)
- **Session management** — restoring subscriptions on reconnect
- **Inflight window** — tracking unacknowledged QoS 1 messages

### Layer 3: Broker (Business Logic)

**What it does:** Manages topics, routes messages to partitions, tracks consumer offsets, persists sessions.

**Components:**
- `Broker` — Top-level orchestrator. Holds the topic map, consumer manager, and session store.
- `Topic` — Owns N partitions (each backed by a Batcher). Routes publishes via `hash(key) % N`.
- `ConsumerManager` — Maps `group:topic:partition` → offset. Persists to its own commit log for crash recovery.
- `SessionStore` — Maps `clientID` → list of subscriptions. Also backed by a commit log.

### Layer 4: Storage (Commit Log Engine)

**What it does:** Durably stores messages on disk. Provides append and read-by-offset operations.

**Components:**
- `Batcher` — Buffers writes and calls `fsync` periodically (every N writes or every M milliseconds), not on every append. This is the performance optimization layer.
- `Log` — Manages a sequence of segments. Handles rotation (creating new segments when the current one is full). Translates global offsets to local (segment, localOffset) pairs.
- `Segment` — A single file on disk. Appends records, reads by local offset, rebuilds its position index on startup.
- `Record` — The encoding format: `[length 4B][CRC32 4B][payload NB]`.

---

## Message Flow: Publish (MQTT Client → Disk)

Here's exactly what happens when an MQTT client publishes a message:

```
1. Client sends MQTT PUBLISH packet over TCP
         │
         ▼
2. Server goroutine reads bytes from bufio.Reader
         │
         ▼
3. ReadFixedHeader() decodes packet type + remaining length
         │
         ▼
4. DecodePublish() extracts: topic, payload, QoS, packetID
         │
         ▼
5. MQTTHandler maps MQTT topic → broker topic name
         │
         ▼
6. broker.Publish(topic, key=nil, value=payload)
         │
         ▼
7. Topic.selectPartition(key) → hash(key) % N  (or round-robin if nil)
         │
         ▼
8. partitions[p].Append(payload)  (Batcher)
         │
         ▼
9. Batcher passes to Log.Append(data)
         │
         ▼
10. Log writes to active segment; rotates if segment is full
         │
         ▼
11. Segment.Append(): Encode → file.Write → update positions[]
         │
         ▼
12. Batcher increments pending count; if >= maxPending → fsync
         │
         ▼
13. Returns (partition, globalOffset) up the stack
         │
         ▼
14. If QoS 1: MQTTHandler sends PUBACK to client
         │
         ▼
15. MQTTHandler calls trie.Match(topic) → find all subscribers
         │
         ▼
16. For each subscriber: send message to their buffered channel
```

## Message Flow: Subscribe + Receive

```
1. Client sends MQTT SUBSCRIBE packet with topic filter (e.g., "sensors/+/temp")
         │
         ▼
2. MQTTHandler registers a Subscriber in the topic trie at that filter path
         │
         ▼
3. Sends SUBACK to confirm subscription
         │
         ▼
4. (Later) A publisher publishes to "sensors/room1/temp"
         │
         ▼
5. trie.Match("sensors/room1/temp") walks the trie:
   - "sensors" → exact match, go deeper
   - "+" → wildcard match at level 2, go deeper
   - "temp" → exact match → collect subscribers at this leaf
         │
         ▼
6. Each matching subscriber's Deliver() function is called
         │
         ▼
7. Deliver() puts the message on the subscriber's buffered channel
         │
         ▼
8. The subscriber's goroutine reads from the channel, encodes an MQTT PUBLISH packet, writes to TCP
```

## Message Flow: Custom Protocol (Pull-Based Consume)

```
1. jarctl connects to :2708, sends a CONSUME frame:
   [frameLen 4B][cmd=0x02][topicLen 2B][topic][partition 4B][offset 8B]
         │
         ▼
2. BrokerHandler.handleConsume() parses the frame
         │
         ▼
3. broker.Consume(topic, partition, offset)
         │
         ▼
4. Topic.Read(partition, offset) → Batcher.Read(offset) → Log.Read(offset)
         │
         ▼
5. Log.findSegment(offset): linear scan of segments to find which one contains this offset
         │
         ▼
6. Segment.Read(localOffset): lookup positions[localOffset] → file position → Decode record
         │
         ▼
7. Returns payload up the stack
         │
         ▼
8. BrokerHandler sends response: [frameLen 4B][status=0x00][payload]
```

## Crash Recovery

When JAR starts up, it rebuilds all in-memory state from disk:

```
Startup sequence:
  1. Load config (TOML file + env var overrides)
  2. Open Broker:
     a. Open ConsumerManager:
        - Open its commit log (in __consumer_offsets/)
        - Rebuild the offset map by reading every record from offset 0 → end
     b. Open SessionStore:
        - Open its commit log (in __client_sessions/)
        - Rebuild session map by replaying all records
  3. Open each Topic:
     a. For each partition directory:
        - Open Log → scan for .log files, sort by name, open each as a Segment
        - Each Segment.Rebuild(): scan file, rebuild positions[] array from record headers
        - Wrap in Batcher (starts flush goroutine)
  4. Create default topic if configured
  5. Start servers (MQTT, Custom, Admin)
```

**Why this works:** Every piece of mutable state (messages, consumer offsets, sessions) is backed by a commit log. The in-memory structures (maps, slices) are just caches — they're rebuilt by replaying the log from the beginning. This is the core insight of log-based systems.

## Concurrency Model

```
Main goroutine
  │
  ├── MQTT Server accept loop
  │     ├── goroutine: client-1 (read loop)
  │     ├── goroutine: client-2 (read loop)
  │     └── ...
  │
  ├── Custom Server accept loop
  │     ├── goroutine: jarctl-1 (read loop)
  │     └── ...
  │
  ├── Admin HTTP server (net/http handles goroutines internally)
  │
  └── Per-partition Batcher flush goroutines (one per partition)
        ├── partition-0 flush ticker
        ├── partition-1 flush ticker
        └── ...
```

**Synchronization:**
- `Segment` — `sync.Mutex` protects file writes and position updates
- `Log` — `sync.RWMutex` allows concurrent reads, exclusive writes
- `Topic` — `sync.RWMutex` protects partition selection
- `Broker` — `sync.RWMutex` protects the topic map
- `ConsumerManager` — `sync.RWMutex` protects the offset map
- `TopicTrie` — `sync.RWMutex` protects subscription tree
- **Fan-out** — Buffered channels per subscriber (no lock contention on delivery)

## Data Directory Layout

```
data/
├── default/                          # Topic "default"
│   ├── 0/                            # Partition 0
│   │   ├── 00000000000000000000.log  # Segment starting at offset 0
│   │   └── 00000000000000000042.log  # Segment starting at offset 42
│   ├── 1/                            # Partition 1
│   │   └── 00000000000000000000.log
│   ├── 2/
│   │   └── 00000000000000000000.log
│   └── 3/
│       └── 00000000000000000000.log
├── sensors/                          # Topic "sensors"
│   └── 0/
│       └── 00000000000000000000.log
├── __consumer_offsets/               # Internal: committed offsets
│   └── 00000000000000000000.log
└── __client_sessions/                # Internal: MQTT session state
    └── 00000000000000000000.log
```

## Graceful Shutdown

```
1. SIGINT or SIGTERM received
         │
         ▼
2. Stop MQTT server:
   - Cancel context → all connection goroutines return
   - Close listener → stop accepting new connections
   - Close all tracked connections
   - WaitGroup.Wait() → block until all goroutines exit
         │
         ▼
3. Stop Custom Protocol server (same pattern)
         │
         ▼
4. Stop Admin server (http.Server.Shutdown)
         │
         ▼
5. Broker.Close():
   - ConsumerManager.Close() → flush + close its log
   - SessionStore.Close() → flush + close its log
   - For each topic: close all partition batchers
     - Batcher.Close(): signal flush goroutine to stop, wait, flush pending, close log
     - Log.Close(): close all segment files
         │
         ▼
6. "shutdown complete" logged. Process exits.
```
