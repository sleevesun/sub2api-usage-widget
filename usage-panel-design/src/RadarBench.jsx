import { useEffect, useRef, useState } from "react";
import { ArrowsOut, ArrowClockwise, X } from "@phosphor-icons/react";
import { RADAR_BENCH_MODELS, RADAR_BENCH_EFFORTS, radarBenchKey } from "./radarBench.js";
import "./radarBench.css";

const numeric = (value) => typeof value === "number" && Number.isFinite(value);
const scoreText = (value) => numeric(value) ? value.toFixed(1) : "—";
const costText = (cell) => numeric(cell?.averageCostUsd) ? `$${cell.averageCostUsd.toFixed(2)}${cell.costPartial ? "*" : ""}` : "—";
const durationText = (cell) => numeric(cell?.averageDurationMinutes) ? `${cell.averageDurationMinutes.toFixed(1)}m${cell.durationPartial ? "*" : ""}` : "—";
const hasData = (cell) => numeric(cell?.fetchedAtMs);
const relativeTime = (timestamp, nowMs) => {
  if (!numeric(timestamp)) return "等待首次读取";
  const minutes = Math.floor(Math.max(0, nowMs - timestamp) / 60000);
  return minutes < 1 ? "刚刚读取" : minutes < 60 ? `${minutes} 分钟前读取` : `${Math.floor(minutes / 60)} 小时前读取`;
};

function cellDescription(model, effort, cell, nowMs) {
  const name = `${model.label} · ${effort}`;
  if (!cell) return `${name}：正在读取`;
  if (!hasData(cell)) return `${name}：读取失败，${cell.error || "请重试"}`;
  return [
    name,
    `雷达分 ${scoreText(cell.score)} / 150`,
    `平均 API 等价费用 ${costText(cell)}${cell.costPartial ? `（已知 ${cell.costKnownSamples}/${cell.samples}）` : ""}`,
    `平均总耗时 ${durationText(cell)}${cell.durationPartial ? `（已知 ${cell.durationKnownSamples}/${cell.samples}）` : ""}`,
    `覆盖 ${cell.coverage}/64`,
    cell.stale ? `暂用缓存，${relativeTime(cell.fetchedAtMs, nowMs)}，${cell.error}` : "",
  ].filter(Boolean).join("｜");
}

