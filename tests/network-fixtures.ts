// Ephemeral providers and certificates are synthetic test fixtures, never production fallback paths.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import type { RequestListener } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
export async function embeddingFixture(tls = false) {
  const seen: {
    model: string;
    input: string[];
    authorization: string | undefined;
  }[] = [];
  const directories: string[] = [];
  const handle: RequestListener = (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = z
        .object({ model: z.string(), input: z.array(z.string()) })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      seen.push({ ...body, authorization: request.headers.authorization });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: body.input.map((text, index) => ({
            index,
            embedding: /bread|croissant|pastry/i.test(text) ? [1, 0] : [0, 1],
          })),
        }),
      );
    })().catch(() => response.destroy());
  };
  let caFile: string | undefined;
  const server = await (async () => {
    if (!tls) return httpServer(handle);
    const dir = await mkdtemp(join(tmpdir(), "mcp-memory-ca-"));
    directories.push(dir);
    const key = join(dir, "test.key"),
      cert = join(dir, "test.pem"),
      config = join(dir, "test.cnf");
    await writeFile(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    caFile = cert;
    return httpsServer(
      { key: await readFile(key), cert: await readFile(cert) },
      handle,
    );
  })();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  return {
    baseUrl: `${tls ? "https" : "http"}://127.0.0.1:${address.port}/openai/v1`,
    caFile,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const dir of directories)
        await rm(dir, { recursive: true, force: true });
    },
  };
}
