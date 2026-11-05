import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import { getX402Networks, isUsdcAsset } from "../x402/utils";
import { AskSchema, SearchSchema, SpendStatusSchema, SingItConfig } from "./schemas";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  USDC_DECIMALS,
} from "./constants";

/** Buys SingIt answers and searches with client-side spending ceilings. */
export class SingItActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly perCallAtomic: bigint;
  private readonly perDayAtomic: bigint;
  private readonly baseUrl: string;
  private spentAtomic = 0n;
  private day = "";
  private queue: Promise<void> = Promise.resolve();

  /**
   * Creates a provider with mandatory spending ceilings.
   *
   * @param config - Required ceilings and optional gateway
   */
  constructor(config: SingItConfig) {
    super("singit", []);
    this.perCallAtomic = this.validateCeiling(config?.maxPerCallUsd, "maxPerCallUsd");
    this.perDayAtomic = this.validateCeiling(config?.maxPerDayUsd, "maxPerDayUsd");
    if (config.maxPerCallUsd > config.maxPerDayUsd) {
      throw new Error("SingIt maxPerCallUsd must not exceed maxPerDayUsd");
    }
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("SingIt baseUrl must be a valid HTTPS URL");
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    ) {
      throw new Error(
        "SingIt baseUrl must use https:// (http:// is allowed only for localhost or 127.0.0.1)",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Requests a model answer.
   *
   * @param walletProvider - Payment provider
   * @param args - Prompt and model
   * @returns JSON result with billing and charged amount
   */
  @CreateAction({
    name: "singit_ask",
    schema: AskSchema,
    description: `Buys a language-model answer from SingIt (https://ask.singitai.app) and pays for it in USDC on Base over x402, from the agent's wallet.
Takes a prompt and optionally a model id (see https://ask.singitai.app/v1/models; leave it empty for the default model). The model 'free/deepseek-v4.1-flash' answers a short prompt with no payment, within a small daily limit.
The provider never signs a price above its per-call ceiling or above what is left of today's ceiling, and the model cannot change the ceilings. If a price is refused, tell the user instead of retrying.
Returns the answer, the server's billing details and the amount charged for this call. A failed call may still have been charged: check the returned settlement details and do not blindly retry.`,
  })
  async ask(walletProvider: EvmWalletProvider, args: z.infer<typeof AskSchema>): Promise<string> {
    const model = args.model ?? DEFAULT_MODEL;
    return this.request(
      walletProvider,
      "/v1/chat/completions",
      { model, max_tokens: DEFAULT_MAX_TOKENS, messages: [{ role: "user", content: args.prompt }] },
      model.startsWith("free/"),
      false,
    );
  }

  /**
   * Requests web search results.
   *
   * @param walletProvider - Payment provider
   * @param args - Query and result count
   * @returns JSON search results and charges
   */
  @CreateAction({
    name: "singit_search",
    schema: SearchSchema,
    description: `Buys web search results from SingIt (https://ask.singitai.app) and pays for them in USDC on Base over x402, from the agent's wallet.
Takes a search query and optionally a number of results (1 to 25, default 5; results beyond 10 cost extra).
The provider never signs a price above its per-call ceiling or above what is left of today's ceiling. If a price is refused, tell the user instead of retrying.
Returns the ranked results, the server's billing details and the amount charged for this call. A failed call may still have been charged: check the returned settlement details and do not blindly retry.`,
  })
  async search(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof SearchSchema>,
  ): Promise<string> {
    return this.request(
      walletProvider,
      "/v1/exa/search",
      { query: args.query, numResults: args.numResults ?? 5 },
      false,
      true,
    );
  }

  /**
   * Reports local spending without a network request.
   *
   * @param _walletProvider - Unused payment provider
   * @param _args - Empty parameters
   * @returns JSON spending status
   */
  @CreateAction({
    name: "singit_spend_status",
    schema: SpendStatusSchema,
    description: `Shows how much this agent has spent through the SingIt provider today and how much of its per-call and per-day ceilings is left.
Free, makes no request. The counter lives in the agent process and resets at 00:00 UTC. Use it before a paid call if you are unsure whether the ceiling leaves room.`,
  })
  async spendStatus(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof SpendStatusSchema>,
  ): Promise<string> {
    this.resetDay();
    return JSON.stringify({ success: true, ...this.ceilings() });
  }

  /**
   * Checks Base mainnet support.
   *
   * @param network - Candidate network
   * @returns Whether the network is supported
   */
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.networkId === "base-mainnet";

  /**
   * Validates and floors a ceiling to atomic USDC.
   *
   * @param value - USD ceiling
   * @param name - Configuration field
   * @returns Floored atomic ceiling
   */
  private validateCeiling(value: number, name: string): bigint {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`SingIt ${name} must be a finite number greater than 0`);
    if (value >= 1e21) throw new Error(`SingIt ${name} must be less than 1e21`);
    const decimal = String(value);
    const atomic = decimal.includes("e") ? 0n : this.floorPaymentAtomic(decimal);
    if (atomic === 0n) throw new Error(`SingIt ${name} must be at least 0.000001`);
    return atomic;
  }

  /** Resets the counter when the UTC day changes. */
  private resetDay(): void {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spentAtomic = 0n;
    }
  }

  /**
   * Builds the current ceiling report.
   *
   * @returns Local spending status
   */
  private ceilings() {
    return {
      spentTodayUsd: Number(this.spentAtomic) / 1e6,
      remainingTodayUsd: Number(this.perDayAtomic - this.spentAtomic) / 1e6,
      maxPerCallUsd: Number(this.perCallAtomic) / 1e6,
      maxPerDayUsd: Number(this.perDayAtomic) / 1e6,
      day: this.day,
      resetsAt: new Date(Date.parse(`${this.day}T00:00:00.000Z`) + 86400000).toISOString(),
    };
  }

  /**
   * Serializes paid requests through one promise chain.
   *
   * @param walletProvider - Payment provider
   * @param path - API path
   * @param body - JSON request body
   * @param free - Whether signing and accounting are bypassed
   * @param search - Whether to extract search results
   * @returns JSON response
   */
  private async request(
    walletProvider: EvmWalletProvider,
    path: string,
    body: Record<string, unknown>,
    free: boolean,
    search: boolean,
  ): Promise<string> {
    if (!(walletProvider instanceof EvmWalletProvider))
      return JSON.stringify({ error: true, message: "Unsupported wallet provider" });
    if (free) return this.performRequest(walletProvider, path, body, true, search);
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await this.performRequest(walletProvider, path, body, false, search);
    } finally {
      release();
    }
  }

  /**
   * Performs a single request and accounts for its signed flat price.
   *
   * @param walletProvider - Payment provider
   * @param path - API path
   * @param body - Request body
   * @param free - Whether to bypass payments
   * @param search - Whether to return search results
   * @returns JSON response
   */
  private async performRequest(
    walletProvider: EvmWalletProvider,
    path: string,
    body: Record<string, unknown>,
    free: boolean,
    search: boolean,
  ): Promise<string> {
    if (!free) this.resetDay();
    const remaining = this.perDayAtomic - this.spentAtomic;
    const allowedAtomic = remaining < this.perCallAtomic ? remaining : this.perCallAtomic;
    let signedAtomic = 0n;
    let chargedAtomic = 0n;
    let settlement: Record<string, string | boolean> | undefined;
    let counted = false;
    let paymentCreated = false;
    let knownUncharged = false;
    try {
      let requestFetch = fetch;
      if (!free) {
        const client = new x402Client();
        const account = walletProvider.toSigner();
        registerExactEvmScheme(client, {
          signer: {
            ...account,
            readContract: args =>
              walletProvider.readContract({
                ...args,
                abi: args.abi as never,
                functionName: args.functionName as never,
                args: args.args as never,
              }),
          },
        });
        const networks = getX402Networks(walletProvider.getNetwork());
        client.registerPolicy((_version, requirements) =>
          requirements.filter(
            requirement =>
              requirement.scheme === "exact" &&
              networks.includes(requirement.network) &&
              isUsdcAsset(requirement.asset, walletProvider) &&
              /^\d+$/.test(requirement.amount) &&
              BigInt(requirement.amount) <= allowedAtomic,
          ),
        );
        client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
          if (
            !/^\d+$/.test(selectedRequirements.amount) ||
            BigInt(selectedRequirements.amount) > allowedAtomic
          )
            return { abort: true, reason: "SingIt price exceeds the configured ceiling" };
        });
        client.onAfterPaymentCreation(async ({ selectedRequirements }) => {
          signedAtomic = BigInt(selectedRequirements.amount);
          paymentCreated = true;
        });
        requestFetch = wrapFetchWithPayment(fetch, client);
      }
      const response = await requestFetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      settlement = this.readSettlement(response);
      const outcomeUnknown =
        !response.ok &&
        settlement?.success !== true &&
        (response.status === 502 ||
          response.status === 504 ||
          (response.status >= 520 && response.status <= 530));
      if (response.ok || settlement?.success === true || outcomeUnknown)
        chargedAtomic = signedAtomic;
      // Gateway failures are uncharged unless a proxy/edge failure leaves settlement uncertain.
      knownUncharged = !response.ok && settlement?.success !== true && !outcomeUnknown;
      const text = await response.text();
      // Commit once the body is readable; failures count the signed price in the catch path.
      if (!free) {
        this.resetDay();
        this.spentAtomic += chargedAtomic;
      }
      counted = true;
      let data: Record<string, unknown> | undefined;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      const charges = {
        chargedAtomic: chargedAtomic.toString(),
        chargedUsd: Number(chargedAtomic) / 1e6,
      };
      if (!response.ok)
        return JSON.stringify({
          error: true,
          message: `SingIt returned status ${response.status}${outcomeUnknown ? "; outcome unknown, counted against today's ceiling" : ""}. A failed call may still have been charged; check settlement and do not blindly retry.`,
          details: data ?? text.slice(0, 500),
          paymentError: this.readPaymentError(response),
          settlement,
          ...charges,
        });
      const choices = data?.choices as Array<{ message?: { content?: unknown } }> | undefined;
      if (!search && typeof choices?.[0]?.message?.content !== "string")
        return JSON.stringify({
          error: true,
          message: "SingIt returned a response without an answer",
          billing: data?.billing,
          settlement,
          ...charges,
        });
      return JSON.stringify({
        success: true,
        ...(search
          ? { results: data?.results ?? data }
          : { answer: choices?.[0]?.message?.content, model: data?.model ?? body.model }),
        billing: data?.billing,
        settlement,
        ...charges,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (paymentCreated && !knownUncharged) {
        this.resetDay();
        this.spentAtomic += signedAtomic - (counted ? chargedAtomic : 0n);
        chargedAtomic = signedAtomic;
      }
      if (
        !paymentCreated &&
        message.includes("All payment requirements were filtered out by policies")
      )
        return JSON.stringify({
          error: true,
          refused: true,
          message:
            "SingIt quoted a price above your per-call or remaining daily ceiling, so nothing was signed",
          ...this.ceilings(),
          chargedAtomic: "0",
          chargedUsd: 0,
        });
      return JSON.stringify({
        error: true,
        message: `SingIt request failed: ${message}${paymentCreated && !knownUncharged ? "; outcome unknown, counted against today's ceiling" : ""}. A failed call may still have been charged; check settlement and do not blindly retry.`,
        settlement,
        chargedAtomic: chargedAtomic.toString(),
        chargedUsd: Number(chargedAtomic) / 1e6,
      });
    }
  }

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
}

/**
 * Creates a provider with required client-side ceilings.
 *
 * @param config - Required spending configuration
 * @returns Configured SingIt provider
 */
export const singitActionProvider = (config: SingItConfig) => new SingItActionProvider(config);
