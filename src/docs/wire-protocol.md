# Wire Protocol

This document describes the byte-level format of both protocols JAR supports: the custom binary protocol (used by `jarctl`) and the subset of MQTT v3.1.1 that JAR implements.

---

## Custom Protocol (Port :2708)

The custom protocol is a simple length-prefixed binary protocol designed for programmatic access. It supports four commands: PUBLISH, CONSUME, COMMIT, and FETCH_OFFSET.

### Frame Format

Every message (request or response) is wrapped in a frame:

```
┌──────────────────────────────────────────────┐
│                    Frame                      │
├────────────────┬─────────────────────────────┤
│  Frame Length  │           Payload            │
│   (4 bytes)    │         (N bytes)            │
└────────────────┴─────────────────────────────┘
     │                      │
     │                      └── The actual command or response data
     └── Big-endian uint32: how many bytes follow
```

The first byte of the payload is the **command byte** (for requests) or **status byte** (for responses).

### Command Bytes

| Command | Byte | Direction |
|---------|------|-----------|
| PUBLISH | `0x01` | Client → Server |
| CONSUME | `0x02` | Client → Server |
| COMMIT | `0x03` | Client → Server |
| FETCH_OFFSET | `0x04` | Client → Server |

### Status Bytes

| Status | Byte | Meaning |
|--------|------|---------|
| OK | `0x00` | Success |
| ERROR | `0x01` | Failure (followed by error message) |

---

### PUBLISH Request

Writes a message to a topic.

```
Frame payload:
┌──────┬───────────┬───────┬──────────┬─────┬──────────────┐
│ Cmd  │ TopicLen  │ Topic │  KeyLen  │ Key │    Value     │
│ 0x01 │ (2 bytes) │ (var) │ (2 bytes)│(var)│   (rest)     │
└──────┴───────────┴───────┴──────────┴─────┴──────────────┘
```

| Field | Size | Encoding | Description |
|-------|------|----------|-------------|
| Cmd | 1 | `0x01` | PUBLISH command |
| TopicLen | 2 | Big-endian uint16 | Length of topic name |
| Topic | TopicLen | UTF-8 string | Topic to publish to |
| KeyLen | 2 | Big-endian uint16 | Length of partition key (0 = no key) |
| Key | KeyLen | Raw bytes | Partition routing key |
| Value | remaining | Raw bytes | Message payload |

### PUBLISH Response

```
Success:
┌────────┬───────────┬────────────┐
│ Status │ Partition │   Offset   │
│  0x00  │ (4 bytes) │  (8 bytes) │
└────────┴───────────┴────────────┘

Error:
┌────────┬────────────────────┐
│ Status │   Error Message    │
│  0x01  │   (rest, UTF-8)    │
└────────┴────────────────────┘
```

---

### CONSUME Request

Reads one message at a specific offset.

```
Frame payload:
┌──────┬───────────┬───────┬───────────┬────────────┐
│ Cmd  │ TopicLen  │ Topic │ Partition │   Offset   │
│ 0x02 │ (2 bytes) │ (var) │ (4 bytes) │  (8 bytes) │
└──────┴───────────┴───────┴───────────┴────────────┘
```

| Field | Size | Encoding | Description |
|-------|------|----------|-------------|
| Cmd | 1 | `0x02` | CONSUME command |
| TopicLen | 2 | Big-endian uint16 | Length of topic name |
| Topic | TopicLen | UTF-8 string | Topic to read from |
| Partition | 4 | Big-endian uint32 | Partition number |
| Offset | 8 | Big-endian uint64 | Global offset to read |

### CONSUME Response

```
Success:
┌────────┬────────────────────┐
│ Status │      Payload       │
│  0x00  │    (rest, raw)     │
└────────┴────────────────────┘

Error:
┌────────┬────────────────────┐
│ Status │   Error Message    │
│  0x01  │   (rest, UTF-8)    │
└────────┴────────────────────┘
```

---

### COMMIT Request

Saves consumer progress (committed offset).

```
Frame payload:
┌──────┬───────────┬───────┬───────────┬───────┬───────────┬────────────┐
│ Cmd  │ GroupLen  │ Group │ TopicLen  │ Topic │ Partition │   Offset   │
│ 0x03 │ (2 bytes) │ (var) │ (2 bytes) │ (var) │ (4 bytes) │  (8 bytes) │
└──────┴───────────┴───────┴───────────┴───────┴───────────┴────────────┘
```

