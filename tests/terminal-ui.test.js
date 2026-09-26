import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";

import { countTerminalRows, formatDuration, renderBox, renderRow, resolveNumberKey, visibleWidth } from "../src/terminal-ui.js";

describe("terminal boxes", () => {
  it("should wrap long lines by words, never truncate them, and keep every line aligned", () => {
    const sentence = "Corregí el error y corré pnpm create-version: retoma solo lo que falte sin volver a subir la versión.";
    const box = renderBox({ title: "Plan", lines: ["corto", `→ ${sentence}`], width: 40 }).split("\n");
    const bodyText = box
      .slice(2, -1)
      .map((line) => stripVTControlCharacters(line).slice(2, -2).trim())
      .join(" ");

    expect(new Set(box.map((line) => visibleWidth(line)))).toEqual(new Set([40]));
    expect(box.length).toBeGreaterThan(4);
    expect(box.join("\n")).not.toContain("…");
    expect(bodyText).toBe(`→ ${sentence}`);
    expect(stripVTControlCharacters(box[3]).startsWith("│   ")).toBe(true);
  });

  it("should reopen colors on every wrapped line and split words wider than the box", () => {
    const styledUrl = `\x1b[31mhttps://example.test/${"x".repeat(60)}\x1b[39m`;
    const box = renderBox({ lines: [styledUrl], width: 30 }).split("\n");

    expect(new Set(box.map((line) => visibleWidth(line)))).toEqual(new Set([30]));
    expect(box.slice(1, -1).every((line) => line.includes("\x1b[31m"))).toBe(true);
    expect(box.join("\n")).not.toContain("…");
  });

  it("should move a title that does not fit in the border inside the box", () => {
    const title = "Falló el paso 1: Crear y publicar la nueva versión";
    const box = renderBox({ title, lines: ["detalle"], width: 30 });

    expect(stripVTControlCharacters(box.split("\n")[0])).toBe(`╭${"─".repeat(28)}╮`);
    expect(stripVTControlCharacters(box)).toContain("Falló el paso 1:");
  });

  it("should align the value column of status rows", () => {
    expect(stripVTControlCharacters(renderRow("*", "Rama", "main"))).toBe(`* ${"Rama".padEnd(16)}main`);
  });
});

describe("numbered prompt options", () => {
  it("should pick an option with its number key and ignore keys outside the listed options", () => {
    expect(resolveNumberKey("1", 3)).toBe(0);
    expect(resolveNumberKey("3", 3)).toBe(2);
    expect(resolveNumberKey("4", 3)).toBe(-1);
    expect(resolveNumberKey("0", 3)).toBe(-1);
    expect(resolveNumberKey("a", 3)).toBe(-1);
    expect(resolveNumberKey(undefined, 3)).toBe(-1);
  });
});

describe("prompt redraw", () => {
  it("should count the extra rows of lines wider than the terminal so the prompt erases all of them", () => {
    const question = "? ¿Publicar beez-ui@0.6.2? Commitea package.json y CHANGELOG.md, valida todo (varios minutos), pushea a main y publica en npm.";
    expect(countTerminalRows(["corta", "otra"], 80)).toBe(2);
    expect(countTerminalRows([question, "  1. Sí", "  2. No"], 80)).toBe(4);
    expect(countTerminalRows([`\x1b[1m${"x".repeat(80)}\x1b[22m`], 80)).toBe(1);
    expect(countTerminalRows([""], 80)).toBe(1);
  });
});

describe("durations", () => {
  it("should format seconds under a minute and minutes with padded seconds", () => {
    expect(formatDuration(3200)).toBe("3.2 s");
    expect(formatDuration(245_000)).toBe("4 min 05 s");
  });
});
