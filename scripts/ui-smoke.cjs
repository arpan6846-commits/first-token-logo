// Browser smoke test of the full owner flow in local simulation mode.
// Usage: npm run build && npx vite preview --port 4173 (in frontend/), then: node scripts/ui-smoke.cjs
const { chromium } = require('playwright');
const OUT = (process.env.SHOTS_DIR || require('os').tmpdir()) + '/';
const U = process.env.APP_URL || 'http://localhost:4173';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const msg = async () => (await p.locator('main').evaluate((m) => m.previousElementSibling?.textContent ?? '')).slice(0, 300);
  await p.goto(U + '/settings'); await p.waitForSelector('text=Risk & strategy', { timeout: 30000 });
  await p.fill('input[placeholder="25"]', '100');
  await p.locator('input').filter({ hasNot: p.locator('[type=number]') }).nth(0);
  await p.fill('xpath=//div[contains(text(),"Type exactly")]/following-sibling::input', 'I CONFIRM THIS RISK CHANGE');
  await p.click('button:has-text("Save 1 change")'); await p.waitForTimeout(800);
  console.log('SETTINGS MSG:', await msg());
  await p.screenshot({ path: OUT + '10-settings.png', fullPage: true });
  const t0 = Date.now();
  await p.click('button:has-text("+1 day")'); await p.waitForSelector('header svg.animate-spin', { state: 'detached', timeout: 120000 });
  console.log('+1 day took', Date.now() - t0, 'ms; msg:', await msg());
  await p.goto(U + '/stocks'); await p.waitForSelector('text=Quotes');
  await p.click('td:has-text("TATASTEEL")');
  await p.click('button:has-text("Load scripted rulebook setup on TATASTEEL")'); await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + '02-stocks.png', fullPage: true });
  await p.goto(U + '/signals'); await p.waitForSelector('text=Generate now');
  await p.click('button:has-text("Generate now")'); await p.waitForTimeout(3000);
  console.log('GEN MSG:', await msg());
  const val = p.locator('tr:has-text("TATASTEEL"):has-text("VALIDATED")');
  console.log('VALIDATED TATASTEEL rows:', await val.count());
  if (await val.count()) {
    await val.first().click(); await p.waitForTimeout(300);
    await p.screenshot({ path: OUT + '03-signal-validated.png', fullPage: true });
    await p.click('button:has-text("Approve & arm")'); await p.waitForTimeout(1000);
    console.log('ARM MSG:', await msg());
    for (let i = 0; i < 8; i++) {
      await p.click('button:has-text("+15m")'); await p.waitForTimeout(700);
      const st = await p.locator('tr:has-text("TATASTEEL")').first().innerText();
      if (!/APPROVED/.test(st)) { console.log('after', i + 1, 'x15m:', st.replace(/\s+/g, ' ')); break; }
    }
  } else {
    const any = p.locator('tr:has-text("TATASTEEL")'); if (await any.count()) { await any.first().click(); console.log((await p.locator('section').nth(1).innerText()).slice(0, 600)); }
  }
  for (const [path, name] of [['/trades', '04-trades'], ['/', '01-dashboard'], ['/ledger', '05-ledger'], ['/risk', '06-risk'], ['/prop-desk', '07-propdesk'], ['/connections', '08-connections'], ['/automation', '09-automation'], ['/audit', '11-audit'], ['/portfolio', '12-portfolio'], ['/crypto', '13-crypto']]) {
    await p.goto(U + path); await p.waitForTimeout(1200);
    await p.screenshot({ path: OUT + name + '.png', fullPage: true });
  }
  await p.goto(U + '/trades'); await p.waitForTimeout(1000);
  console.log('ORDERS:', (await p.locator('section').nth(1).innerText()).slice(0, 700).replace(/\n/g, ' | '));
  await p.click('button[role=tab]:has-text("production")'); await p.waitForTimeout(800);
  await p.goto(U + '/'); await p.waitForTimeout(800);
  console.log('PROD DASH:', (await p.locator('main').innerText()).slice(0, 300).replace(/\n/g, ' | '));
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(U + '/'); await m.waitForSelector('text=Total equity', { timeout: 30000 });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('MOBILE horizontal overflow px:', overflow);
  await m.screenshot({ path: OUT + '14-mobile.png', fullPage: false });
  await b.close();
  console.log('ERRORS:', JSON.stringify(errs.slice(0, 10)));
})();
