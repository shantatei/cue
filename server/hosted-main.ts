import { fileURLToPath } from "node:url";
import { hostedConfig } from "./hosted/config.js";
import { createHostedServer } from "./hosted/gateway.js";

const config = hostedConfig(process.env);
const server = await createHostedServer(config, fileURLToPath(new URL("../public/", import.meta.url)));
server.listen(config.port, config.bind, () => console.log(`Cue guest web app listening on port ${config.port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.close(); server.closeAllConnections(); });
