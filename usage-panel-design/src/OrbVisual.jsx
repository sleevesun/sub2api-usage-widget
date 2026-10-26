import { useId } from "react";

export function describeOrb({ percent, mode, hasUsage, error }) {
  const isUnlimited = Boolean(hasUsage) && mode === "unrestricted";
  const known = hasUsage && !isUnlimited && typeof percent === "number" && Number.isFinite(percent);
  const value = known ? Math.min(100, Math.max(0, percent)) : null;
  const isLow = value !== null && value < 20;
  const state = error ? (known || isUnlimited ? "stale" : "error") : !hasUsage ? "loading" : isUnlimited ? "unlimited" : !known ? "unknown" : isLow ? "low" : "ready";
  const label = isUnlimited ? "∞" : known ? `${Math.round(value)}%` : error ? "!" : !hasUsage ? "…" : "—";
  const cachedPrefix = error ? "查询失败，暂用上次数据；" : "";
  const description = isUnlimited ? `${cachedPrefix}不限额度` : known
    ? `${cachedPrefix}剩余额度 ${label}`
    : error ? `用量读取失败：${error}` : !hasUsage ? "正在读取用量" : "未提供总额度，无法计算百分比";
  return { percent: value, liquidLevel: isUnlimited ? 75 : value, isUnlimited, isLow, state, label, description, warning: Boolean(error) || isLow };
}

export default function OrbVisual(props) {
  const id = useId();
  const { liquidLevel, isUnlimited, label, warning, state } = describeOrb(props);
  const liquidY = 100 - (liquidLevel ?? 0);
  const color = warning ? "#ff9f0a" : "#2c8be0";
  const color2 = warning ? "#e67e00" : "#1c6fc7";
  const colorTop = warning ? "#ffc94d" : "#6cb4e8";
  return (
    <svg viewBox="0 0 100 100" className="orb-window-svg" width="72" height="72" data-orb-state={state} aria-hidden="true">
      <defs>
        <clipPath id={`${id}-clip`}><circle cx="50" cy="50" r="49" /></clipPath>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={warning ? "#fff1ce" : "#dceeff"} />
          <stop offset="100%" stopColor={warning ? "#f3c36d" : "#9fcaf0"} />
        </linearGradient>
        <linearGradient id={`${id}-liquid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colorTop} /><stop offset="60%" stopColor={color} /><stop offset="100%" stopColor={color2} />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx="30%" cy="22%" r="55%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.72)" />
          <stop offset="45%" stopColor="rgba(255,255,255,0.1)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <filter id={`${id}-text-shadow`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="0.5" floodColor="#0a2540" floodOpacity="0.5" />
        </filter>
      </defs>
      <circle data-orb-body="true" cx="50" cy="50" r="49" fill={`url(#${id}-body)`} />
      {liquidLevel !== null && <g clipPath={`url(#${id}-clip)`}>
        <rect data-orb-water="true" x="0" y={liquidY} width="100" height={liquidLevel} fill={`url(#${id}-liquid)`} />
        <path d={`M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z`} fill="rgba(255,255,255,0.35)">
          <animate attributeName="d" values={`M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z;
            M 0 ${liquidY} Q 12.5 ${liquidY + 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z;
            M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z`} dur="3.2s" repeatCount="indefinite" />
        </path>
        <path d={`M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z`} fill="rgba(255,255,255,0.22)">
          <animate attributeName="d" values={`M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z;
            M 0 ${liquidY + 1.5} Q 16 ${liquidY + 3.5} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z;
            M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z`} dur="4.4s" repeatCount="indefinite" />
        </path>
        {liquidLevel > 0 && <>
          <circle cx="30" cy="88" r="1.8" fill="rgba(255,255,255,0.65)"><animate attributeName="cy" values="88;68;88" dur="4.6s" repeatCount="indefinite" /></circle>
          <circle cx="44" cy="92" r="1.2" fill="rgba(255,255,255,0.45)"><animate attributeName="cy" values="92;72;92" dur="3.8s" repeatCount="indefinite" /></circle>
          <circle cx="56" cy="90" r="1" fill="rgba(255,255,255,0.4)"><animate attributeName="cy" values="90;74;90" dur="5.2s" repeatCount="indefinite" /></circle>
        </>}
      </g>}
      <circle cx="50" cy="50" r="49" fill={`url(#${id}-shine)`} />
      <circle cx="50" cy="50" r="48.5" fill="none" stroke={warning ? "#dda94f" : "#75b0df"} strokeWidth="1.5" />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize={isUnlimited ? 30 : 20} fontWeight="700" fill="#ffffff"
        style={{ fontFamily: "system-ui,-apple-system,Segoe UI,sans-serif", letterSpacing: "-0.02em", paintOrder: "stroke fill" }}
        stroke="#0a2540" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" filter={`url(#${id}-text-shadow)`}>{label}</text>
    </svg>
  );
}
