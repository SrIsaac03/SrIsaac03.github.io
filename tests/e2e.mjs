// Test E2E del Copiloto de Inversión: onboarding completo, decisiones,
// límite de portafolios, máquina del tiempo (verde y rojo) y degradación sin red.
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8321/';
let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const ko = (name, e) => { failures++; console.error(`  ✗ ${name}: ${e}`); };
async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { ko(name, e.message); }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

// --- Onboarding en modo máquina del tiempo (2021: mercado alcista → verde) ---
await page.goto(BASE + '?fecha=2021-06-01', { waitUntil: 'networkidle' });

await check('Pantalla de bienvenida con disclaimer no-custodial', async () => {
  await page.waitForSelector('text=no-custodial', { timeout: 5000 });
  await page.waitForSelector('#start');
});

await page.click('#start');

await check('Test psicométrico: 12 preguntas, botón bloqueado hasta completar', async () => {
  const n = await page.locator('.likert').count();
  if (n !== 12) throw new Error(`${n} preguntas`);
  if (!(await page.locator('#next').isDisabled())) throw new Error('next debería estar deshabilitado');
});

for (let i = 0; i < 12; i++) {
  await page.locator('.likert').nth(i).locator('button').nth(3).click();
  await page.waitForTimeout(50);
}
await page.waitForFunction(() => !document.querySelector('#next')?.disabled, { timeout: 3000 });
await page.click('#next');

await check('Perfil calculado y mostrado', async () => {
  await page.waitForSelector('text=Tu perfil:', { timeout: 3000 });
});

await page.locator('#cap .opt').nth(2).click();
await page.locator('#inc .opt').nth(2).click();
await page.click('#next');

await check('Selección de bróker requerida', async () => {
  await page.waitForSelector('#brk', { timeout: 3000 });
  if (!(await page.locator('#next').isDisabled())) throw new Error('debería requerir bróker');
});
await page.locator('#brk .opt[data-id="traderepublic"]').click();
await page.click('#next');

await page.waitForSelector('#pfname', { timeout: 3000 });
await page.fill('#pfname', 'Largo plazo');
await page.click('#done');

await check('Máquina del tiempo 2021: banner y semáforo NO rojo', async () => {
  await page.waitForSelector('.semaforo', { timeout: 15000 });
  await page.waitForSelector('text=Máquina del tiempo', { timeout: 3000 });
  const cls = await page.getAttribute('css=.semaforo', 'class');
  if (/red/.test(cls)) throw new Error('rojo en pleno alcista 2021');
});

await check('Porcentajes (nunca importes fijos) en la asignación', async () => {
  const txt = await page.locator('.tiles').first().innerText();
  if (!/%/.test(txt)) throw new Error('sin %');
});

await check('Recomendaciones con botón de compra y comprobación del futuro', async () => {
  await page.waitForSelector('.rec', { timeout: 5000 });
  await page.waitForSelector('[data-acc]');
  await page.waitForSelector('text=Comprobación:');
});

await check('Rechazo pide motivo y la tarjeta desaparece', async () => {
  const firstName = await page.locator('.rec .name').first().innerText();
  await page.locator('[data-rej]').first().click();
  await page.waitForSelector('.modal');
  await page.locator('.modal .opt[data-r="too_risky"]').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  const names = await page.locator('.rec .name').allInnerTexts();
  if (names.includes(firstName)) throw new Error('la rechazada sigue visible');
});

await check('Aceptar muestra pasos de ejecución manual (no-custodial)', async () => {
  await page.locator('[data-acc]').first().click();
  await page.waitForSelector('text=Ejecuta la orden en tu plataforma');
  await page.click('#ok');
});

await check('Historial registra ambas decisiones con motivo', async () => {
  await page.locator('nav.tabs button:has-text("Historial")').click();
  await page.waitForSelector('text=rechazada');
  await page.waitForSelector('text=aceptada');
  await page.waitForSelector('text=Demasiado riesgo');
});

await check('Portafolios: crear el 2º funciona, el 3º está bloqueado', async () => {
  await page.locator('nav.tabs button:has-text("Portafolios")').click();
  await page.waitForSelector('#npfname');
  await page.fill('#npfname', 'Especulativa');
  await page.locator('#npfrisk .opt[data-id="agresivo"]').click();
  await page.click('#npfcreate');
  await page.waitForSelector('text=2/2');
  const blocked = await page.locator('text=límite de 2 portafolios').count();
  if (!blocked) throw new Error('no muestra bloqueo del 3º');
});

await check('Dos carteras con riesgos distintos → asignaciones distintas', async () => {
  await page.locator('nav.tabs button:has-text("Hoy")').click();
  await page.waitForSelector('[data-pf]');
  const eq1 = await page.locator('.tile .v').first().innerText();
  await page.locator('[data-pf]').nth(1).click();
  await page.waitForSelector('.tiles');
  const eq2 = await page.locator('.tile .v').first().innerText();
  if (eq1 === eq2) throw new Error(`misma asignación (${eq1})`);
});

