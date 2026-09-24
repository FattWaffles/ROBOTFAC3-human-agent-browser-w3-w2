import { test } from "node:test";
import assert from "node:assert/strict";
import { safeUrl, prepare, search } from "../src/search.js";

test("search: only plain https URLs are ever shown or opened", () => {
  assert.equal(safeUrl("https://jup.ag/"), "https://jup.ag/");
  for (const bad of ["http://jup.ag", "https://user@jup.ag", "https://xn--jup-9na.ag", "https://jüp.ag", "javascript:alert(1)", "https://jup.ag:8443/", "https://localhost/"]) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

test("search: name matches first, chain filter works, unsafe entries are dropped", () => {
  const idx = prepare([
    { name: "Jupiter", url: "https://jup.ag/", description: "Swap aggregator", category: "DEX Aggregator", chains: ["solana"], tvl: 1e9 },
    { name: "Swapper", url: "https://swapper.example/", description: "Another swap", category: "Dexs", chains: ["base"], tvl: 1e3 },
    { name: "Jupiter Phish", url: "https://jüpiter.ag/", description: "swap", category: "Dexs", chains: ["solana"] },
  ]);
  assert.equal(idx.length, 2);
  assert.deepEqual(search(idx, "jupiter").map((p) => p.name), ["Jupiter"]);
  assert.deepEqual(search(idx, "swap", "base").map((p) => p.name), ["Swapper"]);
  assert.deepEqual(search(idx, "swap solana").map((p) => p.name), ["Jupiter"]);
  assert.deepEqual(search(idx, "nothing here"), []);
});
