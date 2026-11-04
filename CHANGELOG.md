# Changelog

## 3.0.0-pre.1 (architecture rework)

Install with `npm install galactic.ts@next`. The wire protocol message types are unchanged from
2.1.x.

### Migrating `new EventManager(send, on, request)`

This is the only source-level break in GalaxyBot and GalaxyBridge (both `WhitelabelInstance`s).
Pass a transport and register the handlers afterwards:

```ts
// net-ipc Client side
const eventManager = new EventManager(new NetIpcClientTransport(client));
// net-ipc Connection side: the Server demuxes, so forward with transport.dispatch(raw)
const transport = new NetIpcConnectionTransport(connection);
const eventManager = new EventManager(transport);

eventManager.onMessage((message) => { /* ... */ });
eventManager.onRequest((message, timeout) => { /* ... */ });
```

`NetIpcClientTransport` subscribes to the client's `message` event itself. Remove any existing
`client.on('message', (m) => eventManager.receive(m))`, otherwise every request is handled twice.

### Breaking changes

- `BridgeInstanceConnection.connectionStatus`, `BridgeClusterConnection.connectionStatus` and
  `ClusterProcess.status` are read-only getters backed by a guarded state machine. Assigning
  them is a compile error; use the `mark*()` methods instead.
- `EventManager` now takes a `Transport` (`new EventManager(transport)`) instead of three
  callbacks, and is generic over the message/request protocol types.
- `HeartbeatResponse.memory.usage` is typed `string` (it always was a string at runtime).
- `ClusterEventListeners.request` receives the request timeout as a fourth argument.
- `Bridge.on()` / `BotInstance.on()` for typed events now *add* a listener (Node `EventEmitter`
  semantics) instead of replacing the previous one. Use `off()` to remove. (`Cluster.on()` and
  the `message` / `request` handlers of `BotInstance` still replace.)

### Deprecated (still exported, will be removed in a later major)

- `BridgeConnectionStatus` → `ManagedInstanceConnectionStatus` (members are string-valued now).
- `BridgeEventListeners` → `BridgeEvents`.
- `BotInstanceEventListeners` → `BotInstanceListeners`.
- `BridgeInstanceConnection.onMessage()` / `.onRequest()` / `.messageReceive()` →
  `eventManager.onMessage()` / `eventManager.onRequest()` / `dispatch()`.

### Added

- `Bridge.off()`, `BotInstance.off()`.
- `NetIpcClientTransport` and `NetIpcConnectionTransport` are exported, so an `EventManager` can
  be used over net-ipc outside of `Bridge` / `ManagedInstance`.
- `StandaloneInstance` and `ManagedInstance` accept an optional `env` constructor argument (last
  parameter) whose variables are merged into the environment of forked cluster processes. Forked
  clusters still do not inherit `process.env` by default - pass it explicitly if needed. The
  variables galactic sets itself (`TOKEN`, `CLUSTER_ID`, ...) always take precedence.
- `StandaloneInstance` restarts crashed clusters with exponential backoff (1s doubling, capped
  at 60s) and emits `ERROR` once a cluster crash-loops more than 5 times in a row.
- Typed wire protocol (`protocol/process.ts`, `protocol/bridge.ts`) with compile-time
  exhaustiveness checks in every router.

### Fixed

- Unknown message/request types from a peer on another version are dropped / rejected
  instead of crashing the process.
- `ManagedInstance` survives net-ipc emitting `status` 4 followed by `close` for one drop.
- `CLUSTER_READY` from a cluster that is already being killed is ignored.
- `killProcess()` no longer runs twice per teardown (double `CLUSTER_STOPPED`, double restart).
- `Bridge.moveCluster()` validates its input and throws a descriptive error.
- Heartbeat CPU sampling measures a real 500ms window.