| Field | Size | Encoding | Description |
|-------|------|----------|-------------|
| Cmd | 1 | `0x03` | COMMIT command |
| GroupLen | 2 | Big-endian uint16 | Length of consumer group name |
| Group | GroupLen | UTF-8 string | Consumer group identifier |
| TopicLen | 2 | Big-endian uint16 | Length of topic name |
| Topic | TopicLen | UTF-8 string | Topic name |
| Partition | 4 | Big-endian uint32 | Partition number |
| Offset | 8 | Big-endian uint64 | Offset to commit |

### COMMIT Response

```
Success:
┌────────┐
│ Status │
│  0x00  │
└────────┘

Error:
┌────────┬────────────────────┐
│ Status │   Error Message    │
│  0x01  │   (rest, UTF-8)    │
└────────┴────────────────────┘
```

---

### FETCH_OFFSET Request

Retrieves the last committed offset for a consumer.

```
Frame payload:
┌──────┬───────────┬───────┬───────────┬───────┬───────────┐
│ Cmd  │ GroupLen  │ Group │ TopicLen  │ Topic │ Partition │
│ 0x04 │ (2 bytes) │ (var) │ (2 bytes) │ (var) │ (4 bytes) │
└──────┴───────────┴───────┴───────────┴───────┴───────────┘
```

### FETCH_OFFSET Response

```
Success:
┌────────┬────────────┐
│ Status │   Offset   │
│  0x00  │  (8 bytes) │
└────────┴────────────┘

Error:
┌────────┬────────────────────┐
│ Status │   Error Message    │
│  0x01  │   (rest, UTF-8)    │
└────────┴────────────────────┘
```

---

## MQTT v3.1.1 Protocol (Port :2707)

