/**
 * Azure OpenAI adapter (P10).
 *
 * Azure differs from vanilla OpenAI in auth (an `api-key` header, not a Bearer
 * token), an `api-version` query param, and deployment names instead of model
 * names. We configure the base `OpenAI` client explicitly for Azure rather than
 * the SDK's `AzureOpenAI` wrapper — the wrapper's `endpoint` option conflicts
 * with a stray `OPENAI_BASE_URL` in the environment ("baseURL and endpoint are
 * mutually exclusive"). Setting `baseURL` ourselves is deterministic and ignores
 * env leakage.
 *
 * The response shape is identical to OpenAI chat completions, so we REUSE the
 * OpenAI wire-format normalizers verbatim. See issue #19.
 */

import OpenAI from "openai";
import type { AssistantTurn } from "../core/types";
import type { GenerateRequest, ModelProvider, StreamChunk } from "./provider";
import { fromOpenAIResponse, toOpenAIMessages, toOpenAITools, toToolChoice, type OAIResponse } from "./openai";

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  /** Base resource host, e.g. https://<resource>.cognitiveservices.azure.com */
  endpoint?: string;
  apiVersion?: string;
  /** Azure deployment name — used as the `model` on each call. */
  deployment?: string;
}

/** Catch values left as an unfilled `<...>` placeholder from .env.example. */
function assertNotPlaceholder(name: string, value: string): void {
  if (/[<>]/.test(value)) {
    throw new Error(
      `${name} looks like an unfilled placeholder ("${value}"). ` +
        `Replace it with the real value from the Azure portal (Model deployments).`,
    );
  }
}

/** Reduce a possibly-full endpoint URL (with /openai/... and query) to its origin. */
function toOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export class AzureOpenAIProvider implements ModelProvider {
  readonly name = "azure";
  private client: OpenAI;
  private deployment: string;

  constructor(opts: AzureOpenAIProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
    const endpoint = opts.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
    const apiVersion = opts.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2025-04-01-preview";
    const deployment = opts.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!apiKey) throw new Error("AZURE_OPENAI_API_KEY is not set (see .env.example).");
    if (!endpoint) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT is not set (e.g. https://<resource>.cognitiveservices.azure.com).",
      );
    }
    if (!deployment) {
      throw new Error("AZURE_OPENAI_DEPLOYMENT is not set (your Azure deployment name).");
    }
    assertNotPlaceholder("AZURE_OPENAI_ENDPOINT", endpoint);
    assertNotPlaceholder("AZURE_OPENAI_DEPLOYMENT", deployment);

    this.deployment = deployment;
    this.client = new OpenAI({
      apiKey, // required by the SDK; Azure authenticates via the api-key header below
      baseURL: `${toOrigin(endpoint)}/openai/deployments/${deployment}`,
      defaultQuery: { "api-version": apiVersion },
      defaultHeaders: { "api-key": apiKey },
    });
  }

  /** Shared request body — Azure differs from OpenAI only in `model` (deployment). */
  private buildParams(req: GenerateRequest): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.deployment,
      messages: toOpenAIMessages(req.messages, req.system),
    };
    const tools = toOpenAITools(req.tools);
    if (tools) {
      params.tools = tools;
      params.tool_choice = toToolChoice(req.toolChoice) ?? "auto";
    }
    if (req.maxTokens) params.max_completion_tokens = req.maxTokens;
    return params;
  }

  async generate(req: GenerateRequest): Promise<AssistantTurn> {
    const resp = await this.client.chat.completions.create(this.buildParams(req) as any, { signal: req.signal });
    return fromOpenAIResponse(resp as unknown as OAIResponse);
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    // Azure chat completions stream identically to OpenAI — same client, same
    // chunk shape — so reuse the OpenAI normalizer on the assembled result.
    // `include_usage` (streaming-only) keeps token usage on the `done` turn.
    const body = { ...this.buildParams(req), stream_options: { include_usage: true } };
    const stream = this.client.chat.completions.stream(body as any, { signal: req.signal });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { type: "text_delta", text: delta };
    }
    const completion = await stream.finalChatCompletion();
    yield { type: "done", turn: fromOpenAIResponse(completion as unknown as OAIResponse) };
  }
}
