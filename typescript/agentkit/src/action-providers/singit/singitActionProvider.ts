import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider, SvmWalletProvider, WalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import { getX402Networks, isUsdcAsset } from "../x402/utils";
import { AskSchema, ListModelsSchema, SingitConfig } from "./schemas";

const SINGIT_ASK_URL = "https://ask.singitai.app";
const SUPPORTED_NETWORKS = ["base-mainnet", "solana-mainnet"];
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_MAX_PAYMENT_USDC = 0.05;
const USDC_DECIMALS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * SingitActionProvider lets an agent buy language-model answers from SingIt Ask,
 * an x402 gateway that is paid per call in USDC on Base or Solana, with no account or API key.
 */
export class SingitActionProvider extends ActionProvider<WalletProvider> {
  private readonly maxPaymentAtomic: bigint;

  /**
   * Creates a new SingitActionProvider.
   *
   * @param config - Optional configuration, mainly the per-call payment limit
   */
  constructor(config: SingitConfig = {}) {
    super("singit", []);
    const envLimit = process.env.SINGIT_MAX_PAYMENT_USDC?.trim();
    if (config.maxPaymentUsdc !== undefined) {
      const limit = config.maxPaymentUsdc;
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error("SingIt maxPaymentUsdc must be a non-negative number");
      }
      const decimal = String(limit);
      if (decimal.includes("e")) {
        if (limit < 1e-6) {
          this.maxPaymentAtomic = 0n;
          return;
        }
        throw new Error("SingIt maxPaymentUsdc must be less than 1e21");
      }
      this.maxPaymentAtomic = this.floorPaymentAtomic(decimal);
    } else {
      if (envLimit && !/^\d+(\.\d+)?$/.test(envLimit)) {
        throw new Error("SingIt SINGIT_MAX_PAYMENT_USDC must be a non-negative number");
      }
      this.maxPaymentAtomic = this.floorPaymentAtomic(envLimit || String(DEFAULT_MAX_PAYMENT_USDC));
    }
  }

  /**
   * Lists the models SingIt Ask serves. Free, no payment.
   *
   * @param _walletProvider - The wallet provider (unused, listing models is free)
   * @param _args - No parameters
   * @returns A JSON string with the models and their prices
   */
  @CreateAction({
    name: "list_models",
    description: `
Lists the language models available through SingIt Ask (https://ask.singitai.app), a pay-per-call gateway.
Listing is free. Returns each model id, name, tags and, where known, its price per million tokens in USD.
Use an id from this list as the model for the ask action.
Includes the free model 'free/deepseek-v4.1-flash', which answers without any payment within a small daily limit.`,
    schema: ListModelsSchema,
  })
  async listModels(
    _walletProvider: WalletProvider,
    _args: z.infer<typeof ListModelsSchema>,
  ): Promise<string> {
    try {
      const response = await fetch(`${SINGIT_ASK_URL}/v1/models`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return JSON.stringify({
          error: true,
          message: `SingIt returned status ${response.status} for the model list`,
        });
      }
      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      const models = (body.data ?? []).map(model => ({
        id: model.id,
        name: model.name,
        tags: model.tags,
        free: model.free,
        usdPerMillionTokens: model.singitUsdPerMillionTokens,
        recommendedScheme: model.recommendedScheme,
      }));
      return JSON.stringify({ success: true, models }, null, 2);
    } catch (error) {
      return JSON.stringify({
        error: true,
        message: `Failed to list SingIt models: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Asks a model a question and pays for the answer over x402.
   *
   * @param walletProvider - The wallet provider that signs the USDC payment
   * @param args - The prompt, optional model, system message and token limit
   * @returns A JSON string with the answer and what was charged
   */
  @CreateAction({
    name: "ask",
    description: `
Asks a language model a question through SingIt Ask (https://ask.singitai.app) and pays for the answer
in USDC from the agent's wallet, on Base or Solana, using the x402 protocol. No account or API key is needed.
The price depends on the model and on maxTokens (a short answer from a small model costs a fraction of a cent).
A payment above the configured per-call limit is never signed.
Call list_models first if you are unsure which model to use.
Use model 'free/deepseek-v4.1-flash' for a short answer (up to 400 tokens) with no payment.
For Claude Opus models the flat price used here includes room for thinking tokens and is usually dearer than for other models.
A failed call may still have been charged; check settlement/billing and do not blindly retry.
Returns the model's answer and the amount charged in USDC micro-units (billing.totalAtomic).`,
    schema: AskSchema,
  })
  async ask(walletProvider: WalletProvider, args: z.infer<typeof AskSchema>): Promise<string> {
    try {
      if (
        !(
          walletProvider instanceof EvmWalletProvider || walletProvider instanceof SvmWalletProvider
        )
      ) {
        return JSON.stringify({
          error: true,
          message: "Unsupported wallet provider",
          details: "Only EvmWalletProvider and SvmWalletProvider are supported",
        });
      }

      const messages: Array<{ role: string; content: string }> = [];
      if (args.system) {
        messages.push({ role: "system", content: args.system });
      }
      messages.push({ role: "user", content: args.prompt });

      const client = await this.createX402Client(walletProvider);
      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      const response = await fetchWithPayment(`${SINGIT_ASK_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model ?? DEFAULT_MODEL,
          max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const settlement = this.readSettlement(response);
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return JSON.stringify({
          error: true,
          message: `The answer from SingIt Ask could not be read and the payment may have been charged: ${error instanceof Error ? error.message : String(error)}`,
          settlement,
        });
      }
      let data: Record<string, unknown> | undefined;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = undefined;
      }

      if (!response.ok) {
        return JSON.stringify({
          error: true,
          message: `SingIt Ask returned status ${response.status}.`,
          settlement,
          details: data && Object.keys(data).length > 0 ? data : text.slice(0, 500),
          paymentError: this.readPaymentError(response),
        });
      }

      const choices = data?.choices as Array<{ message?: { content?: unknown } }> | undefined;
      const answer = choices?.[0]?.message?.content;
      if (typeof answer !== "string") {
        return JSON.stringify({
          error: true,
          message: "SingIt Ask returned a response without an answer",
          billing: data?.billing,
          settlement,
        });
      }

      return JSON.stringify(
        {
          success: true,
          model: data?.model,
          answer,
          billing: data?.billing,
          settlement,
        },
        null,
        2,
      );
    } catch (error) {
      return JSON.stringify({
        error: true,
        message: `Failed to get an answer from SingIt Ask: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Checks if the action provider supports the given network.
   *
   * @param network - The network to check support for
   * @returns True if the network is supported, false otherwise
   */
  supportsNetwork = (network: Network) =>
    network.networkId !== undefined && SUPPORTED_NETWORKS.includes(network.networkId);

  /**
   * Floors a plain decimal payment limit to whole micro-USDC without rounding.
   *
   * @param decimal - The validated non-negative decimal string
   * @returns The payment limit in atomic units
   */
  private floorPaymentAtomic(decimal: string): bigint {
    const [whole, fraction = ""] = decimal.split(".");
    return BigInt(whole + fraction.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0"));
  }

  /**
   * Decodes a base64 header value as UTF-8 text.
   *
   * @param header - The base64-encoded header value
   * @returns The decoded UTF-8 text
   */
  private decodeBase64Utf8(header: string): string {
    const bytes = Uint8Array.from(atob(header), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /**
   * Reads settlement details from the PAYMENT-RESPONSE header when available.
   *
   * @param response - The gateway response
   * @returns Known settlement fields, or undefined for a missing or malformed header
   */
  private readSettlement(response: Response): Record<string, string | boolean> | undefined {
    const header =
      response.headers?.get("PAYMENT-RESPONSE") ?? response.headers?.get("payment-response");
    if (!header) {
      return undefined;
    }
    try {
      const decoded: unknown = JSON.parse(this.decodeBase64Utf8(header));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        return undefined;
      }
      const fields = decoded as Record<string, unknown>;
      const settlement: Record<string, string | boolean> = {};
      if (typeof fields.success === "boolean") {
        settlement.success = fields.success;
      }
      for (const key of ["transaction", "network", "errorReason"]) {
        if (typeof fields[key] === "string") {
          settlement[key] = fields[key];
        }
      }
      return settlement;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the reason a payment was refused from the PAYMENT-REQUIRED response header, if present.
   *
   * @param response - The failed response
   * @returns The reason, or undefined when the header is missing or unreadable
   */
  private readPaymentError(response: Response): string | undefined {
    const header = response.headers?.get("payment-required");
    if (!header) {
      return undefined;
    }
    try {
      const decoded = JSON.parse(this.decodeBase64Utf8(header)) as { error?: unknown };
      return typeof decoded.error === "string" ? decoded.error : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Creates an x402 client for the wallet that only signs `exact` USDC offers on the wallet's own
   * network that are within the payment limit.
   *
   * @param walletProvider - The wallet provider to sign with
   * @returns The configured x402 client
   */
  private async createX402Client(walletProvider: WalletProvider): Promise<x402Client> {
    const client = new x402Client();

    if (walletProvider instanceof EvmWalletProvider) {
      const account = walletProvider.toSigner();
      const signer = {
        ...account,
        readContract: (args: {
          address: `0x${string}`;
          abi: readonly unknown[];
          functionName: string;
          args?: readonly unknown[];
        }) =>
          walletProvider.readContract({
            address: args.address,
            abi: args.abi as never,
            functionName: args.functionName as never,
            args: args.args as never,
          }),
      };
      registerExactEvmScheme(client, { signer });
    } else if (walletProvider instanceof SvmWalletProvider) {
      const signer = await walletProvider.toSigner();
      registerExactSvmScheme(client, { signer });
    }

    const networks = getX402Networks(walletProvider.getNetwork());
    client.registerPolicy((_version, requirements) =>
      requirements.filter(
        requirement =>
          requirement.scheme === "exact" &&
          networks.includes(requirement.network) &&
          isUsdcAsset(requirement.asset, walletProvider) &&
          /^\d+$/.test(requirement.amount) &&
          BigInt(requirement.amount) <= this.maxPaymentAtomic,
      ),
    );

    return client;
  }
}

/**
 * Creates a SingIt action provider.
 *
 * @param config - Optional per-call payment configuration
 * @returns The configured provider
 */
export const singitActionProvider = (config?: SingitConfig) => new SingitActionProvider(config);
