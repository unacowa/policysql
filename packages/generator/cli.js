#!/usr/bin/env node
import { generate } from "./index.js";

const args = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
if (process.argv[2] !== "generate") {
  console.error("usage: policysql generate --endpoint URL --role ROLE --input DIR --output DIR");
  process.exitCode = 2;
} else {
  await generate({
    endpoint: args.get("--endpoint"),
    role: args.get("--role"),
    input: args.get("--input"),
    output: args.get("--output"),
    token: process.env.POLICYSQL_CODEGEN_TOKEN,
  }).catch((error) => {
    console.error(`policysql generate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
