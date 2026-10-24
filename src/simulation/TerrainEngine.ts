import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Culling/ray';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import physics from './physics.wgsl?raw';
import vertex from './render.wgsl?raw';
import fragment from './fragment.wgsl?raw';
import diagnostics from './diagnostics.wgsl?raw';
import { DOMAIN, DT, STRIDE, emptyStats, generateTerrain } from './model';
import type { Settings, Stats, ViewMode, EditTool, ExperimentFile } from './model';

interface Baseline {
  water: number;
  earth: number;
  waterIn: number;
  waterOut: number;
  infiltrated: number;
  sedimentIn: number;
  uplift: number;
  sedimentOut: number;
}
export class TerrainEngine {
  private engine: WebGPUEngine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private mesh!: Mesh;
  private waterMesh!: Mesh;
  private material!: ShaderMaterial;
  private waterMaterial!: ShaderMaterial;
  private buffers: StorageBuffer[] = [];
  private temporary!: StorageBuffer;
  private flux!: StorageBuffer;
  private result!: StorageBuffer;
  private uniform!: UniformBuffer;
  private sourceShaders: ComputeShader[] = [];
  private updateShaders: ComputeShader[] = [];
  private flowShader!: ComputeShader;
  private diagnoseShader!: ComputeShader;
  private current = 0;
  private seaOffset = 0;
  private seaAnchorTime = 0;
  private initial!: Float32Array;
  private baseline!: Baseline;
  private undoData: { state: Float32Array; initial: Float32Array; baseline: Baseline } | null =
    null;
  private lastStatsAt = 0;
  private reading = false;
  private history: Stats['history'] = [];
  private accumulator = 0;
  private lastFrame = 0;
  private lastHudAt = 0;
  private disposed = false;
  private initialized = false;
  private engineReady = false;
  private editing = false;
  private computeError = '';
  private generation = 0;
  private tool: EditTool = 'orbit';
  private resizeObserver: ResizeObserver;
  private settings: Settings;
  running = false;
  speed = 1;
  time = 0;
  steps = 0;
  brush = 140;
  onStats: (stats: Stats) => void;
  onError: (message: string) => void;
  onEdit: (undo: boolean) => void;
  onCamera?: (hud: { angle: number; width: number; distance: number }) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    settings: Settings,
    callbacks: {
      onStats: (stats: Stats) => void;
      onError: (message: string) => void;
      onEdit: (undo: boolean) => void;
      onCamera?: (hud: { angle: number; width: number; distance: number }) => void;
    },
  ) {
    this.settings = { ...settings };
    this.onStats = callbacks.onStats;
    this.onError = callbacks.onError;
    this.onEdit = callbacks.onEdit;
    this.onCamera = callbacks.onCamera;
    this.engine = new WebGPUEngine(canvas, {
      antialias: true,
      enableAllFeatures: false,
      adaptToDeviceRatio: true,
      powerPreference: 'high-performance',
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.initialized) this.engine.resize();
    });
    this.resizeObserver.observe(canvas);
  }

  async init() {
    await this.engine.initAsync();
    this.engineReady = true;
    if (this.disposed) {
      this.engine.dispose();
      return;
    }
    if (!this.engine.getCaps().supportComputeShaders)
      throw new Error('このGPUは計算シェーダーに対応していない。');
    this.engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.09, 0.12, 0.115, 1);
    this.camera = new ArcRotateCamera(
      'observer',
      Math.PI * 0.34,
      0.91,
      4250,
      new Vector3(0, 100, 0),
      this.scene,
    );
    this.camera.lowerRadiusLimit = 900;
    this.camera.upperRadiusLimit = 6200;
    this.camera.lowerBetaLimit = 0.01;
    this.camera.upperBetaLimit = 1.49;
    this.camera.wheelPrecision = 16;
    this.camera.panningSensibility = 30;
    this.camera.minZ = 5;
    this.camera.maxZ = 15000;
    this.camera.attachControl(this.canvas, true);
    this.uniform = new UniformBuffer(this.engine);
    for (const key of ['grid', 'rain', 'hydro', 'material', 'longterm'])
      this.uniform.addUniform(key, 4);
    this.uniform.create();
    this.material = this.createMaterial(false);
    this.waterMaterial = this.createMaterial(true);
    this.createFloor();
    this.reset(this.settings);
    await this.waitForCompute();
    if (this.disposed) return;
    this.initialized = true;
    this.canvas.addEventListener('pointerdown', this.editPointer);
    this.engine.onContextLostObservable.add(() => {
      this.running = false;
      this.onError('GPUとの接続が失われた。ページを再読み込みして再開。');
    });
    this.engine.runRenderLoop(this.frame);
  }

  private createMaterial(water: boolean) {
    const m = new ShaderMaterial(
      water ? 'water' : 'terrain',
      this.scene,
      { vertexSource: vertex, fragmentSource: fragment },
      {
        attributes: ['position'],
        uniforms: [
          'worldViewProjection',
          'gridSize',
          'exaggeration',
          'waterPass',
          'viewMode',
          'contours',
          'clock',
        ],
        storageBuffers: ['state'],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: water,
      },
    );
    m.backFaceCulling = false;
    m.setFloat('gridSize', this.settings.resolution);
    m.setFloat('exaggeration', 2.1);
    m.setFloat('waterPass', water ? 1 : 0);
    m.setFloat('viewMode', 0);
    m.setFloat('contours', 0);
    m.setFloat('clock', 0);

    m.onError = (_effect, errors) => {
      this.running = false;
      this.onError(`描画シェーダーの初期化に失敗: ${errors.slice(0, 180)}`);
    };

    return m;
  }

  private createFloor() {
    const floor = new Mesh('reference-grid', this.scene);
    const vd = new VertexData();
    vd.positions = [-6000, -35, -6000, 6000, -35, -6000, 6000, -35, 6000, -6000, -35, 6000];
    vd.indices = [0, 2, 1, 0, 3, 2];
    vd.applyToMesh(floor);
    floor.isPickable = false;
    const m = new ShaderMaterial(
      'grid',
      this.scene,
      {
        vertexSource: `uniform worldViewProjection: mat4x4f; attribute position: vec3f; varying vPosition: vec3f;
      @vertex fn main(input: VertexInputs)->FragmentInputs { vertexOutputs.position=uniforms.worldViewProjection*vec4f(vertexInputs.position,1); vertexOutputs.vPosition=vertexInputs.position; }`,
        fragmentSource: `varying vPosition: vec3f;
      @fragment fn main(input: FragmentInputs)->FragmentOutputs {
      let p=fragmentInputs.vPosition.xz/200.0;
      let g=abs(fract(p-0.5)-0.5)/max(fwidth(p),vec2f(0.001));
      let line=1.0-min(min(g.x,g.y),1.0);
      let fade=1.0-smoothstep(1300.0,4000.0,length(fragmentInputs.vPosition.xz));
      fragmentOutputs.color=vec4f(vec3f(0.09,0.12,0.115)+vec3f(line*0.037*fade),1); }`,
      },
      {
        attributes: ['position'],
        uniforms: ['worldViewProjection'],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    m.backFaceCulling = false;
    floor.material = m;
  }

  private createMesh() {
    this.mesh?.dispose();
    this.waterMesh?.dispose();
    const n = this.settings.resolution,
      positions: number[] = [],
      indices: number[] = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        positions.push((x / (n - 1) - 0.5) * DOMAIN, 0, (y / (n - 1) - 0.5) * DOMAIN);
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        const a = y * n + x;
        indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    const topIndices = [...indices];
    const edges = [
      Array.from({ length: n }, (_, x) => x),
      Array.from({ length: n }, (_, y) => y * n + n - 1),
      Array.from({ length: n }, (_, x) => (n - 1) * n + n - 1 - x),
      Array.from({ length: n }, (_, y) => (n - 1 - y) * n),
    ];
    for (const edge of edges) {
      const start = positions.length / 3;
      for (const i of edge) positions.push(positions[i * 3], -1, positions[i * 3 + 2]);
      for (let k = 0; k < n - 1; k++)
        indices.push(edge[k], start + k, edge[k + 1], edge[k + 1], start + k, start + k + 1);
    }
    this.mesh = new Mesh('land', this.scene);
    this.mesh.alwaysSelectAsActiveMesh = true;
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.applyToMesh(this.mesh);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.waterMesh = new Mesh('surface-water', this.scene);
    this.waterMesh.alwaysSelectAsActiveMesh = true;
    const waterData = new VertexData();
    waterData.positions = positions.slice(0, n * n * 3);
    waterData.indices = topIndices;
    waterData.applyToMesh(this.waterMesh);
    this.waterMesh.material = this.waterMaterial;
    this.waterMesh.isPickable = false;
    this.material.setFloat('gridSize', n);
    this.waterMaterial.setFloat('gridSize', n);
  }

  reset(settings: Settings, loaded?: ExperimentFile) {
    this.generation++;
    this.running = false;
    this.settings = { ...settings };
    this.time = loaded?.time ?? 0;
    this.steps = loaded?.steps ?? 0;
    this.seaOffset = loaded?.boundary?.offset ?? 0;
    this.seaAnchorTime = loaded?.boundary?.time ?? 0;
    this.history = [];
    this.undoData = null;
    this.onEdit(false);
    this.disposeCompute();
    const n = settings.resolution;
    const state = loaded ? new Float32Array(loaded.state) : generateTerrain(settings);
    this.initial = loaded ? new Float32Array(loaded.initial) : state.slice();
    this.baseline = this.getBaseline(this.initial);
    this.buffers = [
      new StorageBuffer(this.engine, state.byteLength),
      new StorageBuffer(this.engine, state.byteLength),
    ];
    this.buffers.forEach((b) => b.update(state));
    this.current = 0;
    this.temporary = new StorageBuffer(this.engine, state.byteLength);
    this.flux = new StorageBuffer(this.engine, n * n * 48);
    this.result = new StorageBuffer(this.engine, n * 20 * 4);

    const shader = (
      name: string,
      entryPoint: string,
      mapping: Record<string, { group: number; binding: number }>,
    ) => {
      const cs = new ComputeShader(
        name,
        this.engine,
        { computeSource: physics },
        { entryPoint, defines: [`PASS_${entryPoint.toUpperCase()}`], bindingsMapping: mapping },
      );

      cs.onError = (_effect, error) => {
        this.computeError = error;
        this.running = false;
        this.onError(`計算シェーダーの初期化に失敗: ${error.slice(0, 180)}`);
      };

      return cs;
    };

    const base = { p: { group: 0, binding: 0 }, src: { group: 0, binding: 1 } };
    this.sourceShaders = [0, 1].map((i) => {
      const cs = shader(`sources-${i}`, 'sources', { ...base, dst: { group: 0, binding: 2 } });
      cs.setUniformBuffer('p', this.uniform);
      cs.setStorageBuffer('src', this.buffers[i]);
      cs.setStorageBuffer('dst', this.temporary);
      return cs;
    });
    this.flowShader = shader('flows', 'flows', { ...base, flux: { group: 0, binding: 3 } });
    this.flowShader.setUniformBuffer('p', this.uniform);
    this.flowShader.setStorageBuffer('src', this.temporary);
    this.flowShader.setStorageBuffer('flux', this.flux);
    this.updateShaders = [0, 1].map((i) => {
      const cs = shader(`transport-${i}`, 'transport', {
        ...base,
        dst: { group: 0, binding: 2 },
        flux: { group: 0, binding: 3 },
      });
      cs.setUniformBuffer('p', this.uniform);
      cs.setStorageBuffer('src', this.temporary);
      cs.setStorageBuffer('dst', this.buffers[1 - i]);
      cs.setStorageBuffer('flux', this.flux);
      return cs;
    });
    this.diagnoseShader = new ComputeShader(
      'diagnostics',
      this.engine,
      { computeSource: diagnostics },
      {
        bindingsMapping: {
          p: { group: 0, binding: 0 },
          state: { group: 0, binding: 1 },
          result: { group: 0, binding: 2 },
        },
      },
    );
    this.diagnoseShader.setUniformBuffer('p', this.uniform);
    this.diagnoseShader.setStorageBuffer('result', this.result);
    this.diagnoseShader.setStorageBuffer('state', this.buffers[0]);
    this.updateSettings(settings);
    this.createMesh();
    this.bindRender();
    this.lastStatsAt = 0;
  }

  updateSettings(s: Settings) {
    if (s.sea !== this.settings.sea) {
      this.seaOffset = 0;
      this.seaAnchorTime = this.time;
    } else if (s.seaRate !== this.settings.seaRate) {
      this.seaOffset += (this.settings.seaRate * (this.time - this.seaAnchorTime)) / 3600;
      this.seaAnchorTime = this.time;
    }
    this.settings = { ...s };
    this.uniform.updateFloat4(
      'grid',
      s.resolution,
      DOMAIN / s.resolution,
      DT,
      s.sea + this.seaOffset,
    );
    this.uniform.updateFloat4(
      'rain',
      s.rain,
      s.duration * 3600,
      ['constant', 'front', 'back'].indexOf(s.pattern),
      s.repeat ? 1 : 0,
    );
    this.uniform.updateFloat4('hydro', s.interval * 3600, s.inflow, s.sediment, s.infiltration);
    this.uniform.updateFloat4(
      'material',
      s.erosion,
      s.grain,
      (s.repose * Math.PI) / 180,
      s.vegetation,
    );
    this.uniform.updateFloat4('longterm', s.seaRate, s.uplift, s.weathering, this.seaAnchorTime);
    this.uniform.update();
  }

  private async waitForCompute() {
    const start = performance.now();
    while (!this.computeReady()) {
      if (this.disposed) return;
      if (this.computeError) throw new Error(this.computeError);
      if (performance.now() - start > 20000)
        throw new Error('計算シェーダーの準備がタイムアウト。再読み込みして再試行。');
      await new Promise(requestAnimationFrame);
    }
  }

  private computeReady() {
    return [
      ...this.sourceShaders,
      ...this.updateShaders,
      this.flowShader,
      this.diagnoseShader,
    ].every((s) => s.isReady());
  }

  private bindRender() {
    this.material.setStorageBuffer('state', this.buffers[this.current]);
    this.waterMaterial.setStorageBuffer('state', this.buffers[this.current]);
  }

  step(count = 1) {
    if (this.disposed || !this.computeReady()) return;
    if (count > 0 && this.undoData) {
      this.undoData = null;
      this.onEdit(false);
    }
    const groups = Math.ceil(this.settings.resolution / 8);
    for (let i = 0; i < count; i++) {
      this.sourceShaders[this.current].dispatch(groups, groups);
      this.flowShader.dispatch(groups, groups);
      this.updateShaders[this.current].dispatch(groups, groups);
      this.current = 1 - this.current;
      this.time += DT;
      this.steps++;
    }
    this.bindRender();
    if (!this.running) this.lastStatsAt = 0;
  }

  private frame = () => {
    if (this.disposed) return;
    try {
      const now = performance.now();
      if (this.running) {
        this.accumulator +=
          (Math.min(0.05, (now - (this.lastFrame || now)) / 1000) * 120 * this.speed) / DT;
        const count = Math.min(256, Math.floor(this.accumulator));
        if (count > 0) {
          this.step(count);
          this.accumulator -= count;
        }
        // Slow down under GPU pressure instead of accumulating unbounded work.
        this.accumulator = Math.min(this.accumulator, 256);
      } else this.accumulator = 0;
      this.lastFrame = now;
      this.material.setFloat('clock', now / 1000);
      this.waterMaterial.setFloat('clock', now / 1000);
      this.scene.render();
      if (now - this.lastHudAt > 60) {
        this.updateCameraHUD();
        this.lastHudAt = now;
      }
      if (now - this.lastStatsAt > 900 && !this.reading) {
        this.lastStatsAt = now;
        void this.readStats();
      }
    } catch (e) {
      this.running = false;
      this.onError(e instanceof Error ? e.message : String(e));
    }
  };

  private updateCameraHUD() {
    if (!this.onCamera) return;
    const viewport = this.camera.viewport.toGlobal(
      this.engine.getRenderWidth(),
      this.engine.getRenderHeight(),
    );
    const matrix = this.scene.getTransformMatrix(),
      center = this.camera.target;
    const origin = Vector3.Project(center, Matrix.Identity(), matrix, viewport);
    const north = Vector3.Project(
      center.add(new Vector3(0, 0, -500)),
      Matrix.Identity(),
      matrix,
      viewport,
    );
    const right = this.camera.getDirection(new Vector3(1, 0, 0)).normalize();
    const endpoint = Vector3.Project(
      center.add(right.scale(500)),
      Matrix.Identity(),
      matrix,
      viewport,
    );
    let width =
      (Math.abs(endpoint.x - origin.x) * this.canvas.clientWidth) / this.engine.getRenderWidth();
    let distance = 500;
    if (width > 140) {
      width *= 0.4;
      distance = 200;
    } else if (width < 40) {
      width *= 2;
      distance = 1000;
    }
    this.onCamera({
      angle: (Math.atan2(north.x - origin.x, origin.y - north.y) * 180) / Math.PI,
      width,
      distance,
    });
  }

  private getBaseline(a: Float32Array): Baseline {
    const b: Baseline = {
      water: 0,
      earth: 0,
      waterIn: 0,
      waterOut: 0,
      infiltrated: 0,
      sedimentIn: 0,
      uplift: 0,
      sedimentOut: 0,
    };
    for (let i = 0; i < a.length; i += STRIDE) {
      b.water += a[i + 2];
      b.earth += a[i] + a[i + 1] + a[i + 3];
      b.waterIn += a[i + 8];
      b.waterOut += a[i + 9];
      b.infiltrated += a[i + 10];
      b.sedimentOut += a[i + 11];
      b.sedimentIn += a[i + 14];
      b.uplift += a[i + 15];
    }
    return b;
  }

  async readStats() {
    if (this.reading || this.disposed || !this.diagnoseShader.isReady()) return;
    this.reading = true;
    const gen = this.generation,
      snapshotTime = this.time,
      snapshotSteps = this.steps;
    try {
      this.diagnoseShader.setStorageBuffer('state', this.buffers[this.current]);
      this.diagnoseShader.dispatch(Math.ceil(this.settings.resolution / 64));
      const bytes = await this.result.read(undefined, undefined, undefined, true);
      if (this.disposed || gen !== this.generation) return;
      const rows = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
        b = this.baseline;
      const totals = new Float64Array(12),
        profile: Stats['profile'] = { initial: [], current: [], water: [] };
      let maxSpeed = 0,
        maxWater = 0,
        minWater = Infinity,
        minSoil = Infinity;
      for (let i = 0; i < rows.length; i += 20) {
        for (let k = 0; k < 12; k++) totals[k] += rows[i + k];
        maxSpeed = Math.max(maxSpeed, rows[i + 12]);
        maxWater = Math.max(maxWater, rows[i + 13]);
        minWater = Math.min(minWater, rows[i + 14]);
        minSoil = Math.min(minSoil, rows[i + 15]);
        profile.initial.push(rows[i + 16]);
        profile.current.push(rows[i + 17]);
        profile.water.push(rows[i + 18]);
      }
      const area = (DOMAIN / this.settings.resolution) ** 2;
      const water = totals[0] * area,
        waterIn = (totals[4] - b.waterIn) * area,
        waterOut = (totals[5] - b.waterOut) * area,
        infiltrated = (totals[6] - b.infiltrated) * area;
      const sedimentIn = (totals[10] - b.sedimentIn) * area,
        sedimentOut = (totals[7] - b.sedimentOut) * area;
      const waterError =
        ((water - b.water * area - waterIn + waterOut + infiltrated) /
          Math.max(1, waterIn, b.water * area)) *
        100;
      const sedimentError =
        (((totals[1] -
          b.earth -
          (totals[10] - b.sedimentIn) -
          (totals[11] - b.uplift) +
          (totals[7] - b.sedimentOut)) *
          area) /
          Math.max(1, Math.abs(b.earth * area))) *
        100;
      const eroded = totals[2] * area,
        deposited = totals[3] * area;
      if (!this.history.length || snapshotTime > this.history[this.history.length - 1].time) {
        this.history.push({ time: snapshotTime, eroded, deposited });
        if (this.history.length > 120) this.history.shift();
      }
      this.onStats({
        ...emptyStats,
        time: snapshotTime,
        steps: snapshotSteps,
        fps: this.engine.getFps(),
        water,
        sediment: totals[1] * area,
        eroded,
        deposited,
        maxSpeed,
        maxWater,
        waterIn,
        waterOut,
        infiltrated,
        sedimentIn,
        sedimentOut,
        waterError,
        sedimentError,
        minWater,
        minSoil,
        profile,
        history: [...this.history],
      });
    } catch (e) {
      if (!this.disposed && gen === this.generation) {
        this.running = false;
        this.onError(`計測に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      this.reading = false;
    }
  }

  setView(mode: ViewMode, contours: boolean, exaggeration: number, water: boolean) {
    const v = ['terrain', 'change', 'water', 'velocity', 'moisture'].indexOf(mode);
    for (const m of [this.material, this.waterMaterial]) {
      m.setFloat('viewMode', v);
      m.setFloat('contours', contours ? 1 : 0);
      m.setFloat('exaggeration', exaggeration);
    }
    this.waterMesh.setEnabled(water);
  }

  setTool(tool: EditTool) {
    this.tool = tool;
    if (tool === 'orbit') this.camera.attachControl(this.canvas, true);
    else this.camera.detachControl();
  }

  cameraView(view: 'perspective' | 'top' | 'reset') {
    this.camera.setTarget(new Vector3(0, 100, 0), false, false, true);
    this.camera.inertialAlphaOffset = 0;
    this.camera.inertialBetaOffset = 0;
    this.camera.inertialRadiusOffset = 0;
    this.camera.inertialPanningX = 0;
    this.camera.inertialPanningY = 0;
    if (view === 'top') {
      this.camera.alpha = Math.PI / 2;
      this.camera.beta = 0.01;
      this.camera.radius = 3550;
    } else {
      this.camera.alpha = Math.PI * 0.34;
      this.camera.beta = 0.91;
      this.camera.radius = 4250;
    }
    this.camera.getViewMatrix(true);
  }

  private editPointer = (event: PointerEvent) => {
    if (this.running || this.editing || this.tool === 'orbit' || event.button !== 0) return;
    this.editing = true;
    void this.editAt(event)
      .catch((e) => this.onError(`編集に失敗: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.editing = false;
      });
  };

  private async editAt(event: PointerEvent) {
    if (this.reading) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const ray = this.scene.createPickingRay(sx, sy, Matrix.Identity(), this.camera);
    const state = await this.snapshotState();
    if (this.disposed || this.running) return;
    const n = this.settings.resolution;
    // Ray-march against the current GPU height field, including vertical exaggeration.
    let hit: Vector3 | null = null;
    for (let distance = 10; distance < 9000; distance += 6) {
      const point = ray.origin.add(ray.direction.scale(distance));
      const x = Math.round((point.x / DOMAIN + 0.5) * (n - 1)),
        y = Math.round((point.z / DOMAIN + 0.5) * (n - 1));
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const i = (y * n + x) * STRIDE;
      if (point.y <= (state[i] + state[i + 1]) * this.verticalScale) {
        hit = point;
        break;
      }
    }
    if (!hit) return;
    this.undoData = {
      state: state.slice(),
      initial: this.initial.slice(),
      baseline: { ...this.baseline },
    };
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const wx = (x / (n - 1) - 0.5) * DOMAIN,
          wz = (y / (n - 1) - 0.5) * DOMAIN;
        const d = Math.hypot(wx - hit.x, wz - hit.z) / this.brush;
        if (d >= 1) continue;
        const amount = (1 - d * d) ** 2 * 8,
          i = (y * n + x) * STRIDE;
        if (this.tool === 'soil') state[i + 1] += amount;
        else if (this.tool === 'raise') state[i] += amount;
        else if (this.tool === 'lower') state[i] -= amount;
        else {
          const remove = Math.min(state[i + 1], amount);
          state[i + 1] -= remove;
          state[i] -= (amount - remove) * 0.5;
        }
      }
    for (let i = 0; i < state.length; i += STRIDE) state[i + 5] = state[i] + state[i + 1];
    this.initial = state.slice();
    this.baseline = this.getBaseline(state);
    this.buffers[this.current].update(state);
    this.history = [];
    this.lastStatsAt = 0;
    this.onEdit(true);
  }

  verticalScale = 2.1;

  undo() {
    if (!this.undoData || this.running) return;
    this.initial = this.undoData.initial;
    this.baseline = this.undoData.baseline;
    this.buffers[this.current].update(this.undoData.state);
    this.undoData = null;
    this.lastStatsAt = 0;
    this.onEdit(false);
  }

  async snapshotState() {
    const bytes = await this.buffers[this.current].read(undefined, undefined, undefined, true);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
  }

  async export(): Promise<ExperimentFile> {
    this.running = false;
    const time = this.time,
      steps = this.steps,
      settings = { ...this.settings },
      boundary = { offset: this.seaOffset, time: this.seaAnchorTime };
    const state = await this.snapshotState();
    return {
      format: 'sanga-experiment',
      version: 1,
      settings,
      time,
      steps,
      state: Array.from(state),
      initial: Array.from(this.initial),
      boundary,
    };
  }

  screenshot() {
    this.scene.render();
    this.engine.flushFramebuffer();
    return this.canvas.toDataURL('image/png');
  }

  private disposeCompute() {
    this.buffers.forEach((b) => b.dispose());
    this.temporary?.dispose();
    this.flux?.dispose();
    this.result?.dispose();
    this.sourceShaders = [];
    this.updateShaders = [];
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.editPointer);
    if (this.engineReady) {
      this.engine.stopRenderLoop(this.frame);
      this.disposeCompute();
      this.uniform?.dispose();
      this.scene?.dispose();
      this.engine.dispose();
    }
  }
}
