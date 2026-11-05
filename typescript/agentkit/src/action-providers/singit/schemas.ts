import { z } from "zod";

/** Required client-side spending configuration. */
export interface SingItConfig {
  /** Maximum USD spent per call. */
  maxPerCallUsd: number;
  /** Maximum USD spent per UTC day. */
  maxPerDayUsd: number;
  /** Optional gateway URL. */
  baseUrl?: string;
}

/** Parameters for a model answer. */
export const AskSchema = z.object({
  prompt: z.string().min(1).max(20000).describe("The question or instruction for the model."),
  model: z
    .string()
    .nullable()
    .describe(
      "Model id from https://ask.singitai.app/v1/models. Null selects deepseek-v4.1-flash; 'free/deepseek-v4.1-flash' needs no payment.",
    ),
});

/** Parameters for web search. */
export const SearchSchema = z.object({
  query: z.string().min(1).max(2000).describe("The web search query."),
  numResults: z
    .number()
    .int()
    .min(1)
    .max(25)
    .nullable()
    .describe("Number of results, default 5. Results beyond 10 cost extra."),
});

/** Parameters for local spending status. */
export const SpendStatusSchema = z.object({});