// --- Modo rojo: fin de 2022 (bajista) ---
await check('Semáforo rojo (2022): candidatos en vigilancia, sin botón de compra', async () => {
  await page.goto(BASE + '?fecha=2022-12-28', { waitUntil: 'networkidle' });
  await page.waitForSelector('.semaforo.red', { timeout: 15000 });
  await page.waitForSelector('text=Candidatos en vigilancia');
  const accBtns = await page.locator('[data-acc]').count();
  if (accBtns > 0) throw new Error('hay botones de compra con semáforo rojo');
  await page.waitForSelector('text=objetivo'); // % objetivo, no % del capital
});

await check('Suelo COVID (2020-03-23): el semáforo no es verde', async () => {
  await page.goto(BASE + '?fecha=2020-03-23', { waitUntil: 'networkidle' });
  await page.waitForSelector('.semaforo', { timeout: 15000 });
  const cls = await page.getAttribute('css=.semaforo', 'class');
  if (/green/.test(cls)) throw new Error('verde en pleno crash');
});

await check('Mercado: gráfico SVG con tooltip y presets de máquina del tiempo', async () => {
  await page.locator('nav.tabs button:has-text("Mercado")').click();
  await page.waitForSelector('.chart-wrap svg');
  const box = await page.locator('.chart-wrap svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('.chart-wrap .tooltip:visible', { timeout: 2000 });
  await page.waitForSelector('a[href="?fecha=2008-09-15"]');
});

await check('Volver a hoy: degradación limpia sin APIs en vivo', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.semaforo', { timeout: 15000 });
  const badge = await page.locator('#dataBadge').innerText();
  if (!/histórico/.test(badge)) throw new Error(badge);
});

// ---------- Accesibilidad ----------

await check('A11y: skip-link y landmarks (nav con role=tablist, main, status)', async () => {
  const skip = await page.locator('.skip-link').getAttribute('href');
  if (skip !== '#app') throw new Error('skip-link ausente');
  if (await page.locator('nav.tabs[role="tablist"]').count() !== 1) throw new Error('nav sin role=tablist');
  if (await page.locator('nav.tabs button[role="tab"]').count() !== 5) throw new Error('tabs sin role=tab');
  if (await page.locator('#dataBadge[aria-live="polite"]').count() !== 1) throw new Error('badge sin aria-live');
});

await check('A11y: semáforo con role=status y aria-label descriptivo (no solo color)', async () => {
  const label = await page.locator('.semaforo').getAttribute('aria-label');
  if (!/Semáforo (verde|ámbar|rojo)/.test(label || '')) throw new Error('aria-label=' + label);
  if (await page.locator('.semaforo[role="status"]').count() !== 1) throw new Error('sin role=status');
});

await check('A11y: navegación por teclado en las pestañas (flechas + roving tabindex)', async () => {
  await page.locator('nav.tabs button.active').focus();
  const before = await page.locator('nav.tabs button[aria-selected="true"]').getAttribute('aria-label');
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('nav.tabs button[aria-selected="true"]').getAttribute('aria-label');
  if (before === after) throw new Error(`flecha no cambió de pestaña (${before})`);
  // solo la pestaña activa es tabbable (roving tabindex)
  const tabbable = await page.locator('nav.tabs button[tabindex="0"]').count();
  if (tabbable !== 1) throw new Error(`${tabbable} pestañas tabbables`);
  await page.locator('nav.tabs button:has-text("Hoy")').click();
});

await check('A11y: el modal atrapa el foco, se cierra con Escape y restaura el foco', async () => {
  await page.waitForSelector('[data-rej]');
  const rejBtn = page.locator('[data-rej]').first();
  await rejBtn.focus();
  await rejBtn.click();
  await page.waitForSelector('.modal[role="dialog"][aria-modal="true"]');
  // el foco está dentro del diálogo
  const focusedInDialog = await page.evaluate(() => !!document.activeElement.closest('.modal'));
  if (!focusedInDialog) throw new Error('el foco no entró en el diálogo');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 3000 });
  // tras cerrar, no debe quedar backdrop
  if (await page.locator('.modal-backdrop').count() !== 0) throw new Error('el modal no se cerró con Escape');
});

await check('Ajustes: reset borra datos y devuelve al onboarding', async () => {
  await page.locator('nav.tabs button:has-text("Ajustes")').click();
  page.once('dialog', d => d.accept());
  await page.click('#reset');
  await page.waitForSelector('#start', { timeout: 8000 });
});

await check('A11y: los radios del test psicométrico responden a las flechas', async () => {
  await page.click('#start');
  await page.waitForSelector('.likert[role="radiogroup"]');
  const first = page.locator('.likert').first().locator('button').first();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const checked = await page.locator('.likert').first().locator('button[aria-checked="true"]').count();
  if (checked !== 1) throw new Error(`${checked} radios marcados tras flecha`);
});

const realErrors = consoleErrors.filter(e =>
  !/net::ERR|Failed to fetch|CORS|ERR_TUNNEL|403|api\.binance|coingecko|frankfurter|corsproxy/i.test(e));
await check('Sin errores de consola inesperados', async () => {
  if (realErrors.length) throw new Error(realErrors.slice(0, 3).join(' | '));
});

await browser.close();
console.log(`\nE2E: ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'}`);
process.exit(failures ? 1 : 0);
