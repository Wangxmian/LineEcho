import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [runtime, assets, mode] = process.argv.slice(2);
const configDir = join(assets, "config");
const modelDir = join(assets, "models");
const packageDir = join(runtime, "node_modules", "mtranserver");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function prepareAssets() {
  const registry = await readFile(new URL("mtran-records.json", import.meta.url), "utf8");
  const target = join(modelDir, "en_zh-Hans");
  const { decompress } = await import(pathToFileURL(join(runtime, "node_modules", "fzstd", "esm", "index.mjs")));
  await mkdir(target, { recursive: true });
  for (const record of JSON.parse(registry).data) {
    const { filename, location, hash } = record.attachment;
    const output = join(target, filename.replace(/\.zst$/, ""));
    const previous = await readFile(output).catch(() => null);
    if (previous && sha256(previous) === record.decompressedHash) continue;
    const url = "https://firefox-settings-attachments.cdn.mozilla.net/" + location;
    const compressed = execFileSync("/usr/bin/curl", [
      "-fsSL", "--retry", "1", "--connect-timeout", "10", "--max-time", "240", url,
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (sha256(compressed) !== hash) throw new Error(`Mozilla 下载校验失败: ${filename}`);
    const bytes = decompress(compressed);
    if (sha256(bytes) !== record.decompressedHash) throw new Error(`Mozilla 解压校验失败: ${filename}`);
    await writeFile(output + ".part", bytes);
    await rename(output + ".part", output);
  }
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "records.json"), registry);
}

// MTranServer initializes its cache when the package is imported.
Object.assign(process.env, {
  MT_CACHE_SIZE: "0",
  MT_CPU_ONLY: "true",
  MT_LOG_CONSOLE: "false",
});
const { MTran } = await import(pathToFileURL(join(packageDir, "dist", "index.js")));
const engine = new MTran({
  homeDir: assets, configDir, modelDir, logDir: join(assets, "logs"),
  enableOfflineMode: true, checkUpdate: false, fast: false, cacheSize: 0,
  workerIdleTimeout: 3600, workersPerLanguage: 1, logConsole: false, logToFile: false, logRequests: false,
});
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");

try {
  if (mode === "--prepare") await prepareAssets();
  await engine.init();
  const warmup = await engine.translate("en", "zh-Hans", "Good morning.");
  if (!/\p{Script=Han}/u.test(warmup)) throw new Error("MTranServer 简体中文预热失败。");
  if (mode === "--prepare") {
    console.log("MTranServer 英译简中模型已准备，可离线运行。");
  } else {
    emit({ ready: true });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const { text } = JSON.parse(line);
        emit({ translation: await engine.translate("en", "zh-Hans", text) });
      } catch (error) {
        console.error("MTranServer 翻译失败", error);
        emit({ error: true });
      }
    }
  }
} finally {
  await engine.close();
}
