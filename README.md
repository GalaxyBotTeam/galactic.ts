![Galactic Logo](https://s3.galaxybot.app/media/galactic/readmeBanner.png?v=2)

galactic is a powerful scaling library for Discord bots, built to make distributed shard and cluster management simple, efficient, and highly flexible.

## Overview

galactic allows you to run multiple Discord shards within a single process and scale your bot seamlessly across multiple machines or containers. It’s designed to integrate smoothly with [discord.js](https://discord.js.org/), enabling developers to focus on building features instead of managing complex scaling setups.

## Key Features

- Run multiple **Discord shards** in one process
- Automate **cluster distribution** across multiple machines or Docker containers
- Utilize the **galactic Bridge** to synchronize shards and clusters
- **Seamless integration** with discord.js
- Optimized for both **small** and **large-scale** bot deployments
- Easy configuration and setup
- Open-source and actively maintained
- Reclustering without downtime
- Graceful shutdown with async cleanup callbacks

## Installation

```bash
npm install galactic.ts
# or
yarn add galactic.ts
```

## Quick Start Example

### Standalone Setup (Single Machine)

```ts
// index.ts
import { StandaloneInstance } from "galactic.ts";

// Create a standalone instance running 2 clusters with 2 shards each
const instance = new StandaloneInstance(
  `${__dirname}/bot.js`,
  2,
  2,
  process.env.BOT_TOKEN!,
  [],
);

instance.start();
```

### Bot File Setup

```ts
// bot.ts
import { Cluster } from "galactic.ts";
import { Client, ClientOptions } from "discord.js";

// Extend the Discord Client to include a reference to its Cluster
export class ExtendedClient extends Client {
  cluster: Cluster<ExtendedClient>;

  constructor(options: ClientOptions, cluster: Cluster<ExtendedClient>) {
    super(options);
    this.cluster = cluster;
  }
}

// Initialize the Cluster
const cluster = Cluster.initial<ExtendedClient>();

const client = new ExtendedClient(
  {
    shards: cluster.shardList,
    shardCount: cluster.totalShards,
    intents: cluster.intents,
  },
  cluster,
);

cluster.client = client;

client.login(cluster.token);
```

## Graceful Shutdown

`StandaloneInstance` exposes a `shutdown()` method that gracefully stops all clusters before the process exits. It sends each cluster a destruct signal, awaits its cleanup callback, and only resolves once every child process has fully terminated.

```ts
// index.ts
import { StandaloneInstance } from "galactic.ts";

const instance = new StandaloneInstance(
  `${__dirname}/bot.js`,
  2,
  2,
  process.env.BOT_TOKEN!,
  [],
);

instance.start();

// Wire up OS signals for clean shutdown
process.on("SIGTERM", () => instance.shutdown().then(() => process.exit(0)));
process.on("SIGINT", () => instance.shutdown().then(() => process.exit(0)));
```

To run custom cleanup logic per cluster (e.g. destroying a Discord client), set `onSelfDestruct` in your bot file. Async callbacks are fully awaited before the cluster exits:

```ts
// bot.ts
cluster.onSelfDestruct = async () => {
  await client.destroy();
};
```

## Distributed Setup

To scale your bot across multiple servers or containers, galactic uses the **galactic Bridge**.  
Each instance connects to the same bridge to coordinate shard and cluster responsibilities.

Typical distributed setup:

1. Deploy a **Bridge** (centralized coordinator for all instances)
2. Deploy multiple galactic **instances** (e.g., on different VPS or Docker nodes)
3. Configure each instance to connect to the shared Bridge
4. galactic automatically distributes and balances clusters and shards across all connected instances

### Terminology

- **Instance**: A bot deployment (StandaloneInstance, ManagedInstance) that manages clusters
- **Cluster**: A process group within an instance that manages shards
- **Shard**: Discord gateway connection for a portion of guilds
- **Bridge**: Centralized coordinator for multi-instance deployments

### Restart Routines

`bridge.restartAll(routine?)` restarts every connected instance. galactic stops each instance; your supervisor (systemd, Docker, pm2, …) must start it again so it reconnects with the same `instanceID`. Each step waits for that reconnect. Rebalancing pauses while a routine runs, and only one routine runs at a time.

- `sequentialRestart()` (default): drains and restarts the instances one after another.
- `rollingReload()`: needs exactly one **standby** instance. The balancer never gives clusters to a standby. The routine restarts the empty standby first, then moves each instance's clusters onto the previously restarted instance before restarting it. At the end the standby is empty again.

Mark an instance as standby with the last `ManagedInstance` constructor argument:

```ts
new ManagedInstance(entryPoint, host, port, instanceID, data, execArgv, false /* dev */, true /* standby */);
```

Both routines take an optional `InstanceOrder`, e.g. to restart host by host:

```ts
import { rollingReload } from "galactic.ts";

await bridge.restartAll(rollingReload((ids, ctx) =>
  [...ids].sort((a, b) => String((ctx.get(a)?.data as any)?.host).localeCompare(String((ctx.get(b)?.data as any)?.host)) || a - b)
));
```

A failed step rejects with `RestartStepError` (no rollback). Progress is reported through the `RESTART_STEP` event.

## Integration with Discord.js

galactic is fully compatible with the latest version of discord.js.  
You can integrate it without modifying your existing command or event handling structure.

## Use Cases

- Running high-traffic bots with thousands of guilds
- Horizontal scaling using containers (Docker, Kubernetes)
- Efficient utilization of hardware on a single machine

## License

MIT © 2025 GalaxyBot