JAR implements a subset of MQTT v3.1.1 as defined in the [OASIS specification](http://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).

### Fixed Header (all packets)

```
Byte 1:
┌─────────────────────┬──────────────────┐
│  Packet Type (4 bit)│   Flags (4 bit)  │
└─────────────────────┴──────────────────┘
  Bits 7-4               Bits 3-0

Bytes 2-5: Remaining Length (variable, 1-4 bytes)
```

**Remaining length encoding:**

Each byte contributes 7 bits of value. The high bit (0x80) means "another byte follows."

```
Length 64:     → [0x40]                    (1 byte, high bit = 0)
Length 321:    → [0xC1, 0x02]              (321 = 65 + 2*128)
Max (256 MB):  → [0xFF, 0xFF, 0xFF, 0x7F]  (4 bytes)
```

### Packet Types Implemented

| Type | Value | Direction | Description |
|------|-------|-----------|-------------|
| CONNECT | 1 | Client → Server | Initiate connection |
| CONNACK | 2 | Server → Client | Connection acknowledgement |
| PUBLISH | 3 | Both | Publish a message |
| PUBACK | 4 | Both | QoS 1 acknowledgement |
| SUBSCRIBE | 8 | Client → Server | Subscribe to topics |
| SUBACK | 9 | Server → Client | Subscribe acknowledgement |
| UNSUBSCRIBE | 10 | Client → Server | Unsubscribe from topics |
| UNSUBACK | 11 | Server → Client | Unsubscribe acknowledgement |
| PINGREQ | 12 | Client → Server | Heartbeat request |
| PINGRESP | 13 | Server → Client | Heartbeat response |
| DISCONNECT | 14 | Client → Server | Clean disconnect |

---

### CONNECT Packet

```
Fixed Header: [0x10][remaining length]

Variable Header:
┌──────────────────────────────────────────────────────────────────────┐
│ Protocol Name Length (2B) │ "MQTT" (4B) │ Protocol Level (1B) = 0x04│
├──────────────────────────────────────────────────────────────────────┤
│                    Connect Flags (1 byte)                             │
│  ┌────┬────┬──────────┬──────────┬────────┬──────────────┬─────────┐│
│  │Usr │Pwd │WillRetain│ WillQoS  │HasWill │CleanSession  │Reserved ││
│  │Bit7│Bit6│  Bit5    │Bits 4-3  │ Bit2   │   Bit1       │  Bit0   ││
│  └────┴────┴──────────┴──────────┴────────┴──────────────┴─────────┘│
├──────────────────────────────────────────────────────────────────────┤
│                    Keep Alive (2 bytes, big-endian)                    │
└──────────────────────────────────────────────────────────────────────┘

Payload (in this order, presence determined by flags):
  1. Client ID        [length 2B][string]     ← always present
  2. Will Topic       [length 2B][string]     ← if HasWill
  3. Will Message     [length 2B][bytes]      ← if HasWill
  4. Username         [length 2B][string]     ← if HasUsername
  5. Password         [length 2B][string]     ← if HasPassword
```

### CONNACK Packet

```
Fixed Header: [0x20][0x02]

Variable Header (2 bytes):
┌──────────────────────┬────────────────────┐
│ Session Present (1B) │  Return Code (1B)  │
└──────────────────────┴────────────────────┘

Return codes:
  0x00 = Connection accepted
  0x01 = Unacceptable protocol version
  0x02 = Client ID rejected
  0x03 = Server unavailable
  0x04 = Bad credentials
  0x05 = Not authorized
```

---

### PUBLISH Packet

```
Fixed Header:
  Byte 1: [0x3X] where X encodes flags:
    Bit 3: DUP (duplicate delivery)
    Bits 2-1: QoS (0, 1, or 2)
    Bit 0: RETAIN

Variable Header:
┌───────────────────────────┬─────────────────┐
│ Topic Name [len 2B][str]  │ Packet ID (2B)  │  ← Packet ID only if QoS > 0
└───────────────────────────┴─────────────────┘

Payload: raw message bytes (remaining length - variable header size)
```

**Example: QoS 1 publish to "sensors/temp" with payload "22.5":**

```
Hex: 32 12 00 0C 73 65 6E 73 6F 72 73 2F 74 65 6D 70 00 01 32 32 2E 35
     ││ ││ └──┬──┘ └──────────── topic ────────────────┘ └─┬─┘ └─ payload ─┘
     ││ ││    │                                             │
     ││ ││    └── topic length = 12                         └── packetID = 1
     ││ └└── remaining length = 18
     │└── flags: DUP=0, QoS=1, RETAIN=0
     └── packet type = 3 (PUBLISH)
```

### PUBACK Packet

```
Fixed Header: [0x40][0x02]
Variable Header: [Packet ID (2 bytes, big-endian)]
```

---

### SUBSCRIBE Packet

```
Fixed Header: [0x82][remaining length]
  (flags MUST be 0x02 for SUBSCRIBE per spec)

Variable Header:
┌─────────────────────┐
│  Packet ID (2B)     │
└─────────────────────┘

Payload (repeated for each subscription):
┌───────────────────────────┬──────────┐
│ Topic Filter [len 2B][str]│ QoS (1B) │
└───────────────────────────┴──────────┘
```

### SUBACK Packet

```
Fixed Header: [0x90][remaining length]
Variable Header: [Packet ID (2B)]
Payload: one byte per subscription — granted QoS (0, 1, 2) or 0x80 (rejected)
```

---

### UNSUBSCRIBE Packet

```
Fixed Header: [0xA2][remaining length]
Variable Header: [Packet ID (2B)]
Payload (repeated):
┌───────────────────────────┐
│ Topic Filter [len 2B][str]│
└───────────────────────────┘
```

### UNSUBACK Packet

```
Fixed Header: [0xB0][0x02]
Variable Header: [Packet ID (2B)]
```

---

### PINGREQ / PINGRESP

```
PINGREQ:  [0xC0][0x00]   (2 bytes total, no payload)
PINGRESP: [0xD0][0x00]   (2 bytes total, no payload)
```

### DISCONNECT

```
DISCONNECT: [0xE0][0x00]  (2 bytes total, no payload)
```

---

## Internal Storage Formats

### Consumer Offset Record (in `__consumer_offsets/`)

```
┌───────────┬───────┬───────────┬───────┬───────────┬────────────┐
│ GroupLen  │ Group │ TopicLen  │ Topic │ Partition │   Offset   │
│ (2 bytes) │ (var) │ (2 bytes) │ (var) │ (4 bytes) │  (8 bytes) │
└───────────┴───────┴───────────┴───────┴───────────┴────────────┘
```

### Session Record (in `__client_sessions/`)

```
┌────────────┬──────────┬──────────┬────────────────────────────────────────┐
│ ClientIDLen│ ClientID │ NumSubs  │ [Sub1Len][Sub1][Sub2Len][Sub2]...      │
│  (2 bytes) │  (var)   │ (2 bytes)│                                        │
└────────────┴──────────┴──────────┴────────────────────────────────────────┘
```

---

## What's NOT Implemented

| MQTT Feature | Status | Reason |
|---|---|---|
| QoS 2 (exactly once) | Skipped | Complex 4-step handshake (PUBREC/PUBREL/PUBCOMP), rarely needed |
| Retained messages | Not yet | Would require log compaction (keep latest per topic) |
| Will messages | Parsed but not acted on | Needs delayed publish on unclean disconnect |
| Keep-alive timeout disconnect | Not yet | Timer per connection needed |
| Topic name validation | Minimal | No checks for empty levels or `#` in middle |
| Auth (username/password) | Parsed but ignored | No auth backend wired up |
