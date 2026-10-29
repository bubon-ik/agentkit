import { SingitActionProvider, singitActionProvider } from "./singitActionProvider";
import { EvmWalletProvider, SvmWalletProvider } from "../../wallet-providers";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";

jest.mock("@x402/fetch");
jest.mock("@x402/evm/exact/client");
jest.mock("@x402/svm/exact/client");

const mockFetch = jest.fn();
const mockFetchWithPayment = jest.fn();
const mockRegisterPolicy = jest.fn();
const mockX402Client = { registerPolicy: mockRegisterPolicy };

jest
  .mocked(x402Client)
  .mockImplementation(() => mockX402Client as unknown as InstanceType<typeof x402Client>);
jest.mocked(wrapFetchWithPayment).mockReturnValue(mockFetchWithPayment);
global.fetch = mockFetch;

const makeEvmWallet = () => {
  const wallet = Object.create(EvmWalletProvider.prototype);
  wallet.toSigner = jest.fn().mockReturnValue({ address: "0xabc" });
  wallet.readContract = jest.fn();
  wallet.getNetwork = jest
    .fn()
    .mockReturnValue({ protocolFamily: "evm", networkId: "base-mainnet" });
  return wallet as EvmWalletProvider;
};

const makeSvmWallet = () => {
  const wallet = Object.create(SvmWalletProvider.prototype);
  wallet.toSigner = jest.fn().mockResolvedValue({ address: "svm-signer" });
  wallet.getNetwork = jest
    .fn()
    .mockReturnValue({ protocolFamily: "svm", networkId: "solana-mainnet" });
  return wallet as SvmWalletProvider;
};

const makeResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: jest.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ANSWER = {
  id: "chatcmpl-1",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello!" } }],
  billing: { totalAtomic: "1008", currency: "USDC" },
};

