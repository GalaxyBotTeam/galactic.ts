# Changelog

## 3.0.0-pre.4 (large bot sharding, moves without downtime)

Update the Bridge and all instances together: the Bridge now asks starting clusters for
heartbeats, and a cluster on an older version crashes if that happens before it has a client.

### Added

- `BridgeClusterConnection.servingConnection`: the instance that answers for a cluster. During a
  move that is the old instance until the new cluster is ready. Use it instead of checking
  `connectionStatus` to tell whether a cluster can be reached: `starting` covers a first start,
  where nothing answers, as well as a move, where the old process still does.
- Heartbeats also run while a cluster starts, so `heartbeatResponse.shardPings` shows every shard
  on its way to ready, with discord.js' status. It stays empty until the cluster has a client. A
  starting cluster that does not answer yet is not counted as a missed heartbeat.
- The Bridge reads `GET /gateway/bot` on start and before every restart routine and emits
  `GATEWAY_INFO`. `ERROR` reports too few shards, too few session starts left, and on large bot
  sharding a shard count that is not a multiple of `max_concurrency`.
- Close code 4010: the cluster reports it and the Bridge stops starting clusters until it is
  restarted. Assign `cluster.client` before the client logs in.

### Changed

- Cluster starts follow `max_concurrency` across all instances. A cluster with several shards in
  one rate limit key now blocks that key for all of its identifies, 6.5 seconds each (Discord's
  5 second window plus the jitter of discord.js). Bots with `shardsPerCluster` above
  `max_concurrency` start slower than before, but within the limit.
- `moveAllClusters`, draining and `Bridge.moveCluster` wait for their identify slot instead of
  starting all clusters at once.
- `Bridge.restartAll` is `async` and reads the gateway limits first.
- `Bridge.sendRequestToGuild` and requests between clusters go to `servingConnection`, so they
  keep working during a move. `sendRequestToGuild` now rejects during a first start instead of
  reaching a process that is not ready. Requests the old process has not answered about 250 ms
  after the new cluster is ready still fail.

### Fixed

- A cluster answers heartbeats before it has a client instead of crashing.
- `oldConnection` is cleared when the old process or its instance goes away during a move.

## 3.0.0-pre.3 (rotating standby)

### Changed

- `rollingReload` moves every cluster exactly once. The final move back off the standby is gone:
  the standby role follows the empty instance, so the last restarted instance becomes the new
  standby. The `standby` flag now only sets the starting point; a role moved by a routine wins
  over it on reconnect until the Bridge restarts.

### Added

- `RestartContext.transferStandby(fromID, toID)` for custom routines.
- `BridgeInstanceConnection.setStandby()`; `standby` is now a getter.
- `INSTANCE_STANDBY` message and `ManagedInstance` event: the Bridge reports the current role on
  every connect and role change. `ManagedInstance.standby` follows it. Instances on an older
  version ignore the message with a warning.
- `RESTART_STEP` reports `{ kind: 'standby', from, to }`. Handle this kind if you switch over
  `step.kind`.

## 3.0.0-pre.2 (restart routines)

### Added

- `Bridge.restartAll(routine?, options?)` restarts every connected instance through a pluggable
  `RestartRoutine`; ships `sequentialRestart` (default) and `rollingReload`. Each step has a
  timeout (`stepTimeoutMs`, default 10 minutes) and fails with `RestartStepError`.
- `standby` connect flag (last `ManagedInstance` constructor parameter): the balancer never puts
  clusters on a standby instance; `rollingReload` uses it as a buffer.
- `RESTART_STEP` bridge event.

### Deprecated

- `Bridge.stopAllInstancesWithRestart()` → `restartAll()`.

### Fixed

- Restarts wait for the instance to reconnect instead of a flat 10s delay.
- `InstanceStopCoordinator.waitForDrain()` no longer polls forever; it takes an optional timeout.

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
