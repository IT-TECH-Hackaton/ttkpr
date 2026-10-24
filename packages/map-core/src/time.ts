// Time at the venue: events now and next, announcements, labels in the venue's time zone.
// Times in the document are ISO 8601 with an offset; the zone is only for showing them.

import type { Announcement, Poi, PoiEvent } from "@ttkpr/api-client";
import type { MapBundle } from "./bundle";

export const DEFAULT_TIME_ZONE = "Europe/Moscow";

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * ISO 8601 date-time with an offset -> ms since the epoch; null when missing, without an offset
 * or impossible. Parsed by hand: engines disagree on Date.parse of offsets and fractions.
 */
export function parseIsoTime(value: string | null | undefined): number | null {
  const m = ISO.exec(value?.trim() ?? "");
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59)
    return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null; // 31 February
  const zone = m[8] as string;
  let offsetMin = 0;
  if (zone !== "Z" && zone !== "z") {
    const digits = zone.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    offsetMin = zone[0] === "-" ? -minutes : minutes;
  }
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000;
}

const toMs = (now: Date | number) => (typeof now === "number" ? now : now.getTime());

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The venue's IANA time zone, Europe/Moscow when unset or unknown to this browser. */
export function venueTimeZone(bundle: MapBundle | null | undefined): string {
  const zone = bundle?.venue.timezone || DEFAULT_TIME_ZONE;
  return isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

export interface WallClock {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday .. 6 = Sunday */
  weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const clocks = new Map<string, Intl.DateTimeFormat>();

/** Calendar date and time of a moment as the clocks show it in `timeZone`. */
export function wallClock(at: Date | number, timeZone: string): WallClock {
  let format = clocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    clocks.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(toMs(at))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "")),
  };
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (c: WallClock) => c.year * 10000 + c.month * 100 + c.day;
/** Days between two calendar dates (b - a). */
const daysBetween = (a: WallClock, b: WallClock) =>
  Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 864e5);

/** "18:05" in the venue's time zone. */
export function formatClock(at: Date | number, timeZone: string): string {
  const c = wallClock(at, timeZone);
  return `${pad(c.hour)}:${pad(c.minute)}`;
}

/** "24 октября". */
export function formatDay(at: Date | number, timeZone: string): string {
  const c = wallClock(at, timeZone);
  return `${c.day} ${MONTHS[c.month - 1]}`;
}

/** "15 мин", "1 ч 10 мин", "2 ч". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
}

export interface EventRef {
  event: PoiEvent;
  poi: Poi;
  /** ms since the epoch */
  start: number;
  end: number;
}

export interface PoiEventsNow {
  /** Running now (the latest started, if several overlap). */
  current: EventRef | null;
  /** The next one to start. */
  next: EventRef | null;
}

export interface EventsNow {
  /** Places with something running or coming. */
  byPoi: Map<string, PoiEventsNow>;
  /** Everything running now across the venue, by start. */
  current: EventRef[];
  /** Everything still to start, by start. */
  upcoming: EventRef[];
}

/** Events of every place with valid times (end after start), in document order. */
export function allEvents(bundle: MapBundle): EventRef[] {
  const result: EventRef[] = [];
  for (const poi of bundle.pois ?? []) {
    for (const event of poi.events ?? []) {
      const start = parseIsoTime(event.start);
      const end = parseIsoTime(event.end);
      if (start !== null && end !== null && end > start) result.push({ event, poi, start, end });
    }
  }
  return result;
}

const byStart = (a: EventRef, b: EventRef) => a.start - b.start || a.end - b.end;

/** What is on now and what is next, per place and for the whole venue. */
export function eventsAt(bundle: MapBundle, now: Date | number = Date.now()): EventsNow {
  const t = toMs(now);
  const byPoi = new Map<string, PoiEventsNow>();
  const current: EventRef[] = [];
  const upcoming: EventRef[] = [];
  for (const ref of allEvents(bundle)) {
    const entry = byPoi.get(ref.poi.id) ?? { current: null, next: null };
    if (ref.start <= t && t < ref.end) {
      current.push(ref);
      if (!entry.current || ref.start > entry.current.start) entry.current = ref;
    } else if (ref.start > t) {
      upcoming.push(ref);
      if (!entry.next || ref.start < entry.next.start) entry.next = ref;
    } else continue;
    byPoi.set(ref.poi.id, entry);
  }
  return { byPoi, current: current.sort(byStart), upcoming: upcoming.sort(byStart) };
}

