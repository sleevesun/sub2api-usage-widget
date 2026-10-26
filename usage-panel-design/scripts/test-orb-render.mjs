import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  let OrbVisual;
  let describeOrb;
  try {
    ({ default: OrbVisual, describeOrb } = await server.ssrLoadModule("/src/OrbVisual.jsx"));
  } catch (error) {
    if (error.code !== "ERR_LOAD_URL") throw error;
  }
  assert.equal(typeof OrbVisual, "function", "The orb needs a visible body even before quota data arrives");
  const scenarios = [
    { props: { percent: null, hasUsage: false, error: null }, label: "…", state: "loading" },
    { props: { percent: null, hasUsage: false, error: "HTTP 502" }, label: "!", state: "error" },
    { props: { percent: 0, hasUsage: true, error: null }, label: "0%", state: "low" },
    { props: { percent: 79, hasUsage: true, error: null }, label: "79%", state: "ready" },
    { props: { percent: null, hasUsage: true, error: null }, label: "—", state: "unknown" },
    { props: { percent: 79, hasUsage: true, error: "HTTP 502" }, label: "79%", state: "stale" },
    { props: { percent: null, mode: "unrestricted", hasUsage: true, error: null }, label: "∞", state: "unlimited" },
    { props: { percent: 79, mode: "unrestricted", hasUsage: true, error: null }, label: "∞", state: "unlimited" },
    { props: { percent: null, mode: "unrestricted", hasUsage: true, error: "HTTP 502" }, label: "∞", state: "stale" },
    { props: { percent: null, mode: "unrestricted", hasUsage: false, error: null }, label: "…", state: "loading" },
    { props: { percent: null, mode: "unrestricted", hasUsage: false, error: "HTTP 502" }, label: "!", state: "error" },
    { props: { percent: null, mode: "quota_limited", hasUsage: true, error: null }, label: "—", state: "unknown" },
  ];
  for (const { props, label, state } of scenarios) {
    const model = describeOrb(props);
    assert.equal(model.label, label);
    assert.equal(model.state, state);
    const html = renderToStaticMarkup(createElement(OrbVisual, props));
    assert.ok(html.includes('data-orb-body="true"'), `${state} must keep a visible filled circular body`);
    assert.ok(html.includes(`>${label}</text>`));
    if (label === "∞") {
      assert.equal(model.percent, null, "Unlimited quota must not invent a remaining percentage");
      assert.equal(model.isLow, false, "Unlimited quota must not trigger a low-quota warning");
      assert.match(model.description, /不限额度/);
      assert.ok(model.liquidLevel > 0 && model.liquidLevel < 100, "Unlimited quota keeps a visible wave surface inside the orb");
      assert.ok(html.includes('data-orb-water="true"'), "Unlimited quota keeps the liquid fill");
      assert.ok(html.includes('<animate attributeName="d"'), "Unlimited quota keeps the animated waves");
    } else if (props.percent === null) {
      assert.ok(!html.includes('data-orb-water="true"'), "Unknown quota does not invent a water level");
    }
  }
  assert.match(
    describeOrb({ percent: null, mode: "unrestricted", hasUsage: true, error: "HTTP 502" }).description,
    /查询失败，暂用上次数据/,
    "A failed refresh preserves the last confirmed unlimited state",
  );
  assert.equal(describeOrb({ percent: 120, hasUsage: true }).percent, 100);
  assert.equal(describeOrb({ percent: -1, hasUsage: true }).percent, 0);
} finally {
  await server.close();
}
console.log("Orb loading, error, zero, live, unlimited animated liquid, unknown and stale rendering passed");
