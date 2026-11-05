# SingIt action provider

Buy LLM answers and web search results over x402 using USDC on Base mainnet.

## Structure

- `singitActionProvider.ts`: actions, payment policy, and spending accounting.
- `schemas.ts`: action schemas and required `SingItConfig`.
- `constants.ts`: gateway, model, token budget, and request constants.
- `index.ts`: public exports.
- `singitActionProvider.test.ts`: mocked payment and accounting tests.

## Actions

| Action | Description |
| --- | --- |
| `singit_ask` | Ask a model a question (1–20000 characters), with an 800-token budget. Null model selects `deepseek-v4.1-flash`. `free/deepseek-v4.1-flash` needs no payment. |
| `singit_search` | Search the web (1–2000 characters), requesting 1–25 results; null defaults to 5. Results beyond 10 cost extra. |
| `singit_spend_status` | Read local spending, remaining budget, ceilings, UTC day, and next reset without a network request. |

Answers and searches report server billing separately from `chargedAtomic` (USDC micro-units as a string) and `chargedUsd` for the call.

## Setup

```typescript
import { singitActionProvider } from "@coinbase/agentkit";

const provider = singitActionProvider({ maxPerCallUsd: 0.05, maxPerDayUsd: 1 });
```

Both ceilings are required finite positive numbers, with the per-call ceiling no greater than the daily ceiling. Values are floored to six decimal places and must represent at least 0.000001 USD. Optional `baseUrl` defaults to `https://ask.singitai.app`; HTTPS is required except for HTTP localhost or 127.0.0.1 development servers.

## Spending ceilings

Ceilings are enforced in the agent process (client-side) and cover only calls made through this provider. The counter is in memory: a restart resets it. The daily window resets at 00:00 UTC. All paid calls share a queue to prevent concurrent calls from exceeding the daily ceiling.

Only exact USDC offers on the supported network within the per-call and remaining daily ceilings are eligible for signing. A second check runs before payment creation. Free-model calls cost zero and never change the counter.

Successful HTTP responses count the signed flat price, independently of server billing. Failed HTTP responses without a successful PAYMENT-RESPONSE settlement count zero, except for proxy/edge statuses 502, 504, and 520–530. Those statuses conservatively count the signed amount against the daily ceiling and report "outcome unknown, counted against today's ceiling". Other failures, including 400 and 503, count zero because the gateway never settles an answer of 400 or above. A thrown error after payment creation, including a timeout or unreadable body, counts the signed amount conservatively because the outcome is unknown. Errors before signing count zero. A failed call may still have been charged; check settlement and do not blindly retry. The provider never retries automatically.

## Network support

Base mainnet only (`evm`, `base-mainnet`).

## Links

- [SingIt documentation](https://ask.singitai.app/llms.txt)
- [Model catalog](https://ask.singitai.app/v1/models)
- [First paid call guide](https://github.com/SingItAi/SingItAI/blob/main/docs/first-paid-call.md)
