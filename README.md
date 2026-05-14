# Halo Mint Bot

Adaptive EVM NFT mint bot for FCFS competition scenarios.

## What it does

- Loads up to 5 competition wallets from `.env`
- Connects to one primary RPC and multiple broadcast RPC endpoints
- Waits in `standby` mode until a trigger is active
- Arms a timed mint a few seconds early, then fires on the exact target clock
- Signs locally and broadcasts the same raw transaction to many RPCs in parallel
- Uses different fee profiles per wallet
- Replaces pending transactions with higher fees automatically
- Pre-signs a replacement ladder before mint opens when using timed standby

## Core commands

```bash
npm.cmd install
npm.cmd run build
npm.cmd run bot -- validate --target ./targets/manual-contract.sample.json
npm.cmd run bot -- rehearse --target ./targets/manual-contract.sample.json
npm.cmd run bot -- status --target ./targets/manual-contract.sample.json
npm.cmd run bot -- standby --target ./targets/manual-contract.sample.json
npm.cmd run bot -- fire --target ./targets/manual-contract.sample.json
```

## Files you will edit most often

- `.env`
- `targets/*.json`

## Target modes

### `contractWrite`

Use this when you know the contract address, ABI, function name, and arguments.

### `rawTransaction`

Use this when you already have the final calldata and only need the bot to sign and blast it fast.

This mode is the universal fallback for unusual launchpads, proxy routers, and marketplace routes.

## Competition fee mode

For a practical FCFS setup, use `budgetAggressive` and set:

- `targetUsd`: your per-wallet fee target such as `2.5`
- `assumedNativePriceUsd`: your estimate of the gas token price
- `minFeeFloorGwei`: minimum floor so the bot still shoots hard even if the USD math is too low
- `maxFeeCapGwei`: optional ceiling so it does not overshoot your budget too much

This is still an estimate. Real gas paid can be lower or higher depending on chain conditions.

## Trigger modes

- `manual`: use with the `fire` command
- `time`: bot fires at an exact ISO timestamp
- `block`: bot fires once the configured block number is reached
- `read`: bot polls a contract read until the expected condition is true

## Time trigger tuning

Inside the `time` trigger you can optionally set:

- `armBeforeMs`: how early the bot prepares signed transactions before mint opens
- `countdownIntervalMs`: how often the bot prints countdown notices
- `finalSpinWindowMs`: the final high-precision timing window before broadcast

Recommended starting values:

```json
{
  "mode": "time",
  "startTimeIso": "2026-05-14T15:00:00.000Z",
  "pollIntervalMs": 200,
  "armBeforeMs": 4000,
  "countdownIntervalMs": 15000,
  "finalSpinWindowMs": 125
}
```

## Rehearsal mode

Use `rehearse` to test the critical fire path without broadcasting live transactions.

It will:

- build the full pre-signed replacement ladder
- warm up the broadcast RPC endpoints
- print the signed transaction hashes for each round

This is the safest operational test before the real event.

## Safety

- Use only the 5 wallets provided by the competition
- Do not store your primary wallet here
- Keep `.env` private
