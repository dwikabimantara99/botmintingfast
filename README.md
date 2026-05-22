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
- [targets/opensea-mainnet.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/opensea-mainnet.sample.json)
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

Kalau function mint memakai argumen quantity, pakai `mintQuantityPerWallet` di root target dan isi argumen dengan `__MINT_QUANTITY__`.

Contoh:

```json
"mintQuantityPerWallet": 1,
"transaction": {
  "kind": "contractWrite",
  "functionName": "mint",
  "args": ["__MINT_QUANTITY__"]
}
```

### `rawTransaction`

Pakai ini kalau kamu sudah punya:

- `to`
- `data`
- `value`

Ini fallback paling universal untuk launchpad, router, atau marketplace route yang aneh.

### `openseaDropMint`

Pakai ini kalau target adalah OpenSea Drops dan kamu punya `collectionSlug`.

Bot akan memanggil OpenSea Drops API saat fase prepare/arm untuk tiap wallet, mengambil `target`, `calldata`, dan `value`, lalu tetap menandatangani transaksi secara lokal dan broadcast lewat RPC stack kita.

Contoh:

```json
"transaction": {
  "kind": "openseaDropMint",
  "collectionSlug": "my-collection-slug",
  "quantity": 1,
  "apiKeyEnv": "OPENSEA_API_KEY",
  "gasLimit": 350000
}
```

Catatan tempur: jangan memanggil OpenSea API di detik fire. Jalur ini sengaja mengambil route saat arm/rehearse, supaya saat FCFS open bot tinggal broadcast transaksi yang sudah ditandatangani.

### `seaDropPublicMint`

Pakai ini untuk OpenSea Drops yang memakai SeaDrop public mint. Ini jalur tempur yang lebih deterministik karena bot membaca konfigurasi public drop langsung dari contract SeaDrop, bukan dari UI.

Contoh:

```json
"transaction": {
  "kind": "seaDropPublicMint",
  "nftContract": "0xCOLLECTION_CONTRACT",
  "seaDrop": "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
  "quantity": 1,
  "gasLimit": 350000
}
```

Bot akan membaca `getPublicDrop` dan `getAllowedFeeRecipients`, lalu membangun `mintPublic(...)` dengan `value` terbaru saat prepare/arm.

## Preset Fee Tempur

Untuk `budgetAggressive`, sekarang kamu bisa pakai preset:

- `safe`
- `race`
- `allOut`

Preset ini hanya memberi default tempur. Kalau kamu isi angka manual seperti `targetUsd` atau `maxFeeCapGwei`, nilai manual tetap menang.

Tuning cepat yang penting:

- `replaceAfterMs`: kapan bot mulai mengganti tx pending
- `receiptPollIntervalMs`: seberapa sering bot mengecek receipt sebelum memutuskan replace
- `broadcastBurstMs`: jadwal rebroadcast raw tx yang sama setelah tembakan utama, misalnya `[0, 80, 180]`
- `armBeforeMs`: seberapa awal bot mulai build signing context, warmup, dan pre-sign ladder
- `repriceBeforeMs`: seberapa dekat bot mencoba refresh fee sebelum waktu buka
- `finalSpinWindowMs`: jendela busy-spin pendek tepat sebelum fire

Untuk mode balap, angka kecil biasanya lebih agresif.
Untuk local/Windows race mode, `finalSpinWindowMs` sekitar `300 ms` lebih stabil daripada `100 ms` karena bot masuk fase presisi lebih awal tanpa menambah kerja setelah waktu buka.

Catatan penting untuk `time` trigger:

- kerja berat harus selesai sebelum waktu buka
- untuk `5 wallet`, `repriceBeforeMs` di bawah kira-kira `1500-2000 ms` sering terlalu mepet
- bot sekarang akan `skip final reprice` kalau refresh fee berisiko memakan jendela fire, karena lebih baik menembak tepat waktu daripada telat dengan fee yang lebih segar
- bot sekarang juga punya `adaptive arm buffer`: kalau targetnya berat, bot boleh mulai fase arm lebih awal daripada angka `armBeforeMs` yang kamu tulis, supaya prep selesai sebelum open time
- jalur sign memakai local account signing langsung, bukan `walletClient.prepareTransactionRequest`, supaya tidak ada transport HTTP tersembunyi di proses signing
- jalur public broadcast memakai HTTP keep-alive supaya koneksi RPC bisa dipakai ulang dan tidak mengulang handshake yang tidak perlu

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

## Private Relay

Untuk Ethereum mainnet, bot sekarang bisa punya jalur tambahan `Flashbots private relay`.

Tujuannya:

- menambah jalur submit selain public mempool
- mengurangi ketergantungan pada satu jenis path
- tetap menjaga direct-contract/raw-tx flow yang sama

Config opsional:

```json
"privateRelay": {
  "kind": "flashbots",
  "enabled": true,
  "relayUrl": "https://relay.flashbots.net",
  "maxBlocksInFuture": 2,
  "authKeyEnv": "FLASHBOTS_AUTH_PRIVATE_KEY"
}
```

`FLASHBOTS_AUTH_PRIVATE_KEY` sebaiknya key terpisah untuk relay reputation, bukan wallet dana utama.

## Workflow Operasional

Urutan yang disarankan:

1. isi `.env`
2. isi target JSON
3. jalankan `status`
4. jalankan `validate`
5. jalankan `rehearse`
6. kalau sehat, jalankan `standby` atau `fire`

Arti status operator:

- `READY`: boleh lanjut ke `rehearse` dan `standby`
- `RISKY`: bot bisa jalan, tapi ada warning yang harus kamu sadari; `standby` hanya lanjut kalau `allowRiskyStandby=true`
- `BLOCKED`: target tidak boleh dipakai; `validate` akan exit gagal dan `standby` menolak arm

## File `.env`

Contoh minimum:

```env
PRIVATE_KEYS=0xPRIVATE_KEY_1,0xPRIVATE_KEY_2
OPENSEA_API_KEY=your_opensea_api_key
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

### OpenSea Drops mainnet

Mulai dari:

- [targets/opensea-mainnet.sample.json](C:/Users/ACER/Documents/Codex/2026-05-14/halo-codex/targets/opensea-mainnet.sample.json)

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
