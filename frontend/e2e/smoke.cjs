// End-to-end smoke test against a local Hardhat node seeded by contracts/scripts/seed-local.ts.
// The dev server must run with VITE_DEPLOYMENT=localhost.local VITE_RPC_URL=http://127.0.0.1:8545
// VITE_E2E_ACCOUNT=<an unlocked node account on the depositor allowlist>.
// Usage: node e2e/smoke.cjs <screenshot-dir>
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
const URL = process.env.APP_URL || "http://127.0.0.1:5173";

function check(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const text = () => page.locator("body").innerText();
  const usdt = (t, label) => t.match(new RegExp(`${label}\\n([\\d,.]+) USDT`, "i"))?.[1];

  await page.goto(`${URL}/#/`);
  await page.getByTestId("connect").click();
  await page.getByRole("menuitem").first().click();
  await page.getByTestId("account").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /Pending reward\n[\d,.]+ USDT/i.test(document.body.innerText), null, { timeout: 20000 });

  const before = await text();
  const pending = Number(usdt(before, "Pending reward").replace(/,/g, ""));
  check(pending > 0, `seeded user has realized pending rewards (${pending})`);
  check(/Trailing realized net yield \(annualized\)\n\d/i.test(before), "trailing realized yield is computed from on-chain history");

  await page.fill("#amt", "100");
  await page.getByRole("button", { name: /stake/i }).last().click();
  await page.locator("[data-testid=tx-status][data-status=confirmed]").waitFor({ timeout: 30000 });
  check(true, "stake 100 USDT confirmed on-chain");

  await page.getByRole("tab", { name: "Rewards" }).click();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await page.locator("[data-testid=tx-status][data-status=confirmed]").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /Pending reward\n0\.00 USDT/i.test(document.body.innerText), null, { timeout: 20000 });
  const after = await text();
  check(Number(usdt(after, "Claimed rewards").replace(/,/g, "")) >= pending, "claimed rewards reflect the claim");
  await page.waitForFunction(() => document.body.innerText.includes("Claim rewards"), null, { timeout: 40000 });
  check(true, "transaction history lists the claim");
  await page.screenshot({ path: `${out}/user.png`, fullPage: true });

  await page.getByRole("tab", { name: "Unstake" }).click();
  await page.fill("#amt", "999999");
  await page.getByRole("button", { name: "Partial unstake" }).click();
  await page.locator("[data-testid=tx-status][data-status=failed]").waitFor({ timeout: 20000 });
  check(true, `oversized unstake is reported as failed: "${await page.getByTestId("tx-status").innerText()}"`);

  await page.goto(`${URL}/#/admin`);
  await page.getByText("Realized P&L (all time)").waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes("Harvested"), null, { timeout: 40000 });
  const admin = await text();
  check(/Recognized losses\n−[\d,.]+ USDT/.test(admin) && !/Recognized losses\n−0\.00/.test(admin), "admin shows the seeded strategy loss");
  check(admin.includes("RewardNotified"), "admin event feed lists reward events");
  await page.screenshot({ path: `${out}/admin.png`, fullPage: true });

  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(`${URL}/#/`);
  await m.waitForTimeout(3000);
  check(!(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no horizontal overflow at 390px");
  await m.screenshot({ path: `${out}/mobile.png`, fullPage: true });

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
