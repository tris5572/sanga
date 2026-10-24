import { TerrainEngine } from '../src/simulation/TerrainEngine';
import { defaults, DOMAIN, DT, STRIDE, generateTerrain } from '../src/simulation/model';
import type { Settings, ExperimentFile } from '../src/simulation/model';

const out = document.querySelector<HTMLPreElement>('#results')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;

const write = (message: string) => {
  out.textContent += message + '\n';
};

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const tick = () => new Promise(requestAnimationFrame);

let engine: TerrainEngine | undefined;

function totals(a: Float32Array) {
  const result = {
    water: 0,
    earth: 0,
    input: 0,
    output: 0,
    infiltration: 0,
    sedIn: 0,
    sedOut: 0,
    uplift: 0,
    minimum: Infinity,
  };
  for (let i = 0; i < a.length; i += STRIDE) {
    for (let k = 0; k < STRIDE; k++)
      assert(Number.isFinite(a[i + k]), `non-finite cell ${i / STRIDE}, ${k}`);
    result.water += a[i + 2];
    result.earth += a[i] + a[i + 1] + a[i + 3];
    result.input += a[i + 8];
    result.output += a[i + 9];
    result.infiltration += a[i + 10];
    result.sedOut += a[i + 11];
    result.sedIn += a[i + 14];
    result.uplift += a[i + 15];
    result.minimum = Math.min(result.minimum, a[i + 1], a[i + 2], a[i + 3]);
  }
  return result;
}

function file(s: Settings, a: Float32Array): ExperimentFile {
  return {
    format: 'sanga-experiment',
    version: 1,
    settings: s,
    time: 0,
    steps: 0,
    state: Array.from(a),
    initial: Array.from(a),
  };
}

async function runSteps(count: number) {
  for (let done = 0; done < count;) {
    const batch = Math.min(100, count - done);
    const before = engine!.steps;
    engine!.step(batch);
    if (engine!.steps > before) done += batch;
    await tick();
    if (done % 1000 === 0) await engine!.snapshotState();
  }
}

