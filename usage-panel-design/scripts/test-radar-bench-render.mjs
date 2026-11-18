import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer} from "vite";
import {normalizeRadarSnapshot} from "../src/radarBench.js";
const snapshot=normalizeRadarSnapshot({fetched_at:"2026-11-12T03:00:00Z",status:"latest",metadata:{author_test_interval:{completed_at:"2026-11-12T02:41:00Z"}},unsupported:[{model:"gpt-6-luna",effort:"ultra"}],rows:[
 {model:"gpt-6.1-terra",effort:"max",score150:121.25,cost_usd:2,model_elapsed_seconds:120,cost_kind:"api_equivalent_estimate"},
 {model:"gpt-6.2-astra",effort:"max",score150:90.00001,cost_usd:1,model_elapsed_seconds:60},
 {model:"gpt-6.2-sol",effort:"high",score150:90,cost_usd:0.1,model_elapsed_seconds:10},
 {model:"gpt-6-astra",effort:"max",score150:null,cost_usd:null,model_elapsed_seconds:null},
 {model:"gpt-6-luna",effort:"high",score150:30,cost_usd:0.01,model_elapsed_seconds:30},
]});
const bench={snapshot,loading:false,error:null,refresh:async()=>{}};
const server=await createServer({server:{middlewareMode:true,watch:null,hmr:false},appType:"custom"});
try {
 const {default:RadarBench}=await server.ssrLoadModule("/src/RadarBench.jsx");
 const render=(props={})=>renderToStaticMarkup(createElement(RadarBench,{bench,...props}));
 const matrix=render();
 for(const text of ["Codex Radar","矩阵视图","排名视图","121.25","$2.00","2.0 分钟","待评分","无此档位","并非人类 IQ","官网未提供判分进度","10:41"]) assert.ok(matrix.includes(text),text);
 assert.match(matrix,/aria-selected="true"[^>]*>.*?矩阵视图/);
 assert.ok(!matrix.includes("gpt-5.6")&&!matrix.includes("原型"));
 assert.ok(matrix.includes('data-cell="gpt-6.2-astra/max"')&&matrix.includes('data-cell="gpt-6.2-sol/high"'));
 const ranking=render({initialView:"ranking"});
 for(const text of ["纯智商榜","性价比榜","效率榜","智商 &gt; 90","checked"]) assert.ok(ranking.includes(text),text);
 assert.ok(!ranking.includes('data-model="gpt-6-luna"'),"The default ranking filter excludes low scores");
 assert.equal((ranking.match(/data-model="gpt-6\.2-astra"/g)||[]).length,3);
 assert.ok(!ranking.includes('data-model="gpt-6.2-sol"'),"Exactly 90 is excluded from all default rankings");
 const stale=render({bench:{...bench,snapshot:{...snapshot,status:"stale"},error:"HTTP 503"}});assert.ok(stale.includes("缓存数据")&&stale.includes("121.25"));
 const unavailable=render({bench:{snapshot:null,loading:false,error:"offline",refresh:async()=>{}}});assert.ok(unavailable.includes("不可用")&&unavailable.includes("offline"));
}finally{await server.close()}
console.log("Codex Radar matrix, rankings, default filter and fallback rendering passed");
