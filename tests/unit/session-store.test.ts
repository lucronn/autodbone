import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import { EncryptedSessionStore } from "../../src/auth/session-store.js";
import type { AuthenticatedSession } from "../../src/auth/auth-adapter.js";

function session(): AuthenticatedSession {
  return {
    source: "server",
    cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic-secret; Path=/"], 1_700_000_000),
    createdAt: 1_700_000_000,
  };
}

describe("EncryptedSessionStore", () => {
  it("persists encrypted session state without plaintext cookie values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bankone-session-"));
    const path = join(directory, "server-session.enc");
    const store = new EncryptedSessionStore(path, Buffer.alloc(32, 7));

    await store.save(session());
    const bytes = await readFile(path);

    expect(bytes.toString()).not.toContain("synthetic-secret");
    expect(await store.load()).toMatchObject({ source: "server", createdAt: 1_700_000_000 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects ciphertext written with a different key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bankone-session-"));
    const path = join(directory, "server-session.enc");
    await new EncryptedSessionStore(path, Buffer.alloc(32, 7)).save(session());

    await expect(new EncryptedSessionStore(path, Buffer.alloc(32, 8)).load()).rejects.toThrow(/decrypt/i);
  });
});
