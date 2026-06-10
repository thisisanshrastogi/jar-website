# Broker

The broker is the central coordination layer of JAR. It sits between the protocol handlers (MQTT, custom protocol) and the storage engine (commit log). It manages topics, routes messages to partitions, tracks consumer progress, and persists session state.

---

## Topics

A **topic** is a named channel for messages. Think of it like a mailbox label — producers publish to a topic name, and consumers subscribe to that same name to receive messages.

```
Example topics:
  "sensors/temperature"
  "events/user-signup"
  "logs/application"
```

### What a topic owns

Each topic contains one or more **partitions**. A partition is an independent commit log (backed by a Batcher).

```
Topic "sensors" (4 partitions):
  ├── partition 0  →  Batcher → Log → Segments on disk
  ├── partition 1  →  Batcher → Log → Segments on disk
  ├── partition 2  →  Batcher → Log → Segments on disk
  └── partition 3  →  Batcher → Log → Segments on disk
```

### Topic creation

Topics are created explicitly via:
- The broker's `CreateTopic(name, numPartitions)` method
- The admin HTTP API (`POST /api/topics`)
- Auto-creation on MQTT subscribe (if `auto_create = true` in config)

Each partition gets its own directory on disk:
```
data/sensors/0/   ← partition 0's segment files
data/sensors/1/   ← partition 1's segment files
data/sensors/2/
data/sensors/3/
```

---

## Partitions: The Unit of Parallelism

### Why partition at all?

A single log file can only be written to by one goroutine at a time (the lock prevents corruption). If you have 10,000 messages/sec, that one lock becomes a bottleneck.

Partitions solve this: split the topic into N independent logs. Each can be written to and read from concurrently without contention.

```
10,000 msgs/sec with 4 partitions:
  Partition 0: ~2,500 msgs/sec  ← independent lock
  Partition 1: ~2,500 msgs/sec  ← independent lock
  Partition 2: ~2,500 msgs/sec  ← independent lock
  Partition 3: ~2,500 msgs/sec  ← independent lock
```

### Partition routing (how messages pick a partition)

When a message is published, JAR decides which partition receives it:

**With a key:**
```
partition = hash(key) % numPartitions

Example:
  key = "room-1"
  FNV32a("room-1") = 2847593821
  2847593821 % 4 = 1  → goes to partition 1

  All messages with key "room-1" ALWAYS go to partition 1.
  This guarantees ordering for the same key.
```

**Without a key (key = nil):**
```
partition = counter % numPartitions
counter++

Messages are distributed round-robin across all partitions.
No ordering guarantee, but load is evenly spread.
```

### Why this matters

- **Same key → same partition → guaranteed order.** If sensor "room-1" sends temperature readings, they arrive in order because they all go to the same partition.
- **Different keys → different partitions → parallel processing.** Multiple consumers can each read from a different partition simultaneously.

---

## Consumer Manager: Tracking Progress

### The problem

A consumer reads messages from a partition starting at some offset. If it disconnects and reconnects, where does it resume? It needs to remember "I've processed up to offset 47."

### The solution: committed offsets

The **Consumer Manager** maintains a mapping:

```
group:topic:partition  →  last committed offset

Example:
  "analytics:sensors:0"  →  47
  "analytics:sensors:1"  →  23
  "dashboard:sensors:0"  →  50
```

- **group** — A label for the consumer (e.g., "analytics-service")
- **topic** — Which topic
- **partition** — Which partition
- **offset** — "I've processed everything up to and including this offset"

### How commit works

```
1. Consumer reads offset 47 from partition 0
2. Consumer processes the message successfully
3. Consumer calls CommitOffset("analytics", "sensors", 0, 47)
4. ConsumerManager:
   a. Updates in-memory map: "analytics:sensors:0" → 47
   b. Appends to its own commit log (for durability):
      [groupLen 2B][group][topicLen 2B][topic][partition 4B][offset 8B]
```

### How fetch works

```
1. Consumer reconnects after a crash
2. Calls FetchOffset("analytics", "sensors", 0)
3. ConsumerManager looks up "analytics:sensors:0" in memory → returns 47
4. Consumer resumes reading from offset 48
```

