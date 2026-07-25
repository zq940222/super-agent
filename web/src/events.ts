// The event contract is owned by the engine; re-export it so the client can't
// drift from the server. Type-only — erased at build time.
export type { AgentEvent } from "../../src/core/events";
