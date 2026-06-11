import { app } from "./app.js";

const port = 3000;
// oxlint-disable-next-line no-console -- app startup log
console.log(`Server running on http://localhost:${port}`);
Bun.serve({ fetch: app.fetch, port });
