import { promises as fs } from "node:fs";
import path from "node:path";

const traceRoot = path.resolve(process.argv[2] ?? ".next");
const localVaultArtifact = /(^|\/)(?:\.data|token-recovery|vault\.key|vault[^/]*\.enc[^/]*)(?:\/|$)/;

async function traceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return traceFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".nft.json") ? [absolute] : [];
    }),
  );
  return nested.flat();
}

let traces;
try {
  traces = await traceFiles(traceRoot);
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(`Next output trace directory does not exist: ${traceRoot}`);
  }
  throw error;
}

if (traces.length === 0) throw new Error(`No Next output trace files were found under ${traceRoot}`);

const leaked = [];
for (const trace of traces) {
  const parsed = JSON.parse(await fs.readFile(trace, "utf8"));
  if (!Array.isArray(parsed.files)) throw new Error(`Invalid Next output trace: ${trace}`);
  for (const file of parsed.files) {
    const normalized = String(file).replaceAll("\\", "/");
    if (localVaultArtifact.test(normalized)) leaked.push(path.relative(process.cwd(), trace));
  }
}

if (leaked.length > 0) {
  throw new Error(
    `Local vault material was traced into ${leaked.length} production build trace${leaked.length === 1 ? "" : "s"}.`,
  );
}

console.log(`Verified ${traces.length} Next output traces exclude local vault material.`);
