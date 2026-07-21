import { chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultKeysDirectory = resolve(scriptDirectory, "../keys");
const force = process.argv.includes("--force");

async function writeKey(path: string, contents: string, mode: number): Promise<void> {
  await writeFile(path, contents, {
    encoding: "utf8",
    mode,
    flag: force ? "w" : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  });
  await chmod(path, mode);
}

async function main(): Promise<void> {
  const keysDirectory = resolve(process.env.KEYS_DIRECTORY ?? defaultKeysDirectory);
  const privateKeyPath = resolve(keysDirectory, "private.pem");
  const publicKeyPath = resolve(keysDirectory, "public.pem");

  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });

  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });

  try {
    await writeKey(privateKeyPath, await exportPKCS8(privateKey), 0o600);
    await writeKey(publicKeyPath, await exportSPKI(publicKey), 0o644);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Signing keys already exist in ${keysDirectory}. Use --force to replace them.`,
        { cause: error },
      );
    }
    throw error;
  }

  console.log(`Generated ES256 signing keys in ${keysDirectory}`);
  console.log(`Private key: ${privateKeyPath}`);
  console.log(`Public key: ${publicKeyPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Key generation failed");
  process.exitCode = 1;
});
