import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Poll usage every 5 minutes. The cron only pokes the Next app (see notify.pingCheck) — the
// app decrypts the vault, fetches Anthropic usage, runs the detector, and dispatches events.
const crons = cronJobs();

crons.interval("check usage", { minutes: 5 }, internal.notify.pingCheck, {});

export default crons;
