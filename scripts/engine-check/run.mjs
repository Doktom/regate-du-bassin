// Checks that the same race gives the exact same result in several browser engines.
// A challenge link relies on it. Needs playwright, which only this check uses:
//   npm i --no-save playwright && npx playwright install chromium firefox webkit
//   node scripts/engine-check/run.mjs [chromium,firefox,webkit]
import { buildSync } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const engines = { chromium, firefox, webkit };
const names = (process.argv[2] ?? "chromium,firefox,webkit").split(",");
const built = buildSync({
  entryPoints: [new URL("./entry.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  loader: { ".geojson": "text" },
});
const code = built.outputFiles[0].text;

const results = {};
for (const name of names) {
  const browser = await engines[name].launch();
  const page = await browser.newPage();
  await page.addScriptTag({ content: code });
  results[name] = await page.evaluate(() => globalThis.runRaces());
  await browser.close();
  console.log(name, results[name]);
}
if (new Set(Object.values(results)).size !== 1) {
  console.error("Les moteurs donnent des résultats différents");
  process.exit(1);
}
console.log(`Résultats identiques : ${names.join(", ")}`);
