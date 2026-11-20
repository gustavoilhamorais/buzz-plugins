// Starts the mock relay for manual checks and prints its URL.
import { MockRelay } from "./mock-relay.ts";
const relay = await MockRelay.start();
console.log(relay.url);
setInterval(() => {}, 1 << 30);
