// Verify the production-only image without starting inference, then remove only this test's unique image tag.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const image = "mcp-memory-test:" + randomUUID();
const args = ["build", "--tag", image];
if (process.env.MEMORY_BUILD_CA_FILE)
  args.push("--secret", "id=ca_bundle,src=" + process.env.MEMORY_BUILD_CA_FILE);
args.push(".");
try {
  execFileSync("docker", args, { stdio: "inherit" });
  const version = execFileSync(
    "docker",
    ["run", "--rm", "--network=none", image, "--version"],
    { encoding: "utf8" },
  ).trim();
  if (version !== pkg.version)
    throw new Error("Production image version mismatch");
  const user = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Config.User}}", image],
    { encoding: "utf8" },
  ).trim();
  if (user !== "node")
    throw new Error("Production image must run as the unprivileged node user");
  console.log(
    "Verified production-only image entry point and unprivileged user.",
  );
} finally {
  try {
    execFileSync("docker", ["image", "rm", image], { stdio: "ignore" });
  } catch {
    /* A failed build may not have created this unique tag. */
  }
}
