export const USAGE_PERIOD_MODES = [
  { id: "today", label: "本日" },
  { id: "week", label: "本周" },
  { id: "days", label: "15 日" },
  { id: "weeks", label: "4 周" },
];

export function dateKeyInTimezone(date, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const find = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${find("year")}-${find("month")}-${find("day")}`;
}

const parseDate = (value) => new Date(`${value}T12:00:00Z`);

export function addCalendarDays(value, amount) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

const weekStart = (value) => addCalendarDays(value, -((parseDate(value).getUTCDay() + 6) % 7));
const dateLabel = (value) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC", month: "2-digit", day: "2-digit",
}).format(parseDate(value));

export function getUsagePeriod(mode, todayKey = dateKeyInTimezone(new Date())) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)
    || Number(todayKey.slice(0, 4)) === 0
    || !Number.isFinite(parseDate(todayKey).getTime())
    || parseDate(todayKey).toISOString().slice(0, 10) !== todayKey) {
    throw new Error("无效的统计日期");
  }
  if (!USAGE_PERIOD_MODES.some((item) => item.id === mode)) throw new Error("无效的统计范围");
  const startDate = mode === "today" ? todayKey
    : mode === "week" ? weekStart(todayKey)
      : mode === "weeks" ? addCalendarDays(weekStart(todayKey), -21)
        : addCalendarDays(todayKey, -14);
  return {
    key: `${mode}:${startDate}:${todayKey}`,
    startDate,
    endDate: todayKey,
    rangeLabel: mode === "today" ? `${dateLabel(todayKey)} · 本日`
      : mode === "weeks" ? "含本周在内的 4 个自然周"
        : `${dateLabel(startDate)} 至 ${dateLabel(todayKey)}`,
  };
}

export function buildTrendSeries(days, mode, todayKey = dateKeyInTimezone(new Date())) {
  const period = getUsagePeriod(mode, todayKey);
  const usageByDate = new Map();
  days.forEach((day) => usageByDate.set(day.date, (usageByDate.get(day.date) ?? 0) + (day.cost ?? 0)));
  const points = mode === "weeks"
    ? Array.from({ length: 4 }, (_, index) => {
        const start = addCalendarDays(period.startDate, index * 7);
        const end = addCalendarDays(start, 6);
        const cost = Array.from({ length: 7 }, (_, offset) => addCalendarDays(start, offset))
          .reduce((sum, date) => sum + (date > todayKey ? 0 : usageByDate.get(date) ?? 0), 0);
        return { key: start, label: dateLabel(start), secondaryLabel: dateLabel(end), cost, future: false, current: index === 3 };
      })
    : Array.from({ length: mode === "today" ? 1 : mode === "week" ? 7 : 15 }, (_, index) => {
        const date = addCalendarDays(period.startDate, index);
        const future = date > todayKey;
        return {
          key: date,
          label: mode === "week" ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parseDate(date).getUTCDay()] : dateLabel(date),
          secondaryLabel: "",
          cost: future ? null : usageByDate.get(date) ?? 0,
          future,
          current: date === todayKey,
        };
      });
  return { ...period, points, total: points.reduce((sum, point) => sum + (point.cost ?? 0), 0) };
}
