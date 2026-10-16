#!/usr/bin/env node
// Make the value for the ADMIN_PASSWORD_HASH secret (shared console password).
//
//   node scripts/hash-password.mjs            # prompts, input hidden
//   echo -n 'the password' | node scripts/hash-password.mjs
//
// Output: pbkdf2-sha256$100000$<salt>$<hash>. Pipe it straight into the secret:
//   node scripts/hash-password.mjs | npx wrangler secret put ADMIN_PASSWORD_HASH
// Only the hash leaves this script; the password is never printed or stored. 100,000 is
// the most iterations workerd's PBKDF2 accepts, so do not raise it.
import { hashPassword } from "./lib/password-hash.mjs";

async function readHidden(prompt) {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    stdin.on("data", function onData(ch) {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    });
  });
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

let password;
if (process.stdin.isTTY) {
  password = await readHidden("New shared password: ");
  const again = await readHidden("Repeat it: ");
  if (password !== again) {
    console.error("Passwords do not match.");
    process.exit(1);
  }
} else {
  password = await readStdin();
}

if (password.length < 12 || password.length > 256) {
  console.error("Use 12 to 256 characters. A long random one is best: openssl rand -base64 24");
  process.exit(1);
}

console.log(hashPassword(password));
