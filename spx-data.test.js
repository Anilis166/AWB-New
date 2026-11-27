import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpxResult,
  filterSpxCandidates,
  parseSpxCandidates,
  parseSpxTracking,
} from "./public/spx-data.js";

test("parses and deduplicates SPX candidate JSONL case-insensitively", () => {
  const candidates = parseSpxCandidates(
    '{"resi":"spx-01","date":"2026-11-20"}\n{"resi":"SPX-01","date":"2026-11-21"}',
  );
  assert.equal(candidates.size, 1);
  assert.equal(candidates.get("SPX-01").date, "2026-11-21");
});

test("parses the candidate JSON array format", () => {
  const candidates = parseSpxCandidates('[{"resi":"SPX-02","date":"2026-11-20"}]');
  assert.equal(candidates.get("SPX-02").date, "2026-11-20");
});

test("reports the line number for malformed candidate JSONL", () => {
  assert.throws(() => parseSpxCandidates('{"resi":"SPX-01"}\ninvalid'), /baris 2/);
});

test("filters SPX candidates by exact date and time range", () => {
  const candidates = parseSpxCandidates([
    '{"resi":"SPX-01","date":"2026-11-20T10:59:00+07:00"}',
    '{"resi":"SPX-02","date":"2026-11-20T11:30:00+07:00"}',
    '{"resi":"SPX-03","date":"2026-11-21T11:30:00+07:00"}',
  ].join("\n"));
  const matching = filterSpxCandidates(candidates, "2026-11-20", { start: 660, end: 720 });
  assert.deepEqual(matching.map((candidate) => candidate.resi), ["SPX-02"]);
});

test("filters SPX candidates by month when no time range is set", () => {
  const candidates = parseSpxCandidates([
    '{"resi":"SPX-01","date":"2026-11-20T10:59:00+07:00"}',
    '{"resi":"SPX-02","date":"2026-12-01T11:30:00+07:00"}',
  ].join("\n"));
  assert.deepEqual(
    filterSpxCandidates(candidates, "2026-11", null).map((candidate) => candidate.resi),
    ["SPX-01"],
  );
});

test("maps SPX tracking snapshots into the result-card format", () => {
  const tracking = parseSpxTracking(JSON.stringify([{
    waybill_id: "SPX-03",
    latest_status: "Dalam perjalanan",
    latest_checkpoint_date: "2026-11-21 10:30:00",
    latest_note: "Paket diproses",
    records: [{ actual_time: "2026-11-21 10:30:00", tracking_name: "Paket diproses", current_location: "Jakarta Hub" }],
  }]));
  const result = buildSpxResult("spx-03", new Map(), tracking);
  assert.equal(result.status, "Dalam perjalanan");
  assert.equal(result.tanggal, "2026-11-21");
  assert.equal(result.jam, "10:30");
  assert.equal(result.destination, "Jakarta Hub");
  assert.equal(result.history.length, 1);
});

test("supports a single hasil_match object", () => {
  const tracking = parseSpxTracking('{"awb":"SPX-04","status":"Dikirim","date":"2026-11-22"}');
  assert.equal(buildSpxResult("SPX-04", new Map(), tracking).status, "Dikirim");
});
