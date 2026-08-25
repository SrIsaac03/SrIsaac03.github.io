// E2E de la cartera real: añadir tenencias, ver evaluación (mantener/reducir/vender),
// considerar venta con pasos manuales, y persistencia. Se ejecuta en la máquina del
// tiempo del crash COVID (2020-03-23) para forzar evaluaciones de venta reales.
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8321/';
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); } catch (e) { failures++; console.error('  ✗ ' + name + ': ' + e.message); } };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

// onboarding en el fondo del crash COVID
await page.goto(BASE + '?fecha=2020-03-23', { waitUntil: 'networkidle' });
await page.click('#start');
for (let i = 0; i < 12; i++) { await page.locator('.likert').nth(i).locator('button').nth(2).click(); await page.waitForTimeout(25); }
await page.click('#next');
await page.locator('#cap .opt').nth(2).click(); await page.locator('#inc .opt').nth(2).click(); await page.click('#next');
await page.locator('#brk .opt[data-id="ibkr"]').click(); await page.click('#next'); await page.click('#done');
await page.waitForSelector('.semaforo', { timeout: 15000 });

await check('Portafolios: la cartera real empieza vacía con invitación', async () => {
  await page.locator('nav.tabs button:has-text("Portafolios")').click();
  await page.waitForSelector('.add-holding');
  if (await page.locator('.holding').count() !== 0) throw new Error('debería empezar sin tenencias');
  await page.waitForSelector('text=Aún no has añadido');
});

await check('Añadir un activo poseído lo evalúa y muestra acción + salud', async () => {
  await page.selectOption('.asset-select', 'AAPL');
  await page.locator('[data-addhold]').first().click();
  await page.waitForSelector('.holding');
  const badge = await page.locator('.holding .hold-badge').first().innerText();
  if (!/Mantener|Reducir|Vender/.test(badge)) throw new Error('sin badge de acción: ' + badge);
  if (await page.locator('.health-meter .hm-fill').count() < 1) throw new Error('sin medidor de salud');
});

await check('En el crash COVID hay al menos una tenencia con venta/reducción', async () => {
  // añadir varios para asegurar señales de riesgo
  for (const sym of ['JPM', 'BAC', 'XOM']) {
    await page.selectOption('.asset-select', sym);
    await page.locator('[data-addhold]').first().click();
    await page.waitForTimeout(150);
  }
  const badges = await page.locator('.holding .hold-badge').allInnerTexts();
  if (!badges.some(b => /Vender|Reducir/.test(b))) throw new Error('ninguna acción de riesgo en pleno crash: ' + badges.join(','));
  // debe existir un botón "Considerar venta"
  if (await page.locator('[data-sell]').count() < 1) throw new Error('sin botón de considerar venta');
});

await check('No permite añadir un activo duplicado', async () => {
  const opts = await page.locator('.asset-select option').allInnerTexts();
  if (opts.some(o => /\(AAPL\)/.test(o))) throw new Error('AAPL sigue en la lista de añadir');
});

await check('Considerar venta abre pasos manuales no-custodiales', async () => {
  await page.locator('[data-sell]').first().click();
  await page.waitForSelector('.modal[role="dialog"]');
  await page.waitForSelector('text=La app nunca vende por ti');
  await page.click('#later');
  await page.waitForSelector('.modal', { state: 'detached' });
});

await check('"Lo he vendido" registra la decisión en el historial', async () => {
  const sellBtns = page.locator('[data-sell]');
  if (await sellBtns.count() === 0) throw new Error('no hay tenencia con venta sugerida');
  await sellBtns.first().click();
  await page.waitForSelector('.modal[role="dialog"]');
  await page.click('#done');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.locator('nav.tabs button:has-text("Historial")').click();
  await page.waitForSelector('.card');
  const txt = await page.locator('#app').innerText();
  if (!/vendida|reducida/i.test(txt)) throw new Error('el historial no refleja la venta/reducción: ' + txt.slice(0, 120));
});

await check('Persistencia: las tenencias sobreviven a una recarga', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('nav.tabs button:has-text("Portafolios")').click();
  await page.waitForSelector('.holding');
  if (await page.locator('.holding').count() < 1) throw new Error('las tenencias no persistieron');
});

await check('Dejar de seguir elimina la tenencia', async () => {
  const before = await page.locator('.holding').count();
  await page.locator('[data-remove]').first().click();
  await page.waitForTimeout(200);
  const after = await page.locator('.holding').count();
  if (after !== before - 1) throw new Error(`no se eliminó (${before}→${after})`);
});

const real = errs.filter(e => !/net::ERR|Failed to fetch|CORS|403|binance|coingecko|frankfurter|corsproxy|yahoo/i.test(e));
await check('Sin errores de consola inesperados', async () => { if (real.length) throw new Error(real.slice(0, 3).join(' | ')); });

await browser.close();
console.log(`\nCartera E2E: ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'}`);
process.exit(failures ? 1 : 0);
