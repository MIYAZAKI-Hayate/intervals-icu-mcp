const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: string): Date {
  if (!DATE_RE.test(value)) throw new Error("Dates must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

export function validateRange(oldest: string, newest: string, maxDays: number): void {
  const start = parseDate(oldest);
  const end = parseDate(newest);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1) throw new Error("oldest must be on or before newest");
  if (days > maxDays) throw new Error(`Date range must not exceed ${maxDays} days`);
}

export function japanToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, amount: number): string {
  const value = parseDate(date);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
