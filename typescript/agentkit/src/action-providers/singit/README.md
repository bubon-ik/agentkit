# SingIt Action Provider

This directory contains the **SingitActionProvider**, which lets an agent buy language-model answers from [SingIt Ask](https://ask.singitai.app), an x402 gateway. Each call is paid in USDC on Base or Solana with the agent's own wallet. There is no account and no API key.

## Directory Structure

```
singit/
├── singitActionProvider.ts       # Provider with the list_models and ask actions
├── singitActionProvider.test.ts  # Unit tests
├── schemas.ts                    # Action schemas and configuration type
├── index.ts                      # Main exports
└── README.md                     # This file
```

## Actions

| Action        | Description                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `list_models` | Lists the models SingIt Ask serves with their ids and prices. Free.                                  |
| `ask`         | Sends a prompt to a model and pays for the answer over x402. Returns the answer and what was charged. |

`ask` accepts a `prompt`, and optionally a `model`, a `system` message and `maxTokens` (1 to 1200, default 800). The price grows with the model and with `maxTokens`. The model id `free/deepseek-v4.1-flash` answers without any payment, up to 400 tokens, within a daily limit per network.

## Setup

```typescript
import { AgentKit, singitActionProvider } from "@coinbase/agentkit";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [singitActionProvider()],
});
```

The wallet provider must be an `EvmWalletProvider` on `base-mainnet` or an `SvmWalletProvider` on `solana-mainnet`, funded with USDC. The wallet pays the USDC amount of the answer, plus a small settlement fee, as shown in the offer.

## Configuration

```typescript
import { singitActionProvider, SingitConfig } from "@coinbase/agentkit";

const config: SingitConfig = {
  // Maximum payment per call in USDC whole units.
  // Default: 0.05 (or the SINGIT_MAX_PAYMENT_USDC env var)
  maxPaymentUsdc: 0.05,
};

const provider = singitActionProvider(config);
```

An offer above `maxPaymentUsdc` is never signed. The provider signs only USDC offers on the wallet's own network, and only `exact` ones, a flat price for the call; SingIt also lists a metered `upto` offer, which this provider does not use. For Claude Opus models the flat price includes room for thinking tokens and is usually dearer than the answer used, so prefer other models here.

## Network Support

- `base-mainnet`
- `solana-mainnet`

Testnets are not supported.

## Links

- Models and prices: https://ask.singitai.app/v1/models
- Service description for agents: https://ask.singitai.app/llms.txt
- First paid call walkthrough: https://github.com/bubon-ik/SingItAI/blob/main/docs/first-paid-call.md
