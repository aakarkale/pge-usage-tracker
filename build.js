/* ============================================================================
 * build.js — Produce a portable single-file build at dist/wattwise.html.
 *
 * Inlines the stylesheet and every script into index.html so the whole app is
 * one self-contained HTML file you can email, drop on a USB stick, or open
 * offline. No dependencies — run with `node build.js`.
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function readRel(p) { return fs.readFileSync(path.join(ROOT, p), "utf8"); }

let out = html;

// Inline the stylesheet.
out = out.replace(
  /<link rel="stylesheet" href="css\/styles\.css"\s*\/?>/,
  "<style>\n" + readRel("css/styles.css") + "\n</style>"
);

// Inline each script in order.
out = out.replace(/<script src="(js\/[^"]+)"><\/script>/g, function (_m, src) {
  return "<script>\n" + readRel(src) + "\n</script>";
});

const distDir = path.join(ROOT, "dist");
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
const outPath = path.join(distDir, "wattwise.html");
fs.writeFileSync(outPath, out);

const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
console.log("Wrote " + path.relative(ROOT, outPath) + " (" + kb + " KB, self-contained)");
