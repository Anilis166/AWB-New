import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpxResult,
  formatSpxAwb,
  parseSpxAwbList,
} from "./public/spx-data.js";

test("parses known SPX AWBs from pasted lines and deduplicates them", () => {
  assert.deepEqual(
    parseSpxAwbList("SPXID001B\nspxid001b, 002B; SPXID003B"),
    ["SPXID001B", "002B", "SPXID003B"],
  );
});

test("returns no AWBs for empty input", () => {
  assert.deepEqual(parseSpxAwbList(" \n\t "), []);
});

test("formats a numeric SPX suffix and preserves a complete SPX AWB", () => {
  assert.equal(formatSpxAwb("001B"), "SPXID001B");
  assert.equal(formatSpxAwb("spxid001b"), "SPXID001B");
});

test("maps live SPX tracking into the shared result-card format", () => {
  const tracking = new Map([["SPXID001B", {
    waybill_id: "SPXID001B",
    latest_status: "Dalam perjalanan",
    latest_checkpoint_date: "2026-11-21T03:30:00.000Z",
    latest_note: "Paket diproses",
    location: "Jakarta Hub",
    records: [{
      actual_time: "2026-11-21T03:30:00.000Z",
      status: "Dalam perjalanan",
      description: "Paket diproses",
      current_location: { location_name: "Jakarta Hub" },
    }],
  }]]);
  const result = buildSpxResult("spxid001b", tracking);
  assert.equal(result.status, "Dalam perjalanan");
  assert.equal(result.tanggal, "2026-11-21");
  assert.equal(result.jam, "10:30");
  assert.equal(result.lastUpdate, "2026-11-21 10:30");
  assert.equal(result.receiver, "-");
  assert.equal(result.trackingNote, "Paket diproses");
  assert.equal(result.destination, "Jakarta Hub");
  assert.equal(result.receiverAddress, "-");
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].date, "2026-11-21 10:30");
  assert.equal(result.history[0].description, "Paket diproses");
  assert.equal(result.history[0].location, "Jakarta Hub");
});

test("returns a not-found result when the live API has no matching AWB", () => {
  assert.equal(buildSpxResult("SPXID404B", new Map()).status, "Tidak ditemukan");
});