describe("SingitActionProvider", () => {
  let provider: SingitActionProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SINGIT_MAX_PAYMENT_USDC;
    jest.mocked(wrapFetchWithPayment).mockReturnValue(mockFetchWithPayment);
    provider = new SingitActionProvider();
  });

  describe("constructor", () => {
    it("exposes a factory", () => {
      expect(singitActionProvider()).toBeInstanceOf(SingitActionProvider);
    });

    it("rejects a negative payment limit", () => {
      expect(() => new SingitActionProvider({ maxPaymentUsdc: -1 })).toThrow();
    });

    it("rejects a non-numeric payment limit from the environment", () => {
      process.env.SINGIT_MAX_PAYMENT_USDC = "abc";
      expect(() => new SingitActionProvider()).toThrow();
    });
  });

  describe("supportsNetwork", () => {
    it("supports Base and Solana mainnet", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" })).toBe(
        true,
      );
      expect(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" })).toBe(
        true,
      );
    });

    it("does not support testnets or other networks", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-sepolia" })).toBe(
        false,
      );
      expect(
        provider.supportsNetwork({ protocolFamily: "evm", networkId: "ethereum-mainnet" }),
      ).toBe(false);
      expect(provider.supportsNetwork({ protocolFamily: "evm" })).toBe(false);
    });
  });

  describe("list_models", () => {
    it("returns the models with prices and no unrelated fields", async () => {
      mockFetch.mockResolvedValue(
        makeResponse(200, {
          data: [
            {
              id: "deepseek-v4.1-flash",
              name: "DeepSeek V4.1 Flash",
              tags: ["reasoning"],
              singitUsdPerMillionTokens: { input: 0.1, output: 0.2 },
              owned_by: "DeepSeek",
            },
            { id: "free/deepseek-v4.1-flash", free: true },
          ],
        }),
      );

      const result = JSON.parse(await provider.listModels(makeEvmWallet(), {}));

      expect(mockFetch).toHaveBeenCalledWith(
        "https://ask.singitai.app/v1/models",
        expect.any(Object),
      );
      expect(result.success).toBe(true);
      expect(result.models).toHaveLength(2);
      expect(result.models[0]).toMatchObject({
        id: "deepseek-v4.1-flash",
        usdPerMillionTokens: { input: 0.1, output: 0.2 },
      });
      expect(result.models[0].owned_by).toBeUndefined();
      expect(result.models[1].free).toBe(true);
    });

    it("reports a non-200 status", async () => {
      mockFetch.mockResolvedValue(makeResponse(503, "down"));
      const result = JSON.parse(await provider.listModels(makeEvmWallet(), {}));
      expect(result.error).toBe(true);
      expect(result.message).toContain("503");
    });

    it("reports a network failure", async () => {
      mockFetch.mockRejectedValue(new Error("boom"));
      const result = JSON.parse(await provider.listModels(makeEvmWallet(), {}));
      expect(result.error).toBe(true);
      expect(result.message).toContain("boom");
    });
  });

  describe("ask", () => {
    const args = { prompt: "Hello", model: null, system: null, maxTokens: null };

    it("pays with an EVM wallet and returns the answer and billing", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(registerExactEvmScheme).toHaveBeenCalled();
      expect(registerExactSvmScheme).not.toHaveBeenCalled();
      expect(mockFetchWithPayment).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetchWithPayment.mock.calls[0];
      expect(url).toBe("https://ask.singitai.app/v1/chat/completions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        model: "deepseek-v4.1-flash",
        max_tokens: 800,
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result).toEqual({
        success: true,
        model: "deepseek-v4.1-flash",
        answer: "Hello!",
        billing: { totalAtomic: "1008", currency: "USDC" },
      });
    });

    it("pays with a Solana wallet", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));

      const result = JSON.parse(await provider.ask(makeSvmWallet(), args));

      expect(registerExactSvmScheme).toHaveBeenCalled();
      expect(registerExactEvmScheme).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("sends the system message, model and token limit", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));

      await provider.ask(makeEvmWallet(), {
        prompt: "Hi",
        model: "gpt-5.5",
        system: "Be brief.",
        maxTokens: 100,
      });

      const body = JSON.parse(mockFetchWithPayment.mock.calls[0][1].body);
      expect(body.model).toBe("gpt-5.5");
      expect(body.max_tokens).toBe(100);
      expect(body.messages).toEqual([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ]);
    });

    it("registers a policy that only signs exact offers within the limit", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));
      provider = new SingitActionProvider({ maxPaymentUsdc: 0.01 });

      await provider.ask(makeEvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const offer = (over: Record<string, string>) => ({
        scheme: "exact",
        network: "eip155:8453",
        asset: BASE_USDC,
        amount: "1500",
        ...over,
      });
      const offers = [
        offer({ scheme: "upto" }),
        offer({}),
        offer({ amount: "10000" }),
        offer({ amount: "10001" }),
        offer({ amount: "-1" }),
        offer({ network: "eip155:1" }),
        offer({ asset: "0x0000000000000000000000000000000000000001" }),
      ];
      expect(policy(2, offers)).toEqual([offer({}), offer({ amount: "10000" })]);
    });

    it("takes the payment limit from the environment", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));
      process.env.SINGIT_MAX_PAYMENT_USDC = "0.002";
      provider = new SingitActionProvider();

      await provider.ask(makeEvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const offer = (amount: string) => ({
        scheme: "exact",
        network: "eip155:8453",
        asset: BASE_USDC,
        amount,
      });
      expect(policy(2, [offer("2001")])).toEqual([]);
      expect(policy(2, [offer("2000")])).toHaveLength(1);
    });

    it("never rounds the payment limit up", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));
      provider = new SingitActionProvider({ maxPaymentUsdc: 0.0000006 });

      await provider.ask(makeEvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const offer = { scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "1" };
      expect(policy(2, [offer])).toEqual([]);
    });

    it("truncates the payment limit to whole micro-USDC", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));
      provider = new SingitActionProvider({ maxPaymentUsdc: 0.0000019 });

      await provider.ask(makeEvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const offer = (amount: string) => ({
        scheme: "exact",
        network: "eip155:8453",
        asset: BASE_USDC,
        amount,
      });
      expect(policy(2, [offer("1")])).toHaveLength(1);
      expect(policy(2, [offer("2")])).toEqual([]);
    });

    it("keeps a limit such as 0.07 exact", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));
      provider = new SingitActionProvider({ maxPaymentUsdc: 0.07 });

      await provider.ask(makeEvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const offer = (amount: string) => ({
        scheme: "exact",
        network: "eip155:8453",
        asset: BASE_USDC,
        amount,
      });
      expect(policy(2, [offer("70000")])).toHaveLength(1);
      expect(policy(2, [offer("70001")])).toEqual([]);
    });

    it("only signs Solana USDC offers for a Solana wallet", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, ANSWER));

      await provider.ask(makeSvmWallet(), args);

      const policy = mockRegisterPolicy.mock.calls[0][0];
      const solana = {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: SOLANA_USDC,
        amount: "2002",
      };
      expect(policy(2, [solana])).toEqual([solana]);
      expect(policy(2, [{ ...solana, asset: "SomeOtherMint" }])).toEqual([]);
      expect(policy(2, [{ ...solana, network: "eip155:8453", asset: BASE_USDC }])).toEqual([]);
    });

    it("returns an error for a non-200 answer", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(402, { error: "Payment required" }));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
      expect(result.message).toContain("402");
      expect(result.details).toEqual({ error: "Payment required" });
    });

    it("surfaces the reason from the PAYMENT-REQUIRED header on a refused payment", async () => {
      const header = btoa(JSON.stringify({ x402Version: 2, error: "insufficient_funds" }));
      mockFetchWithPayment.mockResolvedValue(makeResponse(402, {}, { "payment-required": header }));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
      expect(result.paymentError).toBe("insufficient_funds");
    });

    it("returns an error for a non-JSON failure", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(502, "bad gateway"));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
      expect(result.details).toBe("bad gateway");
    });

    it("returns an error when the payment client throws", async () => {
      mockFetchWithPayment.mockRejectedValue(new Error("No supported payment option"));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
      expect(result.message).toContain("No supported payment option");
    });

    it("returns an error when a 200 response has no answer", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, { billing: { totalAtomic: "5" } }));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
      expect(result.success).toBeUndefined();
      expect(result.billing).toEqual({ totalAtomic: "5" });
    });

    it("returns an error when a 200 response is not JSON", async () => {
      mockFetchWithPayment.mockResolvedValue(makeResponse(200, "<html></html>"));

      const result = JSON.parse(await provider.ask(makeEvmWallet(), args));

      expect(result.error).toBe(true);
    });

    it("rejects an unsupported wallet provider", async () => {
      const result = JSON.parse(await provider.ask({} as never, args));

      expect(result.error).toBe(true);
      expect(result.message).toBe("Unsupported wallet provider");
      expect(mockFetchWithPayment).not.toHaveBeenCalled();
    });
  });
});
