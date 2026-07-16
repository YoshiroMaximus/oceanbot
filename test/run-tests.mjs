/**
 * Verifies the Worker end to end without touching Discord: starts
 * `wrangler dev` with a throwaway Ed25519 keypair, then sends signed
 * interaction payloads and checks the responses.
 *
 *   npm test
 */

import { spawn } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const PORT = 8788;
const URL = `http://127.0.0.1:${PORT}/`;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString(
  "hex",
);
const signingKey = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));

async function send(payload, { badSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signature = sign(null, Buffer.from(timestamp + body), signingKey).toString("hex");
  if (badSignature) signature = "00".repeat(64);
  const response = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
  });
  return { status: response.status, body: await response.text() };
}

let failures = 0;
function check(name, condition, detail) {
  console.log(condition ? "PASS" : "FAIL", name, condition ? "" : JSON.stringify(detail));
  if (!condition) failures++;
}

async function runTests() {
  const ping = await send({ type: 1 });
  check("ping -> pong", ping.status === 200 && JSON.parse(ping.body).type === 1, ping);

  const bad = await send({ type: 1 }, { badSignature: true });
  check("bad signature -> 401", bad.status === 401, bad);

  const unsigned = await fetch(URL, { method: "POST", body: "{}" });
  check("unsigned POST -> 401", unsigned.status === 401, { status: unsigned.status });

  const ip = await send({ type: 2, data: { name: "ip" } });
  const ipBody = JSON.parse(ip.body);
  check(
    "/ip -> immediate embed",
    ip.status === 200 && ipBody.type === 4 && ipBody.data.embeds.length === 1,
    ip,
  );

  const member = { user: { id: "2" }, roles: [] };
  for (const name of ["setup", "post"]) {
    const res = await send({ type: 2, guild_id: "1", member, token: "t", data: { name } });
    const resBody = JSON.parse(res.body);
    check(
      `/${name} -> deferred ephemeral`,
      resBody.type === 5 && resBody.data.flags === 64,
      res,
    );
  }

  const click = await send({
    type: 3,
    guild_id: "1",
    member,
    token: "t",
    data: { custom_id: "oceanbot:role:123" },
  });
  const clickBody = JSON.parse(click.body);
  check(
    "role button -> deferred ephemeral",
    clickBody.type === 5 && clickBody.data.flags === 64,
    click,
  );

  const confirm = await send({
    type: 3,
    guild_id: "1",
    member,
    token: "t",
    data: { custom_id: "oceanbot:setup:confirm" },
  });
  check("confirm button -> deferred update", JSON.parse(confirm.body).type === 6, confirm);

  const cancel = await send({ type: 3, data: { custom_id: "oceanbot:setup:cancel" } });
  const cancelBody = JSON.parse(cancel.body);
  check(
    "cancel button -> updates message",
    cancelBody.type === 7 && cancelBody.data.content.startsWith("Cancelled"),
    cancel,
  );

  const unknown = await send({ type: 3, data: { custom_id: "something:else" } });
  const unknownBody = JSON.parse(unknown.body);
  check(
    "unknown component -> ephemeral notice",
    unknownBody.type === 4 && unknownBody.data.flags === 64,
    unknown,
  );

  const health = await fetch(URL);
  check("GET -> health message", health.status === 200, { status: health.status });
}

console.log("starting wrangler dev...");
const server = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--var",
    `DISCORD_PUBLIC_KEY:${publicKeyHex}`,
    "--var",
    "DISCORD_APPLICATION_ID:test-app-id",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    up = await fetch(URL)
      .then(() => true)
      .catch(() => false);
  }
  if (!up) throw new Error("wrangler dev did not come up within 60s");
  await runTests();
} finally {
  server.kill();
}

console.log(failures ? `${failures} test(s) failed` : "all tests passed");
process.exit(failures ? 1 : 0);
