import type { MapDocument, Poi, PoiEvent } from "@ttkpr/api-client";
import { describe, expect, it } from "vitest";
import { amenityEmoji, amenityLabel, categoryOf, poiCategories } from "./categories";
import { contrastRatio, darkVariant, luminance, parseHex, textOn } from "./color";
import { fromLocal, type LonLat, toLocal } from "./geo";
import { languageName, localized, pickLanguage, venueLanguages } from "./i18n";
import { labelPoint, placeOf, poisIn, unitAt, zoneAt } from "./places";
import { insideRing } from "./routing/geometry";
import { searchEntries } from "./search";
import {
  activeAnnouncements,
  daySchedule,
  eventStatus,
  eventsAt,
  eventWhen,
  formatEventTime,
  nextTimeChange,
  parseIsoTime,
  venueTimeZone,
  wallClock,
} from "./time";

const anchor: LonLat = [37.62, 55.754];
const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
const box = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon" as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});
const MSK = "Europe/Moscow";
/** 24 October 2026, hh:mm Moscow time. */
const msk = (hh: number, mm = 0, day = 24) => Date.UTC(2026, 9, day, hh - 3, mm);

const event = (
  id: string,
  start: string,
  end: string,
  extra: Partial<PoiEvent> = {},
): PoiEvent => ({
  id,
  title: `Событие ${id}`,
  start,
  end,
  ...extra,
});

function venue(): MapDocument {
  const stage: Poi = {
    id: "stage",
    levelId: "l1",
    name: "Сцена",
    category: "stage",
    position: at(5, 5),
    tags: ["питчи", "главная"],
    translations: {
      en: { name: "Main stage" },
      "zh-hans": { name: "主舞台", description: "演讲" },
    },
    events: [
      event("e1", "2026-10-24T10:00:00+03:00", "2026-10-24T11:00:00+03:00"),
      event("e2", "2026-10-24T12:00:00+03:00", "2026-10-24T13:00:00+03:00", {
        title: "Открытие",
        speaker: "Анна Иванова",
      }),
      // The same zone written in UTC and in Novosibirsk time: only the moment matters.
      event("e3", "2026-10-24T11:00:00Z", "2026-10-24T12:00:00Z", { title: "Питчи" }),
      event("e4", "2026-10-24T22:00:00+07:00", "2026-10-24T23:00:00+07:00"),
    ],
  };
  const hall: Poi = {
    id: "hall-poi",
    levelId: "l1",
    name: "Мастер-класс",
    category: "partner",
    position: at(15, 5),
    events: [event("e5", "2026-10-24T16:15:00+07:00", "2026-10-24T16:45:00+07:00")],
  };
  return {
    venue: {
      id: "v",
      name: "Форум",
      anchor,
      timezone: MSK,
      languages: ["ru", "en", "zh-hans"],
      categories: [
        { id: "partner", label: "Партнёр", emoji: "🤝", color: "#ff0000" },
        { id: "stand", label: "Экспонент" },
      ],
      announcements: [
        { id: "a1", text: "Добро пожаловать" },
        {
          id: "a2",
          text: "Зал B закрыт до 13:00",
          kind: "warning",
          start: "2026-10-24T12:00:00+03:00",
          end: "2026-10-24T13:00:00+03:00",
        },
        {
          id: "a3",
          text: "Регистрация завершена",
          kind: "success",
          end: "2026-10-24T12:00:00+03:00",
        },
        { id: "a4", text: "Скоро обед", start: "2026-10-24T13:00:00+03:00" },
        { id: "a5", text: "Сломанная дата", start: "завтра" },
      ],
    },
    levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
    units: [
      {
        id: "u-hall",
        levelId: "l1",
        name: "Зал A",
        category: "hall",
        geometry: box(0, 0, 10, 10),
        amenities: ["wifi", "power"],
        translations: { en: { name: "Hall A" } },
      },
      {
        id: "u-room",
        levelId: "l1",
        name: "Переговорная",
        category: "room",
        geometry: box(10, 0, 20, 10),
      },
      {
        id: "u-corr",
        levelId: "l1",
        name: "Коридор",
        category: "corridor",
        geometry: box(0, 10, 20, 13),
      },
    ],
    zones: [
      {
        id: "z-food",
        levelId: "l1",
        name: "Фудкорт",
        geometry: box(1, 1, 8, 8),
        description: "Еда и кофе",
      },
    ],
    pois: [stage, hall],
  };
}

