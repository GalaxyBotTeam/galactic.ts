import { ManagedInstance } from "../src";

import dotenv from "dotenv";

dotenv.config();

// Like test/machine.ts, but with a random instance id so several copies can join one bridge.
const instanceID = Math.floor(Math.random() * 4) + 1;
console.log(`Instance id: ${instanceID}`);

const machine = new ManagedInstance(`${__dirname}/bot.ts`, 'localhost', 3000, instanceID, {
    webserver: ''
}, ['--import', 'tsx'], false);

machine.start();

machine.on("BRIDGE_CONNECTION_ESTABLISHED", () => {
    console.log("Bridge connected")
})


machine.on("CLUSTER_READY", () => {
    console.log("ready")
})

machine.on("CLUSTER_RECLUSTER", (client) => {
    console.error("Cluster reclustered", client.id);
})

machine.on("CLUSTER_ERROR", (error) => {
    console.error("Cluster error", error);
});

machine.on("ERROR", (error) => {
    console.error("Error in instance", error);
})

machine.on("PROCESS_SPAWNED", (r) => {
    console.log("Process spawned", r.id)
});

machine.on("PROCESS_KILLED", (r, reason) => {
    console.log("Process killed", r.id, reason);
});

machine.on("PROCESS_ERROR", (r, error) => {
    console.error("Process error", r.id, error);
});

machine.on("BRIDGE_CONNECTION_CLOSED", (r) => {
    console.log("Bridge connection closed", r)
})

machine.on("INSTANCE_STOP_ACK", () => {
    console.log("Instance stop acknowledged, draining clusters")
})

machine.on("INSTANCE_STOP", () => {
    console.log("Instance stopped")
})

machine.on("SELF_CHECK_SUCCESS", () => {
    console.log("Self check successful")
});


machine.on("SELF_CHECK_ERROR", (error) => {
    console.error("Self check failed", error);
});

// on command input

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', async function (text: Buffer) {
    const input = text.toString().trim();

    if(input == 'test'){
        machine.sendRequestToClusterOfGuild("1297244911787311104", {
            test: 'CLI'
        }).then((result) => {
            console.log(result);
        }).catch((err) => {
           console.error(err);
        });
    } else if(input == 'stop'){
        machine.stopInstance();
    }
});