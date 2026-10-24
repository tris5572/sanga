import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CloudRain,
  Droplets,
  Eye,
  Flag,
  Focus,
  Gauge,
  Layers3,
  Maximize2,
  Mountain,
  MousePointer2,
  Move3D,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Route,
  Ruler,
  Save,
  Settings2,
  SlidersHorizontal,
  Sprout,
  StepForward,
  Undo2,
  Upload,
  Waves,
  X,
  Minus,
  ImageDown,
  Info,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TerrainEngine } from './simulation/TerrainEngine';
import {
  defaults,
  DOMAIN,
  DT,
  emptyStats,
  parseExperiment,
  rainIntensity,
  settingsForPreset,
} from './simulation/model';
import type { EditTool, Preset, Settings, ViewMode } from './simulation/model';
import { ProfileChart, HistoryChart, volume, clockTime } from './components/Charts';

type Notice = { id: number; text: string };
const presets: { id: Preset; name: string; en: string; description: string; icon: LucideIcon }[] = [
  {
    id: 'fan',
    name: '扇状地の形成',
    en: 'ALLUVIAL FAN',
    description: '谷から平地へ。広がる水と土砂。',
    icon: Mountain,
  },
  {
    id: 'terrace',
    name: '河岸段丘',
    en: 'RIVER TERRACE',
    description: '堆積から下刻へ。残される谷底。',
    icon: Layers3,
  },
  {
    id: 'basin',
    name: '閉じた盆地',
    en: 'CLOSED BASIN',
    description: '窪地にたまる水と浸透を観察。',
    icon: Waves,
  },
];
const views: { id: ViewMode; label: string }[] = [
  { id: 'terrain', label: '地形' },
  { id: 'change', label: '侵食・堆積' },
  { id: 'water', label: '水深' },
  { id: 'velocity', label: '流速' },
  { id: 'moisture', label: '土壌水分' },
];

