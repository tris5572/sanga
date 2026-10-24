import { useId } from 'react';
import type { Stats } from '../simulation/model';

export const volume = (v: number) =>
  Math.abs(v) >= 1e6
    ? `${(v / 1e6).toFixed(2)}M`
    : Math.abs(v) >= 1000
      ? `${(v / 1000).toFixed(1)}k`
      : v.toFixed(1);

export const clockTime = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;

export function ProfileChart({ profile }: { profile: Stats['profile'] }) {
  const id = useId().replaceAll(':', '');
  const all = [...profile.initial, ...profile.current];
  const max = Math.max(60, ...all) + 10,
    min = Math.max(0, Math.min(0, ...all));
  const n = profile.current.length;

  const points = (values: number[]) =>
    values
      .map(
        (v, i) => `${22 + (i / Math.max(1, n - 1)) * 222},${108 - ((v - min) / (max - min)) * 84}`,
      )
      .join(' ');

  return (
    <svg
      className="profile-chart"
      viewBox="0 0 264 138"
      role="img"
      aria-label="谷口の横断面。初期地形と現在の標高を比較"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#a7b494" stopOpacity=".55" />
          <stop offset="1" stopColor="#a7b494" stopOpacity=".08" />
        </linearGradient>
      </defs>
      {[24, 66, 108].map((y, i) => (
        <g key={y}>
          <line x1="22" y1={y} x2="244" y2={y} stroke="#e4e6de" strokeDasharray="3 4" />
          <text x="0" y={y + 3} fontSize="8" fill="#94998b">
            {Math.round(max * (1 - i / 2))}
          </text>
        </g>
      ))}
      {n > 0 && (
        <>
          <polygon points={`22,108 ${points(profile.current)} 244,108`} fill={`url(#${id})`} />
          <polyline
            points={points(profile.initial)}
            fill="none"
            stroke="#b6baad"
            strokeWidth="1.3"
            strokeDasharray="4 3"
          />
          <polyline
            points={points(profile.current)}
            fill="none"
            stroke="#71815a"
            strokeWidth="1.8"
          />
          <polyline
            points={points(profile.current.map((v, i) => v + profile.water[i]))}
            fill="none"
            stroke="#58a2ac"
            strokeWidth="1"
          />
        </>
      )}
      <text x="22" y="129" fontSize="9" fill="#929789">
        0
      </text>
      <text x="119" y="129" fontSize="9" fill="#929789">
        1.2 km
      </text>
      <text x="223" y="129" fontSize="9" fill="#929789">
        2.4 km
      </text>
    </svg>
  );
}

export function HistoryChart({ history }: { history: Stats['history'] }) {
  const max = Math.max(1, ...history.flatMap((h) => [h.eroded, h.deposited]));
  const start = history[0]?.time ?? 0,
    end = Math.max(1, history.at(-1)?.time ?? 1);

  const points = (key: 'eroded' | 'deposited') =>
    history
      .map(
        (h) => `${((h.time - start) / Math.max(1, end - start)) * 500},${48 - (h[key] / max) * 42}`,
      )
      .join(' ');

  return (
    <svg
      className="history-chart"
      viewBox="0 0 500 54"
      preserveAspectRatio="none"
      role="img"
      aria-label="侵食量と堆積量の時間変化"
    >
      <path d="M0 49H500M0 25H500" fill="none" stroke="#e9eae3" strokeDasharray="3 5" />
      <polyline
        points={points('eroded')}
        fill="none"
        stroke="#6aabad"
        strokeWidth="1.7"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={points('deposited')}
        fill="none"
        stroke="#c49b60"
        strokeWidth="1.7"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
