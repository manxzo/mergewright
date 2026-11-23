#!/usr/bin/env node
// Launcher. From a checkout it runs the TypeScript source directly (Node strips the types);
// from an installed package it runs the compiled build.
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url);
const src = new URL("src/cli.ts", root);
const fromCheckout = existsSync(src) && !root.pathname.includes("/node_modules/");
const { main } = await import(fromCheckout ? src.href : new URL("dist/cli.js", root).href);
process.exitCode = await main(process.argv.slice(2));
