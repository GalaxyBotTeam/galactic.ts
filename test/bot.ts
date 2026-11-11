import {Cluster} from "../src";
import {Client, ClientOptions} from "discord.js";

export class ExtendedClient extends Client {
     cluster: Cluster<ExtendedClient>;

     constructor(options: ClientOptions, cluster: Cluster<ExtendedClient>) {
          super(options);
          this.cluster = cluster;
     }

}

const cluster = Cluster.initial<ExtendedClient>();

const client = new ExtendedClient({
     shards: cluster.shardList,
     shardCount: cluster.totalShards,
     intents: cluster.intents,
}, cluster);

cluster.client = client;

client.login(cluster.token).then(r => {
     cluster.triggerReady(client.guilds.cache.size, client.guilds.cache.values().map(g => g.memberCount).reduce((a, b) => a + b, 0));

     // set status
     client.user?.setPresence({
          status: "online",
          activities: [{
               name:  cluster.clusterID + "/" + cluster.instanceID
          }],
          shardId: cluster.shardList
     })
}).catch(e => {
     console.error('Failed to login:', e);
     cluster.triggerError(e);
})

cluster.onSelfDestruct = async () => {
     console.log(`[Cluster ${cluster.clusterID}] Graceful shutdown started`);
     await client.destroy();
     console.log(`[Cluster ${cluster.clusterID}] Discord client destroyed`);
};

// Only one process of a moving cluster handles events.
client.on('messageCreate', (message) => {
     if (!cluster.serving) return;
     if (message.content === '!cluster') message.reply(`Cluster ${cluster.clusterID} on instance ${cluster.instanceID}`).catch(() => {});
});

cluster.on('SERVING', (serving) => {
     console.log(`[Cluster ${cluster.clusterID}] ${serving ? 'Serving' : 'Not serving'}`);
});

cluster.on('message', (message) => {

})

cluster.on('request', (message, resolve, reject) => {
     resolve({"no": "No"});
})