#!/usr/bin/env bun
// 为嗅探规则包 / 吊销列表生成签名信封。
//
// 用法：
//   bun scripts/sniff-rules/sign.ts --kind official|community|revocations \
//     --key <私钥.pem> --key-id <keyId> --in <payload.json> --out <signed.json>
//
// 签名对象是 payload 文件的原始字节（不重新序列化），信封格式：
//   {"payload": base64(标准), "signatures": [{"keyId": "...", "sig": base64}]}
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const kind = arg("--kind");
const keyPath = arg("--key");
const keyId = arg("--key-id");
const input = arg("--in");
const output = arg("--out");
if (!kind || !["official", "community", "revocations"].includes(kind) || !keyPath || !keyId || !input || !output) {
  console.error(
    "用法: sign.ts --kind official|community|revocations --key <pem> --key-id <id> --in <payload.json> --out <signed.json>",
  );
  process.exit(2);
}

const payload = readFileSync(input);
let doc: { format?: unknown; packId?: unknown };
try {
  doc = JSON.parse(payload.toString("utf8"));
} catch (e) {
  console.error(`payload 不是合法 JSON: ${(e as Error).message}`);
  process.exit(1);
}
const expectedFormat = kind === "revocations" ? "fluxdown-sniff-revocations" : "fluxdown-sniff-pack";
if (doc.format !== expectedFormat) {
  console.error(`payload.format 应为 ${expectedFormat}`);
  process.exit(1);
}
if (kind !== "revocations" && doc.packId !== kind) {
  console.error(`payload.packId 应为 ${kind}`);
  process.exit(1);
}

const signature = sign(null, payload, createPrivateKey(readFileSync(keyPath)));
const envelope = {
  payload: payload.toString("base64"),
  signatures: [{ keyId, sig: signature.toString("base64") }],
};
writeFileSync(output, JSON.stringify(envelope));
console.log(`已写入 ${output}（${payload.length} 字节 payload）`);
