import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpxResult,
  formatSpxAwb,
  parseSpxCandidateAwbs,
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

test("reads and deduplicates AWBs from JSONL and candidate JSON files", () => {
  assert.deepEqual(
    parseSpxCandidateAwbs('{"resi":"spxid001b","date":"2026-11-20"}\n{"awb":"SPXID001B"}'),
    ["SPXID001B"],
  );
  assert.deepEqual(
    parseSpxCandidateAwbs('{"candidates":[{"waybill_id":"SPXID002B"}]}'),
    ["SPXID002B"],
  );
});

test("formats a numeric SPX suffix and preserves a complete SPX AWB", () => {
  assert.equal(formatSpxAwb("001B"), "SPXID001B");
  assert.equal(formatSpxAwb("spxid001b"), "SPXID001B");
});

test("maps live SPX tracking into the shared result-card format", () => {
  const tracking = new Map([["SPXID001B", {
    waybill_id: "SPXID001B",
    latest_status: "Dalam perjalanan",
    latest_checkpoint_date: "2026-11-21 10:30:00",
    latest_note: "Paket diproses",
    location: "Jakarta Hub",
    records: [{
      actual_time: "2026-11-21 10:30:00",
      tracking_name: "Paket diproses",
      current_location: "Jakarta Hub",
    }],
  }]]);
  const result = buildSpxResult("spxid001b", tracking);
  assert.equal(result.status, "Dalam perjalanan");
  assert.equal(result.tanggal, "2026-11-21");
  assert.equal(result.jam, "10:30");
  assert.equal(result.destination, "Jakarta Hub");
  assert.equal(result.history.length, 1);
});

test("returns a not-found result when the live API has no matching AWB", () => {
  assert.equal(buildSpxResult("SPXID404B", new Map()).status, "Tidak ditemukan");
});
