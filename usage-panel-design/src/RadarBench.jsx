import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, ArrowsOut, ChartBar, Coins, GridFour, Lightning, Trophy, X } from "@phosphor-icons/react";
import { numeric, scored, keyOf, scoreText, costText, timeText, modelName, modelParts, dateText, modelsInOrder, rankRows, effortColumns, resolveRadarSelection } from "./radarBench.js";
import "./radarBench.css";
import { openCodexRadarHomepage, runningInTauriSync } from "./tauriBridge.js";

function Matrix({ snapshot, selected, onSelect }) {
  const models = modelsInOrder(snapshot.rows);
  const columns = effortColumns(snapshot);
  const cells = new Map(snapshot.rows.map((row) => [keyOf(row), row]));
  const unsupported = new Set((snapshot.unsupported || []).map(keyOf));
  const bestKey = rankRows(snapshot.rows)[0] ? keyOf(rankRows(snapshot.rows)[0]) : null;
  return <>
    <div className="crp-matrix-scroll" role="region" tabIndex={0} aria-label="模型与推理强度矩阵，可横向滚动">
      <table className="crp-matrix" style={{ "--crp-matrix-min": `${80 + columns.length * 81}px` }} aria-label="GPT-6、GPT-6.1 模型矩阵：Bench 满分150，费用美元，耗时分钟">
        <colgroup><col className="crp-model-col" />{columns.map((effort) => <col key={effort} />)}</colgroup>
        <thead><tr><th scope="col">模型 / 档位</th>{columns.map((effort) => <th scope="col" key={effort}>{effort.toUpperCase()}</th>)}</tr></thead>
        <tbody>{models.map((model) => {
          const parts = modelParts(model);
          return <tr key={model}>
            <th scope="row"><strong>{parts.name}</strong><span>{parts.generation}</span></th>
            {columns.map((effort) => {
              const key = `${model}/${effort}`, row = cells.get(key), valid = scored(row);
              if (!row && unsupported.has(key)) return <td key={key}><div className="crp-unsupported" aria-label={`${modelName(model)} ${effort}：无此档位`}><span>—</span><small>无此档位</small></div></td>;
              const description = `${modelName(model)} ${effort}，${valid ? `Bench ${scoreText(row.score150)} / 150` : "未测或结果未知"}，估算费用 ${costText(row?.cost_usd)}，耗时 ${timeText(row)}`;
              return <td key={key}><button className={`crp-cell${valid ? "" : " is-ungraded"}`} type="button" data-cell={key} aria-label={description} title={description} aria-pressed={selected === key} onClick={() => onSelect(row || { model, effort })}>
                <span className="crp-cell-score"><strong>{valid ? scoreText(row.score150) : "待评分"}</strong>{key === bestKey && <i aria-label="本轮最高分" />}</span>
                <span className="crp-score-track" aria-hidden="true"><span style={{ width: `${valid ? Math.min(100, Math.max(0, row.score150 / 150 * 100)) : 0}%` }} /></span>
                <span className="crp-cell-cost">{costText(row?.cost_usd)}</span><span className="crp-cell-time">{timeText(row)}</span>
              </button></td>;
            })}
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="crp-legend"><span><i className="crp-unknown-key" />待评分：未测或结果未知</span><span><i className="crp-unsupported-key">—</i>无此档位</span><span className="crp-scroll-hint">窄窗口可横向滚动</span></div>
  </>;
}

const boards = [
  { type: "score", title: "纯智商榜", subtitle: "按 Bench 得分排序", icon: Trophy },
  { type: "value", title: "性价比榜", subtitle: "按得分 ÷ 美元排序", icon: Coins },
  { type: "speed", title: "效率榜", subtitle: "按得分 ÷ 分钟排序", icon: Lightning },
];

function Rankings({ rows, onlyAbove90, selected, onSelect }) {
  return <>
    <div className="crp-rank-grid">{boards.map((board) => {
      const Icon = board.icon, ranked = rankRows(rows, board.type);
      return <section className="crp-board" key={board.type} aria-label={board.title}>
        <header><div className="crp-board-title"><Icon size={15} /><h3>{board.title}</h3><span>TOP 5</span></div><p>{board.subtitle}</p></header>
        <ol>{ranked.map((row, index) => <li key={keyOf(row)}><button type="button" className="crp-rank-item" data-rank-type={board.type} data-model={row.model} data-effort={row.effort} aria-pressed={selected === keyOf(row)} onClick={() => onSelect(row)}>
          <span className={`crp-rank-number${index === 0 ? " is-first" : ""}`}>{index + 1}</span>
          <span className="crp-rank-copy"><strong>{modelName(row.model)}</strong><span className="crp-rank-subline"><span className="crp-effort">{row.effort.toUpperCase()}</span><small>{board.type === "value" ? timeText(row) : board.type === "speed" ? costText(row.cost_usd) : `${costText(row.cost_usd)} · ${timeText(row)}`}</small></span></span>
          <span className="crp-rank-value"><strong>{scoreText(row.score150)}<small> 分</small></strong>{board.type !== "score" && <span>{board.type === "value" ? costText(row.cost_usd) : timeText(row)}</span>}</span>
        </button></li>)}</ol>
        {!ranked.length && <p className="crp-board-empty">{onlyAbove90 ? "暂无智商 > 90 的有效数据" : "暂无有效数据"}</p>}
      </section>;
    })}</div>
    <p className="crp-ranking-note">同一模型的各档位独立排名；缺少有效费用或耗时的组合不进入对应榜单。</p>
  </>;
}

function Selection({ row }) {
  if (!row) return null;
  return <div className="crp-selection" aria-label="选中组合详情" aria-live="polite">
    <div className="crp-selection-name"><span>当前选择</span><strong>{modelName(row.model)}<span className="crp-effort">{row.effort.toUpperCase()}</span></strong></div>
    <dl><div><dt>Bench 得分</dt><dd className="crp-detail-score">{scored(row) ? scoreText(row.score150) : "待评分"}<small> / 150</small></dd></div><div><dt>估算费用</dt><dd>{costText(row.cost_usd)}</dd></div><div><dt>耗时</dt><dd>{timeText(row)}</dd></div></dl>
  </div>;
}

function Header({ bench, snapshot, status, expanded, onExpand, onClose }) {
  const [linkError, setLinkError] = useState(null);
  const openHomepage = (event) => {
    if (!runningInTauriSync()) return;
    event.preventDefault();
    setLinkError(null);
    void openCodexRadarHomepage().catch(() => setLinkError("暂时无法打开官网，请稍后重试"));
  };
  return <>
    <div className="crp-heading"><div className="crp-title"><h2>Codex Radar</h2><span className={`crp-status is-${status.type}`} role="status"><i />{status.label}</span></div>
      <div className="crp-actions">
        <button type="button" onClick={() => { void bench.refresh(); }} disabled={bench.loading} title="从官网刷新整轮数据"><ArrowClockwise size={13} className={bench.loading ? "crp-spinning" : ""} /><span>刷新数据</span></button>
        <a href="https://codexradar.com/" target="_blank" rel="noopener noreferrer" onClick={openHomepage}>官网<ArrowSquareOut size={12} /></a>
        {expanded ? <button type="button" className="crp-icon" aria-label="关闭展开看板" title="关闭" onClick={onClose}><X size={16} /></button> : <button type="button" className="crp-icon" aria-label="展开 Codex Radar 看板" title="展开看板" onClick={onExpand}><ArrowsOut size={15} /></button>}
      </div>
    </div>
    <div className="crp-meta"><span>本轮测试完成 {dateText(snapshot?.metadata?.author_test_interval?.completed_at)}<span className="crp-timezone"> · 北京时间</span></span>{expanded && <span>模型评测看板</span>}</div>
    {linkError && <p className="crp-feedback" role="status">{linkError}</p>}
  </>;
}

export default function RadarBench({ bench, initialView = "matrix" }) {
  const [view, setView] = useState(initialView);
  const [expanded, setExpanded] = useState(false);
  const [onlyAbove90, setOnlyAbove90] = useState(true);
  const [selected, setSelected] = useState(null);
  const dialogRef = useRef(null);
  const snapshot = bench.snapshot;
  const loading = bench.loading;
  const rankingRows = snapshot?.rows.filter((item) => !onlyAbove90 || (scored(item) && item.score150 > 90)) || [];
  const row = resolveRadarSelection(snapshot, selected, view === "ranking" ? rankingRows : null);
  const activeKey = row ? keyOf(row) : null;
  const status = loading ? { label: "读取中", type: "loading" } : !snapshot ? { label: "不可用", type: "error" } : bench.error || snapshot.status === "stale" ? { label: "缓存数据", type: "stale" } : snapshot.status === "cached" ? { label: "已缓存", type: "cached" } : { label: "最新", type: "latest" };
  const chooseView = setView;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (expanded && !dialog.open) dialog.showModal();
    if (!expanded && dialog.open) dialog.close();
  }, [expanded]);

  const content = (scope) => <div className="crp-content">
    <div className="crp-toolbar"><div className="crp-views" role="tablist" aria-label="Codex Radar 视图">{[{ id: "matrix", label: "矩阵视图", icon: GridFour }, { id: "ranking", label: "排名视图", icon: ChartBar }].map((tab) => {
      const Icon = tab.icon;
      return <button type="button" role="tab" id={`crp-${scope}-${tab.id}`} aria-controls={`crp-${scope}-panel`} aria-selected={view === tab.id} key={tab.id} onClick={() => chooseView(tab.id)}><Icon size={13} />{tab.label}</button>;
    })}</div>{view === "ranking" && <label className="crp-ranking-filter"><input type="checkbox" checked={onlyAbove90} onChange={(event) => setOnlyAbove90(event.target.checked)} /><span>智商 &gt; 90</span></label>}<div className="crp-scope"><span className="crp-count">GPT-6 / 6.1</span><span>Bench 满分 <b>150</b></span></div></div>
    {status.type === "stale" && <p className="crp-feedback" role="status">本次读取失败，暂用 {dateText(snapshot.fetched_at)} 获取的整轮缓存。</p>}
    <div role="tabpanel" id={`crp-${scope}-panel`} aria-labelledby={`crp-${scope}-${view}`}>
      {!snapshot ? <div className="crp-empty"><strong>{loading ? "正在读取官网评测数据…" : "暂时无法读取官网数据"}</strong><p>{loading ? "分数、费用和耗时将同步更新" : bench.error || "尚无可用缓存，请稍后刷新"}</p>{!loading && <button type="button" onClick={() => { void bench.refresh(); }}>重新读取</button>}</div> : !snapshot.rows.length ? <div className="crp-empty">本轮暂无 GPT-6 / 6.1 系列数据</div> : view === "matrix" ? <Matrix snapshot={snapshot} selected={activeKey} onSelect={setSelected} /> : <Rankings rows={rankingRows} onlyAbove90={onlyAbove90} selected={activeKey} onSelect={setSelected} />}
    </div>
    <Selection row={row} />
    <footer className="crp-source"><p>“智商”仅为 Bench 得分的通俗叫法，并非人类 IQ。</p><div><span>{row?.cost_kind === "api_equivalent_estimate" ? "API 等价估算费用" : "官网估算费用"} · 模型执行耗时</span><span>{numeric(snapshot?.metadata?.graded) && numeric(snapshot?.metadata?.expected) ? `判分 ${snapshot.metadata.graded}/${snapshot.metadata.expected}` : "官网未提供判分进度"}</span></div></footer>
  </div>;

  return <section className="data-section crp" id="radar-bench" aria-label="Codex Radar 模型评测看板">
    <Header bench={bench} snapshot={snapshot} status={status} onExpand={() => setExpanded(true)} />
    {content("inline")}
    <dialog className="crp-dialog" ref={dialogRef} aria-label="Codex Radar 展开看板" onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)}>
      <Header bench={bench} snapshot={snapshot} status={status} expanded onClose={() => setExpanded(false)} />
      {expanded && content("expanded")}
    </dialog>
  </section>;
}
