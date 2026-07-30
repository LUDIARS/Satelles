#!/usr/bin/env node
// dist 実行 (コンパイル済み)。src を直しても `npm run build` するまで反映されない。
import { main } from "../dist/cli.js";

process.exitCode = await main(process.argv.slice(2));
