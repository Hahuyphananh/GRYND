// Re-export the HTTP-based Neon client from db/index.
// The previous implementation used a WebSocket Pool which caused
// "Connection terminated unexpectedly" errors in serverless environments
// when the idle WebSocket connection was closed between invocations.
// The HTTP-based client in db/index is stateless and safe for serverless.
export { db, getDb } from "./index";
