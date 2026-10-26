import useModelUsage from "./useModelUsage.js";

const compactCount = (value) => value === null ? "—" : new Intl.NumberFormat("zh-CN", {
  notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1,
}).format(value);
const exactCount = (value) => value === null ? "接口未提供" : new Intl.NumberFormat("zh-CN").format(value);

export function ModelUsageTable({ models, unit }) {
  const maxCost = Math.max(0.000001, ...models.map((model) => model.cost ?? 0));
  return (
    <div className="model-list">
      <table className="model-table" aria-label="所选时段各模型的消费金额、请求数和 Token 量">
        <colgroup><col className="model-name-column" /><col className="model-cost-column" /><col className="model-requests-column" /><col className="model-tokens-column" /></colgroup>
        <thead><tr><th scope="col">模型</th><th scope="col">消费金额</th><th scope="col">请求数</th><th scope="col">Token</th></tr></thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.name} data-model={model.name}>
              <th scope="row" title={model.name}>{model.name}</th>
              <td className="model-cost-cell" title={model.cost === null ? "接口未提供" : `${model.cost.toFixed(4)} ${unit}`}>
                <strong>{model.cost === null ? "—" : new Intl.NumberFormat("zh-CN", {
                  style: "currency", currency: unit, minimumFractionDigits: 4, maximumFractionDigits: 4,
                }).format(model.cost)}</strong>
                {model.cost !== null && <div className="model-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, model.cost / maxCost) * 100}%` }} /></div>}
              </td>
              <td title={`请求数：${exactCount(model.requests)}`}>{compactCount(model.requests)}</td>
              <td title={`Token：${exactCount(model.tokens)}`}>{compactCount(model.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ModelUsage({ period, revision, native, unit, previewFetchedAtMs }) {
  const state = useModelUsage({ period, revision, native, previewFetchedAtMs });
  return (
    <section className="data-section model-section" aria-labelledby="model-title" data-model-period={period.key} aria-busy={state.status === "loading"}>
      <div className="section-heading"><div><h2 id="model-title">模型消费</h2><p>{period.rangeLabel} · 按实际费用排序</p></div></div>
      {state.status === "loading" ? <div className="inline-empty" role="status">正在读取该时段的模型消费…</div>
        : state.status === "error" ? <div className="model-error" role="status"><span>{state.error}</span><button type="button" onClick={state.retry}>重试</button></div>
          : state.models.length > 0 ? <ModelUsageTable models={state.models} unit={unit} />
            : <div className="inline-empty">该时段暂无模型消费记录</div>}
    </section>
  );
}