describe("times with offsets", () => {
  it("parses ISO 8601 with an offset by hand, rejects the rest", () => {
    const nine = Date.UTC(2026, 9, 24, 9, 0, 0);
    expect(parseIsoTime("2026-10-24T12:00:00+03:00")).toBe(nine);
    expect(parseIsoTime("2026-10-24T09:00:00Z")).toBe(nine);
    expect(parseIsoTime("2026-10-24 16:00+0700")).toBe(nine);
    expect(parseIsoTime("2026-10-24T05:30:00.250-03:30")).toBe(nine + 250);
    expect(parseIsoTime("2026-10-24T12:00:00.123456789+03:00")).toBe(nine + 123);
    expect(parseIsoTime("2026-10-24T12:00:00")).toBeNull(); // no offset: ambiguous
    expect(parseIsoTime("2026-02-31T12:00:00Z")).toBeNull();
    expect(parseIsoTime("2026-10-24T24:00:00Z")).toBeNull();
    expect(parseIsoTime("завтра")).toBeNull();
    expect(parseIsoTime(null)).toBeNull();
  });

  it("reads the wall clock of the venue", () => {
    expect(wallClock(msk(0, 30), MSK)).toMatchObject({ day: 24, hour: 0, minute: 30, weekday: 5 });
    expect(wallClock(msk(0, 30), "UTC")).toMatchObject({ day: 23, hour: 21, minute: 30 });
    expect(venueTimeZone(venue())).toBe(MSK);
    expect(venueTimeZone({ venue: { ...venue().venue, timezone: "Mars/Olympus" } })).toBe(MSK);
    expect(venueTimeZone({ venue: { ...venue().venue, timezone: "Asia/Novosibirsk" } })).toBe(
      "Asia/Novosibirsk",
    );
  });
});

describe("events", () => {
  it("knows what is on now and next, per place and for the venue", () => {
    const now = msk(12, 30);
    const { byPoi, current, upcoming } = eventsAt(venue(), now);
    expect(byPoi.get("stage")?.current?.event.id).toBe("e2");
    expect(byPoi.get("stage")?.next?.event.id).toBe("e3");
    expect(byPoi.get("hall-poi")?.current?.event.id).toBe("e5");
    expect(current.map((r) => r.event.id)).toEqual(["e2", "e5"]);
    expect(upcoming.map((r) => r.event.id)).toEqual(["e3", "e4"]);
    // Late in the evening nothing runs and only the last talk is ahead.
    const late = eventsAt(venue(), msk(17, 30));
    expect(late.current).toEqual([]);
    expect(late.upcoming.map((r) => r.event.id)).toEqual(["e4"]);
    expect(eventsAt(venue(), msk(23)).byPoi.size).toBe(0);
  });

  it("lists the programme of the day", () => {
    expect(daySchedule(venue(), msk(9), MSK).map((r) => r.event.id)).toEqual([
      "e1",
      "e2",
      "e5",
      "e3",
      "e4",
    ]);
    expect(daySchedule(venue(), msk(9, 0, 25), MSK)).toEqual([]);
  });

  it("says when, in the venue's time zone", () => {
    const now = msk(12, 30);
    const ref = (start: number, end: number) => ({ start, end });
    expect(eventWhen(ref(msk(12), msk(13)), MSK, now)).toBe("Идёт · ещё 30 мин");
    expect(eventWhen(ref(msk(12, 40), msk(13)), MSK, now)).toBe("Через 10 мин");
    expect(eventWhen(ref(msk(14), msk(15)), MSK, now)).toBe("Сегодня в 14:00");
    expect(eventWhen(ref(msk(10, 0, 25), msk(11, 0, 25)), MSK, now)).toBe("Завтра в 10:00");
    expect(eventWhen(ref(msk(10, 0, 27), msk(11, 0, 27)), MSK, now)).toBe("27 октября в 10:00");
    expect(eventWhen(ref(msk(10), msk(11)), MSK, now)).toBe("Закончилось");
    expect(eventWhen(ref(msk(12), msk(14, 10)), MSK, now)).toBe("Идёт · ещё 1 ч 40 мин");

    expect(formatEventTime(ref(msk(12), msk(13)), MSK, now)).toBe("12:00–13:00");
    expect(formatEventTime(ref(msk(12), msk(13)), "Asia/Novosibirsk", now)).toBe("16:00–17:00");
    expect(formatEventTime(ref(msk(10, 0, 25), msk(11, 0, 25)), MSK, now)).toBe(
      "25 октября, 10:00–11:00",
    );
    expect(formatEventTime(ref(msk(10), msk(18, 0, 26)), MSK, now)).toBe(
      "24 октября 10:00 – 26 октября 18:00",
    );

    expect(eventStatus(ref(msk(12), msk(13)), now)).toBe("live");
    expect(eventStatus(ref(msk(12, 40), msk(13)), now)).toBe("soon");
    expect(eventStatus(ref(msk(14), msk(15)), now)).toBe("later");
    expect(eventStatus(ref(msk(10), msk(11)), now)).toBe("past");
  });
});