/** The programme of the venue's calendar day containing `day` (events overlapping it), by start. */
export function daySchedule(
  bundle: MapBundle,
  day: Date | number = Date.now(),
  timeZone = venueTimeZone(bundle),
): EventRef[] {
  const key = dayKey(wallClock(day, timeZone));
  return allEvents(bundle)
    .filter(
      (ref) =>
        dayKey(wallClock(ref.start, timeZone)) <= key &&
        key <= dayKey(wallClock(ref.end - 1, timeZone)),
    )
    .sort(byStart);
}

export type EventStatus = "past" | "live" | "soon" | "later";

/** Over, running, starting within `soonMinutes`, or later. */
export function eventStatus(
  ref: Pick<EventRef, "start" | "end">,
  now: Date | number = Date.now(),
  soonMinutes = 15,
): EventStatus {
  const t = toMs(now);
  if (t >= ref.end) return "past";
  if (t >= ref.start) return "live";
  return ref.start - t <= soonMinutes * 60_000 ? "soon" : "later";
}

/** "12:00–12:45" on the day of `now`, else "25 октября, 12:00–12:45"; spans days in full. */
export function formatEventTime(
  ref: Pick<EventRef, "start" | "end">,
  timeZone: string,
  now: Date | number = Date.now(),
): string {
  const start = wallClock(ref.start, timeZone);
  const end = wallClock(ref.end, timeZone);
  const today = wallClock(now, timeZone);
  const range = `${formatClock(ref.start, timeZone)}–${formatClock(ref.end, timeZone)}`;
  if (dayKey(start) !== dayKey(end)) {
    return `${formatDay(ref.start, timeZone)} ${formatClock(ref.start, timeZone)} – ${formatDay(ref.end, timeZone)} ${formatClock(ref.end, timeZone)}`;
  }
  return dayKey(start) === dayKey(today) ? range : `${formatDay(ref.start, timeZone)}, ${range}`;
}

/** "Идёт · ещё 25 мин", "Через 10 мин", "Сегодня в 18:00", "Завтра в 10:00", "25 октября в 10:00". */
export function eventWhen(
  ref: Pick<EventRef, "start" | "end">,
  timeZone: string,
  now: Date | number = Date.now(),
): string {
  const t = toMs(now);
  if (t >= ref.end) return "Закончилось";
  if (t >= ref.start) return `Идёт · ещё ${formatMinutes((ref.end - t) / 60_000)}`;
  const minutes = (ref.start - t) / 60_000;
  if (minutes < 1) return "Начинается";
  if (minutes <= 60) return `Через ${formatMinutes(minutes)}`;
  const days = daysBetween(wallClock(t, timeZone), wallClock(ref.start, timeZone));
  const at = formatClock(ref.start, timeZone);
  if (days === 0) return `Сегодня в ${at}`;
  if (days === 1) return `Завтра в ${at}`;
  return `${formatDay(ref.start, timeZone)} в ${at}`;
}

const KIND_ORDER: Record<string, number> = { warning: 0, info: 1, success: 2 };

/** Announcements shown now: warnings first, then in the organizer's order. */
export function activeAnnouncements(
  bundle: MapBundle,
  now: Date | number = Date.now(),
): Announcement[] {
  const t = toMs(now);
  return (bundle.venue.announcements ?? [])
    .filter((a) => {
      const start = a.start ? parseIsoTime(a.start) : Number.NEGATIVE_INFINITY;
      const end = a.end ? parseIsoTime(a.end) : Number.POSITIVE_INFINITY;
      return start !== null && end !== null && start <= t && t < end;
    })
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        (KIND_ORDER[x.a.kind ?? "info"] ?? 1) - (KIND_ORDER[y.a.kind ?? "info"] ?? 1) || x.i - y.i,
    )
    .map(({ a }) => a);
}

/**
 * The next moment an event or announcement starts or ends after `now` (ms), so a page can
 * refresh "идёт сейчас" and banners right on time; null when nothing changes any more.
 */
export function nextTimeChange(bundle: MapBundle, now: Date | number = Date.now()): number | null {
  const t = toMs(now);
  let next = Number.POSITIVE_INFINITY;
  const consider = (ms: number | null) => {
    if (ms !== null && ms > t && ms < next) next = ms;
  };
  for (const ref of allEvents(bundle)) {
    consider(ref.start);
    consider(ref.end);
  }
  for (const a of bundle.venue.announcements ?? []) {
    consider(parseIsoTime(a.start));
    consider(parseIsoTime(a.end));
  }
  return Number.isFinite(next) ? next : null;
}
