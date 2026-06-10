# Operations

How to configure, run, and manage JAR in development and production.

---

## Configuration

JAR uses a TOML configuration file with sensible defaults. If no config file is specified, built-in defaults are used. Environment variables override file settings (useful for containers).

### Loading Priority

```
1. Built-in defaults (always present)
2. TOML config file (if --config flag provided)
3. Environment variables (override everything)
```

### Running with Config

```bash
# Use defaults (no config file needed)
./jar

# Specify config file
./jar --config configs/jar.toml

# Override with environment variables
JAR_DATA_DIR=/mnt/ssd/jar JAR_MQTT_ADDR=:1883 ./jar
```

---

### Full Configuration Reference

```toml
[server]
data_dir = "./data"              # Where all data is stored on disk
mqtt_addr = ":2707"              # MQTT server listen address
custom_addr = ":2708"            # Custom protocol listen address
admin_addr = ":8080"             # Admin HTTP panel address
max_connections = 10000          # Max concurrent TCP connections
log_level = "info"               # Log level: debug, info, warn, error
mqtt_server = true               # Enable/disable MQTT server
custom_server = true             # Enable/disable custom protocol server
admin_server = true              # Enable/disable admin HTTP panel

[storage]
max_segment_bytes = 1073741824   # 1 GB — max segment file size before rotation
internal_log_segment_bytes = 67108864  # 64 MB — segment size for internal logs
batch_max_pending = 100          # Flush after this many writes
batch_flush_interval = "5ms"     # Flush at least this often
retention_max_bytes = 0          # Max total log size (0 = unlimited)
retention_max_age = "0s"         # Max message age (0 = keep forever)

[mqtt]
backpressure_buffer = 256        # Per-subscriber channel buffer size
default_replay_qos = 1           # QoS for replayed messages on reconnect
keep_alive_timeout = "60s"       # Disconnect idle clients after this
persistent_sessions = true       # Remember subscriptions across reconnects
max_inflight = 100               # Max unacknowledged messages per client

[topics]
default_name = "default"         # Topic created on startup
default_partitions = 4           # Partitions for the default topic
auto_create_partitions = 1       # Partitions for auto-created topics
auto_create = true               # Create topics on MQTT subscribe if missing
```

### Environment Variables

| Variable | Overrides | Example |
|----------|-----------|---------|
| `JAR_DATA_DIR` | `server.data_dir` | `/var/lib/jar` |
| `JAR_MQTT_ADDR` | `server.mqtt_addr` | `:1883` |
| `JAR_CUSTOM_ADDR` | `server.custom_addr` | `:9092` |
| `JAR_MAX_SEGMENT_BYTES` | `storage.max_segment_bytes` | `536870912` |

---

## Admin HTTP API

The admin panel runs on `:8080` by default. It provides both a web dashboard and a JSON API.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Web dashboard (embedded HTML) |
| GET | `/api/health` | Health check |
| GET | `/api/stats` | Overview: topic count, partition count, connection count |
| GET | `/api/topics` | List all topics with partition counts |
| POST | `/api/topics` | Create a new topic |
| GET | `/api/topics/:name` | Topic detail: partitions, latest offsets |
| DELETE | `/api/topics/:name` | Delete a topic |
| GET | `/api/clients` | List connected MQTT clients |
| GET | `/api/offsets` | List all committed consumer offsets |
| GET | `/api/sessions` | List all persisted client sessions |
| POST | `/api/publish` | Publish a message via HTTP |

### API Examples

**Health check:**
```bash
curl http://localhost:8080/api/health
# {"status":"ok"}
```

**List topics:**
```bash
curl http://localhost:8080/api/topics
# [{"name":"default","partitions":4},{"name":"sensors","partitions":2}]
```

**Create a topic:**
```bash
curl -X POST http://localhost:8080/api/topics \
  -H "Content-Type: application/json" \
  -d '{"name":"events","partitions":8}'
# {"status":"created"}
```

**Get topic detail (latest offsets per partition):**
```bash
curl http://localhost:8080/api/topics/default
# {"name":"default","partitions":4,"latest_offsets":[42,17,23,8]}
```