button.onclick = async () => {
  button.disabled = true;
  out.textContent = '';
  try {
    engine?.dispose();
    let gpuError = '';
    const s: Settings = {
      ...defaults,
      resolution: 128,
      repeat: false,
      rain: 100,
      duration: 1,
      inflow: 0,
      infiltration: 0,
      erosion: 0,
    };
    engine = new TerrainEngine(document.querySelector('canvas')!, s, {
      onStats: () => {},
      onError: (m) => {
        gpuError = m;
        write('GPU ERROR: ' + m);
      },
      onEdit: () => {},
    });
    await engine.init();
    write('WebGPU / WGSL pipelines initialized.');
    const flat = generateTerrain(s);
    for (let i = 0; i < flat.length; i += STRIDE) {
      flat[i] = 80;
      flat[i + 1] = 10;
      flat[i + 5] = 90;
    }
    engine.reset(s, file(s, flat));
    await runSteps(400);
    const a = await engine.snapshotState(),
      t = totals(a),
      initial = totals(flat);
    const rainExpected =
      (s.rain / 1000 / (s.duration * 3600)) *
      (400 * DT) *
      s.resolution ** 2 *
      (2 - (400 * DT) / (s.duration * 3600));
    assert(Math.abs(t.input - rainExpected) / rainExpected < 0.001, 'Rain source total is wrong');
    const waterError =
      Math.abs(t.water - initial.water - t.input + t.output + t.infiltration) /
      Math.max(1, t.input);
    assert(waterError < 0.0001, `Water conservation error ${waterError}`);
    assert(t.minimum >= 0, 'Negative water or sediment');
    write(
      `PASS Rainfall, nonnegativity and water conservation: ${(waterError * 100).toFixed(6)}%.`,
    );
    const sedimentSettings = { ...s, rain: 0, sea: 91 };
    const wet = flat.slice();
    for (let i = 0; i < wet.length; i += STRIDE) {
      wet[i + 2] = 1;
      wet[i + 3] = 0.02;
    }
    engine.reset(sedimentSettings, file(sedimentSettings, wet));
    await runSteps(500);
    const earth0 = totals(wet),
      earth1 = totals(await engine.snapshotState());
    const solidError =
      Math.abs(earth1.earth - earth0.earth - earth1.sedIn - earth1.uplift + earth1.sedOut) /
      earth0.earth;
    assert(solidError < 0.00001, `Solid conservation error ${solidError}`);
    assert(earth1.minimum >= 0, 'Negative solid thickness');
    write(
      `PASS Deposition conserves rock + soil + suspended sediment: ${(solidError * 100).toFixed(7)}%.`,
    );
    const basin = { ...s, preset: 'basin' as const, rain: 0, inflow: 0, sea: 80 };
    engine.reset(basin);
    await runSteps(100);
    const isolated = totals(await engine.snapshotState());
    assert(isolated.water === 0, 'An isolated low basin was incorrectly filled by sea level');
    write('PASS Disconnected low basin remains dry when outlet level is raised.');
    const fan = {
      ...defaults,
      resolution: 128,
      rain: 120,
      inflow: 65,
      sediment: 12,
      infiltration: 5,
    };
    engine.reset(fan);
    await runSteps(400);
    const saved = await engine.export();
    await runSteps(300);
    const continuation = await engine.snapshotState();
    engine.reset(fan, saved);
    await runSteps(300);
    const replay = await engine.snapshotState();
    assert(
      replay.every((v, i) => v === continuation[i]),
      'Restored experiment does not reproduce continuation',
    );
    write('PASS Saved experiment reproduces every GPU cell bit-for-bit.');
    const start = performance.now();
    write('Running alluvial-fan acceptance experiment (2 simulation hours)…');
    await runSteps(28800 - engine.steps);
    const evolved = await engine.snapshotState(),
      f = totals(evolved),
      n = fan.resolution,
      area = (DOMAIN / n) ** 2;
    let erosion = 0,
      deposition = 0,
      mouthDeposition = 0,
      wetCells = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * STRIDE,
          d = evolved[i] + evolved[i + 1] - evolved[i + 5];
        erosion += Math.max(0, -d) * area;
        deposition += Math.max(0, d) * area;
        if (y > n * 0.38 && y < n * 0.85 && Math.abs(x - n / 2) < n * 0.3)
          mouthDeposition += Math.max(0, d) * area;
        if (evolved[i + 2] > 0.01) wetCells++;
      }
    const balance = Math.abs(f.water - f.input + f.output + f.infiltration) / Math.max(1, f.input);
    assert(f.minimum >= 0, 'Negative water/soil after full event');
    assert(balance < 0.005, `Event water error ${balance * 100}%`);
    assert(erosion > 100, 'No erosion');
    assert(mouthDeposition > 10, 'No deposition downstream of valley');
    assert(wetCells > n, 'No connected wet region');
    assert(!gpuError, gpuError);
    write(
      `PASS Fan experiment: erosion ${erosion.toFixed(1)} m³, deposition ${deposition.toFixed(1)} m³, valley-mouth deposition ${mouthDeposition.toFixed(1)} m³, water error ${(balance * 100).toFixed(5)}%, ${((performance.now() - start) / 1000).toFixed(1)} s.`,
    );
    write('Running two rainfall cycles (12 h) to compare sediment-driven flow changes…');
    await runSteps(172800 - engine.steps);
    const evolvedCycles = await engine.snapshotState();
    engine.reset({ ...fan, sediment: 0 });
    await runSteps(172800);
    const clear = await engine.snapshotState();
    let depthDifference = 0,
      depthScale = 0;
    for (let y = Math.floor(n * 0.4); y < Math.floor(n * 0.9); y++)
      for (let x = Math.floor(n * 0.2); x < Math.floor(n * 0.8); x++) {
        const i = (y * n + x) * STRIDE;
        depthDifference += Math.abs(evolvedCycles[i + 2] - clear[i + 2]);
        depthScale += evolvedCycles[i + 2];
      }
    const response = depthDifference / Math.max(1e-6, depthScale);
    assert(response > 0.001, `Deposition did not alter downstream flow: ${response}`);
    write(
      `PASS Sediment-induced terrain change modifies downstream water distribution: ${(response * 100).toFixed(2)}% relative L1 depth change.`,
    );
    write('ALL TESTS PASSED');
  } catch (e) {
    write('FAIL: ' + (e instanceof Error ? e.stack : String(e)));
  } finally {
    button.disabled = false;
  }
};
