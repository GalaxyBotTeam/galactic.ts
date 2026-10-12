# Changelog

## Unreleased (architecture rework)

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
