// Required integration owns an isolated replica set and real native mongot; all fixture data is synthetic.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { MongoGraphStore } from "../dist/store.js";
const command = process.argv.slice(2);
if (!command.length) throw Error("A test command is required");
const id = randomUUID();
const network = "mcp-memory-test-" + id;
const mongo = "mcp-memory-db-" + id;
const search = "mcp-memory-search-" + id;
const owned = [];
let directory;
let networkCreated = false;
let uri = process.env.MEMORY_TEST_MONGODB_URI;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  if (!uri) {
    directory = await mkdtemp(join(tmpdir(), "mcp-native-config-"));
    await writeFile(
      join(directory, "password"),
      "synthetic-search-fixture-only",
      { mode: 0o400 },
    );
    await writeFile(
      join(directory, "mongot.yml"),
      `syncSource:
  replicaSet:
    hostAndPort: mongo:27017
    scramAuth:
      username: searchSync
      passwordFile: /fixture/password
      authSource: admin
      tls:
        enabled: false
storage:
  dataPath: /data/mongot
server:
  grpc:
    address: 0.0.0.0:27028
    tls:
      mode: disabled
healthCheck:
  address: 0.0.0.0:8080
logging:
  verbosity: WARN
`,
    );
    docker("network", "create", network);
    networkCreated = true;
    docker(
      "run",
      "-d",
      "--name",
      mongo,
      "--network",
      network,
      "--network-alias",
      "mongo",
      "--publish",
      "127.0.0.1::27017",
      "--memory",
      "768m",
      "mongodb/mongodb-community-server:8.3.4-ubuntu2204@sha256:7a3a1bf778c7ca1b65b262aa9c5b3d053b6551fed67e36922b3cc584775f9d56",
      "mongod",
      "--bind_ip_all",
      "--replSet",
      "test0",
      "--wiredTigerCacheSizeGB",
      "0.25",
      "--setParameter",
      "searchIndexManagementHostAndPort=search:27028",
      "--setParameter",
      "mongotHost=search:27028",
      "--setParameter",
      "useGrpcForSearch=true",
      "--setParameter",
      "searchTLSMode=disabled",
      "--setParameter",
      "skipAuthenticationToSearchIndexManagementServer=false",
    );
    owned.push(mongo);
    const port = docker("port", mongo, "27017/tcp");
    if (!/^127\.0\.0\.1:\d+$/.test(port))
      throw Error("Test database must bind only to loopback");
    uri = "mongodb://" + port + "/?directConnection=true";
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
      try {
        await client.connect();
        const admin = client.db("admin");
        const hello = await admin.command({ hello: 1 });
        if (!hello.setName)
          await admin.command({
            replSetInitiate: {
              _id: "test0",
              members: [{ _id: 0, host: "mongo:27017" }],
            },
          });
        if ((await admin.command({ hello: 1 })).isWritablePrimary) {
          await admin.command({
            createUser: "searchSync",
            pwd: "synthetic-search-fixture-only",
            roles: ["searchCoordinator"],
          });
          ready = true;
          break;
        }
      } catch {
        await delay(250);
      } finally {
        await client.close();
      }
    }
    if (!ready) throw Error("Isolated native test replica set unavailable");
    docker(
      "create",
      "--name",
      search,
      "--network",
      network,
      "--network-alias",
      "search",
      "--memory",
      "1536m",
      "-e",
      "JAVA_TOOL_OPTIONS=-Xms128m -Xmx768m",
      "--entrypoint",
      "/mongot-community/mongot",
      "mongodb/mongodb-community-search:1.70.1@sha256:3c147230554c9dffa384a90ea63e85e436fae5fd5db25acab89faf20f4f233ad",
      "--config",
      "/fixture/mongot.yml",
    );
    owned.push(search);
    // docker cp works with remote Docker/Colima as well as native WSL; host bind paths are not assumed.
    docker("cp", directory, search + ":/fixture");
    docker("start", search);
  }
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/(?:\?directConnection=true)?$/.test(uri))
    throw Error("Use an isolated credential-free loopback test MongoDB URI");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
  try {
    await client.connect();
    const db = client.db("mcp_memory_tests");
    if (
      !(await db.listCollections({ name: "memory_vectors" }).toArray()).length
    )
      await db.createCollection("memory_vectors");
    let connected = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await db.collection("memory_vectors").listSearchIndexes().toArray();
        connected = true;
        break;
      } catch {
        await delay(250);
      }
    }
    if (!connected) throw Error("Required native search process unavailable");
  } finally {
    await client.close();
  }
  await MongoGraphStore.prepare(uri, "mcp_memory_tests", {
    name: "memory_semantic_v2",
    dimensions: 2,
  });
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, MEMORY_TEST_MONGODB_URI: uri },
  });
  const forward = () => child.kill("SIGTERM");
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(signal ? 1 : (status ?? 1)));
  });
  process.removeListener("SIGTERM", forward);
  process.removeListener("SIGINT", forward);
} finally {
  for (const name of owned.reverse())
    docker("rm", "--force", "--volumes", name);
  if (networkCreated) docker("network", "rm", network);
  if (directory) await rm(directory, { recursive: true, force: true });
}