**Delete a topic:**
```bash
curl -X DELETE http://localhost:8080/api/topics/events
# {"status":"deleted"}
```

**Publish a message via HTTP:**
```bash
curl -X POST http://localhost:8080/api/publish \
  -H "Content-Type: application/json" \
  -d '{"topic":"sensors","key":"room-1","value":"temp=22.5"}'
# {"partition":1,"offset":47}
```

**List connected clients:**
```bash
curl http://localhost:8080/api/clients
# [{"client_id":"sensor-01","connected_at":"..."},...]
```

**List consumer offsets:**
```bash
curl http://localhost:8080/api/offsets
# [{"group":"analytics","topic":"sensors","partition":0,"offset":47},...]
```

**List sessions:**
```bash
curl http://localhost:8080/api/sessions
# {"sensor-01":["home/temp","home/humidity"],"dashboard":["home/#"]}
```

---

## Data Directory

All persistent state lives under `data_dir` (default: `./data`):

```
data/
├── <topic-name>/
│   ├── 0/                            # Partition 0
│   │   ├── 00000000000000000000.log  # Segment files
│   │   └── 00000000000000000042.log
│   ├── 1/                            # Partition 1
│   │   └── 00000000000000000000.log
│   └── .../
├── __consumer_offsets/               # Internal: committed offsets
│   └── 00000000000000000000.log
└── __client_sessions/                # Internal: MQTT session state
    └── 00000000000000000000.log
```

### Disk usage estimation

Each message on disk = 8 bytes (header) + payload size.

Example: 1 million messages at 100 bytes average payload:
```
(8 + 100) × 1,000,000 = 108 MB
```

Internal logs (__consumer_offsets, __client_sessions) are typically small — a few MB unless you have thousands of consumers committing frequently.

---

## Structured Logging

JAR uses Go's `log/slog` for structured logging. Output is key-value pairs, machine-parseable.

### Log Levels

| Level | What's logged |
|-------|---------------|
| `debug` | Connection events, packet parsing details, offset commits |
| `info` | Startup, topic creation, client connect/disconnect |
| `warn` | No protocols enabled, slow consumers, approaching limits |
| `error` | Failed writes, connection errors, corrupt records |

### Example output

```
level=INFO msg="JAR broker running" mqtt_addr=:2707
level=INFO msg="custom protocol listening" addr=:2708
level=INFO msg="admin panel listening" addr=:8080
level=INFO msg="topic created via admin" name=sensors partitions=4
level=INFO msg="shutdown complete"
```

Set the level in config:
```toml
[server]
log_level = "debug"   # debug | info | warn | error
```

---

## Graceful Shutdown

JAR handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:

1. Stops accepting new connections
2. Closes all existing connections (in-flight requests may be dropped)
3. Flushes all pending batched writes to disk
4. Closes all segment files
5. Logs "shutdown complete" and exits

**Data safety:** Any message that received a PUBACK is guaranteed to survive a graceful shutdown. Messages that were accepted but not yet flushed (within the batch window) are also flushed during shutdown.

**Hard kill (SIGKILL):** Up to `batch_flush_interval` (default 5ms) of messages may be lost. The commit log's crash recovery (segment rebuild) handles any partial writes on next startup.

---

## Using jarctl (Custom Protocol CLI)

`jarctl` is the CLI client for the custom pull protocol. It connects to `:2708` and issues raw protocol commands.

```bash
# Build jarctl
go build -o jarctl ./cmd/jarctl

# Publish
jarctl publish --topic sensors --key room-1 --value "temp=22.5"

# Consume from specific offset
jarctl consume --topic sensors --partition 0 --offset 0

# Commit an offset
jarctl commit --group analytics --topic sensors --partition 0 --offset 47

# Fetch last committed offset
jarctl fetch-offset --group analytics --topic sensors --partition 0
```

---

## Ports Summary

| Port | Protocol | Purpose |
|------|----------|---------|
| 2707 | MQTT v3.1.1 (TCP) | Standard MQTT clients |
| 2708 | Custom binary (TCP) | jarctl, programmatic replay |
| 8080 | HTTP | Admin dashboard + REST API |

All ports are configurable via the config file or environment variables.
