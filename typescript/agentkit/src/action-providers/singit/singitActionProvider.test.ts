import { SingItActionProvider, singitActionProvider } from "./singitActionProvider";
import { AskSchema, SearchSchema, SingItConfig } from "./schemas";
import { EvmWalletProvider } from "../../wallet-providers";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";

jest.mock("@x402/fetch");
jest.mock("@x402/evm/exact/client");
const mockPolicy = jest.fn();
const mockBefore = jest.fn();
const mockAfter = jest.fn();
const mockSign = jest.fn();
const mockFetch = jest.fn();
const mockPaid = jest.fn();
const offer = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "40000",
};
const answer = {
  model: "deepseek-v4.1-flash",
  choices: [{ message: { content: "Hello" } }],
  billing: { totalAtomic: "7" },
};
const args = { prompt: "Hello", model: null };
/**
 * Creates a mock response.
 *
 * @param status - HTTP status
 * @param body - Response body
 * @param headers - HTTP headers
 * @returns Mock response
 */
const response = (
  status = 200,
  body: unknown = answer,
  headers: Record<string, string> = {},
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as Response;
/**
 * Encodes a header as UTF-8 base64.
 *
 * @param value - Header object
 * @returns Encoded header
 */
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
/**
 * Simulates a 402 negotiation followed by a response or exception.
 *
 * @param amount - Quoted price
 * @param result - Result after payment creation
 */
const handshake = (amount = "40000", result: Response | Error = response()) => {
  let requests = 0;
  mockFetch.mockReset().mockImplementation(async () => {
    requests += 1;
    if (requests % 2 === 1)
      return response(
        402,
        {},
        { "PAYMENT-REQUIRED": encode({ x402Version: 2, accepts: [{ ...offer, amount }] }) },
      );
    if (result instanceof Error) throw result;
    return result;
  });
  mockPaid.mockImplementation(async (url, init) => {
    const initial = await mockFetch(url, init);
    expect(initial.status).toBe(402);
    const requirements = mockPolicy.mock.calls[mockPolicy.mock.calls.length - 1][0](2, [
      { ...offer, amount },
    ]);
    if (!requirements.length)
      throw new Error("All payment requirements were filtered out by policies...");
    const context = { selectedRequirements: requirements[0] };
    const decision = await mockBefore.mock.calls[mockBefore.mock.calls.length - 1][0](context);
    if (decision?.abort) throw new Error(decision.reason);
    mockSign();
    await mockAfter.mock.calls[mockAfter.mock.calls.length - 1][0](context);
    return mockFetch(url, init);
  });
};

describe("SingIt", () => {
  let provider: SingItActionProvider;
  const wallet = Object.create(EvmWalletProvider.prototype);
  wallet.toSigner = jest.fn().mockReturnValue({});
  wallet.readContract = jest.fn();
  wallet.getNetwork = jest
    .fn()
    .mockReturnValue({ protocolFamily: "evm", networkId: "base-mainnet" });
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaid.mockReset();
    jest.mocked(x402Client).mockImplementation(
      () =>
        ({
          registerPolicy: mockPolicy,
          onBeforePaymentCreation: mockBefore,
          onAfterPaymentCreation: mockAfter,
        }) as unknown as x402Client,
    );
    jest.mocked(wrapFetchWithPayment).mockReturnValue(mockPaid);
    global.fetch = mockFetch;
    provider = singitActionProvider({ maxPerCallUsd: 0.05, maxPerDayUsd: 0.08 });
    handshake();
  });
  afterEach(() => jest.useRealTimers());
  it("refuses an excessive quote without signing or counting", async () => {
    handshake("50001");
    expect(JSON.parse(await provider.ask(wallet, args))).toMatchObject({
      refused: true,
      chargedAtomic: "0",
    });
    expect(mockSign).not.toHaveBeenCalled();
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0);
  });
  it.each([false, true])("enforces daily totals, concurrent=%s", async concurrent => {
    const results = concurrent
      ? await Promise.all([
          provider.ask(wallet, args),
          provider.ask(wallet, args),
          provider.ask(wallet, args),
        ])
      : [
          await provider.ask(wallet, args),
          await provider.ask(wallet, args),
          await provider.ask(wallet, args),
        ];
    expect(results.map(value => JSON.parse(value).chargedAtomic)).toEqual(["40000", "40000", "0"]);
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0.08);
  });
  it("returns an answer and sends the fixed request", async () => {
    expect(JSON.parse(await provider.ask(wallet, args))).toMatchObject({
      success: true,
      answer: "Hello",
      model: answer.model,
      billing: answer.billing,
      chargedAtomic: "40000",
      chargedUsd: 0.04,
    });
    expect(mockPaid.mock.calls[0][0]).toBe("https://ask.singitai.app/v1/chat/completions");
    expect(JSON.parse(mockPaid.mock.calls[0][1].body)).toEqual({
      model: answer.model,
      max_tokens: 800,
      messages: [{ role: "user", content: "Hello" }],
    });
  });
  it("passes through search results and uses the configured URL", async () => {
    provider = singitActionProvider({
      maxPerCallUsd: 0.05,
      maxPerDayUsd: 1,
      baseUrl: "http://localhost:3000/",
    });
    const results = [{ title: "é", extra: [1] }];
    handshake("40000", response(200, { results, billing: { price: 1 } }));
    expect(
      JSON.parse(await provider.search(wallet, { query: "q", numResults: null })),
    ).toMatchObject({ results, billing: { price: 1 }, chargedAtomic: "40000" });
    expect(mockPaid.mock.calls[0][0]).toBe("http://localhost:3000/v1/exa/search");
    expect(JSON.parse(mockPaid.mock.calls[0][1].body)).toEqual({ query: "q", numResults: 5 });
  });
  it.each([false, true])(
    "counts HTTP failures only when settlement succeeds: %s",
    async success => {
      handshake(
        "40000",
        response(
          503,
          {},
          {
            "PAYMENT-RESPONSE": encode({ success, errorReason: "échec" }),
            "PAYMENT-REQUIRED": encode({ error: "支付失败" }),
          },
        ),
      );
      expect(JSON.parse(await provider.ask(wallet, args))).toMatchObject({
        chargedAtomic: success ? "40000" : "0",
        settlement: { success, errorReason: "échec" },
        paymentError: "支付失败",
      });
      expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(
        success ? 0.04 : 0,
      );
    },
  );
  it.each([503, 502, 504, 524, 400, 519, 520, 530, 531])(
    "accounts for unsettled HTTP status %s",
    async status => {
      const uncertain = [502, 504, 524, 520, 530].includes(status);
      handshake("40000", response(status));
      const result = JSON.parse(await provider.ask(wallet, args));
      expect(result.chargedAtomic).toBe(uncertain ? "40000" : "0");
      expect(result.chargedUsd).toBe(uncertain ? 0.04 : 0);
      expect(result.message.includes("outcome unknown, counted against today's ceiling")).toBe(
        uncertain,
      );
      expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(
        uncertain ? 0.04 : 0,
      );
    },
  );
  it.each([502, 504, 524])("counts unreadable proxy failure %s once", async status => {
    const res = response(status);
    jest.mocked(res.text).mockRejectedValue(new Error("unreadable"));
    handshake("40000", res);
    const result = JSON.parse(await provider.ask(wallet, args));
    expect(result.chargedAtomic).toBe("40000");
    expect(result.message).toContain("outcome unknown, counted against today's ceiling");
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0.04);
  });
  it("counts exceptions after signing conservatively", async () => {
    handshake("40000", new Error("timeout"));
    expect(JSON.parse(await provider.ask(wallet, args)).message).toContain(
      "outcome unknown, counted against today's ceiling",
    );
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0.04);
  });
  it("counts unreadable responses once", async () => {
    const res = response();
    jest.mocked(res.text).mockRejectedValue(new Error("unreadable"));
    handshake("40000", res);
    expect(JSON.parse(await provider.ask(wallet, args)).chargedAtomic).toBe("40000");
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0.04);
  });
  it("counts nothing before signing", async () => {
    mockPaid.mockRejectedValue(new Error("offline"));
    expect(JSON.parse(await provider.ask(wallet, args)).chargedAtomic).toBe("0");
  });
  it("bypasses payments for the free model", async () => {
    mockFetch.mockResolvedValue(response());
    expect(
      JSON.parse(await provider.ask(wallet, { ...args, model: "free/deepseek-v4.1-flash" }))
        .chargedAtomic,
    ).toBe("0");
    expect(x402Client).not.toHaveBeenCalled();
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0);
  });
  it("filters invalid offers and guards payment creation", async () => {
    await provider.ask(wallet, args);
    for (const override of [
      { scheme: "upto" },
      { network: "eip155:1" },
      { asset: "other" },
      { amount: "-1" },
      { amount: "1.5" },
    ])
      expect(mockPolicy.mock.calls[0][0](2, [{ ...offer, ...override }])).toEqual([]);
    expect(
      await mockBefore.mock.calls[0][0]({ selectedRequirements: { ...offer, amount: "50001" } }),
    ).toMatchObject({ abort: true });
  });
  it("keeps 0.07 exact", async () => {
    provider = singitActionProvider({ maxPerCallUsd: 0.07, maxPerDayUsd: 1 });
    handshake("70000");
    expect(JSON.parse(await provider.ask(wallet, args)).chargedAtomic).toBe("70000");
    expect(mockPolicy.mock.calls[0][0](2, [{ ...offer, amount: "70001" }])).toEqual([]);
  });
  it.each([undefined, 0, -1, NaN, Infinity])("rejects invalid ceilings %s", value => {
    expect(() =>
      singitActionProvider({ maxPerCallUsd: value, maxPerDayUsd: 1 } as SingItConfig),
    ).toThrow();
    expect(() =>
      singitActionProvider({ maxPerCallUsd: 0.05, maxPerDayUsd: value } as SingItConfig),
    ).toThrow();
  });
  it("rejects missing config, reversed limits, and invalid scales", () => {
    expect(() => singitActionProvider(undefined as never)).toThrow();
    expect(() => singitActionProvider({ maxPerCallUsd: 2, maxPerDayUsd: 1 })).toThrow();
    expect(() => singitActionProvider({ maxPerCallUsd: 1e21, maxPerDayUsd: 1e21 })).toThrow(
      "less than 1e21",
    );
    expect(() => singitActionProvider({ maxPerCallUsd: 0.0000009999999, maxPerDayUsd: 1 })).toThrow(
      "must be at least 0.000001",
    );
  });
  it.each(["bad", "http://example.com", "ftp://localhost"])("rejects URL %s", baseUrl => {
    expect(() => singitActionProvider({ maxPerCallUsd: 1, maxPerDayUsd: 1, baseUrl })).toThrow();
  });
  it("supports Base mainnet only", () => {
    expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" })).toBe(
      true,
    );
    for (const networkId of ["base-sepolia", "ethereum-mainnet", "solana-mainnet"])
      expect(provider.supportsNetwork({ protocolFamily: "evm", networkId })).toBe(false);
    expect(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" })).toBe(
      false,
    );
  });
  it("reports local status and resets at midnight UTC", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-05T23:59:59Z"));
    await provider.ask(wallet, args);
    expect(JSON.parse(await provider.spendStatus(wallet, {}))).toEqual({
      success: true,
      spentTodayUsd: 0.04,
      remainingTodayUsd: 0.04,
      maxPerCallUsd: 0.05,
      maxPerDayUsd: 0.08,
      day: "2026-11-05",
      resetsAt: "2026-11-06T00:00:00.000Z",
    });
    jest.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    expect(JSON.parse(await provider.spendStatus(wallet, {}))).toMatchObject({
      spentTodayUsd: 0,
      day: "2026-11-06",
    });
    expect(mockPaid).toHaveBeenCalledTimes(1);
  });
  it.each(["not base64!", encode(null), encode([])])(
    "ignores malformed settlement %s",
    async header => {
      handshake("1", response(200, answer, { "payment-response": header }));
      expect(JSON.parse(await provider.ask(wallet, args)).settlement).toBeUndefined();
    },
  );
  it("rejects non-EVM providers", async () => {
    expect(JSON.parse(await provider.ask({} as never, args)).error).toBe(true);
    expect(mockPaid).not.toHaveBeenCalled();
  });
  it("returns the parsed search body if results are absent", async () => {
    handshake("1", response(200, { value: [1, 2] }));
    expect(
      JSON.parse(await provider.search(wallet, { query: "q", numResults: 2 })).results,
    ).toEqual({ value: [1, 2] });
  });
  it("floors fractional atomic units without rounding", async () => {
    provider = singitActionProvider({ maxPerCallUsd: 0.0000019, maxPerDayUsd: 1 });
    handshake("1");
    expect(JSON.parse(await provider.ask(wallet, args)).chargedAtomic).toBe("1");
    expect(mockPolicy.mock.calls[0][0](2, [{ ...offer, amount: "2" }])).toEqual([]);
  });
  it("validates prompt and search schema boundaries", () => {
    for (const prompt of ["", "x".repeat(20001)])
      expect(AskSchema.safeParse({ prompt, model: null }).success).toBe(false);
    for (const query of ["", "x".repeat(2001)])
      expect(SearchSchema.safeParse({ query, numResults: null }).success).toBe(false);
    for (const numResults of [0, 26, 1.5])
      expect(SearchSchema.safeParse({ query: "q", numResults }).success).toBe(false);
    expect(SearchSchema.safeParse({ query: "q", numResults: 25 }).success).toBe(true);
  });
  it("does not count an unsettled failure whose body cannot be read", async () => {
    const res = response(503);
    jest.mocked(res.text).mockRejectedValue(new Error("unreadable"));
    handshake("40000", res);
    expect(JSON.parse(await provider.ask(wallet, args)).chargedAtomic).toBe("0");
    expect(JSON.parse(await provider.spendStatus(wallet, {})).spentTodayUsd).toBe(0);
  });
  it("treats every free/ model id as free", async () => {
    mockFetch.mockResolvedValue(response());
    await provider.ask(wallet, { ...args, model: "free/other-model" });
    expect(x402Client).not.toHaveBeenCalled();
  });
});
