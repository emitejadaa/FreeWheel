import { isAdultDate } from "./is-adult-date.validator";

/** YYYY-MM-DD `years` before today, in UTC. */
function yearsAgo(years: number, extraDays = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}

describe("isAdultDate", () => {
  it("accepts a clearly-adult birth date", () => {
    expect(isAdultDate("1990-01-01")).toBe(true);
  });

  it("accepts someone who turns 18 exactly today", () => {
    expect(isAdultDate(yearsAgo(18))).toBe(true);
  });

  it("rejects someone whose 18th birthday is still one day away", () => {
    // Born 18 years ago minus one day → 18th birthday is tomorrow → still 17.
    expect(isAdultDate(yearsAgo(18, 1))).toBe(false);
  });

  it("rejects a minor", () => {
    expect(isAdultDate(yearsAgo(15))).toBe(false);
  });

  it("rejects an implausibly old date (over 120)", () => {
    expect(isAdultDate("1800-01-01")).toBe(false);
  });

  it("rejects a malformed or impossible calendar date", () => {
    expect(isAdultDate("2000-13-01")).toBe(false);
    expect(isAdultDate("2000-02-30")).toBe(false);
    expect(isAdultDate("1990/01/01")).toBe(false);
    expect(isAdultDate("not-a-date")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isAdultDate(undefined)).toBe(false);
    expect(isAdultDate(null)).toBe(false);
    expect(isAdultDate(19900101)).toBe(false);
    expect(isAdultDate(new Date())).toBe(false);
  });
});
