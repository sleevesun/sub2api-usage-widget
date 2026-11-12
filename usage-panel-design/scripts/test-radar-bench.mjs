import assert from "node:assert/strict";
import * as radar from "../src/radarBench.js";
assert.equal(typeof radar.normalizeRadarSnapshot, "function", "Whole-round homepage snapshots must replace fixed per-cell reads");
const { normalizeRadarSnapshot, rankRows, modelsInOrder, effortColumns, keyOf, createRadarLoader } = radar;
const row = (model, effort, score150, cost_usd = 1, model_elapsed_seconds = 60) => ({model, effort, score150, cost_usd, model_elapsed_seconds, cost_kind: "api_equivalent_estimate"});
const snapshot = (rows, extra = {}) => ({source: "https://codexradar.com/", score_max: 150, fetched_at: "2026-11-12T03:00:00Z", rows, unsupported: [], metadata: {}, status: "latest", ...extra});
const input = snapshot([
 row("gpt-6-astra", "high", 120), row("gpt-6.1-terra", "max", null),
 row("gpt-6.1-sol", "low", 90.00001), row("gpt-6.1-terra", "medium", 95),
 row("gpt-6-luna", "experimental", 30), row("gpt-5.6-sol", "max", 149),
 row("gpt-6.10-sol", "max", 149), row("gpt-60-sol", "max", 149),
 row("GPT-6-FUTURE", "HIGH", 91), row("gpt-6-sol", "low", -1),
], {unsupported: [{model: "gpt-6-luna", effort: "ultra"}], metadata: {round_id: "synthetic-round"}});
const data = normalizeRadarSnapshot(input);
assert.equal(data.rows.length, 7);
assert.deepEqual(modelsInOrder(data.rows), ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-future", "gpt-6-luna", "gpt-6-sol"]);
assert.equal(data.rows.find(r => r.model === "gpt-6.1-terra" && r.effort === "max").score150, null);
assert.equal(data.rows.find(r => r.model === "gpt-6-sol").score150, null);
assert.deepEqual(data.unsupported, [{model:"gpt-6-luna",effort:"ultra"}]);
assert.deepEqual(effortColumns(data), ["ultra","max","xhigh","high","medium","low","experimental"]);
assert.equal(data.metadata.graded, undefined, "Missing grading metadata must not imply completion");
assert.throws(() => normalizeRadarSnapshot({rows: null}), /格式/);
assert.throws(() => normalizeRadarSnapshot(snapshot([row("gpt-6-sol","low",10),row("GPT-6-SOL","LOW",20)])), /重复/);
assert.equal(normalizeRadarSnapshot(snapshot([row(" GPT-6-SOL ", " HIGH ", 91)])).rows[0].model,"gpt-6-sol");
assert.throws(() => normalizeRadarSnapshot(snapshot([row(" gpt-6-sol ","low",10),row("GPT-6-SOL"," LOW ",20)])), /重复/);
const ranking = normalizeRadarSnapshot(snapshot([
 row("gpt-6-astra","high",120,4,120), row("gpt-6-astra","low",100,1,20),
 row("gpt-6.1-sol","high",90,0.001,1), row("gpt-6.1-sol","max",90.00001,0.1,30),
 row("gpt-6-luna","low",40,0.01,5), row("gpt-6.1-terra","low",110,0,0),
 row("gpt-6-sol","max",105,null,null), row("gpt-6-sol","low",null,0.0001,0.01),
 row("gpt-6-astra","max",101,-2,-1),
])).rows;
assert.deepEqual(rankRows(ranking,"score",{onlyAbove90:true}).map(keyOf), ["gpt-6-astra/high","gpt-6.1-terra/low","gpt-6-sol/max","gpt-6-astra/max","gpt-6-astra/low"]);
assert.deepEqual(rankRows(ranking,"value",{onlyAbove90:true}).map(keyOf), ["gpt-6.1-sol/max","gpt-6-astra/low","gpt-6-astra/high"]);
assert.deepEqual(rankRows(ranking,"speed",{onlyAbove90:true}).map(keyOf), ["gpt-6-astra/low","gpt-6.1-sol/max","gpt-6-astra/high"]);
assert.equal(rankRows(ranking,"value")[0].score150,90,"The unfiltered value ranking can include score 90");
assert.ok(rankRows(ranking,"value").some(r=>r.score150===40),"Removing the filter restores low scores");
assert.ok(rankRows(ranking,"value",{onlyAbove90:true}).some(r=>r.score150===90.00001),"Filter raw precision before rounding");
assert.equal(rankRows(ranking,"score").length,5);
assert.equal(radar.costText(0),"$0.00");
assert.equal(radar.timeText({model_elapsed_seconds:0}),"0.0 分钟");
assert.equal(radar.scoreText(null),"—");
assert.equal(radar.dateText("invalid"),"未提供");
assert.match(radar.dateText("2026-11-12T02:41:00Z"),/10:41/);
const oldSelection = row("gpt-6-sol", "max", 125, 3, 180);
const nextRound = normalizeRadarSnapshot(snapshot([row("gpt-6-sol", "high", 100)]));
assert.deepEqual(radar.resolveRadarSelection(nextRound, oldSelection), {model:"gpt-6-sol",effort:"max"}, "A disappeared combination must not retain old-round measurements in its details");
assert.equal(radar.resolveRadarSelection(nextRound, oldSelection, nextRound.rows).effort, "high");

const pending=[];const updates=[];
const loader=createRadarLoader(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
const old=loader.load(false,s=>updates.push(s));
loader.cancel();
const current=loader.load(true,s=>updates.push(s));
pending[1].resolve(snapshot([row("gpt-6.1-terra","max",99)],{metadata:{round_id:"new-round"}}));await current;
pending[0].resolve(snapshot([row("gpt-6-astra","high",130)]));await old;
assert.equal(updates.at(-1).snapshot.metadata.round_id,"new-round");
const previous=updates.at(-1).snapshot;
const failure=loader.load(true,s=>updates.push(s));pending[2].reject(new Error("HTTP 503"));await failure;
assert.deepEqual(updates.at(-1).snapshot.rows,previous.rows);
assert.equal(updates.at(-1).snapshot.fetched_at,previous.fetched_at);
assert.equal(updates.at(-1).snapshot.status,"stale");assert.match(updates.at(-1).error,/503/);
const malformed=loader.load(true,s=>updates.push(s));pending[3].resolve({rows:null});await malformed;
assert.equal(updates.at(-1).snapshot.metadata.round_id,"new-round");
const canceled=loader.load(true,s=>updates.push(s));loader.cancel();const count=updates.length;pending[4].reject(new Error("late"));await canceled;assert.equal(updates.length,count);
const cold=[];await createRadarLoader(async()=>{throw new Error("offline")}).load(false,s=>cold.push(s));assert.equal(cold.at(-1).snapshot,null);assert.equal(cold.at(-1).loading,false);
console.log("Codex Radar dynamic models, ordering, ranking precision, missing metrics and snapshot lifecycle passed");
