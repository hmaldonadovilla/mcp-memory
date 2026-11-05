// OpenAI-compatible embeddings use explicit profiles, bounded calls and verified TLS, with no synthetic fallback.
import { readFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { digest, MemoryError } from "./model.js";
import type { Embeddings } from "./model.js";

export interface EmbeddingOptions {
  baseUrl: string;
  model: string;
  profileId: string;
  dimensions: number;
  key?: string;
  authHeader?: "bearer" | "api-key";
  caFile?: string;
  timeoutMs?: number;
  sendDimensions?: boolean;
}
const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()),
    }),
  ),
});
export class OpenAICompatibleEmbeddings implements Embeddings {
  readonly profile: string;
  private readonly agent: Agent;
  private constructor(
    private readonly options: EmbeddingOptions,
    ca?: string,
  ) {
    this.profile = digest(
      JSON.stringify({
        id: options.profileId,
        endpoint: options.baseUrl,
        model: options.model,
        dimensions: options.dimensions,
      }),
    );
    this.agent = new Agent({
      connect: {
        rejectUnauthorized: true,
        ...(ca ? { ca: [...getCACertificates("default"), ca] } : {}),
      },
    });
  }
  static async create(
    options: EmbeddingOptions,
  ): Promise<OpenAICompatibleEmbeddings> {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new MemoryError(
        "invalid_embedding_endpoint",
        "Embeddings require HTTPS, or explicit loopback HTTP for local development.",
      );
    if (
      !Number.isInteger(options.dimensions) ||
      options.dimensions < 1 ||
      options.dimensions > 16384 ||
      !options.model.trim() ||
      !options.profileId.trim()
    )
      throw new MemoryError(
        "invalid_embedding_profile",
        "An explicit model, profile identifier and valid vector dimensions are required.",
      );
    try {
      return new OpenAICompatibleEmbeddings(
        { ...options, baseUrl: url.href.replace(/\/$/, "") },
        options.caFile ? await readFile(options.caFile, "utf8") : undefined,
      );
    } catch {
      throw new MemoryError(
        "invalid_ca_file",
        "The configured embedding CA bundle could not be read.",
      );
    }
  }
  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!inputs.length) return [];
    if (
      inputs.length > 64 ||
      inputs.some((input) => !input.trim() || Buffer.byteLength(input) > 8192)
    )
      throw new MemoryError(
        "embedding_budget",
        "Each operation allows at most 64 nonempty embedding inputs, each at most 8,192 UTF-8 bytes.",
      );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.options.key) {
      if (this.options.authHeader === "api-key")
        headers["api-key"] = this.options.key;
      else headers.Authorization = "Bearer " + this.options.key;
    }
    const signals = [AbortSignal.timeout(this.options.timeoutMs ?? 30000)];
    if (signal) signals.push(signal);
    try {
      const response = await fetch(this.options.baseUrl + "/embeddings", {
        method: "POST",
        headers,
        dispatcher: this.agent,
        redirect: "error",
        signal: AbortSignal.any(signals),
        body: JSON.stringify({
          model: this.options.model,
          input: inputs,
          ...(this.options.sendDimensions
            ? { dimensions: this.options.dimensions }
            : {}),
          encoding_format: "float",
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("provider_status");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing_body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("provider_limit");
        }
        chunks.push(part.value);
      }
      const parsed = responseSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const indexed = new Map(
        parsed.data.map((item) => [item.index, item.embedding]),
      );
      if (
        indexed.size !== inputs.length ||
        parsed.data.length !== inputs.length
      )
        throw new Error("provider_count");
      return inputs.map((_, index) => {
        const vector = indexed.get(index);
        if (!vector || vector.length !== this.options.dimensions)
          throw new Error("provider_dimensions");
        const norm = Math.hypot(...vector);
        if (!Number.isFinite(norm) || !norm) throw new Error("provider_norm");
        return vector.map((value) => value / norm);
      });
    } catch {
      throw new MemoryError(
        "embedding_unavailable",
        "The embedding request failed or returned an incompatible vector. No semantic fallback or provider retry was made.",
      );
    }
  }
  async close(): Promise<void> {
    await this.agent.close();
  }
}