describe("announcements", () => {
  it("shows the ones running now, warnings first, and hides broken dates", () => {
    expect(activeAnnouncements(venue(), msk(12, 30)).map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(activeAnnouncements(venue(), msk(11)).map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(activeAnnouncements(venue(), msk(13)).map((a) => a.id)).toEqual(["a1", "a4"]);
  });

  it("tells when to refresh next", () => {
    // At 12:30: the 16:15–16:45 Novosibirsk talk (12:15–12:45 Moscow) ends first.
    expect(nextTimeChange(venue(), msk(12, 30))).toBe(msk(12, 45));
    expect(nextTimeChange(venue(), msk(23, 30))).toBeNull();
  });
});

describe("languages", () => {
  it("translates names and descriptions with fallbacks", () => {
    const stage = venue().pois?.[0] as Poi;
    expect(localized(stage, "en")).toEqual({ name: "Main stage", description: null });
    expect(localized(stage, "en-GB").name).toBe("Main stage");
    expect(localized(stage, "zh")).toEqual({ name: "主舞台", description: "演讲" });
    expect(localized(stage, "de").name).toBe("Сцена");
    expect(localized(stage).name).toBe("Сцена");
    const unit = {
      name: null,
      description: "Тихо",
      translations: { en: { description: "Quiet" } },
    };
    expect(localized(unit, "en")).toEqual({ name: null, description: "Quiet" });
  });

  it("picks the visitor's language from those offered", () => {
    const doc = venue();
    expect(venueLanguages(doc)).toEqual(["ru", "en", "zh-hans"]);
    expect(pickLanguage(doc, ["en-GB", "ru"])).toBe("en");
    expect(pickLanguage(doc, ["zh-CN"])).toBe("zh-hans");
    expect(pickLanguage(doc, ["fr"])).toBe("ru");
    expect(pickLanguage({ venue: { ...doc.venue, languages: [] } }, ["en"])).toBe("ru");
    expect(languageName("en")).toBe("English");
    expect(languageName("zh-Hans")).toBe("中文");
  });
});

describe("categories and amenities", () => {
  it("merges the organizer's categories with the built-in ones", () => {
    const doc = venue();
    expect(categoryOf(doc, "food")).toMatchObject({
      label: "Еда и кофе",
      emoji: "☕",
      custom: false,
    });
    expect(categoryOf(doc, "partner")).toEqual({
      id: "partner",
      label: "Партнёр",
      emoji: "🤝",
      color: "#ff0000",
      custom: true,
    });
    // Same id as a built-in one: renamed, built-in emoji kept.
    expect(categoryOf(doc, "stand")).toMatchObject({
      label: "Экспонент",
      emoji: "🏷️",
      custom: true,
    });
    expect(categoryOf(doc, "nope")).toMatchObject({ id: "nope", label: "Другое", emoji: "📍" });
    expect(categoryOf(null, "stage").label).toBe("Сцена");
    const all = poiCategories(doc).map((c) => c.id);
    expect(all.slice(-1)).toEqual(["partner"]);
    expect(all.filter((id) => id === "stand")).toHaveLength(1);
    expect(poiCategories(doc, { usedOnly: true }).map((c) => c.id)).toEqual(["stage", "partner"]);
  });

  it("labels amenities in Russian with an emoji", () => {
    expect(amenityLabel("wifi")).toBe("Wi-Fi");
    expect(amenityLabel("accessible")).toBe("Доступно на коляске");
    expect(amenityEmoji("accessible")).toBe("♿");
    expect(amenityLabel("teleport")).toBe("teleport");
  });
});

describe("places and search", () => {
  it("finds the room and the zone around a place", () => {
    const doc = venue();
    const stage = doc.pois?.[0] as Poi;
    expect(placeOf(doc, stage)).toMatchObject({ unit: { id: "u-hall" }, zone: { id: "z-food" } });
    expect(unitAt(doc, "l1", at(15, 5))?.id).toBe("u-room");
    expect(zoneAt(doc, "l1", at(15, 5))).toBeNull();
    expect(poisIn(doc, doc.units?.[0] as never).map((p) => p.id)).toEqual(["stage"]);
  });

  it("labels an L-shaped room inside it", () => {
    const doc = venue();
    const l = [[at(0, 0), at(10, 0), at(10, 2), at(2, 2), at(2, 10), at(0, 10), at(0, 0)]];
    const point = labelPoint(doc, l);
    if (!point) throw new Error("no label point");
    const ring = (l[0] as LonLat[]).map((c) => toLocal(anchor, c));
    expect(insideRing(toLocal(anchor, point), ring)).toBe(true);
  });

  it("indexes places, named rooms and zones with every useful text", () => {
    const entries = searchEntries(venue());
    expect(entries.map((e) => e.key)).toEqual([
      "poi:stage",
      "poi:hall-poi",
      "unit:u-hall",
      "unit:u-room",
      "zone:z-food",
    ]);
    const stage = entries[0];
    expect(stage?.category).toBe("Сцена");
    for (const word of [
      "питчи",
      "Main stage",
      "主舞台",
      "Открытие",
      "Анна Иванова",
      "Зал A",
      "Фудкорт",
    ]) {
      expect(stage?.keywords).toContain(word);
    }
    expect(entries.find((e) => e.id === "hall-poi")?.category).toBe("Партнёр");
    expect(entries.find((e) => e.id === "u-hall")?.keywords).toContain("Розетки");
    const zone = entries.find((e) => e.kind === "zone");
    expect(zone?.description).toBe("Еда и кофе");
    // In English the visible name is translated; the original still matches.
    const en = searchEntries(venue(), { lang: "en", kinds: ["poi", "unit"] });
    expect(en.find((e) => e.id === "stage")?.name).toBe("Main stage");
    expect(en.find((e) => e.id === "stage")?.keywords).toContain("Сцена");
    expect(en.find((e) => e.id === "u-hall")?.name).toBe("Hall A");
  });
});

describe("colours", () => {
  it("parses, darkens and finds readable text", () => {
    expect(parseHex("#abc")).toEqual([170, 187, 204]);
    expect(parseHex("red")).toBeNull();
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(luminance(darkVariant("#ffc0cb"))).toBeLessThan(0.05);
    expect(darkVariant("oops")).toBe("oops");
    expect(textOn("#ffffff")).toBe("#111827");
    expect(textOn("#1d4ed8")).toBe("#ffffff");
    expect(textOn("#facc15")).toBe("#111827");
  });
});
