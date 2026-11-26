// Debug helper: connect with the mock wallet and dump the rendered page text and errors.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(`${process.env.APP_URL || "http://127.0.0.1:5173"}/#/`);
  await p.getByTestId("connect").click();
  await p.getByRole("menuitem").first().click();
  await p.waitForTimeout(8000);
  console.log((await p.locator("body").innerText()).slice(0, 1800));
  console.log("ERRORS", errs.slice(0, 5));
  await b.close();
})();
