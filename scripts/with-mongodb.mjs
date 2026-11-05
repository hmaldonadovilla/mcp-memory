// Required integration owns a disposable loopback MongoDB container unless an explicit test URI is supplied.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient } from "mongodb";
const command = process.argv.slice(2);
if (!command.length) throw new Error("A test command is required");
let container;
let uri = process.env.MEMORY_TEST_MONGODB_URI;
try {
  if (!uri) {
    container = "mcp-memory-test-" + randomUUID();
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--publish",
        "127.0.0.1::27017",
        "--memory",
        "512m",
        process.env.MEMORY_TEST_MONGO_IMAGE ?? "mongo:8.0.26",
        "mongod",
        "--bind_ip_all",
        "--wiredTigerCacheSizeGB",
        "0.25",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const port = execFileSync("docker", ["port", container, "27017/tcp"], {
      encoding: "utf8",
    }).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(port))
      throw new Error("Test container must bind only to loopback");
    uri = "mongodb://" + port;
  }
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(uri))
    throw new Error(
      "Tests require an explicit credential-free loopback test MongoDB URI",
    );
  let ready = false;
  let failure = "unknown";
  for (let attempt = 0; attempt < 40; attempt++) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
    try {
      await client.connect();
      await client.db("mcp_memory_tests").command({ ping: 1 });
      ready = true;
      break;
    } catch (error) {
      failure = error instanceof Error ? error.name : "unknown";
      await delay(250);
    } finally {
      await client.close();
    }
  }
  if (!ready) {
    console.error("Isolated MongoDB readiness failed:", failure);
    if (container) {
      // This owned fixture contains no credentials or non-synthetic data.
      for (const args of [
        ["info", "--format", "{{.KernelVersion}}"],
        ["logs", "--tail", "12", container],
      ]) {
        try {
          console.error(
            execFileSync("docker", args, {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }).slice(-8000),
          );
        } catch {
          console.error(
            "The owned fixture exited before diagnostics could be read.",
          );
        }
      }
    }
    throw new Error("The isolated integration database did not become ready");
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, MEMORY_TEST_MONGODB_URI: uri },
  });
  const forward = () => child.kill("SIGTERM");
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(signal ? 1 : (status ?? 1)));
  });
  process.removeListener("SIGTERM", forward);
  process.removeListener("SIGINT", forward);
  process.exitCode = code;
} finally {
  if (container)
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
}
