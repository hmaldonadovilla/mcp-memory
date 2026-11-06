// Install the exact allowlisted tarball in a clean directory and drive its npx binary against isolated MongoDB.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MongoClient } from "mongodb";
const uri = process.env.MEMORY_TEST_MONGODB_URI;
if (
  !uri ||
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/(?:\?directConnection=true)?$/.test(uri)
)
  throw new Error("Use the required isolated test runner");
await mkdir(".local/package", { recursive: true });
const packed = JSON.parse(
  execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      ".local/package",
    ],
    { encoding: "utf8" },
  ),
)[0];
if (packed.name !== "@hmaldonadovilla/mcp-memory")
  throw new Error("Unexpected package identity");
const allowed =
  /^(?:dist\/[a-z-]+\.(?:js|d\.ts)|bin\/mcp-memory\.mjs|package\.json|README\.md|LICENSE|NOTICE|docs\/upstream\.json)$/;
for (const file of packed.files)
  if (!allowed.test(file.path))
    throw new Error("Unexpected published file: " + file.path);
for (const file of [
  "README.md",
  "LICENSE",
  "NOTICE",
  "bin/mcp-memory.mjs",
  "dist/cli.js",
  "dist/index.js",
])
  if (!packed.files.some((f) => f.path === file))
    throw new Error("Missing package file: " + file);
const tarball = resolve(".local/package", packed.filename),
  dir = await mkdtemp(join(tmpdir(), "mcp-memory-pack-"));
const namespace = "pack-" + randomUUID();
let client;
try {
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  const version = execFileSync(
    "npx",
    ["--no-install", "mcp-memory", "--version"],
    { cwd: dir, encoding: "utf8" },
  ).trim();
  if (version !== packed.version)
    throw new Error("Installed binary version mismatch");
  execFileSync("npx", ["--no-install", "mcp-memory", "--help"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  client = new Client({ name: "packed-npx-proof", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["--no-install", "mcp-memory"],
      cwd: dir,
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORY_MONGODB_URI: uri,
        MEMORY_DATABASE: "mcp_memory_tests",
        MEMORY_NAMESPACE: namespace,
      },
    }),
  );
  const tools = await client.listTools();
  if (tools.tools.length !== 13)
    throw new Error("Packed tool discovery mismatch");
  const created = await client.callTool({
    name: "create_entities",
    arguments: {
      entities: [
        {
          name: "package-proof",
          entityType: "synthetic",
          observations: ["Installed npx binary works"],
        },
      ],
    },
  });
  if (created.isError) throw new Error("Packed mutation failed");
  const found = await client.callTool({
    name: "search_nodes",
    arguments: { query: "Installed npx" },
  });
  if (found.isError || !JSON.stringify(found).includes("package-proof"))
    throw new Error("Packed retrieval failed");
  const sha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await writeFile(
    ".local/package/receipt.json",
    JSON.stringify(
      {
        name: packed.name,
        version: packed.version,
        filename: packed.filename,
        sha256,
        files: packed.files.map((f) => f.path),
        npx: true,
        stdio: true,
        realMongoDB: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Verified clean package install, npx discovery, durable mutation and retrieval: " +
      packed.filename,
  );
} finally {
  await client?.close();
  const database = new MongoClient(uri);
  try {
    await database.connect();
    await database
      .db("mcp_memory_tests")
      .collection("memory_graphs")
      .deleteOne({ _id: namespace });
  } finally {
    await database.close();
  }
  await rm(dir, { recursive: true, force: true });
}
