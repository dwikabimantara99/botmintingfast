# Halo Mint Bot

High-speed EVM mint bot for FCFS scenarios.

## Fokus Bot

Bot ini dibangun untuk alur inti berikut:

1. load wallet EVM dari `.env`
2. load target mint dari `targets/*.json`
3. `validate`
4. `rehearse`
5. `standby` atau `fire`
6. sign lokal
7. broadcast ke banyak RPC
8. replace tx kalau pending
9. tunggu konfirmasi

Bot ini adalah `execution bot`, bukan crawler website umum.

## Struktur Penting

- [src/index.ts](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/src/index.ts)
- [src/mint/engine.ts](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/src/mint/engine.ts)
- [src/mint/adapter.ts](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/src/mint/adapter.ts)
- [src/mint/broadcast.ts](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/src/mint/broadcast.ts)
- [src/mint/rpcMesh.ts](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/src/mint/rpcMesh.ts)
- [targets/manual-contract.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/manual-contract.sample.json)
- [targets/manual-rawtx.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/manual-rawtx.sample.json)
- [targets/local-race.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/local-race.sample.json)

## Command Utama

```bash
npm install
npm run build
npm run bot -- status --target ./targets/local-race.sample.json
npm run bot -- validate --target ./targets/local-race.sample.json
npm run bot -- rehearse --target ./targets/local-race.sample.json
npm run bot -- standby --target ./targets/local-race.sample.json
npm run bot -- fire --target ./targets/local-race.sample.json
```

Kalau mau target lain:

```bash
npm run bot:custom -- fire --target ./targets/my-target.json
```

## Mode Target

### `contractWrite`

Pakai ini kalau kamu tahu:

- contract address
- ABI
- function name
- args
- value mint

### `rawTransaction`

Pakai ini kalau kamu sudah punya:

- `to`
- `data`
- `value`

Ini fallback paling universal untuk launchpad, router, atau marketplace route yang aneh.

## Preset Fee Tempur

Untuk `budgetAggressive`, sekarang kamu bisa pakai preset:

- `safe`
- `race`
- `allOut`

Preset ini hanya memberi default tempur. Kalau kamu isi angka manual seperti `targetUsd` atau `maxFeeCapGwei`, nilai manual tetap menang.

## Post-Mint Verification

Target sekarang bisa punya blok `verification` opsional.

Contoh umum untuk ERC-721:

```json
"verification": {
  "abi": ["function balanceOf(address owner) view returns (uint256)"],
  "functionName": "balanceOf",
  "args": ["__WALLET__"],
  "operator": "gte",
  "expected": 1
}
```

Kalau receipt sukses, bot akan coba cek hasil mint itu lagi lewat contract read.

## Trigger

- `manual`
- `time`
- `block`
- `read`

## RPC Roles

- `primaryHttp`: anchor default
- `readHttp`: bacaan nonce, simulation, fee, receipt
- `broadcastHttp`: jalur blast raw tx
- `webSocket`: block/event detection cepat

## Workflow Operasional

Urutan yang disarankan:

1. isi `.env`
2. isi target JSON
3. jalankan `status`
4. jalankan `validate`
5. jalankan `rehearse`
6. kalau sehat, jalankan `standby` atau `fire`

## File `.env`

Contoh minimum:

```env
PRIVATE_KEYS=0xPRIVATE_KEY_1,0xPRIVATE_KEY_2
RPC_REQUEST_TIMEOUT_MS=3500
RECEIPT_TIMEOUT_MS=120000
```

## Sample Target

### Direct contract

Mulai dari:

- [targets/manual-contract.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/manual-contract.sample.json)

### Raw calldata

Mulai dari:

- [targets/manual-rawtx.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/manual-rawtx.sample.json)

### Local aggressive profile

Mulai dari:

- [targets/local-race.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/local-race.sample.json)

## Test & Drill

Build:

```bash
npm run build
```

Smoke:

```bash
npm run smoke:trigger
npm run smoke:rpc
npm run battle:test
```

Sepolia proof path:

```bash
npm run sepolia:deploy -- --openAtIso 2026-05-14T15:00:00.000Z
```

## Catatan

- Bot ini sudah terbukti bisa mint di Sepolia test route.
- Target pihak ketiga tetap perlu route yang benar.
- Kemenangan lomba tetap dipengaruhi target, RPC, jaringan, dan timing.

## Safety

- pakai wallet lomba, bukan wallet utama
- jangan commit `.env`
- jangan kirim private key ke chat
