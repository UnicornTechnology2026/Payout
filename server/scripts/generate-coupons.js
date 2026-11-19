// Usage:  node scripts/generate-coupons.js <count> [batchName]
// Writes: out/<batch>.csv (code, prize, url) and out/<batch>/<code>.png (QR)
import "dotenv/config";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const count = Number(process.argv[2]);
const batch =
  process.argv[3] || `batch-${new Date().toISOString().slice(0, 10)}`;

if (!Number.isInteger(count) || count < 1 || count > 200000) {
  console.error(
    "Usage: node scripts/generate-coupons.js <count 1-200000> [batchName]",
  );
  process.exit(1);
}

// "rupees:weight" — higher weight = more common. Edit via PRIZE_TABLE in .env.
const table = (
  process.env.PRIZE_TABLE || "5:40,10:25,20:15,30:8,50:7,75:3,100:2"
)
  .split(",")
  .map((p) => p.split(":").map(Number));

if (table.some(([r, w]) => !(r >= 5 && r <= 100) || !(w > 0))) {
  console.error(
    "PRIZE_TABLE values must be 5-100 rupees with positive weights.",
  );
  process.exit(1);
}

const totalWeight = table.reduce((s, [, w]) => s + w, 0);
const pickPrize = () => {
  let n = crypto.randomInt(totalWeight * 1000) / 1000;
  for (const [rupees, weight] of table) {
    if ((n -= weight) < 0) return rupees;
  }
  return table[0][0];
};

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
const makeCode = () =>
  Array.from(
    { length: 8 },
    () => ALPHABET[crypto.randomInt(ALPHABET.length)],
  ).join("");

const db = new Database(path.join(__dirname, "..", "data.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY, prize_paise INTEGER NOT NULL, batch TEXT,
  status TEXT NOT NULL DEFAULT 'unused',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, redeemed_at TEXT
);`);

const insert = db.prepare(
  "INSERT OR IGNORE INTO coupons (code, prize_paise, batch) VALUES (?, ?, ?)",
);
const baseUrl = (process.env.PUBLIC_URL || "http://localhost:5173").replace(
  /\/$/,
  "",
);
const rows = [];
let total = 0;

db.transaction(() => {
  while (rows.length < count) {
    const code = makeCode();
    const rupees = pickPrize();
    if (insert.run(code, rupees * 100, batch).changes === 1) {
      rows.push({ code, rupees, url: `${baseUrl}/?code=${code}` });
      total += rupees;
    }
  }
})();

const outDir = path.join(__dirname, "..", "out");
mkdirSync(path.join(outDir, batch), { recursive: true });

writeFileSync(
  path.join(outDir, `${batch}.csv`),
  "code,prize_rupees,url\n" +
    rows.map((r) => `${r.code},${r.rupees},${r.url}`).join("\n") +
    "\n",
);

for (const r of rows) {
  await QRCode.toFile(path.join(outDir, batch, `${r.code}.png`), r.url, {
    width: 600,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}

console.log(`Created ${rows.length} coupons in "${batch}".`);
console.log(
  `Total cashback liability: ₹${total} (average ₹${(total / rows.length).toFixed(2)} per cap).`,
);
console.log(`CSV: out/${batch}.csv   QR images: out/${batch}/`);
