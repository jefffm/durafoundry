import * as v from "valibot";

export const CodexTinyResultSchema = v.object({
  status: v.literal("ok"),
  message: v.literal("codex-through-flue"),
});

export const BaselineTinyResultSchema = v.object({
  status: v.literal("ok"),
  message: v.string(),
});

export const FlueModelProbeResultSchema = v.object({
  provider: v.string(),
  model: v.string(),
  ok: v.boolean(),
  resultExtractionOk: v.boolean(),
  eventStreamObserved: v.boolean(),
  compactionObserved: v.optional(v.boolean()),
  errorClass: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  redactionFindings: v.array(v.string()),
});

export type FlueModelProbeResult = v.InferOutput<typeof FlueModelProbeResultSchema>;
