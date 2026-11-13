export default function LocalTpsControl({ state, native }) {
  const count = state.models?.reduce((total, row) => total + row.samples, 0) ?? 0;
  const label = state.status === "preview" ? "桌面 App 可用"
    : state.status === "loading" ? "读取中"
      : state.status === "error" ? "需要处理"
        : !state.enabled ? "未开启"
          : state.lastReceivedAtMs ? `${count} 个时段内样本` : "等待 Codex 连接";
  const error = state.operationError || state.error;
  return (
    <div className="local-tps">
      <details>
        <summary><span>本机 Codex TPS</span><span className="local-tps-status">{label}</span></summary>
        <div className="local-tps-details">
          <p>本机参考速度 = 输出 Token 总量 ÷ 有效请求总耗时。含网络与首字等待，排除可识别的工具活动；仅采集完整 HTTP/SSE 请求，暂不支持 WebSocket。</p>
          <p>开启会配置本机 Codex 计时事件，关闭会恢复由此修改的配置。启停后请重启 Codex；仅在此 App 运行时记录新请求，不补算历史会话。</p>
          <p>只保存模型、Token 和计时，不保存对话正文。样本保留 35 天；本机样本与账号消费范围可能不同。</p>
          {native && <div className="local-tps-actions">
            <button type="button" className="local-tps-toggle" disabled={state.busy || state.enabled == null}
              onClick={() => void state.setEnabled(!state.enabled)}>
              {state.busy ? "正在处理…" : state.enabled ? "停止采样并恢复配置" : "启用本机 TPS"}
            </button>
            {state.status === "error" && <button type="button" disabled={state.busy} onClick={() => void state.retry()}>重试读取</button>}
          </div>}
          {state.enabled && !error && <p role="status">{state.lastReceivedAtMs
            ? `正在采样 · 已保存 ${state.recordedSamples} 个有效请求；无对应样本的模型显示“—”。`
            : "已启用，请重启 Codex 并完成一次请求；数据通常会稍后批量送达。"}</p>}
        </div>
      </details>
      {error && <p className="local-tps-error" role="status">{error}</p>}
      <p className="local-tps-note">TPS 取自本机 Codex 采样，含网络与首字等待。{!state.enabled && state.recordedSamples > 0 ? "采样已停止，保留已记录数据。" : ""}</p>
    </div>
  );
}
