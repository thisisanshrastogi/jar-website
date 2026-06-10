# MQTT Handler

The MQTT Handler bridges the MQTT protocol world with JAR's internal broker. It accepts standard MQTT v3.1.1 clients, parses their packets, manages subscriptions via a trie, handles QoS delivery guarantees, and maintains persistent sessions.

---

## Overview

The MQTT Handler owns three things:

```
┌─────────────────────────────────────────────────────┐
│                  MQTT Handler                         │
│                                                      │
│   ┌───────────┐  ┌──────────────┐  ┌────────────┐  │
│   │Topic Trie │  │ Client Map   │  │  Broker    │  │
│   │(wildcard  │  │ (clientID →  │  │  (publish, │  │
│   │ matching) │  │  connection) │  │   consume) │  │
│   └───────────┘  └──────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────┘
```

- **Topic Trie** — Data structure for matching published topics against subscription filters (including wildcards `+` and `#`)
- **Client Map** — Tracks connected clients, their state, and their delivery channels
- **Broker reference** — For persisting messages, looking up offsets, saving sessions

---

## Connection Lifecycle

When an MQTT client connects, here's what happens step by step:

```
1. TCP connection accepted by Server
         │
         ▼
2. Server spawns goroutine, calls MQTTHandler.HandleConnection(reader, writer)
         │
         ▼
3. Handler reads first packet — MUST be CONNECT
         │
         ▼
4. DecodeConnect() → extract clientID, cleanSession, keepAlive, credentials
         │
         ▼
5. If CleanSession=false AND session exists:
   - Load saved subscriptions from SessionStore
   - Re-subscribe client to all saved topics
   - Send CONNACK with sessionPresent=true
   Else:
   - Delete any old session
   - Send CONNACK with sessionPresent=false
         │
         ▼
6. Enter read loop: continuously read packets and dispatch by type
         │
         ▼
7. On DISCONNECT or connection drop:
   - Remove from client map
   - Unsubscribe from trie
   - If CleanSession=false: save subscriptions to SessionStore
```

---

## Packet Handling

The handler's read loop processes these MQTT packet types:

| Packet Type | Action |
|-------------|--------|
| CONNECT | Authenticate, set up session, send CONNACK |
| PUBLISH | Store in commit log, fan out to subscribers, PUBACK if QoS 1 |
| SUBSCRIBE | Register filters in trie, send SUBACK |
| UNSUBSCRIBE | Remove filters from trie, send UNSUBACK |
| PINGREQ | Reply with PINGRESP (keep-alive heartbeat) |
| DISCONNECT | Clean shutdown of client connection |
| PUBACK | Client acknowledging a QoS 1 message we sent them |

### MQTT Fixed Header

Every MQTT packet starts with:

```
Byte 1: [packet type (4 bits)][flags (4 bits)]
Bytes 2-5: Remaining length (variable-length encoding, 1-4 bytes)
```

The remaining length uses a variable-length encoding where the high bit of each byte indicates "more bytes follow." This allows lengths from 0 to 268,435,455 (256 MB) in 1-4 bytes.

---

## Topic Trie: Wildcard Matching

### The problem

MQTT supports wildcard subscriptions:
- `+` matches exactly one topic level: `sensors/+/temp` matches `sensors/room1/temp` and `sensors/room2/temp`
- `#` matches zero or more levels: `sensors/#` matches `sensors`, `sensors/room1`, `sensors/room1/temp`

When a message arrives on topic `sensors/room1/temp`, we need to quickly find ALL subscribers whose filters match — including those with wildcards.

### The solution: a trie (prefix tree)

Topics are split by `/` into levels. Each level becomes a node in the tree:

```
After subscribing to:
  Client A: "sensors/room1/temp"
  Client B: "sensors/+/temp"
  Client C: "sensors/#"

The trie looks like:

root
  └── "sensors"
        ├── "room1"
        │     └── "temp"  →  subscribers: [A]
        ├── "+"
        │     └── "temp"  →  subscribers: [B]
        └── "#"           →  subscribers: [C]
```

### Matching algorithm

When a message arrives on `sensors/room1/temp`, the trie walks all possible paths:

```
match(root, ["sensors", "room1", "temp"], index=0):

  1. Check for "#" child → found! Collect C. (# matches everything from here down)
  
  2. Current level = "sensors"
     - Exact match "sensors" exists → recurse: match(sensors_node, levels, index=1)
     - "+" child doesn't exist at root level → skip

  Inside sensors_node, index=1:
    1. Check for "#" child → found! Collect C.
    2. Current level = "room1"
       - Exact match "room1" exists → recurse deeper
       - "+" child exists → recurse: match(plus_node, levels, index=2)
    
    Both paths lead to "temp" at index=2 → collect A and B

Result: [A, B, C]  ← all three receive the message
```

### Why trie over flat map?

| Approach | Publish cost | Subscribe cost |
|----------|-------------|----------------|
| Flat map + linear scan | O(total subscriptions) | O(1) |
| Trie | O(topic depth) | O(topic depth) |

