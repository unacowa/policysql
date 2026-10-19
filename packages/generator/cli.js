#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generate } from "./index.js";

if (process.argv.length !== 5 || process.argv[2] !== "generate" || process.argv[3] !== "--config") {
  console.error("usage: policysql generate --config ./policysql.config.mjs");
  process.exitCode = 2;
} else {
  try {
    const { default: options } = await import(pathToFileURL(resolve(process.argv[4])).href);
    await generate(options);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
