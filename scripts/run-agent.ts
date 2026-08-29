import { runAgent } from "../lib/agent";

runAgent("scheduled")
  .then((decision) => console.log(JSON.stringify(decision, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