### Crash recovery for offsets

The Consumer Manager has its own commit log at `data/__consumer_offsets/`. On startup:

```
Rebuild:
  Read every record from offset 0 to end:
    For each record: decode group/topic/partition/offset → update the map

  The map reflects the latest committed offset for every consumer.
  (Later commits overwrite earlier ones for the same key.)
```

### Consumer groups

Different consumer groups are completely independent. If "analytics" has committed offset 47 and "dashboard" has committed offset 50 for the same partition, each tracks its own position. They read the same data but at their own pace.

```
  Topic "sensors", Partition 0:

  offset: 0  1  2  3  ... 47 48 49 50 51 52
                              ^           ^
                              │           │
                    analytics (here)    dashboard (here)
```

---

## Session Store: Remembering MQTT Clients

### The problem

In MQTT, a client can set `CleanSession = false` when connecting. This means: "If I disconnect and come back, I want my subscriptions to still be there." The broker must remember which topics each client was subscribed to.

### The solution

The **Session Store** persists client subscriptions to a commit log at `data/__client_sessions/`.

```
sessions map:
  "sensor-01"  →  ["home/temp", "home/humidity"]
  "dashboard"  →  ["home/#"]
```

### Record format

```
[clientIDLen 2B][clientID][numSubs 2B][sub1Len 2B][sub1][sub2Len 2B][sub2]...
```

### Lifecycle

```
1. Client connects with CleanSession=false, clientID="sensor-01"
2. Client subscribes to "home/temp"
3. SessionStore.Save("sensor-01", ["home/temp"]) → appends to log
4. Client disconnects
5. (time passes)
6. Client reconnects with same clientID
7. SessionStore.Load("sensor-01") → ["home/temp"]
8. MQTT handler re-subscribes the client to "home/temp" automatically
```

### Deletion

When a client connects with `CleanSession=true`, any previous session is removed:
```
SessionStore.Delete("sensor-01")
  → appends a record with empty subscription list
  → on rebuild, empty list = delete from map
```

---

## Broker API

The Broker exposes these operations to the protocol handlers:

| Method | Purpose |
|--------|---------|
| `CreateTopic(name, partitions)` | Create a new topic with N partitions |
| `DeleteTopic(name)` | Remove a topic and close its logs |
| `Publish(topic, key, value)` | Append a message; returns (partition, offset) |
| `Consume(topic, partition, offset)` | Read one message at a specific position |
| `CommitOffset(group, topic, partition, offset)` | Save consumer progress |
| `FetchOffset(group, topic, partition)` | Get last committed offset |
| `SaveSession(clientID, subs)` | Persist MQTT session |
| `LoadSession(clientID)` | Retrieve saved session |
| `DeleteSession(clientID)` | Remove session data |
| `ListTopics()` | List all topics with partition counts |
| `GetTopicDetail(name)` | Get latest offsets per partition |
| `ListOffsets()` | Get all committed consumer offsets |
| `ListSessions()` | Get all stored sessions |

### What the Broker does NOT do

- **Protocol parsing** — That's the MQTT Handler's job
- **Wire encoding** — That's the protocol layer
- **Disk I/O directly** — That's delegated to the commit log
- **Fan-out to subscribers** — That's the MQTT Handler's trie + channels

The broker is purely about *data management*: where to store, where to find, what state to track.

---

## Putting It Together

Here's how a Publish flows through the broker:

```
broker.Publish("sensors", key=[]byte("room-1"), value=[]byte("temp=22"))
  │
  ├── Lock topic map (RLock — concurrent reads OK)
  ├── Look up topic "sensors" → found
  ├── topic.Publish(key, value)
  │     ├── selectPartition(key):
  │     │     FNV32a("room-1") % 4 = 1
  │     ├── partitions[1].Append(value)  ← Batcher
  │     │     ├── log.Append(value)      ← Log
  │     │     │     ├── activeSegment.Append(Encode(value))  ← Segment
  │     │     │     └── return globalOffset = base + localOffset
  │     │     ├── pending++
  │     │     └── return offset
  │     └── return (partition=1, offset=X)
  └── return (1, X, nil)
```