function Control({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  disabled = false,
  help,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
  help?: string;
}) {
  const id = `control-${label}`;
  return (
    <div className={`control ${disabled ? 'disabled' : ''}`}>
      <div className="control-label">
        <label htmlFor={id} title={help}>
          {label}
          {help && <Info size={11} />}
        </label>
        <span>
          <output htmlFor={id}>{step < 1 ? value.toFixed(step < 0.1 ? 2 : 1) : value}</output>{' '}
          <small>{unit}</small>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(+e.target.value)}
        style={{ '--range-fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className="toggle-line"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span>{label}</span>
      <span className={`switch ${checked ? 'on' : ''}`}>
        <i />
      </span>
    </button>
  );
}

function download(data: Blob | string, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    engineRef = useRef<TerrainEngine | null>(null),
    fileRef = useRef<HTMLInputElement>(null),
    viewportRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<HTMLDivElement>(null),
    scaleRef = useRef<HTMLSpanElement>(null),
    scaleLabelRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<Settings>(defaults),
    [stats, setStats] = useState(emptyStats);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [running, setRunning] = useState(false),
    [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<'water' | 'material'>('water'),
    [view, setView] = useState<ViewMode>('terrain');
  const [contours, setContours] = useState(false),
    [water, setWater] = useState(true),
    [exaggeration, setExaggeration] = useState(2.1);
  const [tool, setTool] = useState<EditTool>('orbit'),
    [brush, setBrush] = useState(140),
    [canUndo, setCanUndo] = useState(false),
    [topView, setTopView] = useState(false);
  const [help, setHelp] = useState(false),
    [notice, setNotice] = useState<Notice | null>(null),
    [events, setEvents] = useState<{ time: number; text: string }[]>([
      { time: 0, text: '谷口から広がる地形を生成' },
    ]);
  const [busy, setBusy] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [seed, setSeed] = useState(defaults.seed),
    [showBudget, setShowBudget] = useState(false);
  const [phase, setPhase] = useState<'aggrade' | 'incise'>('aggrade');

  const notify = (text: string) => setNotice({ id: Date.now(), text });

  const log = (text: string) =>
    setEvents((prev) => [{ time: engineRef.current?.time ?? 0, text }, ...prev].slice(0, 12));

  useEffect(() => {
    let disposed = false;
    let engine: TerrainEngine | undefined;
    void (async () => {
      if (!navigator.gpu || !window.isSecureContext) {
        throw new Error(
          'WebGPUを利用できない環境。対応ブラウザで localhost または HTTPS から開いてください。',
        );
      }
      engine = new TerrainEngine(canvasRef.current!, defaults, {
        onStats: (s) => {
          if (!disposed) setStats(s);
        },
        onCamera: (hud) => {
          if (disposed) return;
          if (compassRef.current) compassRef.current.style.transform = `rotate(${hud.angle}deg)`;
          if (scaleRef.current) scaleRef.current.style.width = `${hud.width}px`;
          if (scaleLabelRef.current)
            scaleLabelRef.current.textContent =
              hud.distance >= 1000 ? `${hud.distance / 1000} km` : `${hud.distance} m`;
        },
        onError: (message) => {
          if (!disposed) {
            setError(message);
            setRunning(false);
          }
        },
        onEdit: (undo) => {
          if (!disposed) {
            setCanUndo(undo);
            if (undo) notify('地形を編集。比較と収支の基準を更新した。');
          }
        },
      });
      engineRef.current = engine;
      await engine.init();
      if (!disposed) setReady(true);
    })().catch((e) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      disposed = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) engineRef.current?.updateSettings(settings);
  }, [settings, ready]);

  useEffect(() => {
    if (ready && engineRef.current) {
      engineRef.current.verticalScale = exaggeration;
      engineRef.current.setView(view, contours, exaggeration, water);
    }
  }, [view, contours, exaggeration, water, ready]);

  useEffect(() => {
    if (ready && engineRef.current) {
      engineRef.current.setTool(tool);
      engineRef.current.brush = brush;
    }
  }, [tool, brush, ready]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.speed = speed;
  }, [speed]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!help) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelp(false);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [help]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const play = () => {
    if (!ready || busy || error) return;
    const next = !running;
    setRunning(next);
    if (engineRef.current) engineRef.current.running = next;
    if (next) {
      setTool('orbit');
      log('シミュレーションを開始');
    }
  };

  const reset = (next = settings, presetChange = false) => {
    if (!ready || busy) return;
    setRunning(false);
    setTool('orbit');
    setSettings(next);
    setStats(emptyStats);
    setSeed(next.seed);
    setPhase('aggrade');
    engineRef.current?.reset(next);
    engineRef.current?.setView(view, contours, exaggeration, water);
    setEvents([
      {
        time: 0,
        text: presetChange
          ? `${presets.find((p) => p.id === next.preset)!.name}を準備`
          : '初期状態に戻した',
      },
    ]);
    notify('初期状態を準備した。');
  };

  const save = async () => {
    const engine = engineRef.current;
    if (!engine || busy || !ready) return;
    setRunning(false);
    engine.running = false;
    setBusy(true);
    try {
      const file = await engine.export();
      download(
        new Blob([JSON.stringify(file)], { type: 'application/json' }),
        `sanga-${settings.preset}-${Date.now()}.json`,
      );
      notify('設定・初期地形・現在の状態を保存した。');
      log('実験ファイルを保存');
    } catch (e) {
      notify(`保存に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const load = async (file?: File) => {
    if (!file || busy || !ready) return;
    setRunning(false);
    if (engineRef.current) engineRef.current.running = false;
    setBusy(true);
    try {
      if (file.size > 140 * 1024 * 1024) throw new Error('ファイルは140 MB以下に制限。');
      const f = parseExperiment(JSON.parse(await file.text()));
      setSettings(f.settings);
      setSeed(f.settings.seed);
      setPhase(f.settings.preset === 'terrace' && f.settings.sediment < 1 ? 'incise' : 'aggrade');
      engineRef.current?.reset(f.settings, f);
      engineRef.current?.setView(view, contours, exaggeration, water);
      setStats({ ...emptyStats, time: f.time, steps: f.steps });
      setTool('orbit');
      setEvents([{ time: f.time, text: '保存した実験を復元' }]);
      notify('実験を復元した。同じ状態から再開できる。');
    } catch (e) {
      notify(e instanceof Error ? e.message : '読み込みに失敗。');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const changePhase = (next: 'aggrade' | 'incise') => {
    setPhase(next);
    const patch =
      next === 'aggrade'
        ? { sediment: 10, sea: 15, inflow: 50, seaRate: 0 }
        : { sediment: 0.3, sea: -8, inflow: 65, seaRate: -0.4 };
    setSettings((prev) => ({ ...prev, ...patch }));
    log(next === 'aggrade' ? '堆積期：土砂供給を増加' : '下刻期：土砂供給と下流端水位を低下');
    notify(
      next === 'aggrade'
        ? '堆積期の条件へ変更。'
        : '下刻期の条件へ変更。水位低下は下流端から伝わる。',
    );
  };

  const rain = rainIntensity(stats.time, settings) * 1000 * 3600;
  const cycle = (settings.duration + settings.interval) * 3600;
  const localTime = settings.repeat ? stats.time % cycle : stats.time;
  const progress = Math.min(100, (localTime / (settings.duration * 3600)) * 100);
  const elapsed = clockTime(stats.time);
  const preset = presets.find((p) => p.id === settings.preset)!;
  const valid =
    Math.abs(stats.waterError) < 0.5 &&
    Math.abs(stats.sedimentError) < 0.02 &&
    stats.minWater >= 0 &&
    stats.minSoil >= 0;
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="./" aria-label="SANGA 地形実験室">
          <span className="brand-mark">
            <Mountain size={23} strokeWidth={1.45} />
          </span>
          <span>
            SANGA<small>地形実験室</small>
          </span>
        </a>
        <div className="header-divider" />
        <span className="workspace-label">TERRAIN EXPLORATION LAB</span>
        <nav>
          <button className="header-help" onClick={() => setHelp(true)}>
            <CircleHelp size={16} />
            <span>モデルについて</span>
          </button>
          <span className={`gpu-status ${ready && !error ? 'connected' : ''}`}>
            <i />
            {error ? 'GPU 未接続' : ready ? 'WebGPU 接続中' : 'GPU 初期化中'}
          </span>
          <button
            className="button subtle"
            onClick={() => fileRef.current?.click()}
            disabled={!ready || busy}
          >
            <Upload size={14} />
            読み込む
          </button>
          <button className="button dark" onClick={() => void save()} disabled={!ready || busy}>
            <Save size={14} />
            {busy ? '処理中…' : '実験を保存'}
          </button>
        </nav>
        <input
          type="file"
          accept=".json,application/json"
          hidden
          ref={fileRef}
          onChange={(e) => void load(e.target.files?.[0])}
        />
      </header>
      <main>
        <section className="intro">
          <div>
            <div className="eyebrow">
              <span>EXPERIMENT 01</span>
              <i />
              水と大地の相互作用
            </div>
            <h1>
              水がつくる、次の地形<span>。</span>
            </h1>
            <p>流れ、削られ、積み重なる。地形が生まれる過程を、あなたの手で。</p>
          </div>
          <div className="intro-note">
            <span className="note-symbol">
              <Sprout size={20} strokeWidth={1.3} />
            </span>
            <div>
              小さな条件の違いが、
              <br />
              大地のかたちを変えていく。<span>EDUCATIONAL SIMULATION · 2.5D MODEL</span>
            </div>
          </div>
        </section>
        <div className="workspace">
          <aside className="settings-panel panel">
            <div className="panel-title">
              <SlidersHorizontal size={16} />
              <h2>実験の条件</h2>
              <span className="section-no">01</span>
            </div>
            <div className="settings-scroll">
              <div className="field-heading">
                <span>地形プリセット</span>
                <small>LANDSCAPE</small>
              </div>
              <div className="preset-list">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    className={`preset ${settings.preset === p.id ? 'selected' : ''}`}
                    onClick={() => reset(settingsForPreset(p.id), true)}
                    disabled={!ready || busy}
                  >
                    <p.icon size={22} strokeWidth={1.3} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.en}</small>
                    </span>
                    {settings.preset === p.id ? (
                      <span className="selection-dot" />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                  </button>
                ))}
              </div>
              <p className="preset-caption">{preset.description}</p>
              {settings.preset === 'terrace' && (
                <div className="phase-switch">
                  <span>外部条件の切り替え</span>
                  <div>
                    <button
                      className={phase === 'aggrade' ? 'active' : ''}
                      onClick={() => changePhase('aggrade')}
                    >
                      1. 堆積期
                    </button>
                    <button
                      className={phase === 'incise' ? 'active' : ''}
                      onClick={() => changePhase('incise')}
                    >
                      2. 下刻期
                    </button>
                  </div>
                  <small>堆積を進めた後、下刻期に切り替える。</small>
                </div>
              )}
              <div className="settings-tabs" role="tablist" aria-label="条件の種類">
                <button
                  role="tab"
                  aria-selected={tab === 'water'}
                  className={tab === 'water' ? 'active' : ''}
                  onClick={() => setTab('water')}
                >
                  <Droplets size={14} />
                  外力・水文
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'material'}
                  className={tab === 'material' ? 'active' : ''}
                  onClick={() => setTab('material')}
                >
                  <Layers3 size={14} />
                  地形・地質
                </button>
              </div>
              {tab === 'water' ? (
                <>
                  <div className="control-group">
                    <h3>
                      <CloudRain size={15} />
                      降雨イベント<span>RAIN</span>
                    </h3>
                    <Control
                      label="総降水量"
                      value={settings.rain}
                      min={0}
                      max={400}
                      step={10}
                      unit="mm"
                      onChange={(v) => update('rain', v)}
                    />
                    <Control
                      label="継続時間"
                      value={settings.duration}
                      min={0.25}
                      max={24}
                      step={0.25}
                      unit="h"
                      onChange={(v) => update('duration', v)}
                    />
                    <label className="select-field">
                      降り方
                      <select
                        value={settings.pattern}
                        onChange={(e) => update('pattern', e.target.value as Settings['pattern'])}
                      >
                        <option value="constant">一定の強さ</option>
                        <option value="front">前半に集中</option>
                        <option value="back">後半に集中</option>
                      </select>
                      <ChevronDown size={12} />
                    </label>
                    <Toggle
                      label="降雨を繰り返す"
                      checked={settings.repeat}
                      onChange={(v) => update('repeat', v)}
                    />
                    {settings.repeat && (
                      <Control
                        label="イベント間の休止"
                        value={settings.interval}
                        min={0}
                        max={48}
                        unit="h"
                        onChange={(v) => update('interval', v)}
                      />
                    )}
                  </div>
                  <div className="control-group">
                    <h3>
                      <Route size={15} />
                      上流からの供給<span>INFLOW</span>
                    </h3>
                    <Control
                      label="上流流量"
                      value={settings.inflow}
                      min={0}
                      max={200}
                      step={5}
                      unit="m³/s"
                      onChange={(v) => update('inflow', v)}
                    />
                    <Control
                      label="供給土砂濃度"
                      value={settings.sediment}
                      min={0}
                      max={30}
                      step={0.1}
                      unit="vol.%"
                      onChange={(v) => update('sediment', v)}
                    />
                  </div>
                  <div className="control-group">
                    <h3>
                      <Waves size={15} />
                      地中と下流端<span>BOUNDARY</span>
                    </h3>
                    <Control
                      label="浸透能"
                      value={settings.infiltration}
                      min={0}
                      max={50}
                      unit="mm/h"
                      onChange={(v) => update('infiltration', v)}
                    />
                    <Control
                      label="下流端水位"
                      value={settings.sea}
                      min={-30}
                      max={80}
                      unit="m"
                      onChange={(v) => update('sea', v)}
                      help="下流の境界セルにのみ適用。閉じた窪地を直接水没させない。"
                    />
                    <button
                      className="disclosure"
                      aria-expanded={advanced}
                      onClick={() => setAdvanced(!advanced)}
                    >
                      <ChevronRight size={12} className={advanced ? 'rotate' : ''} />
                      長期変化を設定
                    </button>
                    {advanced && (
                      <>
                        <Control
                          label="水位の変化速度"
                          value={settings.seaRate}
                          min={-10}
                          max={10}
                          step={0.1}
                          unit="m/h"
                          onChange={(v) => update('seaRate', v)}
                        />
                        <Control
                          label="地盤隆起"
                          value={settings.uplift}
                          min={0}
                          max={5}
                          step={0.1}
                          unit="m/h"
                          onChange={(v) => update('uplift', v)}
                        />
                        <Control
                          label="風化速度"
                          value={settings.weathering}
                          min={0}
                          max={1}
                          step={0.01}
                          unit="mm/h"
                          onChange={(v) => update('weathering', v)}
                        />
                        <p className="micro-note">長期変化の比較用。実際の年数には換算しない。</p>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="control-group">
                    <h3>
                      <Layers3 size={15} />
                      表土と基盤岩<span>MATERIAL</span>
                    </h3>
                    <Control
                      label="侵食係数"
                      value={settings.erosion}
                      min={0}
                      max={2}
                      step={0.05}
                      onChange={(v) => update('erosion', v)}
                    />
                    <Control
                      label="代表粒径"
                      value={settings.grain}
                      min={0.1}
                      max={20}
                      step={0.1}
                      unit="mm"
                      onChange={(v) => update('grain', v)}
                    />
                    <Control
                      label="乾燥時の安息角"
                      value={settings.repose}
                      min={15}
                      max={50}
                      unit="°"
                      onChange={(v) => update('repose', v)}
                    />
                    <Control
                      label="植生による抵抗"
                      value={settings.vegetation}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(v) => update('vegetation', v)}
                    />
                    <p className="micro-note">
                      一種類の非粘着性土砂。基盤岩の侵食抵抗は表土の約67倍。土壌水分に応じて安定限界が低下する。
                    </p>
                  </div>
                  <div className="control-group">
                    <h3>
                      <Settings2 size={15} />
                      初期条件<span>INITIAL STATE</span>
                    </h3>
                    <label className="select-field">
                      格子解像度
                      <select
                        value={settings.resolution}
                        disabled={running || !ready}
                        onChange={(e) => reset({ ...settings, resolution: +e.target.value })}
                      >
                        <option value="128">128 × 128 · 軽量</option>
                        <option value="256">256 × 256 · 標準</option>
                        <option value="512">512 × 512 · 詳細</option>
                      </select>
                      <ChevronDown size={12} />
                    </label>
                    <Control
                      label="初期土壌水分"
                      value={settings.moisture}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(v) => update('moisture', v)}
                      disabled={running}
                    />
                    <label className="seed-field">
                      乱数シード
                      <input
                        type="number"
                        min="0"
                        max="9999999"
                        value={seed}
                        disabled={running}
                        onChange={(e) =>
                          setSeed(Math.max(0, Math.min(9999999, Math.floor(+e.target.value))))
                        }
                      />
                    </label>
                    <button
                      className="button regenerate"
                      onClick={() => reset({ ...settings, seed })}
                      disabled={running || !ready || busy}
                    >
                      <RotateCcw size={13} />
                      初期条件で再生成
                    </button>
                    <p className="micro-note">
                      初期水分とシードは再生成で適用。解像度変更は現在の実験を初期化する。
                    </p>
                  </div>
                </>
              )}
              <div className="model-note">
                <Info size={14} />
                <p>
                  地形の成り立ちを理解するための
                  <br />
                  教育・比較実験モデル。
                </p>
                <button onClick={() => setHelp(true)} aria-label="モデルの詳細">
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
          </aside>
          <section className="center-panel">
            <div className="viewport" ref={viewportRef}>
              <canvas
                ref={canvasRef}
                aria-label="地形と地表水の3Dシミュレーション。ドラッグで回転、ホイールで拡大縮小。"
              />
              <div className="viewport-top">
                <div className="scene-title">
                  <span className="scene-status">
                    <i className={running ? 'running' : ''} />
                    {running ? 'SIMULATING' : 'OBSERVATION'}
                  </span>
                  <h2>{preset.name}</h2>
                  <span>
                    {(DOMAIN / 1000).toFixed(1)} × {(DOMAIN / 1000).toFixed(1)} km <b>·</b> SEED{' '}
                    {settings.seed}
                  </span>
                </div>
                <button
                  className="scene-icon"
                  aria-label="画面を拡大"
                  title="全画面表示"
                  onClick={() => {
                    if (document.fullscreenElement) void document.exitFullscreen();
                    else void viewportRef.current?.requestFullscreen();
                  }}
                >
                  <Maximize2 size={16} />
                </button>
              </div>
              <div className="view-selector" role="tablist" aria-label="可視化レイヤー">
                {views.map((v) => (
                  <button
                    role="tab"
                    aria-selected={view === v.id}
                    key={v.id}
                    className={view === v.id ? 'active' : ''}
                    onClick={() => setView(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              <div className="scene-toolbar">
                <button
                  className={tool === 'orbit' ? 'active' : ''}
                  title="視点を操作"
                  aria-label="視点を操作"
                  onClick={() => setTool('orbit')}
                >
                  <Move3D size={17} />
                </button>
                <span />
                <button
                  className={tool === 'raise' ? 'active' : ''}
                  title="基盤岩を上げる（停止中）"
                  aria-label="基盤岩を上げる"
                  disabled={running || !ready || busy}
                  onClick={() => setTool(tool === 'raise' ? 'orbit' : 'raise')}
                >
                  <Plus size={17} />
                </button>
                <button
                  className={tool === 'lower' ? 'active' : ''}
                  title="基盤岩を下げる（停止中）"
                  aria-label="基盤岩を下げる"
                  disabled={running || !ready || busy}
                  onClick={() => setTool(tool === 'lower' ? 'orbit' : 'lower')}
                >
                  <Minus size={17} />
                </button>
                <button
                  className={tool === 'valley' ? 'active' : ''}
                  title="谷を掘る（停止中）"
                  aria-label="谷を掘る"
                  disabled={running || !ready || busy}
                  onClick={() => setTool(tool === 'valley' ? 'orbit' : 'valley')}
                >
                  <Route size={17} />
                </button>
                <button
                  className={tool === 'soil' ? 'active' : ''}
                  title="表土を加える（停止中）"
                  aria-label="表土を加える"
                  disabled={running || !ready || busy}
                  onClick={() => setTool(tool === 'soil' ? 'orbit' : 'soil')}
                >
                  <Layers3 size={17} />
                </button>
                <span />
                <button
                  title="編集を元に戻す"
                  aria-label="編集を元に戻す"
                  disabled={!canUndo || running || busy}
                  onClick={() => engineRef.current?.undo()}
                >
                  <Undo2 size={17} />
                </button>
              </div>
              {tool !== 'orbit' && (
                <div className="brush-settings">
                  <MousePointer2 size={13} />
                  <span>
                    {
                      (
                        {
                          raise: '基盤岩を上げる',
                          lower: '基盤岩を下げる',
                          soil: '表土を加える',
                          valley: '谷を掘る',
                        } as const
                      )[tool]
                    }
                  </span>
                  <label>
                    半径 {brush} m
                    <input
                      aria-label="編集ブラシの半径"
                      type="range"
                      min="40"
                      max="300"
                      step="10"
                      value={brush}
                      onChange={(e) => setBrush(+e.target.value)}
                    />
                  </label>
                  <small>地形をクリックして編集</small>
                </div>
              )}
              <div className="camera-toolbar">
                <button
                  className={topView ? 'active' : ''}
                  aria-label="真上から見る"
                  title="真上から見る"
                  onClick={() => {
                    setTopView(!topView);
                    engineRef.current?.cameraView(topView ? 'perspective' : 'top');
                  }}
                >
                  <Focus size={17} />
                </button>
                <button
                  aria-label="視点をリセット"
                  title="視点をリセット"
                  onClick={() => {
                    setTopView(false);
                    engineRef.current?.cameraView('reset');
                  }}
                >
                  <RotateCcw size={16} />
                </button>
                <button
                  aria-label="画像を保存"
                  title="画像を保存"
                  disabled={!ready}
                  onClick={() => {
                    try {
                      const url = engineRef.current?.screenshot();
                      if (url) download(url, `sanga-${settings.preset}.png`);
                    } catch {
                      notify('画像を保存できなかった。');
                    }
                  }}
                >
                  <ImageDown size={17} />
                </button>
              </div>
              <div className="compass">
                <span>N</span>
                <div ref={compassRef}>
                  <i />
                  <i />
                </div>
                <small>北</small>
              </div>
              <div className="scene-bottom">
                <div className="scene-scale">
                  <span ref={scaleRef} />
                  <div ref={scaleLabelRef}>500 m</div>
                </div>
                <div className="scene-legend">
                  {view === 'terrain' ? (
                    <>
                      <i className="legend-dot teal" />
                      地表水
                      <span />
                      <i className="legend-dot earth" />
                      移動可能な土砂
                    </>
                  ) : view === 'change' ? (
                    <>
                      <i className="legend-dot teal" />
                      侵食
                      <span />
                      <i className="legend-dot earth" />
                      堆積
                    </>
                  ) : (
                    <>
                      <span className={`gradient-bar ${view}`} />
                      {view === 'water'
                        ? '水深 0 → 1.5 m'
                        : view === 'velocity'
                          ? '流速 0 → 3 m/s'
                          : '乾燥 → 飽和'}
                    </>
                  )}
                </div>
              </div>
              {!ready && !error && (
                <div className="canvas-message">
                  <span className="loader" />
                  <h3>地形を準備している</h3>
                  <p>WebGPU · WGSL compute pipeline</p>
                </div>
              )}
              {error && (
                <div className="canvas-message error-message">
                  <Mountain size={36} strokeWidth={1} />
                  <h3>GPUを利用できない</h3>
                  <p>{error}</p>
                  <button className="button" onClick={() => window.location.reload()}>
                    <RotateCcw size={14} />
                    再読み込み
                  </button>
                </div>
              )}
            </div>
            <div className="display-options">
              <div>
                <Eye size={14} />
                <span>表示</span>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={water}
                  onChange={(e) => setWater(e.target.checked)}
                />
                水面
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={contours}
                  onChange={(e) => setContours(e.target.checked)}
                />
                等高線
              </label>
              <span className="display-separator" />
              <label className="height-scale">
                高さ強調
                <select value={exaggeration} onChange={(e) => setExaggeration(+e.target.value)}>
                  <option value="1">1.0×</option>
                  <option value="2.1">2.1×</option>
                  <option value="3">3.0×</option>
                </select>
              </label>
              <small>
                {settings.resolution}² cells <i /> {(DOMAIN / settings.resolution).toFixed(1)}{' '}
                m/cell
              </small>
            </div>
            <div className="transport panel">
              <div className="playback-controls">
                <button
                  className={`play-button ${running ? 'is-running' : ''}`}
                  aria-label={running ? '一時停止' : 'シミュレーションを開始'}
                  onClick={play}
                  disabled={!ready || !!error || busy}
                >
                  {running ? (
                    <Pause size={19} fill="currentColor" />
                  ) : (
                    <Play size={19} fill="currentColor" />
                  )}
                </button>
                <button
                  className="transport-icon"
                  aria-label="1ステップ進める"
                  title={`1ステップ = ${DT} 秒`}
                  onClick={() => engineRef.current?.step()}
                  disabled={!ready || running || !!error || busy}
                >
                  <StepForward size={18} />
                </button>
                <button
                  className="transport-icon"
                  aria-label="初期状態に戻す"
                  title="現在の設定で初期化"
                  disabled={!ready || busy}
                  onClick={() => reset()}
                >
                  <RotateCcw size={17} />
                </button>
                <span className="transport-divider" />
                <label className="speed-select">
                  <Gauge size={15} />
                  <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                    <option value="0.25">0.25×</option>
                    <option value="1">1×</option>
                    <option value="2">2×</option>
                    <option value="4">4×</option>
                    <option value="8">8×</option>
                  </select>
                  <ChevronDown size={11} />
                </label>
                <div className="time-display">
                  <span>SIMULATION TIME</span>
                  <strong>
                    {elapsed}
                    <small>h : m : s</small>
                  </strong>
                </div>
                <span className={`playback-state ${running ? 'on' : ''}`}>
                  <i />
                  {running ? '実行中' : '一時停止'}
                </span>
              </div>
              <div className="rain-timeline">
                <div className="timeline-label">
                  <CloudRain size={13} />
                  <span>{rain > 0 ? '降雨イベント' : 'イベント間の休止'}</span>
                  <strong>
                    {rain.toFixed(1)}
                    <small> mm/h</small>
                  </strong>
                </div>
                <div className="rain-track">
                  <div
                    className="rain-shape"
                    style={{
                      clipPath:
                        settings.pattern === 'front'
                          ? 'polygon(0 0,100% 100%,0 100%)'
                          : settings.pattern === 'back'
                            ? 'polygon(0 100%,100% 0,100% 100%)'
                            : 'none',
                    }}
                  />
                  <div className="rain-cursor" style={{ left: `${progress}%` }} />
                </div>
                <div className="timeline-ticks">
                  <span>0 h</span>
                  <span>{(settings.duration / 2).toFixed(1)} h</span>
                  <span>{settings.duration} h</span>
                </div>
                <div className="time-note">
                  固定 Δt {DT} s <span>·</span> 1× ≈ 2 分 / 秒 <span>·</span>{' '}
                  実行速度はGPU性能に依存
                </div>
              </div>
            </div>
            <div className="experiment-hint">
              <span>
                <Flag size={14} />
                <strong>観察のヒント</strong>
              </span>
              <p>
                {settings.preset === 'fan'
                  ? '土砂供給を増やしてみる。谷口で流れが弱まり、土砂がたまる場所と流路の変化に注目。'
                  : settings.preset === 'terrace'
                    ? '堆積期に谷底を埋めてから、下刻期へ切り替える。断面で以前の谷底面と現在の河床を比較。'
                    : '雨を降らせ、窪地に水がたまる様子を観察。浸透能を変えて水の残り方を比較。'}
              </p>
              <ArrowUpRight size={16} />
            </div>
          </section>
          <aside className="observation-panel panel">
            <div className="panel-title">
              <Activity size={16} />
              <h2>変化を観察</h2>
              <span className="section-no">02</span>
            </div>
            <div className="observation-scroll">
              <section className="observation-section">
                <div className="field-heading">
                  <span>地形の変化</span>
                  <small>VOLUME</small>
                </div>
                <div className="volume-card">
                  <div>
                    <i className="legend-dot teal" />
                    <span>侵食量</span>
                    <ArrowDownToLine size={13} />
                  </div>
                  <strong>
                    {volume(stats.eroded)}
                    <small>m³</small>
                  </strong>
                  <div className="metric-line">
                    <span
                      style={{
                        width: `${Math.min(100, (stats.eroded / Math.max(1, stats.eroded + stats.deposited)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="volume-card deposition">
                  <div>
                    <i className="legend-dot earth" />
                    <span>堆積量</span>
                    <Layers3 size={13} />
                  </div>
                  <strong>
                    {volume(stats.deposited)}
                    <small>m³</small>
                  </strong>
                  <div className="metric-line">
                    <span
                      style={{
                        width: `${Math.min(100, (stats.deposited / Math.max(1, stats.eroded + stats.deposited)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <p className="metric-caption">初期地表との標高差を面積積分</p>
              </section>
              <section className="observation-section profile-section">
                <div className="field-heading">
                  <span>
                    <Ruler size={13} />
                    谷口の横断面
                  </span>
                  <small>A — A′</small>
                </div>
                <ProfileChart profile={stats.profile} />
                <div className="chart-legend">
                  <span>
                    <i className="line-key dashed" />
                    初期地形
                  </span>
                  <span>
                    <i className="line-key" />
                    現在
                  </span>
                  <span>
                    <i className="line-key blue" />
                    水面
                  </span>
                </div>
                <p className="metric-caption">上流から58%の位置を横断 · 標高 m</p>
              </section>
              <section className="observation-section">
                <div className="field-heading">
                  <span>水の状態</span>
                  <small>HYDROLOGY</small>
                </div>
                <div className="mini-metrics">
                  <div>
                    <span>
                      <Droplets size={13} />
                      貯留水量
                    </span>
                    <strong>
                      {volume(stats.water)}
                      <small>m³</small>
                    </strong>
                  </div>
                  <div>
                    <span>
                      <Waves size={13} />
                      最大水深
                    </span>
                    <strong>
                      {stats.maxWater.toFixed(2)}
                      <small>m</small>
                    </strong>
                  </div>
                  <div>
                    <span>
                      <Route size={13} />
                      最大流速
                    </span>
                    <strong>
                      {stats.maxSpeed.toFixed(2)}
                      <small>m/s</small>
                    </strong>
                  </div>
                </div>
              </section>
              <section className="observation-section budget-section">
                <button
                  className="budget-toggle"
                  onClick={() => setShowBudget(!showBudget)}
                  aria-expanded={showBudget}
                >
                  <span className={`budget-state ${valid ? '' : 'warning'}`}>
                    <Check size={12} />
                  </span>
                  <span>
                    <strong>{valid ? '収支を確認中' : '収支誤差に注意'}</strong>
                    <small>水・土砂の保存性</small>
                  </span>
                  <ChevronDown size={14} className={showBudget ? 'rotate-up' : ''} />
                </button>
                {showBudget && (
                  <div className="budget-details">
                    <div>
                      <span>水の流入</span>
                      <b>{volume(stats.waterIn)} m³</b>
                    </div>
                    <div>
                      <span>水の流出</span>
                      <b>{volume(stats.waterOut)} m³</b>
                    </div>
                    <div>
                      <span>浸透</span>
                      <b>{volume(stats.infiltrated)} m³</b>
                    </div>
                    <div>
                      <span>水収支の相対誤差</span>
                      <b>{stats.waterError.toFixed(4)}%</b>
                    </div>
                    <div>
                      <span>土砂の流入</span>
                      <b>{volume(stats.sedimentIn)} m³</b>
                    </div>
                    <div>
                      <span>土砂の流出</span>
                      <b>{volume(stats.sedimentOut)} m³</b>
                    </div>
                    <div>
                      <span>固体収支の相対誤差</span>
                      <b>{stats.sedimentError.toFixed(5)}%</b>
                    </div>
                    <small>固体は基盤岩・表土・浮遊土砂の合計。隆起の追加体積を含めて評価。</small>
                  </div>
                )}
              </section>
              <section className="observation-section event-section">
                <div className="field-heading">
                  <span>実験ログ</span>
                  <small>LOG</small>
                </div>
                <ol>
                  {events.slice(0, 4).map((e, i) => (
                    <li key={`${e.time}-${i}`}>
                      <span className="event-dot" />
                      <time>{clockTime(e.time)}</time>
                      <p>{e.text}</p>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </aside>
        </div>
        <section className="history-panel">
          <div className="history-heading">
            <span>
              <Activity size={14} />
              <strong>変化の記録</strong>
            </span>
            <p>時間とともに、地形を読む。</p>
          </div>
          <HistoryChart history={stats.history} />
          <div className="history-legend">
            <span>
              <i className="legend-dot teal" />
              侵食
            </span>
            <span>
              <i className="legend-dot earth" />
              堆積
            </span>
            <small>最新120観測</small>
          </div>
        </section>
      </main>
      <footer>
        <span className="footer-brand">
          SANGA <i /> LANDSCAPE IN MOTION
        </span>
        <span>定性的な教育モデル。実際の災害・地形変化の定量予測には使用できない。</span>
        <div>
          <span className="footer-dot" />
          {ready ? `${Math.round(stats.fps)} FPS` : '— FPS'}
          <i />
          {stats.steps.toLocaleString()} steps
        </div>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice.text}
          <button onClick={() => setNotice(null)} aria-label="通知を閉じる">
            <X size={14} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              autoFocus
              onClick={() => setHelp(false)}
              aria-label="閉じる"
            >
              <X size={20} />
            </button>
            <span className="eyebrow">ABOUT THE MODEL</span>
            <h2 id="help-title">地形の変化を、読み解くために。</h2>
            <p className="help-lead">
              SANGAは、降雨と流水が大地のかたちを変える過程を観察する、2.5Dの教育・比較実験モデル。
            </p>
            <div className="model-flow">
              <span>降雨・流入</span>
              <ArrowRight size={14} />
              <span>地表流</span>
              <ArrowRight size={14} />
              <span>侵食・輸送</span>
              <ArrowRight size={14} />
              <span>堆積</span>
            </div>
            <h3>計算していること</h3>
            <p>
              基盤岩、表土、水深、輸送中の土砂、土壌水分を格子ごとに保持。Manning型の簡易流量式と輸送能力モデルを使い、4近傍へ保存的に移動する。固定時間刻みは0.25秒。流出量は利用可能な水量で制限し、負の水深を防ぐ。
            </p>
            <p>
              浸透水は貯留層へ移り、土壌水分は36時間の時定数で排水。勾配と湿り具合による表土の再配置は簡易的な斜面緩和で、実際の斜面崩壊や土石流を予測するものではない。
            </p>
            <h3>実験の進め方</h3>
            <p>
              開始ボタンで計算を進め、停止すると地形を編集できる。「＋」「−」で基盤岩を変更し、レイヤーアイコンで表土を加える。編集後は比較と収支の基準を更新し、直前の編集を一回戻せる。初期化は現在の設定で再生成する。
            </p>
            <p>
              河岸段丘では、堆積期に十分な堆積を進めてから下刻期へ切り替える。下流端の水位変化は境界から伝わり、領域全体には瞬時に反映されない。明瞭な段丘形成は保証されない。
            </p>
            <h3>適用範囲と検証</h3>
            <p>
              一種類の非粘着性土砂と一様な材料を扱う。浅水方程式の慣性項、複数粒径、粘着性土、実際の地質較正は未実装。表示の高さ強調は計算に影響しない。1×は毎秒120秒の計算を目標とし、長期変化の係数は実際の年数に対応しない。
            </p>
            <p>
              水・固体の収支と非負性は観測パネルで確認できる。格子数と時間刻みによる収束、および実測地形との一致は保証しない。研究・防災目的の定量予測には別途検証が必要。
            </p>
            <a
              className="documentation-link"
              href="https://doc.babylonjs.com/features/featuresDeepDive/materials/shaders/computeShader/"
              target="_blank"
              rel="noreferrer"
            >
              Babylon.js Compute Shader ドキュメント
              <ArrowUpRight size={13} />
            </a>
          </section>
        </div>
      )}
    </div>
  );
}
