import { afterEach, describe, expect, it, vi } from "vitest";

const original = process.env.TZ;

afterEach(() => {
  process.env.TZ = original;
  vi.resetModules();
});

/** The module builds its formatters when loaded, so load it afresh in the chosen time zone. */
async function inZone(tz: string) {
  process.env.TZ = tz;
  vi.resetModules();
  return import("@/lib/format");
}

describe("dates", () => {
  it("shows a calendar day as that day west of London too", async () => {
    // Regression: "2026-10-18" was read as midnight UTC, so the forecast's days showed as the day before in the Americas
    const { formatDate } = await inZone("America/Los_Angeles");
    expect(formatDate("2026-10-18")).toBe("18 Oct");
    expect(formatDate("2026-12-02", true)).toBe("2 Dec 2026");
  });

  it("still shows a moment in the person's own time zone", async () => {
    const { formatDate } = await inZone("America/Los_Angeles");
    expect(formatDate("2026-10-18T03:00:00Z")).toBe("17 Oct");
  });

  it("counts and adds whole days across a clock change", async () => {
    const { addDays, daysBetween, localDay } = await inZone("Europe/London");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(localDay(new Date(2026, 9, 18, 23, 30))).toBe("2026-10-18");
  });
});