function Matrix({ cells, selected, onSelect, nowMs, expanded = false }) {
  return (
    <div className={`bench-matrix-wrap${expanded ? " is-expanded" : ""}`} tabIndex={0} role="region" aria-label="模型与思考档位矩阵，可选择单元格查看详情">
      <table className="bench-table" aria-label="雷达分、费用与耗时：模型与思考档位矩阵">
        <colgroup><col />{RADAR_BENCH_EFFORTS.map((effort) => <col key={effort} />)}</colgroup>
        <thead><tr><th scope="col">模型 / 档位</th>{RADAR_BENCH_EFFORTS.map((effort) => <th scope="col" key={effort}>{effort.toUpperCase()}</th>)}</tr></thead>
        <tbody>{RADAR_BENCH_MODELS.map((model) => (
          <tr key={model.id} data-family={model.family}>
            <th scope="row">
              <span className="bench-model-name"><i aria-hidden="true" />{model.name}</span>
              <span className="bench-model-generation">{model.generation}</span>
            </th>
            {RADAR_BENCH_EFFORTS.map((effort) => {
              const key = radarBenchKey({ model: model.id, effort });
              if (model.id.endsWith("-luna") && effort === "ultra") {
                return <td key={effort}><span className="bench-cell-empty" title={`${model.label} · ultra：无此档位`} aria-label={`${model.label} · ultra：无此档位`}>—</span></td>;
              }
              const cell = cells[key];
              const description = cellDescription(model, effort, cell, nowMs);
              const available = hasData(cell);
              return (
                <td key={effort}>
                  <button type="button" className={`bench-cell${cell?.stale ? " is-stale" : ""}${cell?.error && !available ? " is-failed" : ""}`}
                    data-bench-cell={key} aria-pressed={selected === key} aria-label={description} title={description}
                    disabled={!cell} onClick={() => onSelect(key)}>
                    {available ? <>
                      <strong className="bench-cell-value">{scoreText(cell.score)}</strong>
                      <span className="bench-cell-cost">{costText(cell)}</span>
                      <span className="bench-cell-duration">{durationText(cell)}</span>
                    </> : <>
                      <strong className="bench-cell-value">{cell?.error ? "—" : "…"}</strong>
                      <span className="bench-cell-note">{cell?.error ? "待重试" : "读取中"}</span>
                    </>}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function SelectedDetail({ cell, selected, refresh, isRefreshing, nowMs }) {
  const model = RADAR_BENCH_MODELS.find((item) => selected.startsWith(`${item.id}/`));
  const effort = selected.split("/")[1];
  return (
    <div className="bench-selection" aria-live="polite">
      <div className="bench-selection-head">
        <strong>{model?.label}<span>{effort}</span></strong>
        <span className="bench-selection-status">{hasData(cell) ? `覆盖 ${cell.coverage}/64` : cell?.error ? "读取失败" : "正在读取"}</span>
      </div>
      {hasData(cell) && <div className="bench-selected-metrics">
        <div><b>{scoreText(cell.score)}</b><small> / 150</small><span>雷达分{cell.status === "provisional" ? " · 阶段分" : ""}</span></div>
        <div><b>{costText(cell)}</b><span>{cell.costPartial ? `费用 · 已知 ${cell.costKnownSamples}/${cell.samples}` : "平均 API 等价费用"}</span></div>
        <div><b>{scoreText(cell.averageDurationMinutes)}{cell.durationPartial && numeric(cell.averageDurationMinutes) ? "*" : ""}</b><small> 分钟</small><span>{cell.durationPartial ? `耗时 · 已知 ${cell.durationKnownSamples}/${cell.samples}` : "平均总耗时"}</span></div>
      </div>}
      {!cell && <p className="bench-selection-message">正在读取这个档位的分数、费用和耗时。</p>}
      {cell?.error && <div className="bench-selection-error" role="status">
        <p>{cell.stale ? `暂用缓存，${relativeTime(cell.fetchedAtMs, nowMs)}。` : ""}{cell.error}</p>
        <button type="button" disabled={isRefreshing} onClick={() => { void refresh({ model: model.id, effort }); }}>重新读取这个档位</button>
      </div>}
    </div>
  );
}

export default function RadarBench({ bench, nowMs }) {
  const [selected, setSelected] = useState("gpt-6-astra/xhigh");
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef(null);
  const cells = bench.cells;
  const errors = Object.values(cells).filter((cell) => cell.error).length;
  const cell = cells[selected];
  const detail = <SelectedDetail cell={cell} selected={selected} refresh={bench.refresh} isRefreshing={bench.isRefreshing} nowMs={nowMs} />;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded && !dialog.open) dialog.showModal();
    else if (!expanded && dialog.open) dialog.close();
  }, [expanded]);

  return (
    <section className="data-section bench-section" id="radar-bench" aria-labelledby="radar-bench-title">
      <div className="section-heading bench-heading">
        <div><h2 id="radar-bench-title">雷达Bench</h2></div>
        <div className="bench-heading-actions">
          <span className="bench-update" aria-live="polite">{bench.isRefreshing ? `读取 ${bench.resolved}/${bench.pendingCount}` : relativeTime(bench.lastAttemptAtMs, nowMs)}</span>
          <button type="button" className="bench-icon-button" aria-label="刷新雷达Bench" title="刷新雷达Bench" disabled={bench.isRefreshing} onClick={() => { void bench.refresh(); }}><ArrowClockwise size={15} /></button>
          <button type="button" className="bench-icon-button" aria-label="展开完整雷达Bench矩阵" title="展开完整矩阵" onClick={() => setExpanded(true)}><ArrowsOut size={15} /></button>
        </div>
      </div>
      <div className="bench-toolbar"><span>雷达分　费用（$）　耗时（分钟）</span><span>满分 150</span></div>
      <Matrix cells={cells} selected={selected} onSelect={setSelected} nowMs={nowMs} />
      <div className="bench-legend"><span>每格从上到下：雷达分 · 费用 · 耗时</span><span>点击查看详情</span></div>
      {detail}
      {(errors > 0 || bench.batchError) && <p className="bench-refresh-warning" role="status">{bench.batchError || `${errors} 个档位读取失败；有历史数据的档位暂用缓存，可选择后重试。`}</p>}
      <div className="bench-source-line"><span>* 仅有记录的样本均值</span><a href="https://codexradar.com/" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></div>
      <dialog className="bench-dialog" ref={dialogRef} aria-labelledby="radar-bench-dialog-title" onClose={() => setExpanded(false)} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setExpanded(false);
      }}>
        <div className="bench-dialog-heading"><div><h2 id="radar-bench-dialog-title">雷达Bench</h2><p>64 道题 · 满分 150 · 模型 × 思考档位</p></div>
          <button type="button" className="bench-icon-button" aria-label="关闭完整矩阵" onClick={() => setExpanded(false)}><X size={18} /></button>
        </div>
        <p className="bench-dialog-note">费用：平均 API 等价美元　耗时：平均总耗时</p>
        {detail}
        <Matrix cells={cells} selected={selected} onSelect={setSelected} nowMs={nowMs} expanded />
        <p className="bench-dialog-footer">* 表示仅按已有记录计算的均值，具体样本覆盖见所选档位。未覆盖题不按 0 分计入；0.0 表示真实判分。费用为 API 等价成本。</p>
      </dialog>
    </section>
  );
}
