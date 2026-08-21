import { createServer } from "node:http";
import { config } from "./config";
import { buildHttpApp } from "./http";
import { hub } from "./hub";
import { startSlack } from "./slack";

const server = createServer(buildHttpApp());
hub.attach(server);

server.listen(config.port, () => {
  console.log(`[broker] http + ws listening on :${config.port} (dashboard at /admin)`);
});

startSlack().catch((err) => {
  console.error("[broker] failed to start Slack app", err);
  process.exit(1);
});
