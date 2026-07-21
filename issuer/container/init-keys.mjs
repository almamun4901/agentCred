import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  access,
  chmod,
  chown,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const privateDirectory = process.env.PRIVATE_KEYS_DIRECTORY ?? "/keys/private";
const publicDirectory = process.env.PUBLIC_KEYS_DIRECTORY ?? "/keys/public";
const applicationUid = Number(process.env.APPLICATION_UID ?? 10001);
const applicationGid = Number(process.env.APPLICATION_GID ?? 10001);
const privatePath = join(privateDirectory, "private.pem");
const publicPath = join(publicDirectory, "public.pem");

if (!Number.isInteger(applicationUid) || applicationUid < 1) {
  throw new Error("APPLICATION_UID must be a positive integer");
}
if (!Number.isInteger(applicationGid) || applicationGid < 1) {
  throw new Error("APPLICATION_GID must be a positive integer");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function derivedPublicKey(privatePem) {
  return createPublicKey(createPrivateKey(privatePem))
    .export({ type: "spki", format: "pem" })
    .toString();
}

await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
await mkdir(publicDirectory, { recursive: true, mode: 0o755 });

const hasPrivateKey = await exists(privatePath);
const hasPublicKey = await exists(publicPath);

if (hasPrivateKey !== hasPublicKey) {
  throw new Error(
    "Signing key state is incomplete; remove the local signing-key volumes and retry",
  );
}

if (hasPrivateKey) {
  const privatePem = await readFile(privatePath, "utf8");
  const publicPem = await readFile(publicPath, "utf8");
  if (derivedPublicKey(privatePem).trim() !== publicPem.trim()) {
    throw new Error("The stored signing private and public keys do not match");
  }
  await chmod(privatePath, 0o600);
  await chown(privatePath, applicationUid, applicationGid);
  await chmod(publicPath, 0o644);
  console.log("Existing ES256 signing keypair is valid");
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const suffix = `${process.pid}-${Date.now()}`;
  const temporaryPrivatePath = join(privateDirectory, `.private-${suffix}.tmp`);
  const temporaryPublicPath = join(publicDirectory, `.public-${suffix}.tmp`);

  await writeFile(temporaryPrivatePath, privateKey, { flag: "wx", mode: 0o600 });
  await writeFile(temporaryPublicPath, publicKey, { flag: "wx", mode: 0o644 });
  await chown(temporaryPrivatePath, applicationUid, applicationGid);
  await rename(temporaryPublicPath, publicPath);
  await rename(temporaryPrivatePath, privatePath);
  console.log("Generated a new ES256 signing keypair");
}

await chmod(privateDirectory, 0o700);
await chown(privateDirectory, applicationUid, applicationGid);
