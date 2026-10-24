import { describe, it, expect } from 'vitest';
import {
  defaults,
  DT,
  STRIDE,
  generateTerrain,
  parseExperiment,
  rainIntensity,
  settingsForPreset,
} from './model';
import type { ExperimentFile, Settings } from './model';
const settings = { ...defaults, resolution: 128 };

function saved(): ExperimentFile {
  const state = Array.from(generateTerrain(settings));
  return {
    format: 'sanga-experiment',
    version: 1,
    settings: { ...settings },
    time: 0,
    steps: 0,
    state,
    initial: [...state],
  };
}

describe('terrain generation', () => {
  it('reproduces every cell for the same seed', () => {
    expect(generateTerrain(settings)).toEqual(generateTerrain(settings));
    expect(generateTerrain({ ...settings, seed: settings.seed + 1 })).not.toEqual(
      generateTerrain(settings),
    );
  });

  it.each(['fan', 'terrace', 'basin'] as const)(
    '%s has finite, nonnegative material and an exact initial height',
    (preset) => {
      const a = generateTerrain({ ...settings, preset });
      expect(a.length).toBe(128 * 128 * STRIDE);
      for (let i = 0; i < a.length; i += STRIDE) {
        expect(Number.isFinite(a[i])).toBe(true);
        expect(a[i + 1]).toBeGreaterThanOrEqual(0);
        expect(a[i + 2]).toBe(0);
        expect(a[i + 3]).toBe(0);
        expect(a[i + 5]).toBe(Math.fround(a[i] + a[i + 1]));
      }
    },
  );

  it('opens a narrow mountain valley onto a broad plain', () => {
    const a = generateTerrain(settings),
      n = settings.resolution;

    const height = (x: number, y: number) => a[(y * n + x) * STRIDE] + a[(y * n + x) * STRIDE + 1];

    expect(height(10, 10) - height(64, 10)).toBeGreaterThan(80);
    expect(height(10, 100) - height(64, 100)).toBeLessThan(20);
    expect(height(64, 10)).toBeGreaterThan(height(64, 120));
  });
});

describe('rainfall events', () => {
  it.each(['constant', 'front', 'back'] as const)(
    '%s integrates to the specified total',
    (pattern) => {
      const s = { ...settings, pattern, repeat: false, duration: 0.25, rain: 120 };
      let total = 0;
      for (let t = 0; t < s.duration * 3600; t += DT) total += rainIntensity(t + DT / 2, s) * DT;
      expect(total * 1000).toBeCloseTo(120, 6);
      expect(rainIntensity(901, s)).toBe(0);
    },
  );

  it('repeats after the dry interval', () => {
    const period = (settings.duration + settings.interval) * 3600;
    expect(rainIntensity(settings.duration * 3600 + 5, settings)).toBe(0);
    expect(rainIntensity(period + 50, settings)).toBeCloseTo(rainIntensity(50, settings));
  });

  it('stays dry with zero precipitation', () =>
    expect(rainIntensity(0, { ...settings, rain: 0 })).toBe(0));
});

describe('experiment import', () => {
  it('round-trips full initial and current GPU state', () => {
    const f = saved();
    expect(parseExperiment(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it.each([null, {}, { format: 'other', version: 1 }])('rejects unknown file formats', (v) =>
    expect(() => parseExperiment(v)).toThrow(),
  );

  it('rejects oversized resolutions and invalid values before GPU allocation', () => {
    const f = saved();
    f.settings.resolution = 8192;
    expect(() => parseExperiment(f)).toThrow();
    f.settings.resolution = 128;
    f.settings.rain = NaN;
    expect(() => parseExperiment(f)).toThrow();
  });

  it('rejects missing, negative and nonfinite cell values', () => {
    const f = saved();
    f.state[2] = -1;
    expect(() => parseExperiment(f)).toThrow();
    f.state[2] = Infinity;
    expect(() => parseExperiment(f)).toThrow();
    f.state.pop();
    expect(() => parseExperiment(f)).toThrow();
  });

  it('gives each scenario its own boundary and supply conditions', () => {
    const basin: Settings = settingsForPreset('basin');
    expect(basin.inflow).toBe(0);
    expect(settingsForPreset('terrace').sediment).toBeGreaterThan(defaults.sediment);
  });
});
