// Rasterize the SVG sources in this directory into the PNG and ICNS files the
// app and the docs use. Run `pnpm icons` after editing any of them, and commit
// the results.
//
//   icon.svg        -> icon-1024.png, ../packages/app/icons/app.icns
//   icon-slack.svg  -> icon-slack-1024.png  (upload by hand at api.slack.com/apps)
//   tray.svg        -> ../packages/app/icons/trayTemplate.png (22px) and @2x (44px)
//
// The .icns is assembled by macOS's iconutil from every size the system asks
// for at 1x and 2x, so that step is skipped on other platforms.
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appIcons = path.join(root, "packages", "app", "icons");

function render(svgFile, widthPx) {
  const svg = fs.readFileSync(path.join(here, svgFile));
  return new Resvg(svg, { fitTo: { mode: "width", value: widthPx } }).render().asPng();
}

function write(file, data) {
  fs.writeFileSync(file, data);
  console.log(`${path.relative(root, file)}  ${data.length} bytes`);
}

write(path.join(here, "icon-1024.png"), render("icon.svg", 1024));
write(path.join(here, "icon-slack-1024.png"), render("icon-slack.svg", 1024));
write(path.join(appIcons, "trayTemplate.png"), render("tray.svg", 22));
write(path.join(appIcons, "trayTemplate@2x.png"), render("tray.svg", 44));

if (process.platform !== "darwin") {
  console.warn("app.icns not rebuilt: iconutil only exists on macOS");
  process.exit(0);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "understudy-icons-"));
const iconset = path.join(work, "app.iconset");
fs.mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), render("icon.svg", size));
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), render("icon.svg", size * 2));
}
const icns = path.join(appIcons, "app.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
console.log(`${path.relative(root, icns)}  ${fs.statSync(icns).size} bytes`);
fs.rmSync(work, { recursive: true, force: true });
