export type Preset = 'fan' | 'terrace' | 'basin';
export type ViewMode = 'terrain' | 'change' | 'water' | 'velocity' | 'moisture';
export type EditTool = 'orbit' | 'raise' | 'lower' | 'soil' | 'valley';
export interface Settings {
  preset: Preset;
  resolution: number;
  seed: number;
  rain: number;
  duration: number;
  pattern: 'constant' | 'front' | 'back';
  repeat: boolean;
  interval: number;
  inflow: number;
  sediment: number;
  infiltration: number;
  moisture: number;
  sea: number;
  seaRate: number;
  erosion: number;
  grain: number;
  repose: number;
  uplift: number;
  weathering: number;
  vegetation: number;
}
export const defaults: Settings = {
  preset: 'fan',
  resolution: 256,
  seed: 4281,
  rain: 120,
  duration: 2,
  pattern: 'front',
  repeat: true,
  interval: 4,
  inflow: 35,
  sediment: 3,
  infiltration: 8,
  moisture: 0.25,
  sea: 8,
  seaRate: 0,
  erosion: 0.35,
  grain: 2,
  repose: 34,
  uplift: 0,
  weathering: 0,
  vegetation: 0.35,
};
export const DOMAIN = 2400;
export const DT = 0.25;
export const STRIDE = 16;
export interface Stats {
  time: number;
  steps: number;
  fps: number;
  water: number;
  sediment: number;
  eroded: number;
  deposited: number;
  maxSpeed: number;
  maxWater: number;
  waterIn: number;
  waterOut: number;
  infiltrated: number;
  sedimentIn: number;
  sedimentOut: number;
  waterError: number;
  sedimentError: number;
  minWater: number;
  minSoil: number;
  profile: { initial: number[]; current: number[]; water: number[] };
  history: { time: number; eroded: number; deposited: number }[];
}
export const emptyStats: Stats = {
  time: 0,
  steps: 0,
  fps: 0,
  water: 0,
  sediment: 0,
  eroded: 0,
  deposited: 0,
  maxSpeed: 0,
  maxWater: 0,
  waterIn: 0,
  waterOut: 0,
  infiltrated: 0,
  sedimentIn: 0,
  sedimentOut: 0,
  waterError: 0,
  sedimentError: 0,
  minWater: 0,
  minSoil: 0,
  profile: { initial: [], current: [], water: [] },
  history: [],
};

function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number, seed: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy);
  return (
    (hash(ix, iy, seed) * (1 - u) + hash(ix + 1, iy, seed) * u) * (1 - v) +
    (hash(ix, iy + 1, seed) * (1 - u) + hash(ix + 1, iy + 1, seed) * u) * v
  );
}

function fbm(x: number, y: number, seed: number) {
  let sum = 0,
    amp = 0.5;
  for (let k = 0; k < 5; k++) {
    sum += noise(x, y, seed + k * 53) * amp;
    x *= 2.05;
    y *= 2.05;
    amp *= 0.5;
  }
  return sum;
}

export function generateTerrain(s: Settings): Float32Array {
  const n = s.resolution,
    data = new Float32Array(n * n * STRIDE);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1),
        v = y / (n - 1),
        nx = (u - 0.5) * 2;
      const rough = fbm(u * 6, v * 6, s.seed);
      const channel = Math.sin(v * 12) * 0.025 + Math.sin(v * 27) * 0.008;
      const distance = Math.abs(nx - channel);
      let height: number, soil: number;
      if (s.preset === 'fan') {
        const mountain = Math.pow(Math.max(0, 1 - v / 0.67), 0.8);
        const valley = 1 - Math.exp(-Math.pow(distance / (0.07 + v * 0.15), 1.6));
        const ridges = 0.6 + rough * 0.85 + Math.abs(Math.sin(nx * 15 + v * 14)) * 0.16;
        const plain = 9 + (1 - v) * 22;
        const fan = Math.max(0, 1 - Math.hypot(nx * 1.4, (v - 0.56) * 1.7)) * 14;
        height = plain + mountain * (35 + 210 * valley * ridges) + fan;
        // A connected, several-cell-wide incised channel, with a widening mouth.
        height -= 4 * Math.exp(-Math.pow(distance / (0.025 + v * 0.012), 2));
        height += (rough - 0.45) * (mountain * 16 + 1.1);
        soil = 3 + (1 - mountain) * 9 + fan * 0.35;
      } else if (s.preset === 'terrace') {
        const valley = 1 - Math.exp(-Math.pow(distance / 0.3, 4));
        height = 20 + (1 - v) * 60 + valley * (80 + rough * 90) + (rough - 0.45) * 6;
        height -= 5 * Math.exp(-Math.pow(distance / 0.06, 2));
        soil = 12 + (1 - valley) * 18;
      } else {
        const rim = Math.max(0, Math.hypot(nx, (v - 0.5) * 1.7) - 0.3);
        height = 24 + rim * 170 + (rough - 0.45) * 22 + (1 - v) * 15;
        // The basin is isolated from the outlet by a saddle.
        soil = 6 + rough * 6;
      }
      const i = (y * n + x) * STRIDE;
      data[i] = height - soil;
      data[i + 1] = soil;
      data[i + 2] = 0;
      data[i + 3] = 0;
      data[i + 4] = s.moisture;
      data[i + 5] = Math.fround(data[i] + data[i + 1]);
    }
  return data;
}

