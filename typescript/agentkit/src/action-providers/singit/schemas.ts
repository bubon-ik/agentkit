import { z } from "zod";

/**
 * Configuration options for SingitActionProvider.
 */
export interface SingitConfig {
  /**
   * Maximum payment per call in USDC whole units (e.g. 0.05 is five cents).
   * An offer above this amount is never signed.
   * Default: 0.05 (or SINGIT_MAX_PAYMENT_USDC env var)
   */
  maxPaymentUsdc?: number;
}

/**
 * Schema for listing the models SingIt Ask serves (no parameters required).
 */
export const ListModelsSchema = z.object({}).describe("No parameters required");

/**
 * Schema for asking a model a question through SingIt Ask.
 */
export const AskSchema = z
  .object({
    prompt: z.string().min(1).max(20000).describe("The question or instruction for the model."),
    model: z
      .string()
      .nullable()
      .describe(
        "Model id from list_models, for example 'deepseek-v4.1-flash'. Use null for the default model. 'free/deepseek-v4.1-flash' needs no payment.",
      ),
    system: z
      .string()
      .max(4000)
      .nullable()
      .describe("Optional system message that sets the model's behaviour. Use null to skip."),
    maxTokens: z
      .number()
      .int()
      .min(1)
      .max(1200)
      .nullable()
      .describe(
        "Longest answer in tokens (1 to 1200). The price grows with it. Use null for the default of 800.",
      ),
  })
  .describe("Parameters for asking a model through SingIt Ask");
