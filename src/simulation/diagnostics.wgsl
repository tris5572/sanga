struct Cell { ground: vec4f, hydrology: vec4f, waterLedger: vec4f, earthLedger: vec4f }
struct Row { volume: vec4f, waterLedger: vec4f, earthLedger: vec4f, extremes: vec4f, profile: vec4f }
struct Params { grid: vec4f, rain: vec4f, hydro: vec4f, material: vec4f, longterm: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> state: array<Cell>;
@group(0) @binding(2) var<storage,read_write> result: array<Row>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let y=id.x; let n=u32(p.grid.x); if(y>=n) { return; }
  var r: Row;
  r.volume=vec4f(0); r.waterLedger=vec4f(0); r.earthLedger=vec4f(0);
  r.extremes=vec4f(0,0,1e20,1e20);
  for(var x=0u;x<n;x++) {
    let c=state[y*n+x];
    let delta=c.ground.x+c.ground.y-c.hydrology.y;
    r.volume+=vec4f(c.ground.z,c.ground.x+c.ground.y+c.ground.w,max(0.0,-delta),max(0.0,delta));
    r.waterLedger+=c.waterLedger; r.earthLedger+=c.earthLedger;
    r.extremes=vec4f(max(r.extremes.x,c.hydrology.z),max(r.extremes.y,c.ground.z),min(r.extremes.z,c.ground.z),min(r.extremes.w,c.ground.y));
  }
  let c=state[u32(round(f32(n-1u)*0.58))*n+y];
  r.profile=vec4f(c.hydrology.y,c.ground.x+c.ground.y,c.ground.z,c.ground.w);
  result[y]=r;
}