export function rainIntensity(time: number, s: Settings) {
  const duration = s.duration * 3600;
  const period = (s.duration + s.interval) * 3600;
  const local = s.repeat ? time % period : time;
  if (local >= duration) return 0;
  const t = local / duration;
  const factor = s.pattern === 'front' ? 2 * (1 - t) : s.pattern === 'back' ? 2 * t : 1;
  return (s.rain / s.duration / 1000 / 3600) * factor;
}

export function settingsForPreset(preset: Preset): Settings {
  return {
    ...defaults,
    preset,
    ...(preset === 'terrace'
      ? { sediment: 10, inflow: 50, sea: 15, rain: 80 }
      : preset === 'basin'
        ? { inflow: 0, rain: 180, infiltration: 3, sea: 0 }
        : {}),
  };
}

export interface ExperimentFile {
  format: 'sanga-experiment';
  version: 1;
  settings: Settings;
  time: number;
  steps: number;
  state: number[];
  initial: number[];
  boundary?: { offset: number; time: number };
}

export function parseExperiment(value: unknown): ExperimentFile {
  if (!value || typeof value !== 'object') throw new Error('実験ファイルの形式が不正。');
  const f = value as ExperimentFile;
  if (f.format !== 'sanga-experiment' || f.version !== 1 || !f.settings)
    throw new Error('SANGAの実験ファイルではない。');
  const s = f.settings;
  const ranges: Record<string, [number, number]> = {
    seed: [0, 9999999],
    rain: [0, 400],
    duration: [0.25, 24],
    interval: [0, 48],
    inflow: [0, 200],
    sediment: [0, 30],
    infiltration: [0, 50],
    moisture: [0, 1],
    sea: [-30, 80],
    seaRate: [-10, 10],
    erosion: [0, 2],
    grain: [0.1, 20],
    repose: [15, 50],
    uplift: [0, 5],
    weathering: [0, 1],
    vegetation: [0, 1],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const v = s[key as keyof Settings];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`設定値 ${key} が範囲外。`);
  }
  if (
    ![128, 256, 512].includes(s.resolution) ||
    !Number.isInteger(s.seed) ||
    !['fan', 'terrace', 'basin'].includes(s.preset) ||
    !['constant', 'front', 'back'].includes(s.pattern) ||
    typeof s.repeat !== 'boolean'
  )
    throw new Error('実験設定が不正。');
  if (!Number.isFinite(f.time) || f.time < 0 || !Number.isSafeInteger(f.steps) || f.steps < 0)
    throw new Error('計算時刻が不正。');
  if (
    f.boundary &&
    (!Number.isFinite(f.boundary.offset) ||
      Math.abs(f.boundary.offset) > 1e6 ||
      !Number.isFinite(f.boundary.time) ||
      f.boundary.time < 0 ||
      f.boundary.time > f.time)
  )
    throw new Error('水位境界の履歴が不正。');
  const size = s.resolution * s.resolution * STRIDE;
  if (
    !Array.isArray(f.state) ||
    !Array.isArray(f.initial) ||
    f.state.length !== size ||
    f.initial.length !== size
  )
    throw new Error('格子データの大きさが一致しない。');
  for (const arr of [f.state, f.initial])
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) throw new Error('格子データに無効な値がある。');
      if ([1, 2, 3].includes(i % STRIDE) && arr[i] < 0) throw new Error('水深または土砂厚が負。');
    }
  return f;
}