With 10,000 subscriptions and topics 3-4 levels deep, the trie checks ~4 nodes instead of scanning 10,000 strings.

---

## Fan-Out: Delivering to Subscribers

When a publish matches multiple subscribers, each one needs to receive the message. JAR uses per-client buffered channels:

```
Publisher goroutine:
  1. broker.Publish(topic, key, value) → (partition, offset)
  2. trie.Match(topic) → [subscriber1, subscriber2, subscriber3]
  3. For each subscriber:
       subscriber.Deliver(topic, payload, qos, offset)
         → puts message on subscriber's channel (non-blocking if space available)

Each subscriber has:
  deliveryChan: chan Message (buffered, size = backpressure_buffer, default 256)

Subscriber's write goroutine (separate):
  for msg := range deliveryChan:
    encode MQTT PUBLISH packet
    write to TCP connection
    if QoS 1: track in inflight window, wait for PUBACK
```

### Backpressure

If a subscriber is slow (maybe it's on a bad network), its channel fills up. The configurable `backpressure_buffer` (default: 256 messages) determines how many messages can queue before the publisher has to make a decision:

- **Channel full** → the slow subscriber misses messages (current behavior)
- The publisher itself is never blocked — it drops into the channel and moves on

---

## QoS Levels

### QoS 0 (At Most Once)

```
Client → PUBLISH (QoS 0) → Handler
Handler:
  1. Store in commit log
  2. Fan out to subscribers
  3. Done. No PUBACK sent to publisher.

If the message is lost in transit, nobody knows. Fire-and-forget.
```

### QoS 1 (At Least Once)

```
Publisher side:
  Client → PUBLISH (QoS 1, packetID=7) → Handler
  Handler:
    1. Store in commit log (message is durable)
    2. Fan out to subscribers
    3. Send PUBACK (packetID=7) back to publisher
    4. Publisher knows: "message 7 is safely stored"

Subscriber side:
  Handler → PUBLISH (QoS 1, packetID=N) → Subscriber
  Subscriber processes it → sends PUBACK (packetID=N) → Handler
  Handler:
    1. Remove from inflight window
    2. CommitOffset for this subscriber
```

The PUBACK on the subscriber side is where MQTT QoS meets Kafka offsets. Receiving a PUBACK means "the subscriber has processed this message" — so we advance their committed offset.

---

## Inflight Window

### The problem

If we blast 10,000 messages to a subscriber without waiting for PUBACKs, we could:
- Overwhelm the client's network buffer
- Have no idea which messages were actually received if the connection drops
- Waste memory tracking thousands of unacknowledged messages

### The solution

The **inflight window** limits how many unacknowledged messages can be "in flight" at once:

```
max_inflight = 100 (configurable)

inflight window: [msg42, msg43, msg44, ... msg141]
                  ← 100 messages awaiting PUBACK →

If window is full:
  Stop sending new messages to this subscriber.
  Wait for PUBACKs to free up slots.

When PUBACK arrives for msg42:
  Remove msg42 from window.
  Now there's room — send msg142.
```

### Inflight tracking per client

Each client session maintains:
- A map of `packetID → (topic, offset)` for messages awaiting PUBACK
- A counter for the next packetID to assign (wraps at 65535 per MQTT spec)

---

## Session Persistence

### Clean Session = true

```
Client connects: "I'm new, forget everything about me"
  → Delete any old session
  → Start fresh: no subscriptions, no inflight state
  → On disconnect: no state saved
```

### Clean Session = false

```
Client connects: "Remember me"
  → Load saved subscriptions from SessionStore
  → Re-subscribe to trie with saved filters
  → CONNACK sessionPresent=true (tells client: "I remember you")
  → On disconnect: save current subscriptions to SessionStore
```

This is how an IoT sensor can power-cycle and automatically resume receiving messages on the topics it previously subscribed to.

---

## MQTT-to-Kafka Concept Mapping

| MQTT Concept | JAR Implementation |
|---|---|
| Topic (`home/sensor/temp`) | Topic name → routed to a partition in the broker |
| Subscriber | Entry in the trie + a delivery channel + consumer offset |
| QoS 1 PUBACK (from subscriber) | Triggers offset commit for that subscriber |
| Clean Session = false | Session stored in `__client_sessions/` commit log |
| Client ID | Consumer group name for offset tracking |
| Retained message | Not yet implemented (would be latest msg in compacted partition) |

---

## Component Summary

| Component | File | Role |
|-----------|------|------|
| MQTTHandler | `mqtt_handler.go` | Orchestrates MQTT connection lifecycle, packet dispatch |
| TopicTrie | `trie.go` | Wildcard subscription matching |
| Subscriber | `trie.go` | Subscriber struct with Deliver callback |
| FixedHeader | `protocol.go` | MQTT packet header parsing |
| ConnectPacket | `connect.go` | CONNECT/CONNACK encoding and decoding |
| PublishPacket | `publish.go` | PUBLISH/PUBACK encoding and decoding |
| SubscribePacket | `subscribe.go` | SUBSCRIBE/SUBACK/UNSUBSCRIBE encoding and decoding |
