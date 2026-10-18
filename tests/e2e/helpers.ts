import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

export const OWNER = "owner@e2e-bakery.test";
export const BOOKS = "books@e2e-bakery.test";
export const STAFF = "staff@e2e-bakery.test";
export const file = (name: string) => path.join(here, ".data", name);

// Written by seed.py; never committed and never printed
function password(email: string): string {
  const creds = JSON.parse(readFileSync(path.join(here, "e2e-credentials.local.json"), "utf8")) as Record<string, string>;
  const value = creds[email];
  if (!value) throw new Error(`No password for ${email}. seed.py runs before the journeys.`);
  return value;
}

/** The six-digit code an authenticator app would show for this secret (RFC 6238, 30 s, SHA-1). */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Two-step keys set up during this run, kept beside the uploads (git-ignored) so a restarted worker has them
const keyFile = path.join(here, ".data", "two-step.local.json");
const keys = (): Record<string, string> => (existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {});

/** Signs in through the real form. Owners set up two-step on first sign-in and pass it after that. */
export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.endsWith("/sign-in"));
  if (!/two-step/.test(page.url())) return;

  // First time: the page shows a setup key, as an authenticator app would scan it
  const code = page.getByLabel(/code/i);
  await expect(code).toBeVisible();
  if (await page.getByRole("heading", { name: "Set up two-step sign-in" }).isVisible()) {
    const key = page.locator('code[aria-label="Setup key"]');
    await expect(key).toBeVisible();
    writeFileSync(keyFile, JSON.stringify({ ...keys(), [email]: (await key.innerText()).replace(/\s/g, "") }), { mode: 0o600 });
  }
  const secret = keys()[email];
  if (!secret) throw new Error(`Two-step was set up for ${email} in an earlier run; seed.py starts afresh.`);
  await code.fill(totp(secret)); // six digits submit by themselves
  await page.waitForURL((u) => !/two-step|sign-in/.test(u.pathname));
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: /^Account menu for / }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}
